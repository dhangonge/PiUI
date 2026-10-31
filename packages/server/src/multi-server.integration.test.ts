import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { WebSocket } from 'ws'
import {
  EVENT_WS_SUBPROTOCOL,
  PROTOCOL_VERSION,
  eventStreamKey,
  type EventCursor,
  type EventEnvelope,
} from '@piui/protocol'
import { createAppServer, type AppServer } from './http.ts'
import { attachEventWebSocket, closeEventWebSocket } from './ws.ts'
import { RuntimeSupervisor } from './pi/supervisor.ts'
import { SessionLeaseManager } from './pi/session-lease.ts'

async function listen(app: AppServer): Promise<string> {
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const address = app.server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function request(base: string, token: string, route: string, body?: unknown) {
  const response = await fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  assert.ok(response.ok, `${route}: HTTP ${response.status}`)
  return response.json()
}

async function connect(base: string, token: string) {
  const events: EventEnvelope[] = []
  const ws = new WebSocket(
    `${base.replace('http:', 'ws:')}/api/v1/events?token=${encodeURIComponent(token)}`,
    EVENT_WS_SUBPROTOCOL,
  )
  await new Promise<void>((resolve, reject) => {
    ws.once('error', reject)
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.type === 'hello') resolve()
      if (message.channel === 'event') events.push(message.event)
    })
  })
  return { ws, events }
}

async function subscribe(ws: WebSocket, cursor?: EventCursor) {
  const serverStream = { kind: 'server', id: 'server' } as const
  ws.send(
    JSON.stringify({
      type: 'subscribe',
      protocolVersion: PROTOCOL_VERSION,
      streams: [serverStream, { kind: 'session', id: 'same-session' }],
      cursors: cursor === undefined ? {} : { [eventStreamKey(serverStream)]: cursor },
    }),
  )
  // A pong is a barrier: all preceding subscription/replay messages were handled.
  const pong = new Promise<void>(resolve => {
    const onMessage = (raw: Buffer) => {
      if (JSON.parse(String(raw)).type !== 'pong') return
      ws.off('message', onMessage)
      resolve()
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({ type: 'ping', protocolVersion: PROTOCOL_VERSION }))
  await pong
}

async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for isolated events')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

it(
  'isolates two real HTTP/WS servers and worker processes with identical session and command IDs',
  { timeout: 90_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-multi-server-'))
    const apps: AppServer[] = []
    const sockets: WebSocket[] = []
    const servers: ReturnType<typeof attachEventWebSocket>[] = []
    try {
      const instances = await Promise.all(
        ['A', 'B'].map(async label => {
          const home = path.join(root, label)
          mkdirSync(path.join(home, 'sessions'), { recursive: true })
          const sessionFile = path.join(home, 'sessions', 'same-session.jsonl')
          writeFileSync(
            sessionFile,
            JSON.stringify({
              type: 'session',
              version: 1,
              id: 'same-session',
              cwd: root,
              timestamp: new Date().toISOString(),
            }) + '\n',
          )
          const token = randomUUID()
          const supervisor = new RuntimeSupervisor({
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
          })
          const app = createAppServer({ authToken: token, supervisor })
          apps.push(app)
          servers.push(attachEventWebSocket(app.server, { authToken: token, eventHub: app.eventHub }))
          const base = await listen(app)
          const opened = await request(base, token, '/api/v1/pi/commands/session.open', { cwd: root, sessionFile })
          assert.equal(opened.data.sessionId, 'same-session')
          const connection = await connect(base, token)
          sockets.push(connection.ws)
          await subscribe(connection.ws)
          return { label, base, token, app, ...connection }
        }),
      )
      const [a, b] = instances
      assert.ok(a && b)
      const wrongToken = await fetch(b.base + '/api/v1/host/health', {
        headers: { authorization: `Bearer ${a.token}` },
      })
      assert.equal(wrongToken.status, 401)

      await Promise.all(
        instances.map(async instance => {
          const result = await request(
            instance.base,
            instance.token,
            '/api/v1/pi/sessions/same-session/commands/prompt',
            {
              id: 'same-command',
              params: { text: `isolated-marker-${instance.label}` },
            },
          )
          assert.equal(result.command.id, 'same-command')
          await waitUntil(() =>
            instance.events.some(
              event =>
                event.channel === 'command.updated' &&
                (event.payload as { id?: string; status?: string }).id === 'same-command' &&
                (event.payload as { status?: string }).status === 'completed',
            ),
          )
          const branch = await request(
            instance.base,
            instance.token,
            '/api/v1/pi/sessions/same-session/commands/branch.get',
            {},
          )
          const content = JSON.stringify(branch)
          assert.ok(content.includes(`isolated-marker-${instance.label}`))
          assert.ok(!content.includes(`isolated-marker-${instance.label === 'A' ? 'B' : 'A'}`))
        }),
      )

      const stream = { kind: 'server', id: 'server' } as const
      const cursor = a.app.eventHub.getCursor(stream)
      await new Promise<void>(resolve => {
        a.ws.once('close', resolve)
        a.ws.close()
      })
      a.app.eventHub.publish(stream, 'sessions.updated', { marker: 'replay-A' })
      b.app.eventHub.publish(stream, 'sessions.updated', { marker: 'live-B' })
      await waitUntil(() => b.events.some(event => (event.payload as { marker?: string }).marker === 'live-B'))
      const reconnected = await connect(a.base, a.token)
      sockets.push(reconnected.ws)
      await subscribe(reconnected.ws, cursor)
      assert.ok(reconnected.events.some(event => (event.payload as { marker?: string }).marker === 'replay-A'))
      assert.ok(!reconnected.events.some(event => (event.payload as { marker?: string }).marker === 'live-B'))
      assert.ok(!b.events.some(event => (event.payload as { marker?: string }).marker === 'replay-A'))
      assert.equal(b.ws.readyState, WebSocket.OPEN)
    } finally {
      sockets.forEach(socket => socket.terminate())
      servers.forEach(server => closeEventWebSocket(server))
      await Promise.all(apps.map(app => app.dispose()))
      rmSync(root, { recursive: true, force: true })
    }
  },
)
