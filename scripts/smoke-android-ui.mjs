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
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 1,
      id: 'shared',
      name: `${name} chat`,
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
  if (process.env.PIUI_SMOKE_DEBUG)
    app.server.on('request', req => console.log(id, req.method, new URL(req.url, 'http://localhost').pathname))
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
  return {
    id,
    name,
    url,
    token,
    home,
    post,
    publishUi: event => app.eventHub.publish({ kind: 'session', id: 'shared' }, 'extension.ui', event),
  }
}

async function openBrowser() {
  // CHROMIUM_EXTRA_ARGS 用于无特权/容器环境（CI 里通常要给 --no-sandbox）。
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
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text)
      if (process.env.PIUI_SMOKE_DEBUG)
        console.log('Browser exception:', message.params.exceptionDetails.exception?.description?.split('\n')[0])
    }
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
  const [a, b] = await Promise.all([startServer('alpha', 'Alpha'), startServer('beta', 'Beta')])
  const { call, errors } = await openBrowser()
  await call('Page.enable')
  await call('Runtime.enable')
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true })
  const config = {
    i18nextLng: 'en',
    'piui-servers': JSON.stringify(
      [a, b].map(({ id, name, url, token }) => ({ id, name, url, token, createdAt: Date.now() })),
    ),
    'piui-active-server': a.id,
    'piui-multi-server': JSON.stringify({ enabled: true, subscribedServerIds: [a.id, b.id], focusedServerId: a.id }),
    [`srv:${a.id}:piui-last-directory`]: a.home,
    [`srv:${b.id}:piui-last-directory`]: b.home,
    [`srv:${a.id}:piui-saved-directories`]: JSON.stringify([
      { path: a.home, name: 'Alpha workspace', addedAt: Date.now() },
    ]),
    [`srv:${b.id}:piui-saved-directories`]: JSON.stringify([
      { path: b.home, name: 'Beta workspace', addedAt: Date.now() },
    ]),
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
  inspectBrowser = () =>
    evaluate(`(() => {
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
  await waitFor(
    () => evaluate('document.body.innerText.includes("Alpha chat") && document.body.innerText.includes("Beta chat")'),
    'both server session lists',
  )
  console.log('PASS: 412x915 mobile sidebar displays both servers and same-ID sessions')

  await evaluate(`[...document.querySelectorAll('span,p')].find(e => e.textContent === 'Beta chat').click()`)
  await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]')?.click()`)
  await waitFor(
    () =>
      evaluate(
        'localStorage.getItem("piui-active-server") === "beta" && !!document.querySelector("[data-chat-pane-root] textarea")',
      ),
    'Beta route and composer',
  )
  await evaluate('document.querySelector("[data-chat-pane-root] textarea").focus()')
  await waitFor(() => evaluate('document.activeElement?.tagName === "TEXTAREA"'), 'composer focus')
  await call('Input.insertText', { text: 'browser-beta-marker' })
  if (process.env.PIUI_SMOKE_DEBUG)
    console.log(
      await evaluate(
        `JSON.stringify({ body: document.body.innerText.slice(-2200), inputs: [...document.querySelectorAll('textarea')].map(e => ({ value: e.value, disabled: e.disabled })), buttons: [...document.querySelectorAll('button[aria-label]')].map(e => ({ label: e.getAttribute('aria-label'), disabled: e.disabled })) })`,
      ),
    )
  await waitFor(
    () => evaluate(`!!document.querySelector('[aria-label="Send message"]:not(:disabled)')`),
    'send enabled',
  )
  await evaluate(`document.querySelector('[aria-label="Send message"]').click()`)
  await waitFor(async () => {
    const result = await b.post('/api/v1/pi/sessions/shared/commands/branch.get', {})
    return (
      !result.data?.checkpoint?.liveMessage &&
      result.data?.items?.some(
        entry => entry.message?.role === 'assistant' && JSON.stringify(entry).includes('browser-beta-marker'),
      )
    )
  }, 'Beta prompt persisted')
  const alphaBranch = await a.post('/api/v1/pi/sessions/shared/commands/branch.get', {})
  assert.ok(!JSON.stringify(alphaBranch).includes('browser-beta-marker'))
  console.log('PASS: browser prompt reaches Beta only; Alpha has no Beta message')
  if (process.env.PIUI_SMOKE_DEBUG) console.log('Before split:', await inspectBrowser())
  for (const [owner, foreign] of [
    [a, b],
    [b, a],
  ]) {
    const paths = await evaluate(
      `JSON.parse(localStorage.getItem(${JSON.stringify(`srv:${owner.id}:piui-saved-directories`)}) || '[]').map(item => item.path)`,
    )
    assert.ok(!paths.includes(foreign.home), 'selecting a foreign session must not copy its project')
  }
  console.log('PASS: project records remain in their owning server after cross-server navigation')

  a.publishUi({
    type: 'state',
    sessionId: 'shared',
    patch: {
      kind: 'widget',
      key: 'rpiv-todos',
      placement: 'aboveEditor',
      lines: ['● Todos (0/1)', '└─ ○ Alpha-only task', ''],
    },
  })
  b.publishUi({
    type: 'state',
    sessionId: 'shared',
    patch: {
      kind: 'widget',
      key: 'rpiv-todos',
      placement: 'aboveEditor',
      lines: ['● Todos (0/1)', '└─ ○ Beta-only task', ''],
    },
  })
  b.publishUi({
    type: 'state',
    sessionId: 'shared',
    patch: { kind: 'widget', key: 'input-status', placement: 'aboveEditor', lines: ['Model: opus'] },
  })
  await waitFor(
    () => evaluate(`document.querySelector('[data-chat-pane-root]').innerText.includes('Beta-only task')`),
    'composer widget',
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-chat-pane-root]').innerText.includes('Alpha-only task')`),
    false,
  )
  assert.equal(
    await evaluate(`document.querySelector('[data-chat-pane-root]').innerText.includes('Model: opus')`),
    false,
  )
  console.log(
    'PASS: only the todo widget is mirrored beside the composer; other widgets stay out and owners stay isolated',
  )
  // Width parity with the composer itself (OpenCodeUI layout), and the small type scale.
  const todoLayout = await evaluate(`(() => {
    const card = document.querySelector('[data-todo-widget]')
    const composer = document.querySelector('[data-composer-width] [data-input-box]')
    if (!card || !composer) return null
    const c = card.getBoundingClientRect()
    const i = composer.getBoundingClientRect()
    return { left: c.left, right: c.right, width: c.width, inputLeft: i.left, inputRight: i.right, inputWidth: i.width, fontSize: getComputedStyle(card).fontSize, dock: document.querySelector('[data-composer-dock]')?.dataset.composerDock }
  })()`)
  assert.ok(todoLayout, 'todo card and composer must both be mounted')
  assert.ok(
    Math.abs(todoLayout.left - todoLayout.inputLeft) < 2 && Math.abs(todoLayout.right - todoLayout.inputRight) < 2,
    `todo card must share the composer width: ${JSON.stringify(todoLayout)}`,
  )
  assert.equal(todoLayout.fontSize, '12px')
  assert.equal(todoLayout.dock, 'expanded')
  console.log('PASS: todo card matches the composer width and uses the small type scale')

  // Collapsed dock: scroll the chat away from the bottom; the card must ride along.
  // Make sure the mobile sidebar overlay is out of the way first.
  if (await evaluate(`!!document.querySelector('[aria-label="Collapse sidebar"]')`)) {
    await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]').click()`)
  }
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Open sidebar"]')`), 'chat surface visible')
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 360, deviceScaleFactor: 1, mobile: true })
  // Scroll the pane with a wheel gesture (marks the scroll as user-driven, so follow-stick
  // does not pull it back) and a domain scroll event so the dock sees the departure.
  await evaluate(
    `(() => { const el = document.querySelector('[data-chat-pane-root] [data-chat-scroll-root]'); el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true, cancelable: true })); el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })()`,
  )
  await waitFor(
    () => evaluate(`(document.querySelector('[data-chat-pane-root] [data-chat-scroll-root]')?.scrollTop ?? 0) < 20`),
    'chat scrolled away from bottom',
  )
  // Blur the composer the way a real tap does (a synthesized mouse click does not move focus).
  // The dock also waits out the 4s "just cleared" buffer before collapsing.
  await evaluate(`document.querySelector('[data-chat-pane-root] textarea')?.blur()`)
  await waitFor(() => evaluate(`document.activeElement?.tagName !== 'TEXTAREA'`), 'composer blurred')
  await waitFor(
    () => evaluate(`document.querySelector('[data-composer-dock]')?.dataset.composerDock === 'collapsed'`),
    'collapsed input dock',
    12_000,
  )
  // The card must land directly above the collapsed action row + capsule.
  await waitFor(
    () =>
      evaluate(
        `(() => { const card = document.querySelector('[data-todo-widget]'); const actions = document.querySelector('[data-floating-actions]'); if (!card || !actions) return false; return Math.abs(actions.getBoundingClientRect().top - card.getBoundingClientRect().bottom) < 16 })()`,
      ),
    'todo card settled above the actions row',
    5_000,
  )
  assert.equal(
    await evaluate(`!!document.querySelector('[aria-label="Collapse sidebar"]')`),
    false,
    'the tap must not reopen the sidebar',
  )
  const collapsedLayout = await evaluate(`(() => {
    const card = document.querySelector('[data-todo-widget]')
    const actions = document.querySelector('[data-floating-actions]')
    const dock = document.querySelector('[data-composer-dock]')
    if (!card || !actions || !dock) return null
    const c = card.getBoundingClientRect()
    const a = actions.getBoundingClientRect()
    const d = dock.getBoundingClientRect()
    return { cardTop: c.top, cardBottom: c.bottom, cardWidth: c.width, actionsTop: a.top, dockBottom: d.bottom, viewportHeight: window.innerHeight }
  })()`)
  assert.ok(collapsedLayout, 'todo card must stay mounted while the input bar is collapsed')
  assert.ok(
    collapsedLayout.cardTop >= 0 && collapsedLayout.cardBottom <= collapsedLayout.viewportHeight,
    `todo card must stay fully on screen: ${JSON.stringify(collapsedLayout)}`,
  )
  assert.ok(
    collapsedLayout.cardBottom > collapsedLayout.viewportHeight * 0.4,
    `todo card must stay in the lower part of the screen: ${JSON.stringify(collapsedLayout)}`,
  )
  assert.ok(
    collapsedLayout.cardBottom <= collapsedLayout.actionsTop + 16,
    `todo card must stay docked above the collapsed controls: ${JSON.stringify(collapsedLayout)}`,
  )
  // The card stays interactive while the input bar is hidden.
  assert.ok(
    await evaluate(`!!document.querySelector('[data-todo-widget] button[aria-expanded="true"]')`),
    'todo card must start expanded',
  )
  await evaluate(
    `document.querySelector('[data-composer-dock]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`,
  )
  await evaluate(`document.querySelector('[data-todo-widget] button').click()`)
  await waitFor(
    () => evaluate(`!!document.querySelector('[data-todo-widget] button[aria-expanded="false"]')`),
    'todo card collapses while docked',
  )
  // Wait for the collapse transition to settle before measuring.
  let previousHeight = -1
  await waitFor(
    async () => {
      const height = await evaluate(`document.querySelector('[data-todo-widget]').getBoundingClientRect().height`)
      const stable = Math.abs(height - previousHeight) < 0.5
      previousHeight = height
      return stable
    },
    'todo collapse animation settled',
    5_000,
  )
  const collapsedCardHeight = previousHeight
  assert.ok(
    collapsedCardHeight > 0 && collapsedCardHeight < 60,
    `collapsed todo card must keep its header only: ${collapsedCardHeight}`,
  )
  await evaluate(`document.querySelector('[data-todo-widget] button').click()`)
  await waitFor(
    () => evaluate(`!!document.querySelector('[data-todo-widget] button[aria-expanded="true"]')`),
    'todo card re-expands while docked',
  )
  console.log('PASS: todo card stays interactive and animated while the input bar is hidden')
  const collapsedScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  const collapsedScreenshotPath = path.join(tmpdir(), `piui-todo-collapsed-${Date.now()}.png`)
  writeFileSync(collapsedScreenshotPath, Buffer.from(collapsedScreenshot.data, 'base64'), { flag: 'wx' })
  console.log(`Collapsed dock screenshot: ${collapsedScreenshotPath}`)
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true })
  await evaluate(
    `(() => { const el = document.querySelector('[data-chat-pane-root] [data-chat-scroll-root]'); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })()`,
  )
  await waitFor(
    () => evaluate(`document.querySelector('[data-composer-dock]')?.dataset.composerDock === 'expanded'`),
    'expanded input dock after returning to the bottom',
    9_000,
  )
  console.log('PASS: todo card stays docked above the collapsed composer')
  await evaluate(`document.querySelector('[aria-label="Collapse sidebar"]')?.click()`)
  await waitFor(
    () => evaluate(`!document.querySelector('[aria-label="Collapse sidebar"]')`),
    'composer visible for widget screenshot',
  )
  const todoScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  const todoScreenshotPath = path.join(tmpdir(), `piui-todo-widget-${Date.now()}.png`)
  writeFileSync(todoScreenshotPath, Buffer.from(todoScreenshot.data, 'base64'), { flag: 'wx' })
  console.log(`Todo widget screenshot: ${todoScreenshotPath}`)

  const longOption = 'A long option that is displayed once. '.repeat(15)
  b.publishUi({
    type: 'requested',
    request: {
      requestId: 'browser-question',
      sessionId: 'shared',
      kind: 'select',
      title: 'Browser question',
      options: ['Short option', longOption],
      createdAt: new Date().toISOString(),
    },
  })
  await waitFor(
    () => evaluate(`!!document.querySelector('button[aria-label="Fullscreen"]')`),
    'question fullscreen control',
  )
  await evaluate(`document.querySelector('button[aria-label="Fullscreen"]').click()`)
  await waitFor(
    () => evaluate(`!!document.querySelector('[role="dialog"][aria-label="Browser question"]')`),
    'question fullscreen',
  )
  await waitFor(
    () =>
      evaluate(
        `(() => { const r = document.querySelector('[role="dialog"][aria-label="Browser question"]').getBoundingClientRect(); return r.width >= 410 && r.height >= 850; })()`,
      ),
    'fullscreen animation fills the safe mobile viewport',
    5_000,
  )
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('[role="dialog"] span')].filter(e => e.textContent === ${JSON.stringify(longOption)}).length`,
    ),
    1,
  )
  const questionScreenshot = await call('Page.captureScreenshot', { format: 'png' })
  const questionScreenshotPath = path.join(tmpdir(), `piui-question-fullscreen-${Date.now()}.png`)
  writeFileSync(questionScreenshotPath, Buffer.from(questionScreenshot.data, 'base64'), { flag: 'wx' })
  console.log(`Question screenshot: ${questionScreenshotPath}`)
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await waitFor(
    () => evaluate(`!document.querySelector('[role="dialog"][aria-label="Browser question"]')`),
    'exit question fullscreen',
  )
  assert.ok(
    await evaluate(`document.body.innerText.includes('Browser question')`),
    'exiting fullscreen must not cancel the question',
  )
  b.publishUi({ type: 'settled', sessionId: 'shared', requestId: 'browser-question', reason: 'user_cancelled' })
  console.log('PASS: mobile questionnaire fills the screen, has one option copy, and preserves the request on Escape')

  await call('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false })
  await waitFor(() => evaluate(`!!document.querySelector('[aria-label="Split pane"]')`), 'split control')
  await evaluate(`document.querySelector('[aria-label="Split pane"]').click()`)
  await waitFor(() => evaluate('document.querySelectorAll("[data-chat-pane-root]").length === 2'), 'split panes')
  await call('Page.navigate', { url: a.url + '/#/session/alpha%3A%3Ashared' })
  await waitFor(
    () =>
      evaluate(
        'document.querySelectorAll("[data-chat-pane-root]").length === 2 && localStorage.getItem("piui-active-server") === "alpha"',
      ),
    'Alpha focused in split view',
  )
  await waitFor(
    () =>
      evaluate(
        '[...document.querySelectorAll("[data-chat-pane-root]")].some(p => p.innerText.includes("browser-beta-marker"))',
      ),
    'background Beta retained',
  )
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
