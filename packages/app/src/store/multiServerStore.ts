import { useSyncExternalStore } from 'react'
import { serverStore } from './serverStore'
import { getServerRevision } from '../utils/sessionKey'

const STORAGE_KEY = 'piui-multi-server'

interface MultiServerSettings {
  enabled: boolean
  subscribedServerIds: string[]
  focusedServerId: string | null
}
export interface MultiServerSnapshot extends MultiServerSettings {
  serverIds: string[]
  connectionRevision: string
}

function loadSettings(): MultiServerSettings {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    return {
      enabled: data?.enabled === true,
      subscribedServerIds: Array.isArray(data?.subscribedServerIds)
        ? [...new Set<string>(data.subscribedServerIds.filter((id: unknown) => typeof id === 'string'))]
        : [],
      focusedServerId: typeof data?.focusedServerId === 'string' ? data.focusedServerId : null,
    }
  } catch {
    return { enabled: false, subscribedServerIds: [], focusedServerId: null }
  }
}

class MultiServerStore {
  private settings = loadSettings()
  private listeners = new Set<() => void>()
  private snapshot = this.buildSnapshot()

  constructor() {
    serverStore.subscribe(() => this.emit())
  }

  private buildSnapshot(): MultiServerSnapshot {
    const known = new Set(serverStore.getServers().map(server => server.id))
    const subscribedServerIds = this.settings.subscribedServerIds.filter(id => known.has(id))
    const serverIds = this.settings.enabled ? subscribedServerIds : [serverStore.getActiveServerId()]
    return {
      ...this.settings,
      subscribedServerIds,
      focusedServerId:
        this.settings.focusedServerId && known.has(this.settings.focusedServerId)
          ? this.settings.focusedServerId
          : null,
      serverIds,
      connectionRevision: serverIds.map(id => `${id}:${getServerRevision(id)}`).join('|'),
    }
  }

  private emit(): void {
    const next = this.buildSnapshot()
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return
    if (next.serverIds.join('\0') === this.snapshot.serverIds.join('\0')) next.serverIds = this.snapshot.serverIds
    if (next.subscribedServerIds.join('\0') === this.snapshot.subscribedServerIds.join('\0'))
      next.subscribedServerIds = this.snapshot.subscribedServerIds
    this.snapshot = next
    this.settings = {
      enabled: next.enabled,
      subscribedServerIds: next.subscribedServerIds,
      focusedServerId: next.focusedServerId,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings))
    } catch {
      /* storage may be disabled */
    }
    this.listeners.forEach(listener => listener())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getSnapshot = (): MultiServerSnapshot => this.snapshot
  isEnabled = (): boolean => this.settings.enabled
  isSubscribed = (serverId: string): boolean => this.snapshot.subscribedServerIds.includes(serverId)
  getSubscribedServerIds = (): string[] => [...this.snapshot.subscribedServerIds]
  getFocusedServerId = (): string => this.settings.focusedServerId ?? serverStore.getActiveServerId()

  setEnabled(enabled: boolean): void {
    this.settings.enabled = enabled
    if (enabled && this.snapshot.subscribedServerIds.length === 0)
      this.settings.subscribedServerIds = [serverStore.getActiveServerId()]
    this.emit()
  }

  setSubscribed(serverId: string, subscribed: boolean): void {
    this.setSubscribedServerIds(
      subscribed
        ? [...this.settings.subscribedServerIds, serverId]
        : this.settings.subscribedServerIds.filter(id => id !== serverId),
    )
  }

  setSubscribedServerIds(serverIds: string[]): void {
    this.settings.subscribedServerIds = [...new Set(serverIds)]
    this.emit()
  }

  setFocusedServerId(serverId: string | null): void {
    this.settings.focusedServerId = serverId
    this.emit()
  }
}

export const multiServerStore = new MultiServerStore()
export function useMultiServerStore(): MultiServerSnapshot {
  return useSyncExternalStore(multiServerStore.subscribe, multiServerStore.getSnapshot, multiServerStore.getSnapshot)
}
