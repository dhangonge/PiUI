// ============================================
// PinnedSessionsStore — 置顶对话状态管理
// ============================================
//
// 按服务器隔离的置顶会话列表（跨工作区持久化）。
// 存储 { sessionId, directory, title } 以便未加载 session 详情时也能渲染。

import { serverStorage, subscribePerServerStorageVersion } from '../utils/perServerStorage'
import { isScopedSessionKey, makeSessionKey, splitSessionKey } from '../utils/sessionKey'
import { serverStore } from './serverStore'

export interface PinnedSessionEntry {
  sessionId: string
  directory: string
  title: string
}

// 新：srv:{serverId}:piui-pinned-sessions（serverStorage）
// 旧：localStorage 全局 opencode-pinned-sessions——legacy 键名故意保留（迁移要读
// 基线数据），一次性迁到当前 active server。
const STORAGE_KEY = 'piui-pinned-sessions'

function parseEntries(raw: unknown): PinnedSessionEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is PinnedSessionEntry =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as PinnedSessionEntry).sessionId === 'string' &&
      typeof (item as PinnedSessionEntry).directory === 'string' &&
      typeof (item as PinnedSessionEntry).title === 'string',
  )
}

function loadEntries(): PinnedSessionEntry[] {
  // 已有 per-server key 时直接用（含空数组）
  if (serverStorage.get(STORAGE_KEY) !== null) {
    return parseEntries(serverStorage.getJSON<unknown>(STORAGE_KEY))
  }

  // 一次性迁移：旧全局列表归到当前 active server
  try {
    const legacyRaw = localStorage.getItem(STORAGE_KEY)
    if (legacyRaw) {
      const migrated = parseEntries(JSON.parse(legacyRaw))
      serverStorage.setJSON(STORAGE_KEY, migrated)
      localStorage.removeItem(STORAGE_KEY)
      return migrated
    }
  } catch {
    // ignore migration failures
  }

  return []
}

function scopedEntries(sessionId: string): PinnedSessionEntry[] {
  return parseEntries(serverStorage.getJSONFor(STORAGE_KEY, splitSessionKey(sessionId).serverId))
}
function mutateScoped(sessionId: string, update: (entries: PinnedSessionEntry[], rawId: string) => PinnedSessionEntry[]): void {
  const target = splitSessionKey(sessionId)
  serverStorage.setJSONFor(STORAGE_KEY, update(scopedEntries(sessionId), target.sessionId), target.serverId)
}

class PinnedSessionsStore {
  private entries: PinnedSessionEntry[] = []
  private scopedSnapshot: PinnedSessionEntry[] = []
  private listeners = new Set<() => void>()

  constructor() {
    this.reload()
    serverStore.subscribe(() => {
      this.reload()
      this.emit()
    })
    subscribePerServerStorageVersion(() => {
      this.reload()
      this.emit()
    })
  }

  private reload() {
    this.entries = loadEntries()
    this.scopedSnapshot = serverStore.getServers().flatMap(server =>
      parseEntries(serverStorage.getJSONFor(STORAGE_KEY, server.id)).map(entry => ({ ...entry, sessionId: makeSessionKey(server.id, entry.sessionId) })))
  }

  isPinned(sessionId: string): boolean {
    if (isScopedSessionKey(sessionId)) return scopedEntries(sessionId).some(entry => entry.sessionId === splitSessionKey(sessionId).sessionId)
    return this.entries.some(e => e.sessionId === sessionId)
  }

  pin(entry: PinnedSessionEntry) {
    if (isScopedSessionKey(entry.sessionId)) {
      mutateScoped(entry.sessionId, (entries, rawId) => [...entries.filter(item => item.sessionId !== rawId), { ...entry, sessionId: rawId }])
      return
    }
    const existingIndex = this.entries.findIndex(e => e.sessionId === entry.sessionId)
    if (existingIndex !== -1) {
      const existing = this.entries[existingIndex]
      if (existing.directory === entry.directory && existing.title === entry.title) return
      this.entries = [
        ...this.entries.slice(0, existingIndex),
        entry,
        ...this.entries.slice(existingIndex + 1),
      ]
      this.persist()
      this.emit()
      return
    }
    this.entries = [...this.entries, entry]
    this.persist()
    this.emit()
  }

  update(sessionId: string, patch: Partial<Omit<PinnedSessionEntry, 'sessionId'>>) {
    if (isScopedSessionKey(sessionId)) {
      mutateScoped(sessionId, (entries, rawId) => entries.map(entry => entry.sessionId === rawId ? { ...entry, ...patch } : entry))
      return
    }
    const index = this.entries.findIndex(e => e.sessionId === sessionId)
    if (index === -1) return
    const next = { ...this.entries[index], ...patch }
    if (next.directory === this.entries[index].directory && next.title === this.entries[index].title) return
    this.entries = [...this.entries.slice(0, index), next, ...this.entries.slice(index + 1)]
    this.persist()
    this.emit()
  }

  unpin(sessionId: string) {
    if (isScopedSessionKey(sessionId)) {
      mutateScoped(sessionId, (entries, rawId) => entries.filter(entry => entry.sessionId !== rawId))
      return
    }
    const idx = this.entries.findIndex(e => e.sessionId === sessionId)
    if (idx === -1) return
    this.entries = [...this.entries.slice(0, idx), ...this.entries.slice(idx + 1)]
    this.persist()
    this.emit()
  }

  private persist() {
    serverStorage.setJSON(STORAGE_KEY, this.entries)
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): PinnedSessionEntry[] => {
    return this.entries
  }

  getScopedSnapshot = (): PinnedSessionEntry[] => this.scopedSnapshot

  private emit() {
    this.listeners.forEach(fn => fn())
  }
}

export const pinnedSessionsStore = new PinnedSessionsStore()
