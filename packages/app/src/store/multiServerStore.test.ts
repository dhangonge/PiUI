import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { multiServerStore } from './multiServerStore'
import { LayoutStore } from './layoutStore'
import { serverStore, LOCAL_SERVER_ID } from './serverStore'
import { pinnedSessionsStore } from './pinnedSessionsStore'
import { makeSessionKey } from '../utils/sessionKey'
import {
  addServerWorkspace,
  readServerWorkspaces,
  reorderServerWorkspaces,
  SAVED_DIRECTORIES_KEY,
} from '../utils/serverWorkspaces'
import { serverStorage } from '../utils/perServerStorage'
import { linkPiSessionForks } from '../pi/nativeSessionListModel'
import type { UiSession } from '../types/session'

describe('multi-server persisted state', () => {
  let a: string, b: string
  beforeEach(() => {
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
    multiServerStore.setEnabled(false)
    multiServerStore.setSubscribedServerIds([])
    multiServerStore.setFocusedServerId(null)
  })
  afterEach(() => {
    multiServerStore.setEnabled(false)
    multiServerStore.setSubscribedServerIds([])
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
  })

  it('seeds active on enabling, preserves subscriptions on focus changes and filters unknown IDs', () => {
    expect(multiServerStore.getSnapshot().serverIds).toEqual([a])
    multiServerStore.setEnabled(true)
    expect(multiServerStore.getSubscribedServerIds()).toEqual([a])
    multiServerStore.setSubscribedServerIds([a, b, b, 'absent'])
    const revision = multiServerStore.getSnapshot().connectionRevision
    serverStore.setActiveServer(b)
    expect(multiServerStore.getSnapshot().serverIds).toEqual([a, b])
    expect(multiServerStore.getSnapshot().connectionRevision).toBe(revision)
    multiServerStore.setEnabled(false)
    expect(multiServerStore.getSnapshot().serverIds).toEqual([b])
    expect(multiServerStore.getSubscribedServerIds()).toEqual([a, b])
  })

  it('invalidates configuration changes but not names, and drops deleted focused servers', () => {
    multiServerStore.setEnabled(true)
    multiServerStore.setSubscribed(b, true)
    multiServerStore.setFocusedServerId(b)
    const revision = multiServerStore.getSnapshot().connectionRevision
    serverStore.updateServer(b, { name: 'renamed' })
    expect(multiServerStore.getSnapshot().connectionRevision).toBe(revision)
    serverStore.updateServer(b, { url: 'https://new.example.test' })
    expect(multiServerStore.getSnapshot().connectionRevision).not.toBe(revision)
    serverStore.removeServer(b)
    expect(multiServerStore.getSnapshot().focusedServerId).toBeNull()
    expect(multiServerStore.getSubscribedServerIds()).toEqual([a])
    expect(multiServerStore.getSnapshot()).toBe(multiServerStore.getSnapshot())
  })

  it('pins, renames and unpins equal IDs in their owning server shards', () => {
    const ka = makeSessionKey(a, 'same'),
      kb = makeSessionKey(b, 'same')
    pinnedSessionsStore.pin({ sessionId: ka, directory: '/same', title: 'A' })
    pinnedSessionsStore.pin({ sessionId: kb, directory: '/same', title: 'B' })
    pinnedSessionsStore.update(kb, { title: 'updated B' })
    pinnedSessionsStore.unpin(ka)
    expect(pinnedSessionsStore.isPinned(ka)).toBe(false)
    expect(pinnedSessionsStore.isPinned(kb)).toBe(true)
    expect(serverStorage.getJSONFor('piui-pinned-sessions', b)).toEqual([
      { sessionId: 'same', directory: '/same', title: 'updated B' },
    ])
    expect(pinnedSessionsStore.getScopedSnapshot().find(entry => entry.sessionId === kb)?.title).toBe('updated B')
    expect(serverStore.getActiveServerId()).toBe(a)
  })

  it('keeps workspace roots, ignores malformed saved entries and reorders only the requested server', () => {
    serverStorage.setJSONFor(SAVED_DIRECTORIES_KEY, [null, 1, { path: false }], b)
    expect(addServerWorkspace(b, '/')).toBe(true)
    expect(addServerWorkspace(b, 'C:\\')).toBe(true)
    expect(addServerWorkspace(b, '/')).toBe(false)
    addServerWorkspace(a, '/other')
    reorderServerWorkspaces(b, 'C:/', '/')
    expect(readServerWorkspaces(b)).toEqual(['C:/', '/'])
    expect(readServerWorkspaces(a)).toEqual(['/other'])
  })

  it('isolates terminal snapshots for identical paths and IDs, including endpoint replacement', () => {
    const store = new LayoutStore()
    const terminals = [
      { id: 'term', title: 'sh', shell: 'sh', cwd: '/same', status: 'running' as const, pid: 1, cursor: 0 },
    ]
    const ka = makeSessionKey(a, 'term'),
      kb = makeSessionKey(b, 'term')
    store.syncTerminalSessions('/same', terminals, a)
    store.updateTerminalSnapshot(ka, { buffer: 'only A', cursor: 11 })
    store.syncTerminalSessions('/same', terminals, b)
    expect(store.getState().panelTabs.find(tab => tab.id === kb)?.buffer).toBeUndefined()
    store.updateTerminalSnapshot(kb, { buffer: 'only B', cursor: 22 })
    store.syncTerminalSessions('/same', terminals, a)
    expect(store.getState().panelTabs.find(tab => tab.id === ka)?.buffer).toBe('only A')
    serverStore.updateServer(a, { url: 'https://replacement.example.test' })
    store.syncTerminalSessions('/same', terminals, a)
    expect(store.getState().panelTabs.find(tab => tab.id === ka)?.buffer).toBeUndefined()
  })

  it('links fork parents only within a server even if both use the same session-file paths', () => {
    const parent = (id: string): UiSession => ({
      id,
      title: id,
      path: '/sessions/parent.jsonl',
      directory: '/same',
      createdAt: 0,
      updatedAt: 0,
    })
    const child = (id: string): UiSession => ({
      ...parent(id),
      path: '/sessions/child.jsonl',
      parentSessionPath: '/sessions/parent.jsonl',
    })
    const result = linkPiSessionForks([
      parent(makeSessionKey(a, 'parent')),
      parent(makeSessionKey(b, 'parent')),
      child(makeSessionKey(a, 'child')),
      child(makeSessionKey(b, 'child')),
    ])
    expect(result[2].forkParentId).toBe(makeSessionKey(a, 'parent'))
    expect(result[3].forkParentId).toBe(makeSessionKey(b, 'parent'))
  })
})
