// Run after npm run build: node --import tsx scripts/smoke-android-ui.mjs
// Requires Chromium on PATH; all servers, workers and browser storage are temporary.
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

const root = mkdtempSync(path.join(tmpdir(), 'piui-ui-smoke-'))
const staticRoot = fileURLToPath(new URL('../packages/app/dist/', import.meta.url))
const apps = []
const eventServers = []
let browser
let browserClosed
let cdp
let inspectBrowser

async function waitFor(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function startServer(id, name) {
  const home = path.join(root, id)
  mkdirSync(path.join(home, 'sessions'), { recursive: true })
  const sessionFile = path.join(home, 'sessions', 'shared.jsonl')
  writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 1, id: 'shared', name: `${name} chat`, cwd: home, timestamp: new Date().toISOString() }) + '\n')
  const token = randomUUID()
  const app = createAppServer({ authToken: token, staticRoot, supervisor: new RuntimeSupervisor({
    leases: new SessionLeaseManager(path.join(home, 'leases')),
    worker: { handshakeTimeoutMs: 60_000, env: { PIUI_DRIVER: 'mock', PIUI_MOCK_DIR: home,
      PIUI_DATA_DIR: path.join(home, 'data'), PI_CODING_AGENT_DIR: path.join(home, 'agent'), PIUI_FILE_LOG: '0' } },
  }) })
  apps.push(app)
  if (process.env.PIUI_SMOKE_DEBUG) app.server.on('request', req => console.log(id, req.method, new URL(req.url, 'http://localhost').pathname))
  eventServers.push(attachEventWebSocket(app.server, { authToken: token, eventHub: app.eventHub }))
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}`
  const post = async (route, params) => {
    const response = await fetch(url + route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(params) })
    assert.ok(response.ok, `fixture request: HTTP ${response.status}`)
    return response.json()
  }
  await post('/api/v1/pi/commands/session.open', { cwd: home, sessionFile })
  return { id, name, url, token, home, post, publishUi: event => app.eventHub.publish({ kind: 'session', id: 'shared' }, 'extension.ui', event) }
}

async function openBrowser() {
  browser = spawn(process.env.CHROMIUM_BIN || 'chromium', [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${path.join(root, 'chromium')}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  browserClosed = new Promise(resolve => browser.once('exit', resolve))
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not expose DevTools')), 20_000)
    browser.once('error', reject)
    browser.once('exit', code => { clearTimeout(timer); reject(new Error(`Chromium exited: ${code}`)) })
    browser.stderr.on('data', data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
  })
  cdp = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { cdp.once('open', resolve); cdp.once('error', reject) })
  let nextId = 0
  const pending = new Map()
  const errors = []
  cdp.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text)
      if (process.env.PIUI_SMOKE_DEBUG) console.log('Browser exception:', message.params.exceptionDetails.exception?.description?.split('\n')[0])
    }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`))
    else request.resolve(message.result)
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)) }, 20_000)
    pending.set(id, { resolve, reject, timer, method })
    cdp.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  return { errors, call: (method, params) => send(method, params, sessionId) }
}

try {
  const [a, b] = await Promise.all([startServer('alpha', 'Alpha'), startServer('beta', 'Beta')])
  const { call, errors } = await openBrowser()
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true })
  const config = {
    'i18nextLng': 'en',
    'piui-servers': JSON.stringify([a, b].map(({ id, name, url, token }) => ({ id, name, url, token, createdAt: Date.now() }))),
    'piui-active-server': a.id,
    'piui-multi-server': JSON.stringify({ enabled: true, subscribedServerIds: [a.id, b.id], focusedServerId: a.id }),
    [`srv:${a.id}:piui-last-directory`]: a.home,
    [`srv:${b.id}:piui-last-directory`]: b.home,
    [`srv:${a.id}:piui-saved-directories`]: JSON.stringify([{ path: a.home, name: 'Alpha workspace', addedAt: Date.now() }]),
    [`srv:${b.id}:piui-saved-directories`]: JSON.stringify([{ path: b.home, name: 'Beta workspace', addedAt: Date.now() }]),
  }
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `for (const [k,v] of Object.entries(${JSON.stringify(config)})) localStorage.setItem(k,v)` })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description?.split('\n')[0] || 'Browser evaluation failed')
    return result.result.value
  }
  inspectBrowser = () => evaluate(`(() => {
    const panes = [...document.querySelectorAll('[data-chat-pane-root]')];
    const props = [];
    const seen = new Set();
    const walk = f => { if (!f || seen.has(f)) return; seen.add(f); const p = f.memoizedProps; if (p && Array.isArray(p.items)) props.push({ session: p.sessionId, count: p.items.length, kinds: p.items.map(i => i.kind || i.type), load: p.loadState }); walk(f.child); walk(f.sibling); };
    for (const pane of panes) walk(pane[Object.keys(pane).find(k => k.startsWith('__reactFiber'))]);
    return JSON.stringify({ hash: location.hash, active: localStorage.getItem('piui-active-server'), panes: panes.map(p => ({ text: p.innerText.slice(-500), height: p.clientHeight })), props });
  })()`)
  await call('Page.navigate', { url: a.url + '/#/session/alpha%3A%3Ashared' })
  await waitFor(() => evaluate('!!document.querySelector("[data-chat-pane-root]")'), 'mobile chat mount')
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Open sidebar"]')`), 'sidebar toggle')
  await evaluate(`document.querySelector('[aria-label="Open sidebar"]').click()`)
  await waitFor(() => evaluate('document.body.innerText.includes("Alpha chat") && document.body.innerText.includes("Beta chat")'), 'both server session lists')
  console.log('PASS: 412x915 mobile sidebar displays both servers and same-ID sessions')

  await evaluate(`[...document.querySelectorAll('span,p')].find(e => e.textContent === 'Beta chat').click()`)
  await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]')?.click()`)
  await waitFor(() => evaluate('localStorage.getItem("piui-active-server") === "beta" && !!document.querySelector("[data-chat-pane-root] textarea")'), 'Beta route and composer')
  await evaluate('document.querySelector("[data-chat-pane-root] textarea").focus()')
  await waitFor(() => evaluate('document.activeElement?.tagName === "TEXTAREA"'), 'composer focus')
  await call('Input.insertText', { text: 'browser-beta-marker' })
  if (process.env.PIUI_SMOKE_DEBUG) console.log(await evaluate(`JSON.stringify({ body: document.body.innerText.slice(-2200), inputs: [...document.querySelectorAll('textarea')].map(e => ({ value: e.value, disabled: e.disabled })), buttons: [...document.querySelectorAll('button[aria-label]')].map(e => ({ label: e.getAttribute('aria-label'), disabled: e.disabled })) })`))
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`), 'send enabled')
  await evaluate(`document.querySelector('[aria-label="Send message"]').click()`)
  await waitFor(async () => {
    const result = await b.post('/api/v1/pi/sessions/shared/commands/branch.get', {})
    return !result.data?.checkpoint?.liveMessage && result.data?.items?.some(entry => entry.message?.role === 'assistant' && JSON.stringify(entry).includes('browser-beta-marker'))
  }, 'Beta prompt persisted')
  const alphaBranch = await a.post('/api/v1/pi/sessions/shared/commands/branch.get', {})
  assert.ok(!JSON.stringify(alphaBranch).includes('browser-beta-marker'))
  console.log('PASS: browser prompt reaches Beta only; Alpha has no Beta message')
  if (process.env.PIUI_SMOKE_DEBUG) console.log('Before split:', await inspectBrowser())
  for (const [owner, foreign] of [[a, b], [b, a]]) {
    const paths = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(`srv:${owner.id}:piui-saved-directories`)}) || '[]').map(item => item.path)`)
    assert.ok(!paths.includes(foreign.home), 'selecting a foreign session must not copy its project')
  }
  console.log('PASS: project records remain in their owning server after cross-server navigation')

  a.publishUi({ type: 'state', sessionId: 'shared', patch: { kind: 'widget', key: 'todo', placement: 'aboveEditor', lines: ['Alpha-only task'] } })
  b.publishUi({ type: 'state', sessionId: 'shared', patch: { kind: 'widget', key: 'todo', placement: 'aboveEditor', lines: ['Beta-only task'] } })
  await waitFor(() => evaluate(`document.querySelector('[data-chat-pane-root]').innerText.includes('Beta-only task')`), 'composer widget')
  assert.equal(await evaluate(`document.querySelector('[data-chat-pane-root]').innerText.includes('Alpha-only task')`), false)
  console.log('PASS: widget snapshot is visible beside the composer and isolated by owner')

  const longOption = 'A long option that is displayed once. '.repeat(15)
  b.publishUi({ type: 'requested', request: { requestId: 'browser-question', sessionId: 'shared', kind: 'select', title: 'Browser question', options: ['Short option', longOption], createdAt: new Date().toISOString() } })
  await waitFor(() => evaluate(`!!document.querySelector('button[aria-label="Fullscreen"]')`), 'question fullscreen control')
  await evaluate(`document.querySelector('button[aria-label="Fullscreen"]').click()`)
  await waitFor(() => evaluate(`!!document.querySelector('[role="dialog"][aria-label="Browser question"]')`), 'question fullscreen')
  await waitFor(() => evaluate(`(() => { const r = document.querySelector('[role="dialog"][aria-label="Browser question"]').getBoundingClientRect(); return r.width >= 410 && r.height >= 850; })()`), 'fullscreen animation fills the safe mobile viewport', 5_000)
  assert.equal(await evaluate(`[...document.querySelectorAll('[role="dialog"] span')].filter(e => e.textContent === ${JSON.stringify(longOption)}).length`), 1)
  const questionScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  const questionScreenshotPath = path.join(tmpdir(), `piui-question-fullscreen-${Date.now()}.png`)
  writeFileSync(questionScreenshotPath, Buffer.from(questionScreenshot.data, 'base64'), { flag: 'wx' })
  console.log(`Question screenshot: ${questionScreenshotPath}`)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(() => evaluate(`!document.querySelector('[role="dialog"][aria-label="Browser question"]')`), 'exit question fullscreen')
  assert.ok(await evaluate(`document.body.innerText.includes('Browser question')`), 'exiting fullscreen must not cancel the question')
  b.publishUi({ type: 'settled', sessionId: 'shared', requestId: 'browser-question', reason: 'user_cancelled' })
  console.log('PASS: mobile questionnaire fills the screen, has one option copy, and preserves the request on Escape')

  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Split pane"]')`), 'split control')
  await evaluate(`document.querySelector('[aria-label="Split pane"]').click()`)
  await waitFor(() => evaluate('document.querySelectorAll("[data-chat-pane-root]").length === 2'), 'split panes')
  await call('Page.navigate', { url: a.url + '/#/session/alpha%3A%3Ashared' })
  await waitFor(() => evaluate('document.querySelectorAll("[data-chat-pane-root]").length === 2 && localStorage.getItem("piui-active-server") === "alpha"'), 'Alpha focused in split view')
  await waitFor(() => evaluate('[...document.querySelectorAll("[data-chat-pane-root]")].some(p => p.innerText.includes("browser-beta-marker"))'), 'background Beta retained')
  const selected = await evaluate(`(() => {
    const pane = [...document.querySelectorAll('[data-chat-pane-root]')].find(p => p.innerText.includes('browser-beta-marker'));
    let owner;
    const button = pane.querySelector('button');
    button.addEventListener('click', e => { owner = localStorage.getItem('piui-active-server'); e.preventDefault(); e.stopPropagation(); }, { once: true });
    button.click();
    return owner;
  })()`)
  assert.equal(selected, 'beta', 'capture-phase focus must select the owner before child actions')
  assert.deepEqual(errors, [], 'uncaught browser exceptions')
  const screenshot = await call('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = process.env.PIUI_SMOKE_SCREENSHOT || path.join(tmpdir(), `piui-smoke-${Date.now()}.png`)
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  console.log('PASS: split-pane first click selects its server before child handlers; no uncaught exceptions')
  console.log(`Screenshot: ${screenshotPath}`)
} catch (error) {
  if (process.env.PIUI_SMOKE_DEBUG && inspectBrowser) console.log('Browser state:', await inspectBrowser())
  throw error
} finally {
  cdp?.terminate()
  browser?.kill('SIGTERM')
  if (browserClosed) await browserClosed
  eventServers.forEach(server => closeEventWebSocket(server))
  await Promise.all(apps.map(app => app.dispose()))
  rmSync(root, { recursive: true, force: true })
}
