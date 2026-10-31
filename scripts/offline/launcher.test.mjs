import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
async function port() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const value = server.address().port
  await new Promise(resolve => server.close(resolve))
  return value
}

test(
  'portable launcher isolates instances, authenticates, and only stops its own process',
  { timeout: 120_000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piui-launcher-test-'))
    const app = path.join(root, 'lib/piui')
    fs.mkdirSync(path.join(root, 'deploy'), { recursive: true })
    fs.mkdirSync(path.join(app, 'web'), { recursive: true })
    fs.copyFileSync(path.join(repo, 'scripts/offline/launcher.mjs'), path.join(root, 'deploy/launcher.mjs'))
    fs.symlinkSync(path.join(repo, 'packages'), path.join(app, 'packages'))
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(app, 'node_modules'))
    fs.writeFileSync(path.join(app, 'web/index.html'), '<html>offline-fixture</html>')
    const homes = [path.join(root, 'instance-a'), path.join(root, 'instance-b')]
    const ports = [await port(), await port()]
    async function command(home, ...args) {
      return new Promise((resolve, reject) => {
        let output = ''
        const child = spawn(process.execPath, [path.join(root, 'deploy/launcher.mjs'), ...args], {
          cwd: root,
          env: { ...process.env, PIUI_HOME: home, PIUI_DRIVER: 'mock' },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        child.stdout.on('data', data => {
          output += data
        })
        child.stderr.on('data', data => {
          output += data
        })
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('Launcher test timed out'))
        }, 55_000)
        child.on('error', reject)
        child.on('exit', code => {
          clearTimeout(timer)
          resolve({ code, output })
        })
      })
    }
    try {
      for (let i = 0; i < homes.length; i++) {
        const start = await command(homes[i], 'start', '--port', String(ports[i]))
        assert.equal(start.code, 0, 'isolated launcher failed to start')
        assert.equal((await command(homes[i], 'status')).code, 0)
        assert.match((await command(homes[i], 'start')).output, /Already running/)
        assert.equal((await fetch(`http://127.0.0.1:${ports[i]}/api/v1/host/health`)).status, 401)
        assert.match(await (await fetch(`http://127.0.0.1:${ports[i]}/`)).text(), /offline-fixture/)
        const token = fs.readFileSync(path.join(homes[i], 'server/auth-token'), 'utf8').trim()
        const log = fs.readFileSync(path.join(homes[i], 'server.log'), 'utf8')
        assert.ok(!start.output.includes(token) && !log.includes(token), 'startup output must not expose the token')
        const response = await fetch(`http://127.0.0.1:${ports[i]}/api/v1/host/health`, {
          headers: { authorization: `Bearer ${token}` },
        })
        assert.equal(response.status, 200)
      }
      const a = fs.readFileSync(path.join(homes[0], 'server/auth-token'), 'utf8')
      const b = fs.readFileSync(path.join(homes[1], 'server/auth-token'), 'utf8')
      assert.ok(a !== b, 'separate instances must not share credentials')
      const foreign = await fetch(`http://127.0.0.1:${ports[1]}/api/v1/host/health`, {
        headers: { authorization: `Bearer ${a.trim()}` },
      })
      assert.equal(foreign.status, 401)
      assert.equal((await command(homes[0], 'stop')).code, 0)
      assert.equal((await command(homes[1], 'status')).code, 0)
      fs.writeFileSync(
        path.join(homes[0], 'server.pid.json'),
        JSON.stringify({ pid: process.pid, instance: 'not-a-server' }),
      )
      assert.equal((await command(homes[0], 'stop')).code, 1, 'must refuse to stop an unrelated PID')
      fs.unlinkSync(path.join(homes[0], 'server.pid.json'))
      assert.equal((await command(homes[0], 'start', '--port', '1')).code, 1)
    } finally {
      for (const home of homes) await command(home, 'stop')
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
)
