import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useGitWorkspaceCatalog } from './useGitWorkspaceCatalog'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

const getCurrentProjectMock = vi.fn()
const listWorktreesMock = vi.fn()
const subscribeToConnectionStateMock = vi.fn()
const onServerChangeMock = vi.fn()
let latestServerChange: (() => void) | undefined
let activeServerId = 'a'
const serverListeners = new Set<() => void>()

vi.mock('../api', () => ({
  getCurrentProject: (...args: unknown[]) => getCurrentProjectMock(...args),
  listWorktrees: (...args: unknown[]) => listWorktreesMock(...args),
}))

vi.mock('../api/events', () => ({
  subscribeToConnectionState: (...args: unknown[]) => subscribeToConnectionStateMock(...args),
}))

vi.mock('../store/serverStore', () => ({
  serverStore: {
    getActiveServerId: () => activeServerId,
    subscribe: (listener: () => void) => {
      serverListeners.add(listener)
      return () => serverListeners.delete(listener)
    },
    onServerChange: (...args: unknown[]) => onServerChangeMock(...args),
  },
}))

describe('useGitWorkspaceCatalog', () => {
  beforeEach(() => {
    activeServerId = 'a'
    serverListeners.clear()
    getCurrentProjectMock.mockReset()
    listWorktreesMock.mockReset()
    subscribeToConnectionStateMock.mockReset()
    onServerChangeMock.mockReset()
    latestServerChange = undefined

    subscribeToConnectionStateMock.mockReturnValue(vi.fn())
    onServerChangeMock.mockImplementation(listener => {
      latestServerChange = listener as () => void
      return vi.fn()
    })
    listWorktreesMock.mockResolvedValue(['C:/repo', 'C:/repo-worktree'])
  })

  it('never opens the previous server directories on the next server', async () => {
    getCurrentProjectMock.mockImplementation(async (directory: string) => ({ path: directory }))
    const { result, rerender } = renderHook(({ dirs }) => useGitWorkspaceCatalog(dirs), {
      initialProps: { dirs: ['/a'] },
    })
    await waitFor(() => expect(result.current.catalog.has('/a')).toBe(true))
    act(() => {
      activeServerId = 'b'
      latestServerChange?.()
      serverListeners.forEach(listener => listener())
      rerender({ dirs: ['/b'] })
    })
    await waitFor(() => expect(result.current.catalog.has('/b')).toBe(true))
    expect(getCurrentProjectMock).toHaveBeenCalledWith('/a', 'a')
    expect(getCurrentProjectMock).toHaveBeenCalledWith('/b', 'b')
    expect(getCurrentProjectMock).not.toHaveBeenCalledWith('/a', 'b')
    expect(result.current.catalog.has('/a')).toBe(false)
  })

  it('refetches workspace metadata on server endpoint changes while stale requests are in flight', async () => {
    const staleRequest = createDeferred<{ vcs: string; worktree: string }>()
    const freshRequest = createDeferred<{ vcs: string; worktree: string }>()

    getCurrentProjectMock
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise)

    const directories = ['C:\\repo']
    const { result } = renderHook(() => useGitWorkspaceCatalog(directories))

    await waitFor(() => expect(getCurrentProjectMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      latestServerChange?.()
      await Promise.resolve()
    })

    expect(getCurrentProjectMock).toHaveBeenCalledTimes(2)

    await act(async () => {
      freshRequest.resolve({ vcs: 'git', worktree: 'C:/repo' })
      await Promise.resolve()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo'])
    })

    await act(async () => {
      staleRequest.resolve({ vcs: 'git', worktree: 'C:/stale' })
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(result.current.catalog.get('C:/repo')?.rootDirectory).toBe('C:/repo')
    expect(result.current.catalog.get('C:/repo')?.workspaces).toEqual(['C:/repo'])
  })
})
