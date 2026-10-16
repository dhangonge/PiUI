import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

// 文件日志的目录在首次写日志时才解析，所以必须在任何 logToFile 之前设好。
const dataDir = mkdtempSync(path.join(tmpdir(), 'piui-client-log-'))
process.env.PIUI_DATA_DIR = dataDir

const { enableFileLogging } = await import('../logger.ts')
const { MAX_CLIENT_LOG_ENTRIES, reportClientErrors } = await import('./client-log.ts')

const stopFileLogging = enableFileLogging()

after(() => {
  stopFileLogging()
  rmSync(dataDir, { recursive: true, force: true })
})

function readLogFile(): string {
  const logsDir = path.join(dataDir, 'logs')
  const files = readdirSync(logsDir)
  return files.map(name => readFileSync(path.join(logsDir, name), 'utf8')).join('')
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'react',
    category: 'ui',
    operation: 'render',
    message: 'render exploded',
    stack: 'Error: render exploded\n    at Bomb',
    count: 1,
    at: '2026-04-22T15:00:00.000Z',
    appVersion: '0.6.21',
    url: 'https://piui.example/app',
    ...overrides,
  }
}

describe('reportClientErrors', () => {
  beforeEach(() => {
    process.env.PIUI_DATA_DIR = dataDir
  })

  it('rejects a payload without an entries array', () => {
    for (const body of [undefined, null, 'text', {}, { entries: 'nope' }]) {
      assert.throws(
        () => reportClientErrors(body),
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'INVALID_REQUEST')
          return true
        },
      )
    }
  })

  it('writes accepted entries into the server log file', () => {
    const accepted = reportClientErrors({ entries: [entry()] })
    assert.equal(accepted, 1)

    const log = readLogFile()
    assert.match(log, /\[client\] react ui\/render at 2026-04-22T15:00:00\.000Z/)
    assert.match(log, /app 0\.6\.21/)
    assert.match(log, /render exploded/)
  })

  it('counts only entries it can actually log', () => {
    const accepted = reportClientErrors({
      entries: [entry(), { message: '' }, null, 42, entry({ source: 'rejection' })],
    })
    assert.equal(accepted, 2)
  })

  it('caps the batch size', () => {
    const entries = Array.from({ length: MAX_CLIENT_LOG_ENTRIES + 10 }, () => entry())
    assert.equal(reportClientErrors({ entries }), MAX_CLIENT_LOG_ENTRIES)
  })

  it('flattens newlines so a client cannot forge log lines', () => {
    reportClientErrors({ entries: [entry({ message: 'first\n[client] forged', stack: undefined })] })

    const lines = readLogFile().split('\n').filter(Boolean)
    const forged = lines.filter(line => line.includes('forged'))
    assert.equal(forged.length, 1)
    assert.match(forged[0]!, /first \| \[client\] forged/)
  })

  it('truncates oversized fields instead of trusting them', () => {
    reportClientErrors({ entries: [entry({ message: `TRUNCSTART${'m'.repeat(5000)}` })] })

    const log = readLogFile()
    const line = log.split('\n').find(candidate => candidate.includes('TRUNCSTART'))!
    assert.ok(line.length < 1000, `expected a truncated line, got ${line.length} chars`)
    assert.match(line, /…/)
  })

  it('falls back to unknown for unrecognised sources', () => {
    reportClientErrors({ entries: [entry({ source: 'kernel' })] })
    assert.match(readLogFile(), /\[client\] unknown/)
  })
})
