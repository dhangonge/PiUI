import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  exportPerServerStorageBackup,
  getStorageVersion,
  importPerServerStorageBackup,
  serverStorage,
  subscribePerServerStorageVersion,
} from './perServerStorage'

const activeServer = vi.hoisted(() => ({ id: 'a' }))
vi.mock('../store/serverStore', () => ({
  serverStore: { getActiveServerId: () => activeServer.id },
}))

describe('perServerStorage', () => {
  beforeEach(() => {
    localStorage.clear()
    activeServer.id = 'a'
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('isolates explicit servers without switching the active server', () => {
    serverStorage.set('directory', '/a')
    serverStorage.setFor('directory', '/b', 'b')
    expect(localStorage.getItem('srv:a:directory')).toBe('/a')
    expect(serverStorage.get('directory')).toBe('/a')
    expect(serverStorage.getFor('directory', 'b')).toBe('/b')
    activeServer.id = 'b'
    expect(serverStorage.get('directory')).toBe('/b')
    serverStorage.removeFor('directory', 'a')
    expect(serverStorage.getFor('directory', 'a')).toBeNull()
    expect(serverStorage.get('directory')).toBe('/b')
    serverStorage.remove('directory')
    expect(serverStorage.get('directory')).toBeNull()
  })

  it('round-trips JSON and ignores malformed or absent values', () => {
    serverStorage.setJSONFor('projects', ['/b'], 'b')
    serverStorage.setJSON('projects', ['/a'])
    expect(serverStorage.getJSONFor('projects', 'b')).toEqual(['/b'])
    expect(serverStorage.getJSON('projects')).toEqual(['/a'])
    serverStorage.setFor('projects', '{invalid', 'b')
    expect(serverStorage.getJSONFor('projects', 'b')).toBeNull()
    expect(serverStorage.getJSON('missing')).toBeNull()
  })

  it('notifies subscribers on writes and removals, not reads', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePerServerStorageVersion(listener)
    try {
      const initial = getStorageVersion()
      serverStorage.set('key', 'a')
      serverStorage.setFor('key', 'b', 'b')
      serverStorage.get('key')
      serverStorage.getFor('key', 'b')
      serverStorage.remove('key')
      serverStorage.removeFor('key', 'b')
      expect(getStorageVersion()).toBe(initial + 4)
      expect(listener).toHaveBeenCalledTimes(4)
      unsubscribe()
      serverStorage.set('key', 'new')
      expect(listener).toHaveBeenCalledTimes(4)
    } finally {
      unsubscribe()
    }
  })

  it('tolerates denied storage and does not notify for a failed write', () => {
    const initial = getStorageVersion()
    const fail = () => {
      throw new Error('storage denied')
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(fail)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(fail)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(fail)
    expect(serverStorage.get('key')).toBeNull()
    expect(serverStorage.getFor('key', 'b')).toBeNull()
    expect(() => serverStorage.set('key', 'a')).not.toThrow()
    expect(() => serverStorage.setFor('key', 'b', 'b')).not.toThrow()
    expect(() => serverStorage.remove('key')).not.toThrow()
    expect(() => serverStorage.removeFor('key', 'b')).not.toThrow()
    expect(getStorageVersion()).toBe(initial)
  })

  it('exports actual runtime keys and keeps legacy backup entries', () => {
    serverStorage.set('piui-last-directory', '/a')
    serverStorage.setFor('piui-last-directory', '/b', 'b')
    localStorage.setItem('piui-srv:local:last-directory', '/legacy')
    localStorage.setItem('unrelated', 'keep')
    expect(exportPerServerStorageBackup()).toEqual({
      entries: {
        'srv:a:piui-last-directory': '/a',
        'srv:b:piui-last-directory': '/b',
        'piui-srv:local:last-directory': '/legacy',
      },
    })
  })

  it('restores all servers, replaces stale entries and notifies once after the import', () => {
    serverStorage.set('directory', '/a')
    serverStorage.setFor('directory', '/b', 'b')
    const backup = exportPerServerStorageBackup()
    serverStorage.set('directory', '/changed')
    serverStorage.setFor('stale', 'remove', 'c')
    localStorage.setItem('piui-srv:local:stale', 'remove')
    localStorage.setItem('unrelated', 'keep')
    const listener = vi.fn(() => expect(serverStorage.getFor('directory', 'b')).toBe('/b'))
    const unsubscribe = subscribePerServerStorageVersion(listener)
    try {
      importPerServerStorageBackup(backup)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(serverStorage.get('directory')).toBe('/a')
      expect(serverStorage.getFor('stale', 'c')).toBeNull()
      expect(localStorage.getItem('piui-srv:local:stale')).toBeNull()
      expect(localStorage.getItem('unrelated')).toBe('keep')
    } finally {
      unsubscribe()
    }
  })

  it('ignores unrelated and non-string entries during import', () => {
    localStorage.setItem('unrelated', 'keep')
    importPerServerStorageBackup({
      entries: {
        unrelated: 'overwrite',
        'srv:a:invalid': 123,
        'piui-srv:local:last-directory': '/legacy',
        'srv:a:directory': '/a',
      },
    })
    expect(localStorage.getItem('unrelated')).toBe('keep')
    expect(serverStorage.get('invalid')).toBeNull()
    expect(serverStorage.get('directory')).toBe('/a')
    expect(localStorage.getItem('piui-srv:local:last-directory')).toBe('/legacy')
  })
})
