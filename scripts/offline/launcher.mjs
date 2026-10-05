import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
const home = path.resolve(process.env.PIUI_HOME || path.join(root, 'data'))
const app = path.join(root, 'lib/piui')
const pidFile = path.join(home, 'server.pid.json')
const configFile = path.join(home, 'server.json')
const logFile = path.join(home, 'server.log')
const launcher = fileURLToPath(import.meta.url)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// Keep the package isolated even if the invoking shell has a global Pi setup.
for (const key of ['PIUI_NATIVE_MODULES', 'PIUI_SDK_PATH', 'PIUI_USE_SYSTEM_PI', 'PIUI_AUTH_TOKEN', 'PIUI_WORKER_SELF', 'PIUI_WEB_ROOT', 'PI_CODING_AGENT_SESSION_DIR']) delete process.env[key]
Object.assign(process.env, {
  PI_CODING_AGENT_DIR: path.join(home, 'agent'), PI_CODING_AGENT_SESSION_DIR: path.join(home, 'sessions'),
  PIUI_DATA_DIR: path.join(home, 'server'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
  TMPDIR: path.join(home, 'tmp'),
})
process.env.SHELL ||= process.platform === 'android' ? '/system/bin/sh' : '/bin/sh'
process.umask(0o077)
for (const dir of [home, process.env.PI_CODING_AGENT_DIR, process.env.PI_CODING_AGENT_SESSION_DIR, process.env.PIUI_DATA_DIR, process.env.TMPDIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
function createOnce(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
}
createOnce(configFile, { host: '127.0.0.1', port: 8787 })
createOnce(path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), { theme: 'dark', packages: [], extensions: [] })
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
let [command = 'help', ...args] = process.argv.slice(2)

function record() {
  try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('Invalid PID record; inspect it manually, no process was signalled.') }
}
function owned(state) {
  if (!state || !Number.isSafeInteger(state.pid) || state.pid < 2 || typeof state.instance !== 'string') return false
  try {
    const argv = fs.readFileSync(`/proc/${state.pid}/cmdline`, 'utf8').split('\0')
    return argv.includes(launcher) && argv.includes('serve') && argv.includes(state.instance)
  } catch { return false }
}
function alive(state) {
  try { process.kill(state.pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
function clearOwnedRecord(instance) {
  if (record()?.instance === instance) fs.unlinkSync(pidFile)
}
function parseAddress(values) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] === '--listen' && values[i + 1]) config.host = values[++i]
    else if (values[i] === '--port' && values[i + 1]) config.port = Number(values[++i])
    else throw new Error(`Unknown option: ${values[i]}`)
  }
  if (!['127.0.0.1', '0.0.0.0', '::1', '::', 'localhost'].includes(config.host)) throw new Error('Unsupported listen address')
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Port must be 1024..65535')
  return config
}
function summary(state) {
  const address = state.host === '0.0.0.0' || state.host === '::' ? '<this-device-LAN-IP>' : state.host
  console.log(`PiUI: http://${address}:${state.port}`)
  console.log(`Token file (value not printed): ${path.join(process.env.PIUI_DATA_DIR, 'auth-token')}`)
  console.log(`Pi configuration: ${process.env.PI_CODING_AGENT_DIR}`)
  console.log(`Log: ${logFile}`)
  if (address.startsWith('<')) console.log('LAN access enabled explicitly. Use a trusted LAN/VPN; do not expose this port directly to the Internet.')
}
async function healthy(state) {
  try {
    const token = fs.readFileSync(path.join(process.env.PIUI_DATA_DIR, 'auth-token'), 'utf8').trim()
    const host = state.host === '::' || state.host === '::1' ? '[::1]' : '127.0.0.1'
    const response = await fetch(`http://${host}:${state.port}/api/v1/host/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1200) })
    const data = await response.json()
    return response.ok && data.protocolVersion === 1
  } catch { return false }
}

try {
  if (command === 'pi') {
    const child = spawn(process.execPath, [path.join(app, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), ...args], { stdio: 'inherit', env: process.env })
    child.on('error', () => { console.error('Pi CLI could not start'); process.exitCode = 1 })
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
  } else if (command === 'doctor') {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
    console.log(`Bundle: ${manifest.target}; Pi ${manifest.sdkVersion}; Node ${process.version} (${process.platform}/${process.arch})`)
    if (process.arch !== 'arm64' || process.platform !== (manifest.target === 'termux-arm64' ? 'android' : 'linux')) throw new Error('Wrong bundle for this device')
    const result = spawnSync(process.execPath, [path.join(root, 'deploy/runtime-check.mjs')], { stdio: 'inherit', env: process.env })
    if (result.error || result.status !== 0) throw new Error('Runtime checks failed')
  } else if (command === 'serve') {
    const [instance, host, port] = args
    const state = record()
    if (!state || state.instance !== instance) throw new Error('Missing startup reservation')
    const readyFile = `${pidFile}.${instance}.tmp`
    fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, instance, host, port: Number(port) }), { flag: 'wx', mode: 0o600 })
    fs.renameSync(readyFile, pidFile)
    process.on('exit', () => { try { clearOwnedRecord(instance) } catch {} })
    const { startPiUiServer } = await import(pathToFileURL(path.join(app, 'packages/server/dist/start.js')).href)
    await startPiUiServer({ host, port: Number(port), webRoot: path.join(app, 'web') })
  } else if (command === 'start' || command === 'run') {
    parseAddress(args)
    const previous = record()
    if (previous && alive(previous)) {
      if (!owned(previous)) throw new Error('PID record belongs to an unverified process; refusing to replace it')
      console.log('Already running'); summary(previous)
    } else {
      if (previous) fs.unlinkSync(pidFile)
      const instance = randomUUID()
      fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, instance }), { flag: 'wx', mode: 0o600 })
      const foreground = command === 'run'
      const fd = foreground ? undefined : fs.openSync(logFile, 'a', 0o600)
      const child = spawn(process.execPath, [launcher, 'serve', instance, config.host, String(config.port)], {
        detached: !foreground, stdio: foreground ? 'inherit' : ['ignore', fd, fd], env: process.env,
      })
      if (fd !== undefined) fs.closeSync(fd)
      child.on('error', () => { clearOwnedRecord(instance); console.error('Server process could not start'); process.exitCode = 1 })
      if (foreground) {
        for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
        child.on('exit', code => { clearOwnedRecord(instance); process.exitCode = code ?? 1 })
      } else {
        child.unref()
        const deadline = Date.now() + 45_000
        let ready = false
        while (Date.now() < deadline) {
          const state = record()
          if (state?.instance === instance && state.pid === child.pid && owned(state) && await healthy(state)) { ready = true; summary(state); break }
          if (!state || state.instance !== instance || (state.pid === child.pid && !alive(state))) break
          await delay(200)
        }
        if (!ready) throw new Error(`Server did not become healthy. Inspect ${logFile}; use 'status' and 'stop' before retrying.`)
      }
    }
  } else if (command === 'status') {
    const state = record()
    if (!owned(state)) { console.log('Not running (no verified process)'); process.exitCode = 1 }
    else {
      const ready = await healthy(state)
      console.log(ready ? 'Running; health OK' : 'Running; health check failed')
      summary(state)
      if (!ready) process.exitCode = 1
    }
  } else if (command === 'stop') {
    const state = record()
    if (!state) console.log('Not running')
    else if (!alive(state)) { clearOwnedRecord(state.instance); console.log('Removed stale PID record') }
    else {
      if (!owned(state)) throw new Error('Cannot verify process ownership; no signal sent')
      process.kill(state.pid, 'SIGTERM')
      const deadline = Date.now() + 10_000
      while (owned(state) && Date.now() < deadline) await delay(100)
      if (owned(state)) throw new Error('Server has not stopped; no force-kill was performed')
      clearOwnedRecord(state.instance); console.log('Stopped')
    }
  } else if (command === 'paths') {
    console.log(`Data: ${home}\nConfig: ${configFile}\nToken file: ${path.join(process.env.PIUI_DATA_DIR, 'auth-token')}\nLog: ${logFile}`)
  } else {
    console.log('Usage: ./piui doctor | start [--listen 0.0.0.0] [--port 8787] | run | status | stop | paths\n       ./pi [Pi CLI arguments]\nDefault: loopback only; each extracted copy has independent data. Set PIUI_HOME for a persistent data directory.')
    if (command !== 'help' && command !== '--help') process.exitCode = 1
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Deployment command failed')
  process.exitCode = 1
}
