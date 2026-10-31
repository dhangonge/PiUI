import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 客户端 key 标记的生命周期测试。
 *
 * Worker 是模拟的（真实 worker 会真的跑 Shiki），但被测的 map 是真的：
 * 测试在 Map.prototype.set 上挂探针，记录哪些 Map 实例收过带探针前缀的 key，
 * 再按前缀统计残留。这样不需要在生产代码里加 debug API。
 * 注意：这里只能证明「客户端 key 标记有没有释放」，不等于实际堆大小或真 Worker 性能。
 */

const KEY_PREFIX = 'retention-probe:'

type FakeRequest = {
  type: string
  id?: number
  key?: string
  text?: string
  [field: string]: unknown
}

type ShikiWorkerClient = typeof import('./shikiWorkerClient')

const originalMapSet = Map.prototype.set

class FakeWorker {
  static instances: FakeWorker[] = []

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((error: unknown) => void) | null = null
  requests: FakeRequest[] = []

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: FakeRequest) {
    this.requests.push(request)
  }

  terminate() {}
}

const trackedMaps = new Set<Map<unknown, unknown>>()

function retainedProbeKeys(): string[] {
  const keys = new Set<string>()
  trackedMaps.forEach(map => {
    map.forEach((_value, key) => {
      if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) keys.add(key)
    })
  })
  return [...keys].sort()
}

function lastHighlightRequest(worker: FakeWorker): FakeRequest {
  for (let index = worker.requests.length - 1; index >= 0; index -= 1) {
    const request = worker.requests[index]
    if (request.type === 'highlight') return request
  }
  throw new Error('no highlight request posted')
}

function highlightResponse(request: FakeRequest, extra: Record<string, unknown> = {}) {
  return {
    type: 'highlight',
    id: request.id,
    key: request.key,
    code: request.text,
    reset: true,
    stable: [[request.text, '']],
    unstable: [],
    ...extra,
  }
}

function respond(worker: FakeWorker, response: Record<string, unknown>) {
  worker.onmessage?.({ data: response } as MessageEvent)
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; error: unknown }

function trackOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    value => ({ status: 'fulfilled' as const, value }),
    error => ({ status: 'rejected' as const, error }),
  )
}

function rejectionMessage(outcome: Outcome<unknown>): string {
  expect(outcome.status).toBe('rejected')
  if (outcome.status !== 'rejected') return ''
  return outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
}

async function boot(client: ShikiWorkerClient): Promise<FakeWorker> {
  const ready = client.ensureShikiWorkerReady()
  const worker = FakeWorker.instances[0]
  if (!worker) throw new Error('worker was not created')
  expect(worker.requests.some(request => request.type === 'init')).toBe(true)
  respond(worker, { type: 'ready' })
  await ready
  return worker
}

async function startTokens(
  client: ShikiWorkerClient,
  worker: FakeWorker,
  key: string,
  params: { text?: string; complete?: boolean } = {},
): Promise<{ outcome: Promise<Outcome<unknown>>; request: FakeRequest }> {
  const outcome = trackOutcome(
    client.highlightTokensInWorker({
      key,
      text: params.text ?? 'sample',
      language: 'text',
      theme: 'github-dark-default',
      complete: params.complete,
    }),
  )
  await flush()
  return { outcome, request: lastHighlightRequest(worker) }
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  trackedMaps.clear()
  Map.prototype.set = function trackedSet(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) trackedMaps.add(this)
    return originalMapSet.call(this, key, value)
  } as typeof Map.prototype.set
  ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
})

afterEach(() => {
  Map.prototype.set = originalMapSet
  delete (globalThis as { Worker?: unknown }).Worker
  vi.resetModules()
})

describe('shikiWorkerClient 一次性请求的 key 标记释放', () => {
  it('一次性 token 请求成功后不保留 key', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}tokens-success`

    const { outcome, request } = await startTokens(client, worker, key, { complete: true })
    respond(worker, highlightResponse(request))

    const result = await outcome
    expect(result.status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('一次性 token 请求失败后不保留 key', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}tokens-failure`

    const { outcome, request } = await startTokens(client, worker, key, { complete: true })
    respond(worker, { type: 'error', id: request.id, key: request.key, message: 'boom' })

    expect(rejectionMessage(await outcome)).toBe('boom')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('一次性 html 请求成功后不保留 key', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}html-success`

    const outcome = trackOutcome(
      client.highlightHtmlInWorker({ key, text: 'sample', language: 'text', theme: 'github-dark-default' }),
    )
    await flush()
    const request = lastHighlightRequest(worker)
    respond(worker, highlightResponse(request, { html: '<pre>sample</pre>', stable: [], unstable: [] }))

    const result = await outcome
    expect(result.status).toBe('fulfilled')
    if (result.status === 'fulfilled') expect(result.value.html).toBe('<pre>sample</pre>')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('流式请求保留 key，直到调用方 dispose', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}stream`

    const first = await startTokens(client, worker, key)
    respond(worker, highlightResponse(first.request))
    expect((await first.outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([key])

    client.disposeShikiWorkerKey(key)

    expect(worker.requests.some(request => request.type === 'dispose' && request.key === key)).toBe(true)
    expect(retainedProbeKeys()).toEqual([])
  })

  it('同 key 并发时，旧请求先完成不会清掉新请求的标记', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}concurrent-old-finishes-first`

    const older = await startTokens(client, worker, key, { complete: true })
    const newer = await startTokens(client, worker, key, { complete: true })
    expect(newer.request.id).not.toBe(older.request.id)

    respond(worker, highlightResponse(older.request))
    expect(rejectionMessage(await older.outcome)).toBe('superseded')
    // 新请求还没结束，标记必须还在，否则新响应会被误判为 superseded。
    expect(retainedProbeKeys()).toEqual([key])

    respond(worker, highlightResponse(newer.request))
    expect((await newer.outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('新请求先完成后，旧响应仍然判为 superseded 且不复活标记', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}concurrent-new-finishes-first`

    const older = await startTokens(client, worker, key, { complete: true })
    const newer = await startTokens(client, worker, key, { complete: true })

    respond(worker, highlightResponse(newer.request))
    expect((await newer.outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])

    respond(worker, highlightResponse(older.request))
    expect(rejectionMessage(await older.outcome)).toBe('superseded')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('同 key 并发时，旧请求失败不会清掉新请求的标记', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}concurrent-old-fails-first`

    const older = await startTokens(client, worker, key, { complete: true })
    const newer = await startTokens(client, worker, key, { complete: true })

    respond(worker, { type: 'error', id: older.request.id, key: older.request.key, message: 'boom' })
    expect(rejectionMessage(await older.outcome)).toBe('boom')
    expect(retainedProbeKeys()).toEqual([key])

    respond(worker, highlightResponse(newer.request))
    expect((await newer.outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('同 key 后来的旧响应不能抢走流式请求的 latest 标记', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}stream-concurrent`

    const older = await startTokens(client, worker, key, { text: 'sample' })
    const newer = await startTokens(client, worker, key, { text: 'sample sample' })

    respond(worker, highlightResponse(newer.request))
    expect((await newer.outcome).status).toBe('fulfilled')

    respond(worker, highlightResponse(older.request))
    expect(rejectionMessage(await older.outcome)).toBe('superseded')
    expect(retainedProbeKeys()).toEqual([key])
  })

  it('dispose 之后到达的响应仍然判为 superseded', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}dispose-in-flight`

    const pending = await startTokens(client, worker, key, { complete: true })
    client.disposeShikiWorkerKey(key)
    respond(worker, highlightResponse(pending.request))

    expect(rejectionMessage(await pending.outcome)).toBe('superseded')
    expect(retainedProbeKeys()).toEqual([])
  })
})
