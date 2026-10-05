import { describe, expect, it, vi } from 'vitest'
import {
  isScopedSessionKey,
  makeSessionKey,
  resolveSessionTarget,
  sessionKeyToServerId,
  sessionKeyToSessionId,
  splitSessionKey,
} from './sessionKey'

const active = vi.hoisted(() => ({ id: 'active' }))
vi.mock('../store/serverStore', () => ({ serverStore: { getActiveServerId: () => active.id, subscribe: vi.fn(() => () => undefined) } }))

describe('server-scoped session keys', () => {
  it('distinguishes identical session IDs on different servers', () => {
    const a = makeSessionKey('a', 'same')
    const b = makeSessionKey('b', 'same')
    expect(a).not.toBe(b)
    expect(splitSessionKey(a)).toEqual({ serverId: 'a', sessionId: 'same' })
    expect(sessionKeyToServerId(b)).toBe('b')
    expect(sessionKeyToSessionId(b)).toBe('same')
  })

  it('resolves legacy keys using the active server at call time', () => {
    active.id = 'a'
    expect(splitSessionKey('legacy')).toEqual({ serverId: 'a', sessionId: 'legacy' })
    active.id = 'b'
    expect(splitSessionKey('legacy')).toEqual({ serverId: 'b', sessionId: 'legacy' })
    expect(splitSessionKey('a::same').serverId).toBe('a')
    expect(isScopedSessionKey('legacy')).toBe(false)
    expect(isScopedSessionKey('a::same')).toBe(true)
  })

  it('splits only the first separator without altering the session ID', () => {
    expect(splitSessionKey(makeSessionKey('a', 'path::with::separators'))).toEqual({
      serverId: 'a',
      sessionId: 'path::with::separators',
    })
  })

  it('lets an explicit server override the key prefix without forwarding that prefix', () => {
    expect(resolveSessionTarget('a::same', 'b')).toEqual({ serverId: 'b', sessionId: 'same' })
    expect(resolveSessionTarget('same', 'b')).toEqual({ serverId: 'b', sessionId: 'same' })
  })
})
