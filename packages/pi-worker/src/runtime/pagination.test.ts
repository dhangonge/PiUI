import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { entriesPageFromEntries, sessionHeadFromParts } from './pagination.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const paginationEntry = fileURLToPath(new URL('./pagination.ts', import.meta.url))

function childScript(mode: 'sign' | 'verify'): string {
  const paginationImport = JSON.stringify(paginationEntry)
  if (mode === 'sign') {
    return `
      import { entriesPageFromEntries, sessionHeadFromParts } from ${paginationImport}
      const head = sessionHeadFromParts({
        sessionId: "sess-1", sdkVersion: "0.84.0", revision: 1,
        sessionFormatVersion: 1, header: { sessionId: "sess-1" },
        leafId: "leaf", entryCount: 2,
      })
      const page = entriesPageFromEntries(
        head,
        [{ id: "a" }, { id: "b" }] as never,
        { limit: 1, maxBytes: 1024 * 1024 },
        (entry) => entry as never,
      )
      process.stdout.write(page.beforeCursor ?? "")
    `
  }
  return `
    import { entriesPageFromEntries, sessionHeadFromParts } from ${paginationImport}
    const cursor = process.env.CURSOR
    if (!cursor) { process.stdout.write("fail:no-cursor"); process.exit(0) }
    const head = sessionHeadFromParts({
      sessionId: "sess-1", sdkVersion: "0.84.0", revision: 1,
      sessionFormatVersion: 1, header: { sessionId: "sess-1" },
      leafId: "leaf", entryCount: 2,
    })
    try {
      const page = entriesPageFromEntries(
        head,
        [{ id: "a" }, { id: "b" }] as never,
        { cursor, limit: 1, maxBytes: 1024 * 1024 },
        (entry) => entry as never,
      )
      process.stdout.write("ok:" + String((page.items[0] as { id?: string }).id))
    } catch (error) {
      process.stdout.write("fail:" + String((error as { code?: string }).code))
    }
  `
}

function runChild(mode: 'sign' | 'verify', env: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'piui-cursor-'))
  roots.push(root)
  const script = path.join(root, `${mode}.ts`)
  writeFileSync(script, childScript(mode))
  return execFileSync(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  })
}

/**
 * 光标跨进程有效性：旧 bug 是每 worker 进程一个随机 HMAC 密钥，worker 重启
 * 后客户端旧光标全部 400。修复后服务端把持久化密钥经 PIUI_CURSOR_SECRET
 * 注入 worker 环境——"重启后的新 worker"（新进程、同密钥）必须能验证旧进程
 * 签发的光标；不共享密钥时则必须失败（旧行为）。
 */
describe('pagination cursor survives worker restarts', () => {
  it('validates a cursor signed by another process when sharing PIUI_CURSOR_SECRET', () => {
    const sharedSecret = Buffer.alloc(32, 7).toString('base64url')
    const cursor = runChild('sign', { PIUI_CURSOR_SECRET: sharedSecret })
    const result = runChild('verify', { PIUI_CURSOR_SECRET: sharedSecret, CURSOR: cursor })
    assert.equal(result, 'ok:a')
  })

  it('rejects a cursor signed by another process without a shared secret', () => {
    const cursor = runChild('sign', { PIUI_CURSOR_SECRET: '' })
    const result = runChild('verify', { PIUI_CURSOR_SECRET: '', CURSOR: cursor })
    assert.equal(result, 'fail:INVALID_REQUEST')
  })
})

// ---------------------------------------------------------------------------
// 字节预算：页的字节核算走「逐条累加 + 一次性构造」，必须与整页 stringify 完全等价
// ---------------------------------------------------------------------------

type FixtureEntry = {
  id: string
  type: 'message'
  message: { role: 'user' | 'assistant'; content: { type: 'text'; text: string }[] }
}

const fixtureHead = sessionHeadFromParts({
  sessionId: 'sess-bytes',
  sdkVersion: '0.84.0',
  revision: 3,
  sessionFormatVersion: 1,
  header: { sessionId: 'sess-bytes', title: '字节核算 "quoted"' },
  leafId: 'e05',
  entryCount: 6,
})

const fixtureTexts = [
  'a',
  'x'.repeat(37),
  '中文中文中文',
  'quote " backslash \\ newline \n emoji 🚀',
  'y'.repeat(90),
  '',
]

const fixtureEntries: FixtureEntry[] = fixtureTexts.map((text, i) => ({
  id: `e${String(i).padStart(2, '0')}`,
  type: 'message',
  message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text }] },
}))

const serializeFixture = (entry: FixtureEntry) => entry as never
const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const loose = (cursor?: string, extra: Record<string, unknown> = {}) => ({
  cursor,
  limit: 6,
  maxBytes: 1 << 20,
  ...extra,
})
const pageOf = (options: Record<string, unknown>) =>
  entriesPageFromEntries(fixtureHead, fixtureEntries, options as never, serializeFixture)

describe('pagination byte budget', () => {
  // 空页（items: []) 的字节数 = 页 metadata 的固定开销，也是预算下限
  const emptyBytes = bytesOf(pageOf(loose(undefined, { limit: 0 })))
  const fullBytes = bytesOf(pageOf(loose()))
  const idsOf = (page: { items: readonly unknown[] }) => page.items.map(item => String((item as { id: string }).id))

  it('fills the page maximally and never exceeds maxBytes', () => {
    assert.ok(emptyBytes < fullBytes)
    // 起点留出「最大一条 + 光标」的余量：更小的预算属于「页为空且单条就超限」的抛错区间，
    // 那条路径在上面单独断言。
    for (let maxBytes = emptyBytes + 300; maxBytes <= fullBytes; maxBytes += 1) {
      const page = pageOf(loose(undefined, { maxBytes }))
      // 严格不超限：直接量结果对象序列化后的字节数
      assert.ok(bytesOf(page) <= maxBytes, `page took ${bytesOf(page)} bytes with maxBytes=${maxBytes}`)
      // 最大化：再多一条的候选页（同光标、同 checkpoint、limit+1）必须真的超预算
      const wider = pageOf(loose(undefined, { limit: page.items.length + 1 }))
      assert.deepEqual(idsOf(wider).slice(1), idsOf(page))
      if (page.items.length < fixtureEntries.length) {
        assert.ok(bytesOf(wider) > maxBytes, `dropped an entry that fits at maxBytes=${maxBytes}`)
      }
    }
    assert.equal(idsOf(pageOf(loose())).length, fixtureEntries.length)
    // 原实现就有的怪癖（这里锁住它不要变）：装下全部条目时页里没有 beforeCursor，
    // 「少一条 + 光标」的候选页反而更大，所以预算刚好等于整页字节数时只会返回 4 条。
    assert.equal(idsOf(pageOf(loose(undefined, { maxBytes: fullBytes }))).length, 4)
    assert.equal(idsOf(pageOf(loose(undefined, { maxBytes: fullBytes + 100 }))).length, fixtureEntries.length)
  })

  it('keeps the budget exact with a cursor and a checkpoint', () => {
    const checkpoint = { position: { epoch: 'eph', sequence: 9 }, liveMessage: { text: 'live "x"' } }
    const ckptBytes = bytesOf(pageOf(loose(undefined, { limit: 0, checkpoint })))
    assert.ok(ckptBytes > emptyBytes)
    // 起点留出单条 + 光标的余量，保证每轮至少能装下一条
    for (let maxBytes = ckptBytes + 300; maxBytes <= fullBytes + 600; maxBytes += 1) {
      const first = pageOf(loose(undefined, { limit: 2, maxBytes: 1 << 20, checkpoint }))
      assert.equal(idsOf(first).length, 2)
      const page = pageOf(loose(first.beforeCursor, { limit: 4, maxBytes, checkpoint }))
      assert.ok(bytesOf(page) <= maxBytes, `cursor page took ${bytesOf(page)} bytes with maxBytes=${maxBytes}`)
      const wider = pageOf(loose(first.beforeCursor, { limit: page.items.length + 1, maxBytes: 1 << 20, checkpoint }))
      assert.ok(page.items.length >= 1)
      if (page.items.length < 4) assert.ok(bytesOf(wider) > maxBytes)
      // checkpoint 只出现在页的顶层字段里，逐条累加不能把它算漏或算重
      assert.deepEqual(page.checkpoint, checkpoint)
    }
  })

  it('returns entries in session order with a cursor that round-trips', () => {
    assert.deepEqual(idsOf(pageOf(loose(undefined, { limit: 3 }))), ['e03', 'e04', 'e05'])

    const seen: string[] = []
    let cursor: string | undefined
    for (let step = 0; step < 10; step += 1) {
      const page = pageOf(loose(cursor, { limit: 2, maxBytes: fullBytes }))
      assert.ok(bytesOf(page) <= fullBytes)
      seen.push(...idsOf(page))
      if (!page.hasMore) {
        assert.equal(page.beforeCursor, undefined)
        break
      }
      // 同一光标重取必须幂等（光标是无状态签名，不含翻页次数）
      const repeatA = pageOf(loose(page.beforeCursor, { limit: 2, maxBytes: fullBytes }))
      const repeatB = pageOf(loose(page.beforeCursor, { limit: 2, maxBytes: fullBytes }))
      assert.deepEqual(idsOf(repeatA), idsOf(repeatB))
      cursor = page.beforeCursor
    }
    // 协议是「从最新往回翻」：第一页取尾部两条，后续页依次更旧，页内仍是正序
    const expected: string[] = []
    for (let end = fixtureEntries.length; end > 0; end -= 2) {
      expected.push(...fixtureEntries.slice(Math.max(0, end - 2), end).map(entry => entry.id))
    }
    assert.deepEqual(seen, expected)
  })

  it('keeps the FILE_TOO_LARGE and cursor error semantics', () => {
    assert.throws(
      () => pageOf(loose(undefined, { maxBytes: emptyBytes - 1 })),
      (error: { code?: string; message?: string }) =>
        error.code === 'FILE_TOO_LARGE' && /page metadata exceeds/.test(String(error.message)),
    )
    // 页为空且单条就装不下：预算刚好等于 metadata 开销，第一条必然溢出
    assert.throws(
      () => pageOf(loose(undefined, { limit: 1, maxBytes: emptyBytes })),
      (error: { code?: string; message?: string }) =>
        error.code === 'FILE_TOO_LARGE' && /entry exceeds/.test(String(error.message)),
    )
    assert.throws(
      () => pageOf(loose('not-a-cursor')),
      (error: { code?: string }) => error.code === 'INVALID_REQUEST',
    )
    // 合法的旧光标指向已被裁掉的锚点
    const anchorCursor = pageOf(loose(undefined, { limit: 5 })).beforeCursor
    assert.throws(
      () =>
        entriesPageFromEntries(fixtureHead, fixtureEntries.slice(2), loose(anchorCursor) as never, serializeFixture),
      (error: { code?: string }) => error.code === 'STALE_CURSOR',
    )
  })
})
