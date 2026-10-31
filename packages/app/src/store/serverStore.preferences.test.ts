import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('startup server preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.resetModules()
  })

  it('prefers an explicit startup server over the last active server without changing current focus', async () => {
    const { serverStore } = await import('./serverStore')
    const a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    const b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(b)
    expect(serverStore.setDefaultServer(a)).toBe(true)
    expect(serverStore.getActiveServerId()).toBe(b)
    vi.resetModules()
    const { serverStore: reloaded } = await import('./serverStore')
    expect(reloaded.getActiveServerId()).toBe(a)
    expect(reloaded.getDefaultServerId()).toBe(a)
  })

  it('clears deleted or unknown preferences and uses the default when an active server is removed', async () => {
    const { serverStore } = await import('./serverStore')
    const a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    const b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setDefaultServer(a)
    serverStore.setActiveServer(b)
    expect(serverStore.setDefaultServer('missing')).toBe(false)
    serverStore.removeServer(b)
    expect(serverStore.getActiveServerId()).toBe(a)
    serverStore.removeServer(a)
    expect(serverStore.getDefaultServerId()).toBeNull()
    expect(localStorage.getItem('piui-default-server')).toBeNull()
  })

  it('round-trips startup preference in backups and falls back for older backups', async () => {
    const { serverStore, exportServerSettingsBackup, importServerSettingsBackup } = await import('./serverStore')
    const id = serverStore.addServer({ name: 'Remote', url: 'https://remote.example.test' }).id
    serverStore.setDefaultServer(id)
    const backup = exportServerSettingsBackup()
    expect(backup.defaultServerId).toBe(id)
    importServerSettingsBackup(backup)
    expect(localStorage.getItem('piui-default-server')).toBe(id)
    importServerSettingsBackup({ servers: backup.servers, activeServerId: id })
    expect(localStorage.getItem('piui-default-server')).toBeNull()
    vi.resetModules()
    expect((await import('./serverStore')).serverStore.getActiveServerId()).toBe(id)
  })
})
