// Timeline order/expansion smoke test.
//
// Guards the regressions behind "过程内容跑到用户消息上面 / 根本不会折叠":
//   * model-only hook messages (custom_message display=false) must not become rows
//     and must not split a turn — the following assistant used to be flattened and
//     hoisted above every user message
//   * system entries (compaction & friends) must stay in place instead of being
//     emitted before all user messages
//   * a live turn must render below its user message inside a collapsed shell
//
// Runs the built web app (npm run build first) against mock-driver backends in
// headless Chromium at 412x915. Requires Chromium on PATH (CHROMIUM_BIN overrides).
//   node --import tsx scripts/smoke-timeline-order.mjs
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

const root = mkdtempSync(path.join(tmpdir(), 'piui-timeline-smoke-'))
const staticRoot = fileURLToPath(new URL('../packages/app/dist/', import.meta.url))
const home = path.join(root, 'alpha')
const SESSION_ID = 'shared'
const PROMPT = 'mock-slow: live probe'
const HIDDEN_HOOK_ID = 'hook-hidden'
let browser
let browserClosed
let app
let events
let cdp

const iso = () => new Date().toISOString()

/** Fixture: two settled turns, with a model-only hook message inside the first. */
function fixtureEntries() {
  const entries = []
  let parentId = null
  const push = entry => {
    const id = entry.id ?? randomUUID().slice(0, 8)
    entries.push({ ...entry, id, parentId })
    parentId = id
  }
  const callId = 'call-one'
  push({ type: 'model_change', timestamp: iso(), provider: 'mock', modelId: 'mock' })
  push({
    type: 'message',
    timestamp: iso(),
    message: { role: 'user', content: [{ type: 'text', text: 'first question' }], timestamp: Date.now() },
  })
  // Plannotator and friends inject model context this way; the TUI hides them.
  push({
    id: HIDDEN_HOOK_ID,
    type: 'custom_message',
    timestamp: iso(),
    customType: 'plannotator-framing',
    display: false,
    content: '[PLANNOTATOR - PLANNING PHASE] model-only context injection',
  })
  push({
    type: 'message',
    timestamp: iso(),
    message: {
      role: 'assistant',
      provider: 'mock',
      model: 'mock',
      stopReason: 'stop',
      timestamp: Date.now(),
      content: [
        { type: 'thinking', thinking: 'Thinking about the first question' },
        { type: 'toolCall', id: callId, name: 'mock-tool', arguments: { echo: 'probe' } },
        { type: 'text', text: 'First answer text' },
      ],
    },
  })
  push({
    type: 'message',
    timestamp: iso(),
    message: {
      role: 'toolResult',
      toolName: 'mock-tool',
      toolCallId: callId,
      isError: false,
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'mock-tool echo: probe' }],
    },
  })
  push({
    type: 'message',
    timestamp: iso(),
    message: { role: 'user', content: [{ type: 'text', text: 'second question' }], timestamp: Date.now() },
  })
  push({
    type: 'message',
    timestamp: iso(),
    message: {
      role: 'assistant',
      provider: 'mock',
      model: 'mock',
      stopReason: 'stop',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'Second answer text' }],
    },
  })
  return entries
}

async function waitFor(check, label, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Row geometry read out of the DOM: one entry per timeline row, in render order. */
const geometryProbe = `(() => {
  const rows = [...document.querySelectorAll('[data-timeline-key]')].map((el, index) => {
    const rect = el.getBoundingClientRect();
    return {
      index,
      key: el.dataset.timelineKey,
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      text: el.innerText.replace(/\\n+/g, ' | '),
    };
  });
  return JSON.stringify({ rows, errors: window.__err.slice(0, 2) });
})()`

function assertRowOrder(rows) {
  const shells = rows.filter(row => row.key?.startsWith('process-shell:'))
  for (const shell of shells) {
    const userId = shell.key.slice('process-shell:'.length)
    const userRow = rows.find(row => row.key === userId)
    if (userRow) {
      assert.ok(
        userRow.index < shell.index,
        `process shell rendered above its user message: ${JSON.stringify(rows.map(r => r.key))}`,
      )
    }
  }
  assert.ok(!rows.some(row => row.key === HIDDEN_HOOK_ID), 'hidden hook message became a timeline row')
  const anchor = rows.find(row => row.text.includes('first question'))
  const assistantRow = rows.find(row => row.text.includes('Thinking about the first question'))
  if (anchor && assistantRow) {
    assert.ok(
      anchor.index < assistantRow.index,
      `assistant content rendered above the user message: ${JSON.stringify(rows.map(r => r.key))}`,
    )
  }
}

async function startServer() {
  mkdirSync(path.join(home, 'sessions'), { recursive: true })
  mkdirSync(path.join(home, 'data'), { recursive: true })
  const sessionFile = path.join(home, 'sessions', `${SESSION_ID}.jsonl`)
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({ type: 'session', version: 1, id: SESSION_ID, name: 'Alpha chat', cwd: home, timestamp: iso() }),
      ...fixtureEntries().map(entry => JSON.stringify(entry)),
    ].join('\n') + '\n',
  )
  const token = randomUUID()
  app = createAppServer({
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
  events = attachEventWebSocket(app.server, { authToken: token, eventHub: app.eventHub })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${app.server.address().port}`
  const post = async (route, params) => {
    const response = await fetch(url + route, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    assert.ok(response.ok, `${route}: HTTP ${response.status}`)
    return response.json()
  }
  return { url, token, post }
}

async function openBrowser(origin, token) {
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
  // 记下退出信号：浏览器被杀后仍会短暂写 profile，先等它退出再删临时目录，
  // 否则 rmSync 会在遍历途中撞上 Chrome 新写出的文件，报 ENOTEMPTY。
  browserClosed = new Promise(resolve => browser.once('exit', resolve))
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not expose DevTools')), 20_000)
    browser.once('error', reject)
    browser.stderr.on('data', data => {
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
  const socket = new WebSocket(endpoint)
  cdp = socket
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  let nextId = 0
  const pending = new Map()
  socket.on('message', raw => {
    const message = JSON.parse(String(raw))
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
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const call = (method, params) => send(method, params, sessionId)

  await call('Page.enable')
  await call('Runtime.enable')
  await call('Emulation.setFocusEmulationEnabled', { enabled: true })
  await call('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true })
  const storage = {
    i18nextLng: 'en',
    'piui-servers': JSON.stringify([{ id: 'alpha', name: 'Alpha', url: origin, token, createdAt: Date.now() }]),
    'piui-active-server': 'alpha',
    'srv:alpha:piui-last-directory': home,
    // The collapse shell only exists when process collapse is enabled.
    'piui-process-collapse-enabled': 'true',
  }
  await call('Page.addScriptToEvaluateOnNewDocument', {
    source: `for (const [key, value] of Object.entries(${JSON.stringify(storage)})) localStorage.setItem(key, value);
      window.__err = [];
      window.addEventListener('error', event => window.__err.push(String(event.message)));
      window.addEventListener('unhandledrejection', event => window.__err.push(String(event.reason)));`,
  })
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    assert.ok(
      !result.exceptionDetails,
      result.exceptionDetails?.exception?.description?.split('\n')[0] || 'browser evaluation failed',
    )
    return result.result.value
  }
  const rows = async () => {
    const state = JSON.parse(await evaluate(geometryProbe))
    assert.deepEqual(state.errors, [], `browser errors: ${state.errors.join(' | ')}`)
    assertRowOrder(state.rows)
    return state.rows
  }
  return { evaluate, rows }
}

try {
  const { url, token, post } = await startServer()
  const { evaluate, rows } = await openBrowser(url, token)

  await evaluate(`location.href = ${JSON.stringify(`${url}/#/session/${encodeURIComponent(`alpha::${SESSION_ID}`)}`)}`)
  await waitFor(async () => (await rows()).length >= 4, 'history rendered')

  const initial = await rows()
  assert.deepEqual(
    initial
      .filter(row => row.text.includes('question') || row.key.startsWith('process-shell'))
      .map(row => (row.key.startsWith('process-shell') ? 'shell' : 'user')),
    ['user', 'shell', 'user', 'shell'],
    `unexpected timeline: ${JSON.stringify(initial.map(row => row.key))}`,
  )
  await evaluate(`document.querySelector('[data-timeline-key^="process-shell"] button')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 400))
  const expanded = (await rows()).find(row => row.key.startsWith('process-shell'))
  assert.ok(
    expanded.text.includes('Thinking about the first question'),
    `settled shell did not open on click: ${expanded.text}`,
  )
  await evaluate(`document.querySelector('[data-timeline-key^="process-shell"] button')?.click()`)
  await new Promise(resolve => setTimeout(resolve, 400))
  console.log('settled turns: order ok, hidden hook hidden, shell toggles')

  await post(`/api/v1/pi/sessions/${encodeURIComponent(SESSION_ID)}/commands/prompt`, { text: PROMPT })
  const startedAt = Date.now()
  let sawLiveShell = false
  for (;;) {
    const current = await rows()
    const liveUser = current.find(row => row.text.includes(PROMPT))
    const liveShell = current.find(row => row.key === `process-shell:${liveUser?.key}`)
    if (liveUser && liveShell) {
      assert.ok(liveUser.index < liveShell.index, 'live shell rendered above its user message')
      // While the turn is still working the shell keeps its process content
      // collapsed; the settled shell grows by the final answer below it.
      if (liveShell.text.includes('Working for')) {
        assert.ok(
          !liveShell.text.includes('Checking the workspace'),
          `live process content visible instead of collapsed: ${liveShell.text}`,
        )
        assert.ok(liveShell.height < 120, `live shell not collapsed: height ${liveShell.height}`)
      }
      sawLiveShell = true
    }
    const shellText = liveShell?.text ?? ''
    if (shellText.includes('Worked for') && shellText.includes('Mock tool reply')) break
    assert.ok(Date.now() - startedAt < 30_000, `live turn never settled: ${JSON.stringify(current.map(r => r.text))}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(sawLiveShell, 'live turn never rendered a collapsed process shell')

  const settled = await rows()
  const finalShell = settled.find(row => row.text.includes('Mock tool reply'))
  assert.ok(finalShell, 'final answer missing from the timeline')
  assert.ok(finalShell.text.includes('Worked for'), `settled shell still says Working: ${finalShell.text}`)
  assert.deepEqual(
    settled.map(row => row.key),
    [...settled.map(row => row.key)].sort((a, b) => {
      const aUser = a.startsWith('process-shell:') ? a.slice('process-shell:'.length) : a
      const bUser = b.startsWith('process-shell:') ? b.slice('process-shell:'.length) : b
      return settled.findIndex(row => row.key === aUser) - settled.findIndex(row => row.key === bUser)
    }),
    `rows out of order: ${JSON.stringify(settled.map(row => row.key))}`,
  )
  console.log(`live turn: collapsed while streaming, settled to "${finalShell.text.slice(0, 60)}"`)
  console.log('PASS timeline order/expansion smoke')
} finally {
  cdp?.close()
  browser?.kill('SIGTERM')
  if (browserClosed) await browserClosed
  if (events) closeEventWebSocket(events)
  await app?.dispose()
  // maxRetries 覆盖 ENOTEMPTY/EBUSY：浏览器退出后仍有极短的写入尾巴。
  if (!process.env.PIUI_SMOKE_KEEP) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  else console.log('[keep]', root)
}
