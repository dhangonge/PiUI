import { serverStore } from '../store/serverStore'

const SEPARATOR = '::'

export function makeSessionKey(serverId: string, sessionId: string): string {
  return `${serverId}${SEPARATOR}${sessionId}`
}

/** Unqualified legacy keys belong to the active server. */
export function splitSessionKey(sessionKey: string): { serverId: string; sessionId: string } {
  const index = sessionKey.indexOf(SEPARATOR)
  if (index === -1) return { serverId: serverStore.getActiveServerId(), sessionId: sessionKey }
  return { serverId: sessionKey.slice(0, index), sessionId: sessionKey.slice(index + SEPARATOR.length) }
}

export function sessionKeyToServerId(sessionKey: string): string {
  return splitSessionKey(sessionKey).serverId
}

export function sessionKeyToSessionId(sessionKey: string): string {
  return splitSessionKey(sessionKey).sessionId
}

export function resolveSessionTarget(sessionId: string, serverId?: string): { sessionId: string; serverId: string } {
  const parsed = splitSessionKey(sessionId)
  return { sessionId: parsed.sessionId, serverId: serverId ?? parsed.serverId }
}

export function isScopedSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(SEPARATOR)
}

const revisions = new Map<string, { url?: string; token?: string; revision: number }>()

/** Changes only when this endpoint is edited/removed, not when focus changes. */
export function getServerRevision(serverId: string): number {
  const server = serverStore.getServers().find(item => item.id === serverId)
  const previous = revisions.get(serverId)
  if (previous && previous.url === server?.url && previous.token === server?.token) return previous.revision
  const revision = (previous?.revision ?? 0) + 1
  revisions.set(serverId, { url: server?.url, token: server?.token, revision })
  return revision
}

// Observe intermediate edits even if a request only compares revisions later.
serverStore.subscribe(() => {
  for (const serverId of revisions.keys()) getServerRevision(serverId)
})

export function getSessionRevision(sessionId: string): number {
  return isScopedSessionKey(sessionId)
    ? getServerRevision(sessionKeyToServerId(sessionId))
    : serverStore.getActiveServerGeneration()
}

export function scopeSessionResult<T>(result: T, serverId?: string): T {
  if (!serverId || !result || typeof result !== 'object' || Array.isArray(result)) return result
  const copy = { ...result } as Record<string, unknown>
  for (const key of ['sessionId', 'sourceSessionId', 'targetSessionId']) {
    if (typeof copy[key] === 'string') copy[key] = makeSessionKey(serverId, copy[key])
  }
  return copy as T
}
