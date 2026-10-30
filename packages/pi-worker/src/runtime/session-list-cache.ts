import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * Session list index.
 *
 * The SDK's `SessionManager.list/listAll` parse every session file end to end
 * on every call (~2.4s for 188 files / 263MB here) because it needs
 * firstMessage / allMessagesText / messageCount. The sidebar refetches that
 * list on every `sessions.updated`, so the scan price is paid constantly.
 *
 * This module keeps a per-file index and only reads the bytes appended since
 * the last scan: a full walk of the sessions directory is readdir + stat
 * (~3ms), and an appended message costs one line parse.
 *
 * The per-file fields mirror `buildSessionInfo` in
 * `@earendil-works/pi-coding-agent` (dist/core/session-manager.js) so switching
 * between this index and the SDK produces the same list.
 */

export const SESSION_LIST_CACHE_ENV = 'PIUI_SESSION_LIST_CACHE'

/** Full message text kept per session for server-side search. */
const SEARCH_TEXT_LIMIT = 8 * 1024
/** Files scanned in parallel on a cold pass. */
const SCAN_CONCURRENCY = 8

export interface SessionListInfo {
  path: string
  id: string
  cwd: string
  name?: string
  parentSessionPath?: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
  allMessagesText: string
}

interface SessionHeader {
  id: string
  cwd: string
  parentSession?: string
  timestamp?: string
}

interface FileIndex {
  size: number
  mtimeMs: number
  /** Bytes consumed through the last complete line. */
  offset: number
  header?: SessionHeader
  invalid: boolean
  name?: string
  messageCount: number
  lastActivityMs?: number
  firstUserText?: string
  texts: string[]
  textsLength: number
}

const indexes = new Map<string, FileIndex>()

export function isSessionListCacheEnabled(): boolean {
  return process.env[SESSION_LIST_CACHE_ENV]?.trim().toLowerCase() !== 'off'
}

export function resetSessionListCache(): void {
  indexes.clear()
}

function emptyIndex(): FileIndex {
  return { size: 0, mtimeMs: 0, offset: 0, invalid: false, messageCount: 0, texts: [], textsLength: 0 }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join(' ')
}

function consumeEntry(index: FileIndex, entry: unknown): void {
  if (!entry || typeof entry !== 'object') return
  const record = entry as Record<string, unknown>
  const type = record.type
  if (!index.header) {
    if (type !== 'session') {
      // The SDK drops files whose first entry is not a session header.
      index.invalid = true
      return
    }
    index.header = {
      id: typeof record.id === 'string' ? record.id : '',
      cwd: typeof record.cwd === 'string' ? record.cwd : '',
      parentSession: typeof record.parentSession === 'string' ? record.parentSession : undefined,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    }
    return
  }
  if (type === 'session_info') {
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    index.name = name || undefined
    return
  }
  if (type !== 'message') return
  index.messageCount += 1
  const message = record.message
  if (!message || typeof message !== 'object') return
  const messageRecord = message as Record<string, unknown>
  const role = messageRecord.role
  if (typeof role !== 'string' || !('content' in messageRecord)) return
  const messageTimestamp = messageRecord.timestamp
  const entryTimestamp = record.timestamp
  const activity =
    typeof messageTimestamp === 'number'
      ? messageTimestamp
      : typeof entryTimestamp === 'string'
        ? Date.parse(entryTimestamp)
        : Number.NaN
  if (Number.isFinite(activity)) index.lastActivityMs = Math.max(index.lastActivityMs ?? 0, activity)
  if (role !== 'user' && role !== 'assistant') return
  const text = extractText(messageRecord.content)
  if (!text) return
  if (!index.firstUserText && role === 'user') index.firstUserText = text
  if (index.textsLength < SEARCH_TEXT_LIMIT) {
    index.texts.push(text)
    index.textsLength += text.length + 1
  }
}

function consumeLine(index: FileIndex, line: string): number {
  const trimmed = line.trim()
  if (!trimmed) return 0
  let entry: unknown
  try {
    entry = JSON.parse(trimmed)
  } catch {
    return 0
  }
  consumeEntry(index, entry)
  return 1
}

/** Read the bytes appended since the last scan and fold them into the index. */
async function scanAppended(index: FileIndex, filePath: string): Promise<void> {
  const stream = createReadStream(filePath, { start: index.offset })
  const decoder = new StringDecoder('utf8')
  let carry = ''
  let consumed = index.offset
  try {
    for await (const chunk of stream) {
      const text = carry + decoder.write(chunk as Buffer)
      let cursor = 0
      let newline = text.indexOf('\n')
      while (newline !== -1) {
        const line = text.slice(cursor, newline)
        consumeLine(index, line)
        consumed += Buffer.byteLength(line, 'utf8') + 1
        cursor = newline + 1
        newline = text.indexOf('\n', cursor)
      }
      carry = text.slice(cursor)
    }
    carry += decoder.end()
  } finally {
    stream.destroy()
  }
  if (carry.trim()) {
    // A trailing line without a newline: only consume it when it parses, so a
    // half-written line is retried on the next scan instead of being dropped.
    let parsed = false
    try {
      JSON.parse(carry.trim())
      parsed = true
    } catch {
      parsed = false
    }
    if (parsed) {
      consumeLine(index, carry)
      consumed += Buffer.byteLength(carry, 'utf8')
    }
  }
  index.offset = consumed
}

async function refreshIndex(filePath: string, size: number, mtimeMs: number): Promise<FileIndex | undefined> {
  const existing = indexes.get(filePath)
  if (existing && existing.size === size && existing.mtimeMs === mtimeMs) return existing
  const index = existing && size >= existing.offset ? existing : emptyIndex()
  if (index !== existing) indexes.set(filePath, index)
  try {
    await scanAppended(index, filePath)
  } catch {
    // Unreadable file: drop it from the index and skip it for this pass.
    indexes.delete(filePath)
    return undefined
  }
  index.size = size
  index.mtimeMs = mtimeMs
  return index
}

function toInfo(filePath: string, index: FileIndex, fallbackMtime: Date): SessionListInfo | undefined {
  const header = index.header
  if (!header) return undefined
  const created = header.timestamp ? new Date(header.timestamp) : fallbackMtime
  const createdValid = !Number.isNaN(created.getTime())
  const modified =
    typeof index.lastActivityMs === 'number' && index.lastActivityMs > 0
      ? new Date(index.lastActivityMs)
      : createdValid
        ? created
        : fallbackMtime
  return {
    path: filePath,
    id: header.id,
    cwd: header.cwd,
    name: index.name,
    parentSessionPath: header.parentSession,
    created: createdValid ? created : fallbackMtime,
    modified,
    messageCount: index.messageCount,
    firstMessage: index.firstUserText || '(no messages)',
    allMessagesText: index.texts.join(' '),
  }
}

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await map(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** List the sessions in one session directory (flat `.jsonl` files). */
export async function listSessionInfos(dir: string): Promise<SessionListInfo[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const files = names.filter(name => name.endsWith('.jsonl')).map(name => path.join(dir, name))
  const infos = await mapLimit(files, SCAN_CONCURRENCY, async file => {
    const stats = await fs.stat(file).catch(() => undefined)
    if (!stats?.isFile()) return undefined
    const index = await refreshIndex(file, stats.size, stats.mtimeMs)
    if (!index || index.invalid) return undefined
    return toInfo(file, index, stats.mtime)
  })
  return sortInfos(infos.filter((info): info is SessionListInfo => Boolean(info)))
}

/** List every session under a sessions root (one directory per workspace). */
export async function listAllSessionInfos(root: string): Promise<SessionListInfo[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs = entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .map(entry => path.join(root, entry.name))
  const groups = await mapLimit(dirs, SCAN_CONCURRENCY, dir => listSessionInfos(dir))
  return sortInfos(groups.flat())
}

export function sortInfos(infos: SessionListInfo[]): SessionListInfo[] {
  return infos.sort((a, b) => b.modified.getTime() - a.modified.getTime())
}

/** Locate a session file by id without parsing the session directory tree. */
export async function findSessionFileById(root: string, sessionId: string): Promise<string | undefined> {
  const id = sessionId.trim()
  if (!id) return undefined
  const suffix = `_${id}.jsonl`
  const direct = await fs.readdir(root).catch(() => [] as string[])
  const flatMatch = direct.find(name => name.endsWith(suffix))
  if (flatMatch) return path.join(root, flatMatch)
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = path.join(root, entry.name)
    const files = await fs.readdir(dir).catch(() => [] as string[])
    const match = files.find(name => name.endsWith(suffix))
    if (match) return path.join(dir, match)
  }
  return undefined
}

export interface SessionHeaderInfo {
  sessionFile: string
  sessionId: string
  cwd: string
}

/** Read only the session header line (first entry) of a session file. */
export async function readSessionHeader(sessionFile: string): Promise<SessionHeaderInfo | undefined> {
  let handle
  try {
    handle = await fs.open(sessionFile, 'r')
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    const line = (newline === -1 ? text : text.slice(0, newline)).trim()
    if (!line) return undefined
    const entry = JSON.parse(line) as Record<string, unknown>
    if (entry.type !== 'session' || typeof entry.id !== 'string') return undefined
    return { sessionFile, sessionId: entry.id, cwd: typeof entry.cwd === 'string' ? entry.cwd : '' }
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

export function sessionMatchesSearch(info: SessionListInfo, query: string): boolean {
  const needle = query.toLowerCase()
  return (
    info.name?.toLowerCase().includes(needle) === true ||
    info.firstMessage.toLowerCase().includes(needle) ||
    info.id.toLowerCase().includes(needle) ||
    info.cwd.toLowerCase().includes(needle) ||
    info.allMessagesText.toLowerCase().includes(needle)
  )
}

/** Small window around the first match, so the client keeps its local filter. */
export function searchSnippet(text: string, query: string, radius = 80): string | undefined {
  const needle = query.toLowerCase()
  const at = text.toLowerCase().indexOf(needle)
  if (at === -1) return undefined
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
