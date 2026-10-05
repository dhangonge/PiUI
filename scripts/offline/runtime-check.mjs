import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const app = path.join(root, 'lib/piui')
const require = createRequire(path.join(app, 'package.json'))
const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'piui-runtime-check-'))
let session
try {
  await fs.writeFile(path.join(dir, 'probe.txt'), 'offline-search-marker\n')
  for (const [name, args] of [['rg', ['--files', dir]], ['fd', ['--type', 'f', 'probe.txt', dir]]]) {
    const text = execFileSync(path.join(root, 'runtime/bin', name), args, { encoding: 'utf8', timeout: 10_000 })
    assert.ok(text.includes('probe.txt'), `${name} file search failed`)
  }
  console.log('PASS: bundled rg/fd file search (no download)')
  const pty = require('@lydell/node-pty')
  await new Promise((resolve, reject) => {
    let output = ''
    const child = pty.spawn(process.env.SHELL || (process.platform === 'android' ? '/system/bin/sh' : '/bin/sh'), ['-c', 'printf PIUI_OFFLINE_PTY_OK'], { cwd: dir, cols: 80, rows: 24, env: process.env })
    const timer = setTimeout(() => { child.kill(); reject(new Error('PTY timed out')) }, 10_000)
    child.onData(data => { output += data })
    child.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode === 0 && output.includes('PIUI_OFFLINE_PTY_OK')) resolve()
      else reject(new Error('PTY output/exit check failed'))
    })
    child.resize(100, 30)
  })
  console.log('PASS: native PTY spawn/output/resize/exit')
  const { loadPiSdk } = await import(pathToFileURL(path.join(app, 'packages/pi-worker/dist/sdk-host.js')).href)
  const { RealPiSession } = await import(pathToFileURL(path.join(app, 'packages/pi-worker/dist/runtime/real-session.js')).href)
  const loaded = await loadPiSdk()
  assert.equal(loaded.version, '1.0.3')
  session = await RealPiSession.open(dir, undefined, { agentDir: path.join(dir, 'agent') })
  await session.initializeExtensions()
  assert.ok(session.getRegistry().tools.length > 0)
  console.log('PASS: Pi SDK 1.0.3 module/session/extension initialization (no model request)')
} finally {
  await session?.dispose()
  await fs.rm(dir, { recursive: true, force: true })
}
