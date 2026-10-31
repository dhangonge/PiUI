// Round-3 browser probe (fork-only diagnostic; not part of product code).
// Reuses the repo's own mock server + CDP helpers pattern. All servers, workers
// and browser profile live in a temp dir and are removed at the end.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createAppServer } from '../packages/server/src/http.ts'
import { attachEventWebSocket, closeEventWebSocket } from '../packages/server/src/ws.ts'
import { RuntimeSupervisor } from '../packages/server/src/pi/supervisor.ts'
import { SessionLeaseManager } from '../packages/server/src/pi/session-lease.ts'

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const staticRoot = path.join(repoRoot, 'packages/app/dist/')
const root = mkdtempSync(path.join(tmpdir(), 'piui-round3-browser-'))
const apps = []
const eventServers = []
let browser
let browserClosed
let cdp

const settle = (ms = 700) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await settle(100)
  }
}

async function startServer() {
  const home = path.join(root, 'alpha')
  mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const sessionFile = path.join(home, 'sessions', 'shared.jsonl')
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 1,
      id: 'shared',
      name: 'Alpha chat',
      cwd: home,
      timestamp: new Date().toISOString(),
    }) + '\n',
  )
  const token = randomUUID()
  const app = createAppServer({
    authToken: token,
    staticRoot,
    supervisor: new RuntimeSupervisor({
      leases: new SessionLeaseManager(path.join(home, 'leases')),
      worker: {
        handshakeTimeoutMs: 60_000,
        env: {
          PIUI_DRIVER: 'mock',
          PIUI_MOCK_DIR: home,
          PIUI_DATA_DIR: path.join(home, 'data'),
          PI_CODING_AGENT_DIR: path.join(home, 'agent'),
          PIUI_FILE_LOG: '0',
        },
      },
    }),
  })
  apps.push(app)
  eventServers.push(attachEventWebSocket(app.server, { authToken: token, eventHub: app.eventHub }))
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}`
  const post = async (route, params) => {
    const response = await fetch(url + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    assert.ok(response.ok, `fixture request: HTTP ${response.status}`)
    return response.json()
  }
  await post('/api/v1/pi/commands/session.open', { cwd: home, sessionFile })
  return { id: 'alpha', name: 'Alpha', url, token, home }
}

async function openBrowser() {
  const extraArgs = (process.env.CHROMIUM_EXTRA_ARGS || '').split(/\s+/).filter(Boolean)
  browser = spawn(
    process.env.CHROMIUM_BIN || 'chromium',
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${path.join(root, 'chromium')}`,
      ...extraArgs,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  browserClosed = new Promise(resolve => browser.once('exit', resolve))
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not expose DevTools')), 20_000)
    browser.once('error', reject)
    browser.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`Chromium exited: ${code}`))
    })
    browser.stderr.on('data', data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
  cdp = new WebSocket(endpoint)
  await new Promise((resolve, reject) => {
    cdp.once('open', resolve)
    cdp.once('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  const errors = []
  cdp.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text || 'exception')
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`))
    else request.resolve(message.result)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`DevTools timeout: ${method}`))
      }, 20_000)
      pending.set(id, { resolve, reject, timer, method })
      cdp.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  return { errors, call: (method, params) => send(method, params, sessionId) }
}

try {
  const output = process.env.PIUI_ROUND3_OUTPUT
  assert.ok(output, 'PIUI_ROUND3_OUTPUT is required')
  mkdirSync(output, { recursive: true })
  const a = await startServer()
  const { call, errors } = await openBrowser()
  await call('Page.enable')
  await call('Runtime.enable')
  const config = {
    i18nextLng: 'en',
    'piui-theme-preset': 'eucalyptus',
    'piui-theme-mode': 'light',
    'piui-servers': JSON.stringify([{ id: a.id, name: a.name, url: a.url, token: a.token, createdAt: 1 }]),
    'piui-active-server': a.id,
    [`srv:${a.id}:piui-last-directory`]: a.home,
    [`srv:${a.id}:piui-saved-directories`]: JSON.stringify([{ path: a.home, name: 'Alpha workspace', addedAt: 1 }]),
  }
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `for (const [k,v] of Object.entries(${JSON.stringify(config)})) localStorage.setItem(k,v)`,
  })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.ok(
      !result.exceptionDetails,
      result.exceptionDetails?.exception?.description?.split('\n')[0] || 'Browser evaluation failed',
    )
    return result.result.value
  }
  const pointer = async selector => {
    const point = await evaluate(
      `(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return null; el.scrollIntoView({block:'nearest',inline:'nearest'}); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    )
    assert.ok(point, `Missing pointer target ${selector}`)
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  }
  const key = async (key, code, windowsVirtualKeyCode) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  const capture = async name => {
    await settle()
    const rect = await evaluate(
      `(() => { const r=document.querySelector('[role="dialog"][data-dialog-open="true"]').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()`,
    )
    const shot = await call('Page.captureScreenshot', { format: 'png', clip: rect })
    writeFileSync(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'), { flag: 'wx' })
  }
  // Panel opacity + dialog transition internals, read from computed style (no assumption about React).
  const state = () =>
    evaluate(`(() => {
      const panel = document.querySelector('[role="tabpanel"]')
      const dialog = document.querySelector('[role="dialog"][data-dialog-open="true"]')
      const style = dialog ? getComputedStyle(dialog) : null
      return {
        tab: panel?.id ?? null,
        focus: document.activeElement?.id ?? null,
        opacity: panel ? getComputedStyle(panel).opacity : null,
        dialog: style
          ? {
              transitionProperty: style.transitionProperty,
              transitionDuration: style.transitionDuration,
              transform: style.transform,
            }
          : null,
        reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        theme: document.documentElement.dataset.mode,
      }
    })()`)
  const evidence = {
    scope:
      'Chromium built app, mock server, CDP pointer/keyboard; real browser frames for timers/WAAPI, not Android WebView or FPS',
    cases: [],
  }
  for (const [label, width, height, mobile] of [
    ['desktop', 1100, 800, false],
    ['mobile', 412, 915, true],
  ]) {
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    })
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await call('Page.navigate', { url: a.url + '/#/session/shared' })
    await waitFor(() => evaluate('!!document.querySelector("[data-chat-pane-root]")'), `${label} chat mount`)
    await evaluate(`window.dispatchEvent(new CustomEvent('titlebar:open-settings'))`)
    await waitFor(() => evaluate('!!document.querySelector("#settings-tab-appearance")'), `${label} settings mount`)
    await settle()
    // 装一次包装器：同一 document 内重复安装会嵌套，把一次调用记成多条。
    await evaluate(`(() => {
      window.__round3Animations = []
      if (window.__round3ProbeInstalled) return
      window.__round3ProbeInstalled = true
      const original = Element.prototype.animate
      Element.prototype.animate = function (frames, options) {
        const animation = original.call(this, frames, options)
        if (this.getAttribute('role') === 'tabpanel') {
          const row = { node: this, id: this.id, frames, options }
          window.__round3Animations.push(row)
        }
        return animation
      }
    })()`)
    const settledDialog = (await state()).dialog
    assert.ok(settledDialog, `${label} dialog present`)
    assert.ok(!settledDialog.transitionProperty.includes('all'), `${label} dialog must not transition all`)
    assert.ok(settledDialog.transitionProperty.includes('opacity'), `${label} dialog transitions opacity`)
    assert.ok(settledDialog.transitionProperty.includes('transform'), `${label} dialog transitions transform`)
    assert.equal(settledDialog.transitionDuration.split(',')[0].trim(), '0.2s')

    await pointer('#settings-tab-appearance')
    await waitFor(() => evaluate('!!document.querySelector("#settings-panel-appearance")'), `${label} appearance`)
    await capture(`${label}-appearance`)
    const appearance = await state()
    assert.equal(appearance.opacity, '1')
    const pointerAnimations = await evaluate('window.__round3Animations')
    const panelCount = await evaluate('document.querySelectorAll(\'[role="tabpanel"]\').length')
    console.log(
      `${label} diagnostic`,
      JSON.stringify({
        panelCount,
        rows: pointerAnimations.map(row => ({ id: row.id, frames: row.frames, options: row.options })),
      }),
    )
    assert.ok(pointerAnimations.length >= 1, `${label} pointer produces a tab fade`)
    for (const row of pointerAnimations) assert.equal(row.options.duration, 160, `${label} fade duration`)
    assert.deepEqual(
      pointerAnimations.at(-1).frames.map(frame => frame.opacity),
      [0.55, 1],
      `${label} last fade restarts from 0.55`,
    )

    await evaluate(`window.__round3Animations=[]; document.querySelector('#settings-tab-appearance').focus()`)
    await key('ArrowLeft', 'ArrowLeft', 37)
    await waitFor(() => evaluate('!!document.querySelector("#settings-panel-workspace")'), `${label} keyboard next tab`)
    await settle()
    const keyboardState = await state()
    assert.equal(keyboardState.focus, 'settings-tab-workspace')
    const keyboardAnimations = await evaluate('window.__round3Animations')
    assert.deepEqual(keyboardAnimations, [], `${label} keyboard switch must not animate`)

    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await waitFor(() => evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), 'reduced enabled')
    await settle()
    const reducedDialog = (await state()).dialog
    assert.equal(reducedDialog.transform, 'none', `${label} reduced dialog has no transform`)
    assert.ok(!reducedDialog.transitionProperty.includes('transform'), `${label} reduced dialog keeps opacity only`)
    assert.equal(reducedDialog.transitionDuration.trim(), '0.12s')
    await evaluate('window.__round3Animations=[]')
    await pointer('#settings-tab-appearance')
    await waitFor(
      () => evaluate('!!document.querySelector("#settings-panel-appearance")'),
      `${label} reduced appearance`,
    )
    await capture(`${label}-appearance-reduced`)
    const reducedState = await state()
    const reducedAnimations = await evaluate('window.__round3Animations')
    assert.deepEqual(reducedAnimations, [], `${label} reduced switch must not animate`)

    await key('Escape', 'Escape', 27)
    await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), `${label} escape close`)
    await evaluate(`window.dispatchEvent(new CustomEvent('titlebar:open-settings'))`)
    await waitFor(() => evaluate('!!document.querySelector("#settings-tab-servers")'), `${label} reopen`)
    await settle()
    assert.equal(await evaluate(`document.querySelector('[role="tabpanel"]').id`), 'settings-panel-servers')
    await key('Escape', 'Escape', 27)
    await waitFor(() => evaluate('!document.querySelector("[role=dialog]")'), `${label} reclose`)

    evidence.cases.push({
      label,
      width,
      height,
      settledDialog,
      appearance,
      pointerAnimations,
      keyboardState,
      keyboardAnimations,
      reducedDialog,
      reducedState,
      reducedAnimations,
    })
    console.log(`PASS: ${label} tab fade (pointer only), dialog properties, reduced mode, Escape, reopen`)
  }
  assert.deepEqual(errors, [], 'uncaught browser exceptions')
  writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' })
  console.log('PASS: round 3 browser probe')
} finally {
  cdp?.terminate()
  browser?.kill('SIGTERM')
  if (browserClosed) await browserClosed
  eventServers.forEach(server => closeEventWebSocket(server))
  await Promise.all(apps.map(app => app.dispose()))
  rmSync(root, { recursive: true, force: true })
}
