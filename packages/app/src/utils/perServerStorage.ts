// ============================================
// Per-Server Storage - 按服务器隔离的 localStorage 读写
// ============================================
//
// 不同服务器有不同的项目目录、模型、路径风格等设置。
// 这个工具函数给 localStorage key 加上 serverId 前缀，实现隔离。
//
// 用法：
//   import { serverStorage } from '../utils/perServerStorage'
//   serverStorage.get('piui-last-directory')        // 读取当前服务器的值
//   serverStorage.set('piui-last-directory', '/foo') // 写入当前服务器的值
//   serverStorage.remove('piui-last-directory')      // 删除当前服务器的值

import { serverStore } from '../store/serverStore'

const SERVER_STORAGE_PREFIX = 'srv:'
const LEGACY_BACKUP_PREFIX = 'piui-srv:'

function isServerStorageKey(key: string): boolean {
  return key.startsWith(SERVER_STORAGE_PREFIX) || key.startsWith(LEGACY_BACKUP_PREFIX)
}

/**
 * 生成带 serverId 前缀的 localStorage key
 * 格式: `srv:{serverId}:{key}`
 */
function makeKey(key: string, serverId?: string): string {
  const sid = serverId ?? serverStore.getActiveServerId()
  return `${SERVER_STORAGE_PREFIX}${sid}:${key}`
}

// 存储版本（写入时递增，供订阅者通过 getStorageVersion 感知变化触发刷新）
let storageVersion = 0
const versionListeners = new Set<() => void>()

function bumpVersion(): void {
  storageVersion += 1
  versionListeners.forEach(fn => fn())
}

/**
 * 当前存储版本（作为 useSyncExternalStore 的 getSnapshot，
 * 写入时版本递增 → 订阅组件重渲染并重新读取数据）
 */
export function getStorageVersion(): number {
  return storageVersion
}

/** 订阅 per-server storage 的写入事件（返回取消订阅函数） */
export function subscribePerServerStorageVersion(fn: () => void): () => void {
  versionListeners.add(fn)
  return () => versionListeners.delete(fn)
}

export const serverStorage = {
  /**
   * 读取当前服务器的存储值
   */
  get(key: string): string | null {
    try {
      return localStorage.getItem(makeKey(key))
    } catch {
      return null
    }
  },

  /**
   * 写入当前服务器的存储值
   */
  set(key: string, value: string): void {
    try {
      localStorage.setItem(makeKey(key), value)
      bumpVersion()
    } catch {
      // ignore
    }
  },

  /**
   * 删除当前服务器的存储值
   */
  remove(key: string): void {
    try {
      localStorage.removeItem(makeKey(key))
      bumpVersion()
    } catch {
      // ignore
    }
  },

  /**
   * 读取当前服务器的 JSON 值（自动解析）
   */
  getJSON<T>(key: string): T | null {
    const raw = serverStorage.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },

  /**
   * 写入当前服务器的 JSON 值（自动序列化）
   */
  setJSON(key: string, value: unknown): void {
    serverStorage.set(key, JSON.stringify(value))
  },

  /**
   * 读取指定服务器的存储值
   */
  getFor(key: string, serverId: string): string | null {
    try {
      return localStorage.getItem(makeKey(key, serverId))
    } catch {
      return null
    }
  },

  /**
   * 写入指定服务器的存储值（递增版本通知订阅者）
   */
  setFor(key: string, value: string, serverId: string): void {
    try {
      localStorage.setItem(makeKey(key, serverId), value)
      bumpVersion()
    } catch {
      // ignore
    }
  },

  removeFor(key: string, serverId: string): void {
    try {
      localStorage.removeItem(makeKey(key, serverId))
      bumpVersion()
    } catch {
      // ignore
    }
  },

  /**
   * 读取指定服务器的 JSON 值（自动解析）
   */
  getJSONFor<T>(key: string, serverId: string): T | null {
    const raw = serverStorage.getFor(key, serverId)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },

  /**
   * 写入指定服务器的 JSON 值（自动序列化）
   */
  setJSONFor(key: string, value: unknown, serverId: string): void {
    serverStorage.setFor(key, JSON.stringify(value), serverId)
  },
}

export interface PerServerStorageBackup {
  entries: Record<string, string>
}

export function exportPerServerStorageBackup(): PerServerStorageBackup {
  const entries: Record<string, string> = {}

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key || !isServerStorageKey(key)) continue
    const value = localStorage.getItem(key)
    if (value !== null) {
      entries[key] = value
    }
  }

  return { entries }
}

export function importPerServerStorageBackup(raw: unknown): void {
  const parsed = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined
  const entries = parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {}

  const keysToRemove: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key && isServerStorageKey(key)) {
      keysToRemove.push(key)
    }
  }

  for (const key of keysToRemove) {
    localStorage.removeItem(key)
  }

  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (isServerStorageKey(key) && typeof value === 'string') {
      localStorage.setItem(key, value)
    }
  }
  bumpVersion()
}
