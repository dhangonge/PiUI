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
