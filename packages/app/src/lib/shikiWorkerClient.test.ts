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
  /** 让下一次 highlight 的 postMessage 同步抛错（模拟结构化克隆失败） */
  failNextHighlightPost: Error | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: FakeRequest) {
    if (request.type === 'highlight' && this.failNextHighlightPost) {
      const error = this.failNextHighlightPost
      this.failNextHighlightPost = null
      throw error
    }
    this.requests.push(request)
  }

  emitError(error: unknown) {
    this.onerror?.(error)
  }

  terminate() {}
}

const trackedMaps = new Set<Map<unknown, unknown>>()
const trackedNumericMaps = new Set<Map<unknown, unknown>>()

function retainedProbeKeys(): string[] {
  const keys = new Set<string>()
  trackedMaps.forEach(map => {
    map.forEach((_value, key) => {
      if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) keys.add(key)
    })
  })
  return [...keys].sort()
}

/**
 * 客户端只有 pendingRequests 用数字键。请求结算后它必须为空，
 * 否则就是没人认领的 pending 条目（即便 Promise 已经 reject）。
 */
function retainedPendingSizes(): number[] {
  return [...trackedNumericMaps].map(map => map.size)
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
  trackedNumericMaps.clear()
  Map.prototype.set = function trackedSet(this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (typeof key === 'string' && key.startsWith(KEY_PREFIX)) trackedMaps.add(this)
    if (typeof key === 'number') trackedNumericMaps.add(this)
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

  it('一次性 html 请求失败后不保留 key', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}html-failure`

    const outcome = trackOutcome(
      client.highlightHtmlInWorker({ key, text: 'sample', language: 'text', theme: 'github-dark-default' }),
    )
    await flush()
    const request = lastHighlightRequest(worker)
    respond(worker, { type: 'error', id: request.id, key: request.key, message: 'boom' })

    expect(rejectionMessage(await outcome)).toBe('boom')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('Worker onerror 结算所有在飞请求并清掉全部 key 标记', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const streamKey = `${KEY_PREFIX}onerror-stream`
    const oneShotKey = `${KEY_PREFIX}onerror-one-shot`

    const stream = await startTokens(client, worker, streamKey)
    respond(worker, highlightResponse(stream.request))
    expect((await stream.outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([streamKey])

    const pending = await startTokens(client, worker, oneShotKey, { complete: true })
    worker.onerror?.(new Error('worker died'))

    expect(rejectionMessage(await pending.outcome)).toBe('worker died')
    // onerror 后客户端丢弃整个 Worker 实例，worker 侧的 tokenizer 也随之消失，
    // 所有 key 标记都成了死引用（新请求会懒建新 Worker），ref 拿到的 dispose 也已是空转。
    expect(retainedProbeKeys()).toEqual([])
    expect(retainedPendingSizes()).toEqual([0])
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

describe('latest 判定发生在消费方 await 之后', () => {
  it('响应到达后在消费前 dispose，仍判为 superseded', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}dispose-before-consume`

    const pending = await startTokens(client, worker, key, { complete: true })
    // 同一个同步窗口：先让 worker 响应到达，再 dispose，最后才 await 消费。
    respond(worker, highlightResponse(pending.request))
    client.disposeShikiWorkerKey(key)

    expect(rejectionMessage(await pending.outcome)).toBe('superseded')
    expect(retainedProbeKeys()).toEqual([])
  })

  it('响应到达后在消费前启动新请求，旧响应仍判为 superseded 且新标记保留', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}new-request-before-consume`

    const older = await startTokens(client, worker, key, { complete: true, text: 'sample' })
    // 新请求先进入队列（它的 latestRequestByKey.set 排在旧请求的消费回调之前），
    // 旧响应随后到达：旧请求的判定必须看到新请求的标记。
    const newerOutcome = trackOutcome(
      client.highlightTokensInWorker({
        key,
        text: 'sample sample',
        language: 'text',
        theme: 'github-dark-default',
        complete: true,
      }),
    )
    respond(worker, highlightResponse(older.request))

    expect(rejectionMessage(await older.outcome)).toBe('superseded')

    await flush()
    const newerRequest = lastHighlightRequest(worker)
    expect(newerRequest.id).not.toBe(older.request.id)
    expect(retainedProbeKeys()).toEqual([key])

    respond(worker, highlightResponse(newerRequest))
    expect((await newerOutcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])
  })
})

describe('postMessage 同步抛错（请求没进 worker）', () => {
  it('一次性 token 请求 postMessage 抛错后 key 与 pending 都不残留', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}post-throw-one-shot`
    worker.failNextHighlightPost = new Error('clone failed')

    const outcome = trackOutcome(
      client.highlightTokensInWorker({
        key,
        text: 'sample',
        language: 'text',
        theme: 'github-dark-default',
        complete: true,
      }),
    )

    expect(rejectionMessage(await outcome)).toBe('clone failed')
    expect(retainedProbeKeys()).toEqual([])
    expect(retainedPendingSizes()).toEqual([0])
  })

  it('一次性 html 请求 postMessage 抛错后 key 与 pending 都不残留', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}post-throw-html`
    worker.failNextHighlightPost = new Error('clone failed')

    const outcome = trackOutcome(
      client.highlightHtmlInWorker({ key, text: 'sample', language: 'text', theme: 'github-dark-default' }),
    )

    expect(rejectionMessage(await outcome)).toBe('clone failed')
    expect(retainedProbeKeys()).toEqual([])
    expect(retainedPendingSizes()).toEqual([0])
  })

  it('流式请求 postMessage 抛错后不留挂着的 key', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}post-throw-stream`
    worker.failNextHighlightPost = new Error('clone failed')

    const outcome = trackOutcome(
      client.highlightTokensInWorker({ key, text: 'sample', language: 'text', theme: 'github-dark-default' }),
    )

    // 请求从未到达 worker，worker 侧不存在该 key 的 tokenizer，客户端标记也无需保留。
    expect(rejectionMessage(await outcome)).toBe('clone failed')
    expect(retainedProbeKeys()).toEqual([])
    expect(retainedPendingSizes()).toEqual([0])
  })

  it('postMessage 抛错后同一 key 的下一个请求仍能正常完成并清理', async () => {
    const client = await import('./shikiWorkerClient')
    const worker = await boot(client)
    const key = `${KEY_PREFIX}post-throw-recover`
    worker.failNextHighlightPost = new Error('clone failed')
    const failed = trackOutcome(
      client.highlightTokensInWorker({
        key,
        text: 'sample',
        language: 'text',
        theme: 'github-dark-default',
        complete: true,
      }),
    )
    expect(rejectionMessage(await failed)).toBe('clone failed')

    const { outcome, request } = await startTokens(client, worker, key, { complete: true })
    respond(worker, highlightResponse(request))

    expect((await outcome).status).toBe('fulfilled')
    expect(retainedProbeKeys()).toEqual([])
    expect(retainedPendingSizes()).toEqual([0])
  })
})
