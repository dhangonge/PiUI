import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const piFetch = vi.fn()

vi.mock('../pi/httpClient', () => ({
  getApiBase: () => 'http://127.0.0.1:8787',
  piFetch: (...args: unknown[]) => piFetch(...args),
}))

async function loadStore() {
  vi.resetModules()
  return import('./clientErrorLog')
}

function report(store: Awaited<ReturnType<typeof loadStore>>, message = 'boom') {
  return store.recordClientError({ source: 'manual', category: 'ui', operation: 'render', message })
}

describe('clientErrorLog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
    piFetch.mockReset()
    piFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('records entries newest-last and clamps long messages', async () => {
    const store = await loadStore()
    report(store, 'first')
    report(store, 'x'.repeat(2000))

    const entries = store.getClientErrors()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.message).toBe('first')
    expect(entries[1]?.message.length).toBeLessThan(600)
    expect(entries[1]?.message.endsWith('…')).toBe(true)
    expect(entries[1]?.count).toBe(1)
  })

  it('collapses repeats inside the dedupe window and keeps them apart outside it', async () => {
    const store = await loadStore()
    report(store, 'same')
    report(store, 'same')
    expect(store.getClientErrors()).toHaveLength(1)
    expect(store.getClientErrors()[0]?.count).toBe(2)

    vi.advanceTimersByTime(11_000)
    report(store, 'same')
    expect(store.getClientErrors()).toHaveLength(2)
    expect(store.getClientErrors()[1]?.count).toBe(1)
  })

  it('keeps at most MAX_CLIENT_ERRORS entries', async () => {
    const store = await loadStore()
    for (let i = 0; i < store.MAX_CLIENT_ERRORS + 5; i++) {
      vi.advanceTimersByTime(11_000)
      report(store, `error ${i}`)
    }
    const entries = store.getClientErrors()
    expect(entries).toHaveLength(store.MAX_CLIENT_ERRORS)
    expect(entries[0]?.message).toBe('error 5')
  })

  it('survives a reload through localStorage', async () => {
    const first = await loadStore()
    report(first, 'persisted')

    const second = await loadStore()
    expect(second.getClientErrors().map(entry => entry.message)).toEqual(['persisted'])
  })

  it('ignores corrupted storage instead of throwing', async () => {
    localStorage.setItem('piui-client-errors', '{"not":"an array"}')
    const store = await loadStore()
    expect(store.getClientErrors()).toEqual([])
  })

  it('notifies subscribers and clears', async () => {
    const store = await loadStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribeClientErrors(listener)

    report(store)
    expect(listener).toHaveBeenCalledTimes(1)

    store.clearClientErrors()
    expect(store.getClientErrors()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    report(store)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('formats a readable report with the app version header', async () => {
    const store = await loadStore()
    expect(store.formatClientErrorReport()).toBe('')

    report(store, 'render failed')
    const text = store.formatClientErrorReport()
    expect(text).toContain('client error(s)')
    expect(text).toContain('manual ui/render x1')
    expect(text).toContain('render failed')
  })

  it('reports batched errors to the local server', async () => {
    const store = await loadStore()
    report(store, 'boom')

    await store.flushClientErrorForwards()

    expect(piFetch).toHaveBeenCalledTimes(1)
    const [url, init] = piFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8787/api/v1/host/client-log')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body)) as { entries: Array<Record<string, unknown>> }
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({ category: 'ui', operation: 'render', message: 'boom' })
    // URL 只带 origin+pathname，token 不能随 query 泄进日志。
    expect(body.entries[0]?.url).not.toContain('?')
  })

  it('swallows report failures and does not log them back into the error log', async () => {
    const store = await loadStore()
    report(store, 'boom')
    piFetch.mockRejectedValue(new Error('server offline'))

    await expect(store.flushClientErrorForwards()).resolves.toBeUndefined()
    expect(store.getClientErrors()).toHaveLength(1)
  })

  it('stops reporting after the per-session cap', async () => {
    const store = await loadStore()
    for (let i = 0; i < 40; i++) report(store, `error ${i}`)

    await store.flushClientErrorForwards()
    const reported = piFetch.mock.calls.reduce((total, call) => {
      const body = JSON.parse(String((call[1] as RequestInit).body)) as { entries: unknown[] }
      return total + body.entries.length
    }, 0)
    expect(reported).toBe(store.MAX_REPORTED_PER_SESSION)
  })
})
