import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import {
  abortInFlightPiRequests,
  abortUnboundPiRequests,
  createPiHttpClient,
  getApiBase,
  getPiAuthToken,
  piFetch,
} from './httpClient'

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>(), load: vi.fn(), native: true }))
vi.mock('../utils/tauri', () => ({
  isTauri: () => transport.native,
  getHttpFetch: () => transport.load(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function response() {
  return new Response('{}', { status: 200 })
}
function requestHeaders(index: number) {
  return new Headers(transport.fetch.mock.calls[index]?.[1]?.headers)
}

describe('server-bound Pi HTTP clients', () => {
  let a: string
  let b: string

  beforeEach(() => {
    transport.native = true
    transport.fetch.mockReset().mockImplementation(async () => response())
    transport.load.mockReset().mockResolvedValue(transport.fetch)
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test', token: 'test-a' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test', token: 'test-b' }).id
    serverStore.setActiveServer(a)
  })

  afterEach(() => {
    abortInFlightPiRequests()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('pins concurrent requests and credentials while the native bridge loads', async () => {
    const bridge = deferred<typeof fetch>()
    transport.load.mockReturnValue(bridge.promise)
    const clientA = createPiHttpClient(a)
    const clientB = createPiHttpClient(b)
    const first = clientA.fetch('/api/v1/host/health')
    const second = clientB.fetch('/api/v1/host/health')
    serverStore.setActiveServer(b)
    abortUnboundPiRequests()
    bridge.resolve(transport.fetch)
    await Promise.all([first, second])
    expect(transport.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://a.example.test/api/v1/host/health',
      'https://b.example.test/api/v1/host/health',
    ])
    expect(requestHeaders(0).get('authorization')).toBe('Bearer test-a')
    expect(requestHeaders(1).get('authorization')).toBe('Bearer test-b')
    expect(serverStore.getActiveServerId()).toBe(b)
  })

  it('bypasses browser build-time endpoints for explicitly selected servers', async () => {
    transport.native = false
    vi.stubEnv('VITE_PIUI_API', 'https://build.example.test')
    const client = createPiHttpClient(b)
    expect(getApiBase()).toBe('https://build.example.test')
    expect(client.getBaseUrl()).toBe('https://b.example.test')
    expect(client.getAuthToken()).toBe('test-b')
    await client.fetch('/api/v1/host/health')
    expect(transport.fetch.mock.calls[0][0]).toBe('https://b.example.test/api/v1/host/health')
  })

  it('does not give an unauthenticated remote server the build-time or active token', async () => {
    vi.stubEnv('VITE_PIUI_TOKEN', 'test-build')
    serverStore.updateServer(b, { token: '' })
    expect(getPiAuthToken(b)).toBe('')
    await createPiHttpClient(b).fetch('/api/v1/host/health')
    expect(requestHeaders(0).has('authorization')).toBe(false)
    serverStore.setActiveServer(b)
    expect(getPiAuthToken()).toBeUndefined()
  })

  it('cancels only the requested server and rejects late native responses', async () => {
    const result = deferred<Response>()
    transport.fetch.mockReturnValue(result.promise)
    const first = createPiHttpClient(a).fetch('/api/v1/host/health')
    const second = createPiHttpClient(b).fetch('/api/v1/host/health')
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    abortInFlightPiRequests(a)
    result.resolve(response())
    await rejected
    expect((await second).ok).toBe(true)
    expect(transport.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(transport.fetch.mock.calls[1][1]?.signal?.aborted).toBe(false)
  })

  it('cancels unbound requests on a server switch before the bridge loads', async () => {
    const bridge = deferred<typeof fetch>()
    transport.load.mockReturnValue(bridge.promise)
    const first = piFetch(`${getApiBase()}/api/v1/host/health`)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    serverStore.setActiveServer(b)
    bridge.resolve(transport.fetch)
    await rejected
    expect(transport.fetch).not.toHaveBeenCalled()
  })

  it('keeps bound requests alive when the active bootstrap is reset', async () => {
    const bridge = deferred<typeof fetch>()
    transport.load.mockReturnValue(bridge.promise)
    const first = piFetch(`${getApiBase()}/api/v1/host/health`)
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = createPiHttpClient(a).fetch('/api/v1/host/health')
    abortUnboundPiRequests()
    bridge.resolve(transport.fetch)
    await rejected
    expect((await second).ok).toBe(true)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })

  it.each([{ token: 'test-new' }, { url: 'https://new.example.test' }])(
    'cancels inactive requests on endpoint changes: %j',
    async update => {
      const bridge = deferred<typeof fetch>()
      transport.load.mockReturnValue(bridge.promise)
      const client = createPiHttpClient(b)
      const request = client.fetch('/api/v1/host/health')
      const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
      serverStore.updateServer(b, update)
      bridge.resolve(transport.fetch)
      await rejected
      expect(transport.fetch).not.toHaveBeenCalled()
      await client.fetch('/api/v1/host/health')
      expect(client.getBaseUrl()).toBe(update.url ?? 'https://b.example.test')
      expect(requestHeaders(0).get('authorization')).toBe(`Bearer ${update.token ?? 'test-b'}`)
    },
  )

  it('does not cancel requests for a display-name change', async () => {
    const bridge = deferred<typeof fetch>()
    transport.load.mockReturnValue(bridge.promise)
    const request = createPiHttpClient(b).fetch('/api/v1/host/health')
    serverStore.updateServer(b, { name: 'Renamed' })
    bridge.resolve(transport.fetch)
    expect((await request).ok).toBe(true)
  })

  it('fails closed for removed or unknown servers rather than falling back to active', async () => {
    const bridge = deferred<typeof fetch>()
    transport.load.mockReturnValue(bridge.promise)
    const client = createPiHttpClient(b)
    const request = client.fetch('/api/v1/host/health')
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    serverStore.removeServer(b)
    bridge.resolve(transport.fetch)
    await rejected
    expect(() => client.getBaseUrl()).toThrow('Unknown PiUI server')
    expect(() => createPiHttpClient('missing')).toThrow('Unknown PiUI server')
    expect(transport.fetch).not.toHaveBeenCalled()
  })

  it.each(['https://wrong.example.test/api', '//wrong.example.test/api', 'api/health'])(
    'rejects a non-API path: %s',
    async path => {
      await expect(createPiHttpClient(a).fetch(path)).rejects.toThrow('absolute API path')
      expect(transport.fetch).not.toHaveBeenCalled()
    },
  )

  it('honors an already aborted caller signal without loading the bridge', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createPiHttpClient(a).fetch('/api/v1/host/health', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.load).not.toHaveBeenCalled()
  })

  it('retries reads after a network failure', async () => {
    vi.useFakeTimers()
    transport.fetch.mockRejectedValueOnce(new TypeError('network failed'))
    const request = createPiHttpClient(a).fetch('/api/v1/host/health')
    await vi.advanceTimersByTimeAsync(300)
    expect((await request).ok).toBe(true)
    expect(transport.fetch).toHaveBeenCalledTimes(2)
  })

  it('cancels retry waits without making another request', async () => {
    vi.useFakeTimers()
    transport.fetch.mockRejectedValue(new TypeError('network failed'))
    const request = createPiHttpClient(a).fetch('/api/v1/host/health')
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    abortInFlightPiRequests(a)
    await rejected
    await vi.advanceTimersByTimeAsync(2_000)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })

  it('never replays commands after a connection reset', async () => {
    transport.fetch.mockRejectedValue(new TypeError('network connection reset'))
    await expect(
      createPiHttpClient(a).fetch('/api/v1/pi/commands/session.open', { method: 'POST', body: '{}' }),
    ).rejects.toThrow('network connection reset')
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })

  it('does not retry HTTP error responses', async () => {
    transport.fetch.mockResolvedValue(new Response('{}', { status: 503 }))
    expect((await createPiHttpClient(a).fetch('/api/v1/host/health')).status).toBe(503)
    expect(transport.fetch).toHaveBeenCalledTimes(1)
  })
})
