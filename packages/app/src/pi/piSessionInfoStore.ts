import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import { makeSessionKey, isScopedSessionKey, sessionKeyToServerId } from '../utils/sessionKey'

class PiSessionInfoStore {
  private all: SessionInfo[] = []
  private byCwd = new Map<string, SessionInfo[]>()
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  replaceAll(sessions: SessionInfo[]): SessionInfo[] {
    this.all = sessions
    this.notify()
    return this.all
  }

  replaceForServer(serverId: string, sessions: SessionInfo[]): SessionInfo[] {
    this.all = [...this.all.filter(item => isScopedSessionKey(item.id) && sessionKeyToServerId(item.id) !== serverId), ...sessions]
    for (const key of this.byCwd.keys()) if (key.startsWith(`${serverId}::`)) this.byCwd.delete(key)
    this.notify()
    return sessions
  }

  replaceForCwd(cwd: string, sessions: SessionInfo[], serverId?: string): SessionInfo[] {
    this.byCwd.set(serverId ? makeSessionKey(serverId, pathKey(cwd)) : pathKey(cwd), sessions)
    this.notify()
    return sessions
  }

  getAll(): readonly SessionInfo[] {
    return this.all
  }

  getForCwd(cwd: string, serverId?: string): readonly SessionInfo[] {
    return this.byCwd.get(serverId ? makeSessionKey(serverId, pathKey(cwd)) : pathKey(cwd)) ?? []
  }

  clear(): void {
    this.all = []
    this.byCwd.clear()
    this.notify()
  }
}

export const piSessionInfoStore = new PiSessionInfoStore()

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return /^(?:[a-z]:\/|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
