import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRouter } from './useRouter'
import { serverStore, LOCAL_SERVER_ID } from '../store/serverStore'
import { serverStorage } from '../utils/perServerStorage'
import { makeSessionKey } from '../utils/sessionKey'
import { STORAGE_KEY_LAST_DIRECTORY } from '../constants/storage'

vi.mock('./useIsMobile', () => ({ useIsMobile: () => true }))

describe('server-qualified routes', () => {
  let a: string, b: string
  beforeEach(() => {
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
    serverStorage.setFor(STORAGE_KEY_LAST_DIRECTORY, '/a', a)
    serverStorage.setFor(STORAGE_KEY_LAST_DIRECTORY, '/b', b)
    window.history.replaceState(null, '', '#/?dir=%2Fa')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
  afterEach(() => {
    cleanup()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
    window.history.replaceState(null, '', '#/')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })

  it('changes the owner and uses its directory instead of the previous server directory', () => {
    const { result } = renderHook(() => useRouter())
    const key = makeSessionKey(b, 'raw/session')
    act(() => result.current.navigateToSession(key))
    expect(serverStore.getActiveServerId()).toBe(b)
    expect(result.current.directory).toBe('/b')
    expect(result.current.sessionId).toBe(key)
    expect(window.location.hash).toContain(encodeURIComponent(key))
    act(() => result.current.replaceSession(makeSessionKey(a, 'same')))
    expect(result.current.directory).toBe('/a')
    expect(serverStore.getActiveServerId()).toBe(a)
  })

  it('accepts legacy raw hashes and reloads qualified hashes', () => {
    const { result } = renderHook(() => useRouter())
    act(() => {
      window.history.replaceState(null, '', '#/session/legacy')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(result.current.sessionId).toBe(makeSessionKey(a, 'legacy'))
    act(() => {
      window.history.replaceState(null, '', `#/session/${encodeURIComponent(makeSessionKey(b, 'legacy'))}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(result.current.directory).toBe('/b')
    expect(serverStore.getActiveServerId()).toBe(b)
  })
})
