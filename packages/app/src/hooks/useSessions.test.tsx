import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessions } from './useSessions'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any
const { loadPiSessionsMock, loadPiSessionsForCwdMock, openPiSessionMock, deletePiSessionMock } = vi.hoisted(() => ({
  loadPiSessionsMock: vi.fn<AnyFn>(),
  loadPiSessionsForCwdMock: vi.fn<AnyFn>(),
  openPiSessionMock: vi.fn<AnyFn>(),
  deletePiSessionMock: vi.fn<AnyFn>(),
}))

vi.mock('../pi/controllers/index.js', () => ({
  loadPiSessions: (...args: unknown[]) => loadPiSessionsMock(...args),
  loadPiSessionsForCwd: (...args: unknown[]) => loadPiSessionsForCwdMock(...args),
  openPiSession: (...args: unknown[]) => openPiSessionMock(...args),
  deletePiSession: (...args: unknown[]) => deletePiSessionMock(...args),
}))

vi.mock('../pi/piSessionIndex', () => ({
  trackPiSession: vi.fn(),
}))

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function makeSession(id: string, directory = '/workspace/demo') {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: directory,
    name: `Session ${id}`,
    created: '2026-07-28T10:00:00.000Z',
    modified: '2026-07-29T10:00:00.000Z',
    messageCount: 1,
    firstMessage: `Message ${id}`,
  }
}

describe('useSessions', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    loadPiSessionsMock.mockReset()
    loadPiSessionsForCwdMock.mockReset()
    openPiSessionMock.mockReset()
    deletePiSessionMock.mockReset()
    loadPiSessionsMock.mockResolvedValue([])
    loadPiSessionsForCwdMock.mockResolvedValue([])
    openPiSessionMock.mockResolvedValue({
      sessionId: 'new',
      sessionFile: '/sessions/new.jsonl',
      cwd: '/workspace/demo',
    })
    deletePiSessionMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('waits for enabled before fetching', async () => {
    const { rerender } = renderHook(({ enabled }) => useSessions({ directory: '/workspace/demo', enabled }), {
      initialProps: { enabled: false },
    })

    expect(loadPiSessionsForCwdMock).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledWith('/workspace/demo', undefined, undefined, undefined)
  })

  it('passes the scoped directory when removing a session', async () => {
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(result.current.sessions).toHaveLength(1)

    await act(async () => {
      await result.current.remove('session-1')
    })

    expect(deletePiSessionMock).toHaveBeenCalledWith(
      '/workspace/demo',
      '/sessions/session-1.jsonl',
      undefined,
      undefined,
    )
  })

  it('requests sessions with the scoped cwd', async () => {
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledWith('/workspace/demo', undefined, undefined, undefined)
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('refreshes sessions from Pi events', async () => {
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('session-1')])
    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
  })

  it('queues a reconnect refresh while a newer request is still in flight', async () => {
    const firstRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const secondRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const thirdRequest = createDeferred<ReturnType<typeof makeSession>[]>()

    loadPiSessionsForCwdMock
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise)
      .mockImplementationOnce(() => thirdRequest.promise)

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    act(() => {
      result.current.setSearch('branch')
    })

    await act(async () => {
      vi.advanceTimersByTime(300)
      await Promise.resolve()
    })

    await act(async () => {
      firstRequest.resolve([makeSession('session-1')])
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      secondRequest.resolve([makeSession('session-2')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(3)

    await act(async () => {
      thirdRequest.resolve([{ ...makeSession('session-3'), name: 'Branch session' }])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['session-3'])
  })

  it('retries the initial fetch after a startup failure', async () => {
    loadPiSessionsForCwdMock
      .mockRejectedValueOnce(new Error('service not ready'))
      .mockResolvedValueOnce([makeSession('session-1')])

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(2)
    expect(result.current.sessions.map(session => session.id)).toEqual(['session-1'])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('refetches on Pi session changes even while the old request is in flight', async () => {
    const staleRequest = createDeferred<ReturnType<typeof makeSession>[]>()
    const freshRequest = createDeferred<ReturnType<typeof makeSession>[]>()

    loadPiSessionsForCwdMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      staleRequest.resolve([makeSession('stale')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve([makeSession('fresh')])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
  })

  it('keeps loading through all backoffs and exposes an error only after four attempts', async () => {
    const failure = new Error('service not ready')
    loadPiSessionsForCwdMock.mockRejectedValue(failure)
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))

    for (const [index, ms] of [0, 500, 1500].entries()) {
      await advance(ms)
      expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(index + 1)
      expect(result.current.isLoading).toBe(true)
      expect(result.current.error).toBeNull()
    }
    await advance(3000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(4)
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBe(failure)
    expect(result.current.sessions).toEqual([])
    await advance(10000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(4)

    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('recovered')])
    await act(async () => {
      await result.current.refresh()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.sessions.map(session => session.id)).toEqual(['recovered'])
  })

  it('preserves the existing list throughout failed silent refreshes', async () => {
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('existing')])
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))
    await advance(0)

    loadPiSessionsForCwdMock.mockRejectedValue(new Error('offline'))
    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    })
    for (const ms of [0, 500, 1500, 3000]) {
      await advance(ms)
      expect(result.current.isLoading).toBe(false)
      expect(result.current.sessions.map(session => session.id)).toEqual(['existing'])
    }
    expect(result.current.error?.message).toBe('offline')
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('updated')])
    await act(async () => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    })
    expect(result.current.error).toBeNull()
    expect(result.current.sessions.map(session => session.id)).toEqual(['updated'])
  })

  it('does not retry failed pagination or discard loaded sessions', async () => {
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('first'), makeSession('second')])
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo', pageSize: 1 }))
    await advance(0)
    expect(result.current.hasMore).toBe(true)

    loadPiSessionsForCwdMock.mockRejectedValue(new Error('page failed'))
    await act(async () => {
      await result.current.loadMore()
    })
    await advance(10000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(2)
    expect(result.current.isLoadingMore).toBe(false)
    expect(result.current.sessions).toHaveLength(1)
    expect(result.current.hasMore).toBe(true)
    expect(result.current.error?.message).toBe('page failed')
  })

  it('cancels retry timers and queued event refreshes on unmount', async () => {
    loadPiSessionsForCwdMock.mockRejectedValue(new Error('offline'))
    const { unmount } = renderHook(() => useSessions({ directory: '/workspace/demo' }))
    await advance(0)
    act(() => {
      window.dispatchEvent(new CustomEvent('piui:sessions-changed'))
    })
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(10000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)
  })

  it('cancels backoff on disable and starts a fresh request on re-enable', async () => {
    loadPiSessionsForCwdMock.mockRejectedValue(new Error('offline'))
    const { result, rerender } = renderHook(({ enabled }) => useSessions({ directory: '/workspace/demo', enabled }), {
      initialProps: { enabled: true },
    })
    await advance(0)
    rerender({ enabled: false })
    expect(result.current.isLoading).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await advance(10000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()

    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('fresh')])
    rerender({ enabled: true })
    await advance(0)
    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
  })

  it('ignores an in-flight response after disable', async () => {
    const pending = createDeferred<ReturnType<typeof makeSession>[]>()
    loadPiSessionsForCwdMock.mockReturnValue(pending.promise)
    const { result, rerender } = renderHook(({ enabled }) => useSessions({ directory: '/workspace/demo', enabled }), {
      initialProps: { enabled: true },
    })
    await advance(0)
    rerender({ enabled: false })
    await act(async () => {
      pending.resolve([makeSession('stale')])
    })
    expect(result.current.sessions).toEqual([])
    expect(result.current.isLoading).toBe(false)
  })

  it('invalidates old results as soon as search changes, before the debounce fires', async () => {
    const pending = createDeferred<ReturnType<typeof makeSession>[]>()
    loadPiSessionsForCwdMock.mockReturnValueOnce(pending.promise)
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))
    await advance(0)
    act(() => {
      result.current.setSearch('fresh')
    })
    await act(async () => {
      pending.resolve([makeSession('stale')])
    })
    expect(result.current.sessions).toEqual([])
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(1)

    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('fresh'), makeSession('unmatched')])
    await advance(300)
    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
  })

  it('cancels old retries when the directory changes', async () => {
    loadPiSessionsForCwdMock.mockRejectedValue(new Error('old directory offline'))
    const { result, rerender } = renderHook(({ directory }) => useSessions({ directory }), {
      initialProps: { directory: '/workspace/old' },
    })
    await advance(0)
    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('fresh', '/workspace/new')])
    rerender({ directory: '/workspace/new' })
    await advance(0)
    await advance(10000)
    expect(loadPiSessionsForCwdMock.mock.calls).toEqual([
      ['/workspace/old', undefined, undefined, undefined],
      ['/workspace/new', undefined, undefined, undefined],
    ])
    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
    expect(result.current.error).toBeNull()
  })

  it('settles a cancelled refresh without retrying or overwriting a newer result', async () => {
    const { result } = renderHook(() => useSessions({ directory: '/workspace/demo' }))
    await advance(0)
    loadPiSessionsForCwdMock.mockRejectedValue(new Error('offline'))
    let oldRefresh!: Promise<void>
    await act(async () => {
      oldRefresh = result.current.refresh()
    })
    expect(result.current.isLoading).toBe(true)

    loadPiSessionsForCwdMock.mockResolvedValue([makeSession('fresh')])
    await act(async () => {
      await result.current.refresh()
      await oldRefresh
    })
    expect(vi.getTimerCount()).toBe(0)
    await advance(10000)
    expect(loadPiSessionsForCwdMock).toHaveBeenCalledTimes(3)
    expect(result.current.sessions.map(session => session.id)).toEqual(['fresh'])
    expect(result.current.error).toBeNull()
  })
})
