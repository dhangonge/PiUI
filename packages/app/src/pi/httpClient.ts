import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'
import { getHttpFetch, isTauri } from '../utils/tauri'
import { PROTOCOL_VERSION } from '@piui/protocol'

const DEFAULT_BASE = 'http://127.0.0.1:8787'
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000

interface InflightRequest {
  controller: AbortController
  serverId: string
  bound: boolean
}

const inflightRequests = new Set<InflightRequest>()

export function abortInFlightPiRequests(serverId?: string): void {
  for (const request of inflightRequests) {
    if (serverId === undefined || request.serverId === serverId) request.controller.abort()
  }
}

export function abortUnboundPiRequests(): void {
  for (const request of inflightRequests) {
    if (!request.bound) request.controller.abort()
  }
}

// A connection reset can occur after a command was accepted. Retry only reads.
const NETWORK_RETRY_DELAYS_MS = [300, 900]

function isNetworkLevelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false
  if (error instanceof TypeError) return true
  return /fetch failed|network|econnrefused|econnreset|enotfound|connection|error sending request/i.test(error.message)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

/**
 * HTTP transport base for the PiUI server.
 * Browser dev uses same-origin + Vite proxy (`/api` → :8787) to avoid CORS.
 * Tauri 壳的同源是 tauri://localhost，不是 API，必须始终用完整 URL。
 * Browser builds can use VITE_PIUI_API. Tauri always follows serverStore so
 * switching servers in Settings cannot be pinned to a build-time endpoint.
 */
export function getApiBase(serverId?: string): string {
  if (serverId !== undefined) return requireServer(serverId).url.replace(/\/+$/, '')
  const envBase = import.meta.env.VITE_PIUI_API as string | undefined
  if (typeof window !== 'undefined') {
    const active = serverStore.getActiveServer()
    if (isTauri()) {
      if (active?.url) return active.url.replace(/\/$/, '')
      return envBase?.replace(/\/$/, '') || DEFAULT_BASE
    }
    if (envBase) return envBase.replace(/\/$/, '')
    if (active && active.id !== LOCAL_SERVER_ID) return active.url.replace(/\/$/, '')
    const storedLocal = serverStore.getStoredServers().find(server => server.id === LOCAL_SERVER_ID)
    if (active && storedLocal && active.url !== storedLocal.url) return active.url.replace(/\/$/, '')
    return ''
  }
  return envBase?.replace(/\/$/, '') || DEFAULT_BASE
}

function requireServer(serverId: string) {
  const server = serverStore.getServers().find(server => server.id === serverId)
  if (!server) throw new Error(`Unknown PiUI server: ${serverId}`)
  return server
}

export function getPiAuthToken(serverId?: string): string | undefined {
  // An explicitly selected server must never inherit another endpoint's token.
  if (serverId !== undefined) return requireServer(serverId).token
  const activeToken = serverStore.getActiveToken()
  if (activeToken) return activeToken
  const active = serverStore.getActiveServer()
  if (active && active.id !== LOCAL_SERVER_ID) return undefined
  return import.meta.env.VITE_PIUI_TOKEN as string | undefined
}

export interface PiHttpClient {
  readonly serverId: string
  getBaseUrl(): string
  getAuthToken(): string | undefined
  fetch(path: string, init?: RequestInit): Promise<Response>
}

export function createPiHttpClient(serverId: string): PiHttpClient {
  requireServer(serverId)
  return {
    serverId,
    getBaseUrl: () => getApiBase(serverId),
    getAuthToken: () => getPiAuthToken(serverId),
    fetch: (path, init) => {
      if (!path.startsWith('/') || path.startsWith('//')) {
        return Promise.reject(new Error('PiUI client requires an absolute API path, not a URL'))
      }
      return piFetch(`${getApiBase(serverId)}${path}`, init, serverId)
    },
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export async function piFetch(input: string, init?: RequestInit, serverId?: string): Promise<Response> {
  // Capture the endpoint and credentials before loading the native fetch bridge.
  const id = serverId ?? serverStore.getActiveServerId()
  const base = getApiBase(serverId)
  const token = getPiAuthToken(serverId)
  const headers = new Headers(init?.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  const request: InflightRequest = { controller: new AbortController(), serverId: id, bound: serverId !== undefined }
  const signals = [request.controller.signal, AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)]
  if (init?.signal) signals.push(init.signal)
  const signal = AbortSignal.any(signals)
  inflightRequests.add(request)
  const unsubscribe = serverStore.subscribe(() => {
    try {
      if (
        (!request.bound && serverStore.getActiveServerId() !== id) ||
        getApiBase(serverId) !== base ||
        getPiAuthToken(serverId) !== token
      ) {
        request.controller.abort()
      }
    } catch {
      // The selected server may have been removed while a request was in flight.
      request.controller.abort()
    }
  })
  try {
    signal.throwIfAborted()
    const fetchImpl = await getHttpFetch()
    signal.throwIfAborted()
    const canRetry = ['GET', 'HEAD', 'OPTIONS'].includes((init?.method ?? 'GET').toUpperCase())
    let lastError: unknown
    for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt++) {
      try {
        signal.throwIfAborted()
        const response = await fetchImpl(input, { ...init, signal, headers })
        signal.throwIfAborted()
        return response
      } catch (error) {
        if (signal.aborted || isAbortError(error) || !canRetry || !isNetworkLevelError(error)) throw error
        lastError = error
        const delay = NETWORK_RETRY_DELAYS_MS[attempt]
        if (delay === undefined) break
        await waitForRetry(delay, signal)
      }
    }
    throw lastError
  } finally {
    unsubscribe()
    inflightRequests.delete(request)
  }
}

export async function isPiServerUp(): Promise<boolean> {
  try {
    const res = await piFetch(`${getApiBase()}/api/v1/host/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = (await res.json()) as { service?: string; protocolVersion?: number }
    return body.service === 'piui-server' && body.protocolVersion === PROTOCOL_VERSION
  } catch {
    return false
  }
}
