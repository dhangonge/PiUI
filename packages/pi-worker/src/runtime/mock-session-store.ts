import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { JsonObject, JsonValue } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'

/**
 * mock 模式的会话仓：一族 jsonl 文件（首行 header，其余为条目）。
 * 这里只做文件层读写与路径校验，不含任何会话/事件语义——
 * MockCatalog 与 MockPiSession 共用。
 */
function mockHome(): string {
  return process.env.PIUI_MOCK_DIR?.trim() || path.join(tmpdir(), 'piui-mock')
}

export function sessionsDir(): string {
  return path.join(mockHome(), 'sessions')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export class MockStore {
  list(): JsonObject[] {
    const dir = sessionsDir()
    if (!existsSync(dir)) return []
    return readDirJsonl(dir)
  }

  open(sessionFile: string): { header: JsonObject | null; entries: JsonObject[] } {
    return readJsonlFile(sessionFile)
  }

  create(cwd: string): { sessionFile: string; sessionId: string } {
    const dir = sessionsDir()
    mkdirSync(dir, { recursive: true })
    const sessionId = randomUUID()
    const sessionFile = path.join(dir, `${sessionId}.jsonl`)
    const header: JsonObject = {
      type: 'session',
      version: 1,
      id: sessionId,
      cwd,
      timestamp: nowIso(),
    }
    writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8')
    return { sessionFile, sessionId }
  }

  async delete(sessionFile: string): Promise<void> {
    await fs.unlink(sessionFile)
  }
}

function readDirJsonl(dir: string): JsonObject[] {
  const result: JsonObject[] = []
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const file = path.join(dir, name)
    try {
      const { header, entries } = readJsonlFile(file)
      const id = typeof header?.id === 'string' ? header.id : path.basename(name, '.jsonl')
      const messages = entries.filter(entry => entry.type === 'message')
      const firstUser = messages.find(entry => isJsonObject(entry.message) && entry.message.role === 'user')
      result.push({
        id,
        path: file,
        cwd: typeof header?.cwd === 'string' ? header.cwd : '',
        name: typeof header?.name === 'string' ? header.name : null,
        parentSessionPath: typeof header?.parentSession === 'string' ? header.parentSession : null,
        created: typeof header?.timestamp === 'string' ? header.timestamp : nowIso(),
        modified: lastTimestamp(entries) ?? (typeof header?.timestamp === 'string' ? header.timestamp : nowIso()),
        messageCount: messages.length,
        firstMessage:
          firstUser && isJsonObject(firstUser.message) ? textFromContent(firstUser.message.content).slice(0, 120) : '',
      })
    } catch {
      /* skip corrupted mock session files */
    }
  }
  result.sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
  return result
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function readJsonlFile(file: string): { header: JsonObject | null; entries: JsonObject[] } {
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim())
  let header: JsonObject | null = null
  const entries: JsonObject[] = []
  for (const line of lines) {
    const value = JSON.parse(line) as unknown
    if (!isJsonObject(value)) continue
    if (value.type === 'session') header = value
    else entries.push(value)
  }
  return { header, entries }
}

export async function assertMockSessionFileInside(sessionFile: string): Promise<void> {
  const root = await realpath(sessionsDir())
  const target = await realpath(sessionFile)
  const rootKey = process.platform === 'win32' ? root.toLowerCase() : root
  const targetKey = process.platform === 'win32' ? target.toLowerCase() : target
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) {
    throw Object.assign(new Error('Mock session file is outside the session directory'), {
      code: 'PATH_OUTSIDE_WORKSPACE',
    })
  }
}

function lastTimestamp(entries: JsonObject[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const ts = entries[index]?.timestamp
    if (typeof ts === 'string') return ts
  }
  return undefined
}

export function textFromContent(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => isJsonObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map(block => String((block as JsonObject).text))
    .join('')
}

export function mockBranch(entries: JsonObject[], leafId: string | null): JsonObject[] {
  const byId = new Map(entries.map(entry => [String(entry.id), entry]))
  const branch: JsonObject[] = []
  const visited = new Set<string>()
  let id = leafId
  while (id && !visited.has(id)) {
    visited.add(id)
    const entry = byId.get(id)
    if (!entry) break
    branch.unshift(entry)
    id = typeof entry.parentId === 'string' ? entry.parentId : null
  }
  return branch
}

export function filterMockSessions(sessions: JsonValue[], search?: string): JsonValue[] {
  const query = search?.trim().toLowerCase()
  if (!query) return sessions
  return sessions.filter(session => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) return false
    const record = session as Record<string, unknown>
    return ['name', 'firstMessage', 'id', 'cwd', 'allMessagesText'].some(
      key => typeof record[key] === 'string' && (record[key] as string).toLowerCase().includes(query),
    )
  })
}
