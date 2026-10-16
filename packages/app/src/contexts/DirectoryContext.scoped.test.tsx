import { act, cleanup, renderHook } from '@testing-library/react'
import { useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryProvider } from './DirectoryContext'
import { DirectoryContext } from './DirectoryContext.shared'
import { serverStore, LOCAL_SERVER_ID } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'

const route = vi.hoisted(() => ({
  directory: undefined as string | undefined,
  serverId: undefined as string | undefined,
  setDirectory: vi.fn(),
}))
vi.mock('../hooks/useRouter', () => ({ useRouter: () => route }))
vi.mock('../utils/tauri', () => ({ isTauri: () => false, isTauriMobile: () => false }))

describe('DirectoryProvider server isolation', () => {
  let a: string, b: string
  beforeEach(() => {
    route.directory = undefined
    route.serverId = undefined
    route.setDirectory.mockClear()
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
  })
  afterEach(() => {
    cleanup()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
  })

  it('loads the new shard without copying prior folders or recents into it', () => {
    const { result } = renderHook(() => useContext(DirectoryContext), { wrapper: DirectoryProvider })
    act(() => result.current!.addDirectory('/a'))
    const before = serverStorage.getJSONFor('piui-saved-directories', a)
    act(() => serverStore.setActiveServer(b))
    expect(result.current!.savedDirectories).toEqual([])
    expect(result.current!.recentProjects).toEqual({})
    act(() => result.current!.addDirectory('/b'))
    expect(serverStorage.getJSONFor('piui-saved-directories', a)).toEqual(before)
    act(() => serverStore.setActiveServer(a))
    expect(result.current!.savedDirectories.map(entry => entry.path)).toEqual(['/a'])
  })

  it('remembers a foreign session project only on its owner before navigation', () => {
    const { result } = renderHook(() => useContext(DirectoryContext), { wrapper: DirectoryProvider })
    act(() => result.current!.addDirectory('/b-project', b))
    expect(serverStorage.getJSONFor('piui-saved-directories', a)).toBeNull()
    expect(result.current!.savedDirectories).toEqual([])
    expect(route.setDirectory).not.toHaveBeenCalled()
    act(() => serverStore.setActiveServer(b))
    expect(result.current!.savedDirectories.map(entry => entry.path)).toEqual(['/b-project'])
  })

  it('does not expose the previous owner route while a server switch is synchronizing', () => {
    route.directory = '/a-project'
    route.serverId = a
    const { result } = renderHook(() => useContext(DirectoryContext), { wrapper: DirectoryProvider })
    expect(result.current!.currentDirectory).toBe('/a-project')
    act(() => serverStore.setActiveServer(b))
    expect(result.current!.currentDirectory).toBeUndefined()
    expect(serverStorage.getJSONFor('piui-saved-directories', b)).toBeNull()
  })

  it('keeps delayed callbacks bound to their original shard', () => {
    const { result } = renderHook(() => useContext(DirectoryContext), { wrapper: DirectoryProvider })
    const addToA = result.current!.addDirectory
    act(() => serverStore.setActiveServer(b))
    act(() => addToA('/a-late'))
    expect(serverStorage.getJSONFor('piui-saved-directories', b)).toBeNull()
    expect(result.current!.savedDirectories).toEqual([])
    act(() => serverStore.setActiveServer(a))
    expect(result.current!.savedDirectories.map(entry => entry.path)).toEqual(['/a-late'])
  })
})
