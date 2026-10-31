/**
 * 客户端错误上报（`POST /api/v1/host/client-log`）。
 *
 * 浏览器/壳把 app 侧记录的客户端错误尽力发到这里，追加进 server 的日志文件
 * （<数据目录>/logs/piui-server-YYYY-MM-DD.log）——打包后的 app 没有 devtools，
 * 这是把现场带到开发机上唯一可靠的通道。
 *
 * 客户端是不可信输入：字段按类型 + 长度白名单化，换行一律压平（否则客户端可以
 * 往日志里伪造行），条数有上限；整个 body 的大小由 http 层的 MAX_JSON_BODY_BYTES 兜。
 */

import { logClientError } from '../logger.ts'

export const MAX_CLIENT_LOG_ENTRIES = 20
const MAX_FIELD_CHARS = 120
const MAX_MESSAGE_CHARS = 500
const MAX_STACK_CHARS = 4000

const SOURCES = new Set(['window', 'rejection', 'react', 'manual'])

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\r\n\t]+/g, ' | ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function formatEntry(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>

  const message = text(entry.message, MAX_MESSAGE_CHARS)
  if (!message) return null

  const source = text(entry.source, MAX_FIELD_CHARS)
  const count = typeof entry.count === 'number' && entry.count > 1 ? ` x${Math.floor(entry.count)}` : ''
  const parts = [
    `[client] ${SOURCES.has(source) ? source : 'unknown'}`,
    `${text(entry.category, MAX_FIELD_CHARS) || 'unknown'}/${text(entry.operation, MAX_FIELD_CHARS) || 'unknown'}${count}`,
    `at ${text(entry.at, MAX_FIELD_CHARS) || 'unknown'}`,
    `app ${text(entry.appVersion, MAX_FIELD_CHARS) || 'unknown'}`,
    `url ${text(entry.url, MAX_FIELD_CHARS) || 'unknown'}`,
  ]

  const stack = text(entry.stack, MAX_STACK_CHARS)
  return `${parts.join(' ')} ${message}${stack ? ` :: ${stack}` : ''}`
}

/**
 * 逐条落盘，返回接受的条数。形状不对（没有 entries 数组）时抛 INVALID_REQUEST，
 * 由 http 层转成 400——静默 200 会让客户端以为已经上报成功。
 */
export function reportClientErrors(body: unknown): number {
  const entries =
    body && typeof body === 'object' && Array.isArray((body as { entries?: unknown }).entries)
      ? ((body as { entries: unknown[] }).entries as unknown[])
      : null
  if (!entries)
    throw Object.assign(new Error('client log payload requires an entries array'), { code: 'INVALID_REQUEST' })

  let accepted = 0
  for (const raw of entries.slice(0, MAX_CLIENT_LOG_ENTRIES)) {
    const line = formatEntry(raw)
    if (!line) continue
    logClientError(line)
    accepted++
  }
  return accepted
}
