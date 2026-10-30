import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { JsonObject, JsonValue } from '@piui/protocol'
import type { BranchCheckpoint, EntriesPage, LiveMessage, SessionHead } from '@piui/protocol'

export type { BranchCheckpoint, EntriesPage, LiveMessage, SessionHead }

type NativeCursor = { v: 1; epoch: string; beforeId: string }

/**
 * 光标 HMAC 密钥。优先用服务端注入的持久化密钥（PIUI_CURSOR_SECRET），
 * 这样 worker 进程重启（空闲回收后重新 attach）后旧光标依然有效；
 * 没有注入时退回每进程随机密钥（独立运行场景）。
 */
const cursorSecret = resolveCursorSecret()

function resolveCursorSecret(): Buffer {
  const configured = process.env.PIUI_CURSOR_SECRET?.trim()
  if (configured) {
    const decoded = Buffer.from(configured, 'base64url')
    if (decoded.length >= 32) return decoded.subarray(0, 32)
  }
  return randomBytes(32)
}

export function sessionHeadFromParts(
  parts: Omit<SessionHead, 'epoch'>,
  epochSeed: unknown = parts.header,
): SessionHead {
  return {
    ...parts,
    epoch: createHash('sha256').update(JSON.stringify(epochSeed)).digest('base64url').slice(0, 22),
  }
}

export function entriesPageFromEntries<T>(
  head: SessionHead,
  entries: readonly T[],
  options: { cursor?: string; limit: number; maxBytes: number; checkpoint?: BranchCheckpoint },
  serialize: (entry: T) => JsonObject,
): EntriesPage {
  const decoded = options.cursor ? decodeCursor(options.cursor) : undefined
  if (decoded && decoded.epoch !== head.epoch) throw staleCursor('cursor belongs to another session epoch')
  const before = decoded ? entries.findIndex(entry => entryIdOf(entry) === decoded.beforeId) : entries.length
  if (before < 0) throw staleCursor('cursor anchor is no longer in the session')
  const emptyPage = { head, items: [], checkpoint: options.checkpoint, hasMore: before > 0 }
  if (bytesOf(JSON.stringify(emptyPage)) > options.maxBytes) {
    throw Object.assign(new Error('page metadata exceeds the byte limit'), { code: 'FILE_TOO_LARGE' })
  }
  // 字节核算：不再每加一条就整页 stringify 一次（那是 O(k²)），而是把页的固定部分算一次，
  // 逐条只累加单条序列化字节与条目间逗号，总成本 O(k)。
  // 页的 JSON 形状固定，键序即对象字面量插入序，undefined 值的键会被 JSON.stringify 丢掉：
  //   {"head":H,"items":[i0,i1,…][,"checkpoint":C][,"beforeCursor":"B"]"hasMore":M}
  // 于是整页字节数 = prefix + items + suffix + cursor：
  //   prefix = '{"head":' + H + ',"items":['
  //   items  = Σ|i_n| + (n-1) 个逗号
  //   suffix = ']' + [',"checkpoint":' + C] + ',"hasMore":' + M + '}'
  //   cursor = [',"beforeCursor":' + B 的 JSON 字面量]（B 含首条 id，故逐条算，O(1) 不碰整页）
  // UTF-8 字节数在字符串拼接时可加，所以这个和恒等于最终 JSON.stringify(page) 的字节数。
  const prefixBytes = bytesOf('{"head":') + bytesOf(JSON.stringify(head)) + bytesOf(',"items":[')
  const checkpointBytes =
    options.checkpoint === undefined ? 0 : bytesOf(',"checkpoint":') + bytesOf(JSON.stringify(options.checkpoint))
  const suffixBytes = bytesOf(']') + checkpointBytes + bytesOf(',"hasMore":') + bytesOf('}') + bytesOf('false')
  const cursorKeyBytes = bytesOf(',"beforeCursor":')
  const selected: JsonObject[] = []
  let itemsBytes = 0
  let index = before - 1
  while (index >= 0 && selected.length < options.limit) {
    const item = serialize(entries[index]!)
    if (typeof item.id !== 'string') {
      throw Object.assign(new Error('Pi session entry id is not a string'), { code: 'NATIVE_DATA_NOT_JSON' })
    }
    const hasMore = index > 0
    const cursor = hasMore ? encodeCursor({ v: 1, epoch: head.epoch, beforeId: String(item.id) }) : undefined
    const candidateItemsBytes = itemsBytes + bytesOf(JSON.stringify(item)) + (selected.length ? 1 : 0)
    const cursorBytes = cursor === undefined ? 0 : cursorKeyBytes + bytesOf(JSON.stringify(cursor))
    // hasMore 为 true 时 'true' 比 suffix 里预留的 'false' 少 1 字节
    const hasMoreAdjust = hasMore ? 1 : 0
    const candidateBytes = prefixBytes + candidateItemsBytes + suffixBytes + cursorBytes - hasMoreAdjust
    if (candidateBytes > options.maxBytes) {
      if (!selected.length)
        throw Object.assign(new Error('entry exceeds the page byte limit'), { code: 'FILE_TOO_LARGE' })
      break
    }
    selected.push(item)
    itemsBytes = candidateItemsBytes
    index -= 1
  }
  const start = index + 1
  // 选中项是从尾往头 push 的，末尾整体反转回正序（原来是逐条 unshift，O(k²)）
  selected.reverse()
  return {
    head,
    items: selected,
    checkpoint: options.checkpoint,
    beforeCursor:
      start > 0 && selected[0]
        ? encodeCursor({ v: 1, epoch: head.epoch, beforeId: String(selected[0].id) })
        : undefined,
    hasMore: start > 0,
  }
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

export function imageAttachmentFromEntry(
  entry: JsonObject,
  blockIndex: number,
): { mimeType: string; data: string; etag: string } {
  const message = asRecord(entry.message)
  const content = message.content
  if (!Array.isArray(content)) throw notFound('entry has no message content')
  const block = asRecord(content[blockIndex] as JsonValue)
  if (block.type !== 'image' || typeof block.mimeType !== 'string' || typeof block.data !== 'string') {
    throw notFound('image block not found')
  }
  return {
    mimeType: block.mimeType,
    data: block.data,
    etag: `"${createHash('sha256').update(Buffer.from(block.data, 'base64')).digest('hex')}"`,
  }
}

function encodeCursor(cursor: NativeCursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
  const signature = createHmac('sha256', cursorSecret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function decodeCursor(cursor: string): NativeCursor {
  try {
    const [payload, signature] = cursor.split('.')
    if (!payload || !signature) throw new Error('bad cursor')
    const expected = createHmac('sha256', cursorSecret).update(payload).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('bad cursor')
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<NativeCursor>
    if (value.v !== 1 || typeof value.epoch !== 'string' || typeof value.beforeId !== 'string')
      throw new Error('bad cursor')
    return value as NativeCursor
  } catch {
    throw Object.assign(new Error('invalid pagination cursor'), { code: 'INVALID_REQUEST' })
  }
}

function asRecord(value: JsonValue | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function entryIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

function staleCursor(message: string): Error {
  return Object.assign(new Error(message), { code: 'STALE_CURSOR' })
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' })
}
