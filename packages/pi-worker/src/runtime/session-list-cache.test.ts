import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import {
  findSessionFileById,
  listAllSessionInfos,
  listSessionInfos,
  readSessionHeader,
  resetSessionListCache,
  searchSnippet,
  sessionMatchesSearch,
  type SessionListInfo,
} from './session-list-cache.ts'

const root = mkdtempSync(path.join(tmpdir(), 'piui-session-list-cache-'))

after(() => rmSync(root, { recursive: true, force: true }))

let counter = 0

function sessionFile(dir: string, id = `sess-${counter++}`) {
  return { file: path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`), id }
}

function writeLines(file: string, lines: unknown[]): void {
  writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
}

function appendLine(file: string, line: unknown): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`)
}

const header = (id: string, cwd: string, parentSession?: string) => ({
  type: 'session',
  version: 3,
  id,
  timestamp: '2026-01-01T00:00:00.000Z',
  cwd,
  ...(parentSession ? { parentSession } : {}),
})

const message = (role: string, text: string, timestamp: number) => ({
  type: 'message',
  id: `m-${timestamp}`,
  timestamp: new Date(timestamp).toISOString(),
  message: { role, content: [{ type: 'text', text }], timestamp },
})

describe('session list index', () => {
  it('reports the same fields the SDK builds and picks up appended entries', async () => {
    const dir = path.join(root, 'one')
    mkdirSync(dir, { recursive: true })
    const { file, id } = sessionFile(dir)
    writeLines(file, [
      header(id, '/work/a', '/parent/session.jsonl'),
      message('user', 'hello world', 1000),
      message('assistant', 'hi there', 2000),
      { type: 'session_info', name: 'Explore#dead' },
    ])

    const [info] = await listSessionInfos(dir)
    assert.ok(info)
    assert.equal(info.path, file)
    assert.equal(info.id, id)
    assert.equal(info.cwd, '/work/a')
    assert.equal(info.parentSessionPath, '/parent/session.jsonl')
    assert.equal(info.messageCount, 2)
    assert.equal(info.firstMessage, 'hello world')
    assert.equal(info.allMessagesText, 'hello world hi there')
    assert.equal(info.name, 'Explore#dead')
    assert.equal(info.modified.getTime(), 2000)
    assert.equal(info.created.getTime(), Date.parse('2026-01-01T00:00:00.000Z'))

    appendLine(file, message('user', 'third', 3000))
    const [updated] = await listSessionInfos(dir)
    assert.ok(updated)
    assert.equal(updated.messageCount, 3)
    assert.equal(updated.allMessagesText, 'hello world hi there third')
    // modified follows the newest user/assistant timestamp, not the file mtime
    assert.equal(updated.modified.getTime(), 3000)
  })

  it('falls back to "(no messages)" and drops files without a session header', async () => {
    const dir = path.join(root, 'two')
    mkdirSync(dir, { recursive: true })
    const sessions = sessionFile(dir)
    writeLines(sessions.file, [header(sessions.id, '/work/b')])
    const bogus = path.join(dir, 'bogus.jsonl')
    writeLines(bogus, [{ type: 'message', id: 'x', message: { role: 'user', content: 'nope' } }])

    const infos = await listSessionInfos(dir)
    assert.equal(infos.length, 1)
    assert.equal(infos[0]?.id, sessions.id)
    assert.equal(infos[0]?.firstMessage, '(no messages)')
    assert.equal(infos[0]?.messageCount, 0)
  })

  it('retries a half-written trailing line on the next scan', async () => {
    const dir = path.join(root, 'three')
    mkdirSync(dir, { recursive: true })
    const { file, id } = sessionFile(dir)
    writeLines(file, [header(id, '/work/c'), message('user', 'first', 1000)])
    appendFileSync(file, '{"type":"message","message":{"role":"user","content":[{"type":"text","te')
    const [before] = await listSessionInfos(dir)
    assert.equal(before?.messageCount, 1)

    appendFileSync(file, 'xt":"second"}]},"timestamp":"2026-01-01T00:00:02.000Z","id":"m2"}\n')
    const [after] = await listSessionInfos(dir)
    assert.equal(after?.messageCount, 2)
    assert.equal(after?.firstMessage, 'first')
    assert.equal(after?.modified.getTime(), Date.parse('2026-01-01T00:00:02.000Z'))
  })

  it('re-reads a file that was rewritten shorter', async () => {
    const dir = path.join(root, 'four')
    mkdirSync(dir, { recursive: true })
    const { file, id } = sessionFile(dir)
    writeLines(file, [header(id, '/work/d'), message('user', 'a', 1000), message('user', 'b', 2000)])
    assert.equal((await listSessionInfos(dir))[0]?.messageCount, 2)

    writeLines(file, [header(id, '/work/d'), message('user', 'only', 5000)])
    const [rewritten] = await listSessionInfos(dir)
    assert.equal(rewritten?.messageCount, 1)
    assert.equal(rewritten?.allMessagesText, 'only')
    assert.equal(rewritten?.modified.getTime(), 5000)
  })

  it('lists every workspace directory under the sessions root', async () => {
    resetSessionListCache()
    const sessionsRoot = path.join(root, 'root')
    const first = sessionFile(path.join(sessionsRoot, '--a--'))
    const second = sessionFile(path.join(sessionsRoot, '--b--'))
    mkdirSync(path.dirname(first.file), { recursive: true })
    mkdirSync(path.dirname(second.file), { recursive: true })
    writeLines(first.file, [header(first.id, '/a'), message('user', 'aaa', 1000)])
    writeLines(second.file, [header(second.id, '/b'), message('user', 'bbb', 5000)])

    const infos = await listAllSessionInfos(sessionsRoot)
    assert.deepEqual(
      infos.map(info => info.id),
      [second.id, first.id],
      'newest activity first',
    )
  })

  it('finds a session file by id and reads only its header', async () => {
    const sessionsRoot = path.join(root, 'lookup')
    const { file, id } = sessionFile(path.join(sessionsRoot, '--x--'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeLines(file, [header(id, '/work/x'), message('user', 'x', 1)])

    assert.equal(await findSessionFileById(sessionsRoot, id), file)
    assert.equal(await findSessionFileById(sessionsRoot, 'missing'), undefined)
    const head = await readSessionHeader(file)
    assert.deepEqual(head, { sessionFile: file, sessionId: id, cwd: '/work/x' })
    assert.equal(await readSessionHeader(path.join(sessionsRoot, 'nope.jsonl')), undefined)
  })
})

describe('session search', () => {
  const info = {
    path: '/s/a.jsonl',
    id: 'abc-123',
    cwd: '/work/piui',
    name: '测试会话',
    created: new Date(0),
    modified: new Date(0),
    messageCount: 2,
    firstMessage: '统计模块规模',
    allMessagesText: '统计模块规模 后台长任务验证通过',
  } satisfies SessionListInfo

  it('matches name, first message, id, cwd and transcript text', () => {
    for (const query of ['测试', '统计', 'abc-1', 'piui', '后台长任务']) {
      assert.equal(sessionMatchesSearch(info, query), true, query)
    }
    assert.equal(sessionMatchesSearch(info, 'missing'), false)
  })

  it('returns only the window around the match', () => {
    const text = `${'x'.repeat(200)}needle${'y'.repeat(200)}`
    const snippet = searchSnippet(text, 'needle', 10)
    assert.equal(snippet, '…xxxxxxxxxxneedleyyyyyyyyyy…')
    assert.equal(searchSnippet(text, 'absent'), undefined)
  })
})
