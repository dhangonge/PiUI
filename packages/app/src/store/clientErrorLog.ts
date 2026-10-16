/**
 * 客户端错误日志（app 侧）。
 *
 * 为什么需要：打包后的 app 没有 devtools（Android WebView / Tauri 壳），生产构建里
 * 原本所有错误都被 logError 的 `import.meta.env.DEV` 分支吞掉——用户只看到「点了没反应」，
 * 排查时零线索。
 *
 * 这里做三件事：
 *   1. 进程内环形缓冲 + localStorage 持久化，最近 N 条随时可查（设置 → 关于 → 诊断）；
 *   2. 尽力上报本地 server，追加进它的日志文件
 *      （<数据目录>/logs/piui-server-YYYY-MM-DD.log，桌面壳和远程 server 都拿得到）；
 *   3. 上报失败、存储失败一律静默——错误通道自己不能再制造错误。
 *
 * 隐私：上报的字段只有 来源/分类/操作/消息/堆栈/版本/页面，URL 只取 origin+pathname
 * （token 在 query 里，不能带出去）；不上报任何用户内容。
 */

import { logger } from '../utils/logger'

export type ClientErrorSource = 'window' | 'rejection' | 'react' | 'manual'

export interface ClientErrorEntry {
  id: string
  source: ClientErrorSource
  category: string
  operation: string
  message: string
  stack: string | null
  /** 同一错误重复出现的次数（10 秒窗口内按 source/category/operation/message 归并） */
  count: number
  firstAt: string
  lastAt: string
  appVersion: string
  url: string
}

export interface ClientErrorInput {
  source?: ClientErrorSource
  category: string
  operation: string
  message: string
  stack?: string | null
}

export const MAX_CLIENT_ERRORS = 50
/** 每次会话上报给 server 的错误条数上限（防止一次崩溃风暴灌爆日志文件） */
export const MAX_REPORTED_PER_SESSION = 30

const STORAGE_KEY = 'piui-client-errors'
const MAX_MESSAGE_CHARS = 500
const MAX_STACK_CHARS = 4000
const DEDUPE_WINDOW_MS = 10_000
const FORWARD_MAX_PER_SESSION = MAX_REPORTED_PER_SESSION
const FORWARD_BATCH_DELAY_MS = 1000
const FORWARD_TIMEOUT_MS = 5000

let entries: readonly ClientErrorEntry[] = loadPersisted()
const listeners = new Set<() => void>()

// ============================================
// 持久化
// ============================================

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式/配额满：内存里的日志仍然可用。
  }
}

function clampText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.length > max ? `${value.slice(0, max)}…` : value
  return text
}

function isEntry(value: unknown): value is ClientErrorEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.category === 'string' &&
    typeof record.operation === 'string' &&
    typeof record.message === 'string'
  )
}

function loadPersisted(): readonly ClientErrorEntry[] {
  const raw = readStorage(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).slice(-MAX_CLIENT_ERRORS)
  } catch {
    return []
  }
}

function persist(): void {
  writeStorage(STORAGE_KEY, JSON.stringify(entries))
}

// ============================================
// 记录
// ============================================

function nowIso(): string {
  return new Date().toISOString()
}

function currentUrl(): string {
  try {
    return `${location.origin}${location.pathname}`
  } catch {
    return ''
  }
}

function currentAppVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown'
  } catch {
    return 'unknown'
  }
}

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
}

function sameError(a: ClientErrorEntry, b: ClientErrorInput): boolean {
  return (
    a.source === (b.source ?? 'manual') &&
    a.category === b.category &&
    a.operation === b.operation &&
    a.message === clampText(b.message, MAX_MESSAGE_CHARS)
  )
}

/**
 * 记录一条客户端错误。永不抛错：调用点都在 catch/错误分支里。
 */
export function recordClientError(input: ClientErrorInput): ClientErrorEntry {
  const normalized: ClientErrorInput = {
    source: input.source ?? 'manual',
    category: input.category,
    operation: input.operation,
    message: clampText(input.message, MAX_MESSAGE_CHARS) || 'unknown error',
    stack: clampText(input.stack, MAX_STACK_CHARS) || null,
  }

  const last = entries[entries.length - 1]
  if (last && sameError(last, normalized) && Date.now() - Date.parse(last.lastAt) < DEDUPE_WINDOW_MS) {
    const bumped: ClientErrorEntry = { ...last, count: last.count + 1, lastAt: nowIso() }
    entries = [...entries.slice(0, -1), bumped]
    persist()
    notify()
    scheduleForward(bumped)
    return bumped
  }

  const at = nowIso()
  const entry: ClientErrorEntry = {
    id: newId(),
    source: normalized.source!,
    category: normalized.category,
    operation: normalized.operation,
    message: normalized.message,
    stack: normalized.stack ?? null,
    count: 1,
    firstAt: at,
    lastAt: at,
    appVersion: currentAppVersion(),
    url: currentUrl(),
  }

  entries = [...entries, entry].slice(-MAX_CLIENT_ERRORS)
  persist()
  notify()
  scheduleForward(entry)
  return entry
}

export function getClientErrors(): readonly ClientErrorEntry[] {
  return entries
}

export function subscribeClientErrors(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 订阅者异常不影响记录流程。
    }
  }
}

export function clearClientErrors(): void {
  entries = []
  persist()
  notify()
}

/** 纯文本导出，供复制按钮和「诊断」面板使用。 */
export function formatClientErrorReport(): string {
  if (entries.length === 0) return ''
  const header = `PiUI ${currentAppVersion()} — ${entries.length} client error(s)`
  const lines = entries
    .slice()
    .reverse()
    .map(entry => {
      const parts = [
        `[${entry.lastAt}] ${entry.source} ${entry.category}/${entry.operation} x${entry.count}`,
        `  ${entry.message}`,
        `  url: ${entry.url}`,
      ]
      if (entry.stack) parts.push(`  ${entry.stack.split('\n').join('\n  ')}`)
      return parts.join('\n')
    })
  return [header, ...lines].join('\n\n')
}

// ============================================
// 上报给本地 server（尽力而为）
// ============================================

let forwardQueue: ClientErrorEntry[] = []
let forwardTimer: ReturnType<typeof setTimeout> | null = null
let forwardInflight: Promise<void> | null = null
let forwardedCount = 0

function scheduleForward(entry: ClientErrorEntry): void {
  // 队列也计数：否则一次长会话能攒满整队再一次性灌给 server。
  if (forwardedCount + forwardQueue.length >= FORWARD_MAX_PER_SESSION) return
  forwardQueue.push(entry)
  if (forwardTimer) return
  forwardTimer = setTimeout(() => {
    forwardTimer = null
    void flushClientErrorForwards()
  }, FORWARD_BATCH_DELAY_MS)
}

function toPayload(entry: ClientErrorEntry): Record<string, unknown> {
  return {
    source: entry.source,
    category: entry.category,
    operation: entry.operation,
    message: entry.message,
    stack: entry.stack,
    count: entry.count,
    at: entry.lastAt,
    appVersion: entry.appVersion,
    url: entry.url,
  }
}

/**
 * 把排队中的错误批量发给本地 server。失败就算了——server 可能没起、可能刚切换、
 * 也可能是远程离线，这些都不该冒泡到用户面前。
 */
export async function flushClientErrorForwards(): Promise<void> {
  if (forwardInflight) return forwardInflight
  const batch = forwardQueue
  forwardQueue = []
  if (batch.length === 0) return
  if (typeof fetch !== 'function') return

  forwardInflight = (async () => {
    try {
      // 动态导入：错误日志是底层设施，不应该让 utils 桶的每个使用者都静态地
      // 把传输层（及其 serverStore/tauri 依赖）拉进来。
      const { getApiBase, piFetch } = await import('../pi/httpClient')
      const response = await piFetch(`${getApiBase()}/api/v1/host/client-log`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries: batch.map(toPayload) }),
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      })
      if (response.ok) forwardedCount += batch.length
      else logger.warn(`[client-error] server rejected report: HTTP ${response.status}`)
    } catch {
      // 静默：上报失败不是用户需要知道的事，也不能再进错误日志形成回环。
    } finally {
      forwardInflight = null
    }
  })()

  return forwardInflight
}
