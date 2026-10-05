import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPiEventStream } from './eventStream'
import { serverStore, LOCAL_SERVER_ID } from '../store/serverStore'
import { makeSessionKey } from '../utils/sessionKey'
import { activeSessionStore } from '../store/activeSessionStore'
import { getPiCommandStore } from './state/piCommandStore'
import { extensionUiStore } from './extensionUiStore'
import { liveToolOutputStore } from './liveToolOutput'
import type { PiSocket } from './piSocket'

const mocks = vi.hoisted(() => ({ open: vi.fn(), refresh: vi.fn(), load: vi.fn() }))
vi.mock('./piSocket', () => ({
  openPiSocket: mocks.open,
  PI_SOCKET_OPEN: 1,
  PI_SOCKET_CLOSING: 2,
  PI_SOCKET_CLOSED: 3,
}))
vi.mock('./controllers/index.js', () => ({
  loadPiSessionData: mocks.load,
  refreshPiBranch: mocks.refresh,
  refreshPiSessionState: mocks.refresh,
}))

function socket() {
  return {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  } satisfies PiSocket
}
function emit(ws: PiSocket, channel: string, payload: unknown, kind = 'session', sequence = 1) {
  ws.onmessage?.({
    data: JSON.stringify({
      channel: 'event',
      event: {
        channel,
        payload,
        stream: { kind, id: kind === 'session' ? 'same' : 'server' },
        cursor: { epoch: 'epoch', sequence },
      },
    }),
  })
}

describe('parallel Pi event streams', () => {
  let a: string
  let b: string
  let sockets: ReturnType<typeof socket>[]
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.load.mockReset().mockResolvedValue(undefined)
    sockets = []
    mocks.open.mockReset().mockImplementation(() => {
      const ws = socket()
      sockets.push(ws)
      return ws
    })
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test', token: 'test-a' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test', token: 'test-b' }).id
    serverStore.setActiveServer(a)
  })
  afterEach(() => {
    getPiEventStream(a).invalidate()
    getPiEventStream(b).invalidate()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
    vi.useRealTimers()
  })

  function connectBoth() {
    getPiEventStream(a).connect('same')
    getPiEventStream(b).connect('same')
    sockets.forEach(ws => (ws as PiSocket).onopen?.())
  }

  it('uses independent sockets and credentials, sending raw IDs on the wire', () => {
    connectBoth()
    expect(mocks.open.mock.calls.map(([url]) => new URL(url).host)).toEqual(['a.example.test', 'b.example.test'])
    expect(mocks.open.mock.calls.map(([url]) => new URL(url).searchParams.get('token'))).toEqual(['test-a', 'test-b'])
    for (const ws of sockets) {
      const subscription = JSON.parse(ws.send.mock.lastCall![0])
      expect(subscription.streams).toContainEqual({ kind: 'session', id: 'same' })
    }
    serverStore.setActiveServer(b)
    expect(sockets[0].close).not.toHaveBeenCalled()
    expect(sockets[1].close).not.toHaveBeenCalled()
    getPiEventStream(a).disconnect('same')
    expect(sockets[0].close).toHaveBeenCalledOnce()
    expect(sockets[1].close).not.toHaveBeenCalled()
  })

  it('isolates duplicate command IDs and activity snapshots', () => {
    connectBoth()
    const command = { id: 'cmd', sessionId: 'same', type: 'prompt', submittedAt: '2026-01-01', status: 'accepted' }
    emit(sockets[0], 'command.updated', command)
    emit(sockets[1], 'command.updated', { ...command, status: 'completed' })
    expect(getPiCommandStore(a).get('cmd')?.status).toBe('accepted')
    expect(getPiCommandStore(b).get('cmd')?.status).toBe('completed')
    emit(sockets[0], 'sessions.activity', { sessions: { same: { type: 'busy' } } }, 'server')
    emit(sockets[1], 'sessions.activity', { sessions: { same: { type: 'busy' } } }, 'server')
    emit(sockets[0], 'sessions.activity', { sessions: {} }, 'server')
    expect(activeSessionStore.getSnapshot().statusMap[makeSessionKey(a, 'same')]?.type).not.toBe('busy')
    expect(activeSessionStore.getSnapshot().statusMap[makeSessionKey(b, 'same')]?.type).toBe('busy')
  })

  it('isolates extension requests and tool output with identical IDs', () => {
    connectBoth()
    for (const [index, title] of ['A', 'B'].entries()) {
      emit(sockets[index], 'extension.ui', {
        type: 'requested',
        request: { requestId: 'req', sessionId: 'same', kind: 'confirm', title },
      })
      emit(sockets[index], 'pi.event', {
        event: {
          type: 'tool_execution_update',
          toolCallId: 'tool',
          partialResult: { content: [{ type: 'text', text: title }] },
        },
        meta: { epoch: 'e', sequence: 1 },
      })
    }
    const ka = makeSessionKey(a, 'same'),
      kb = makeSessionKey(b, 'same')
    expect(extensionUiStore.getSnapshot().sessions[ka]).toBeDefined()
    expect(extensionUiStore.getSnapshot().sessions[kb]).toBeDefined()
    expect(liveToolOutputStore.get('tool', ka)).toBe('A')
    expect(liveToolOutputStore.get('tool', kb)).toBe('B')
    emit(sockets[0], 'pi.event', {
      event: { type: 'tool_execution_end', toolCallId: 'tool' },
      meta: { epoch: 'e', sequence: 2 },
    })
    expect(liveToolOutputStore.get('tool', ka)).toBeUndefined()
    expect(liveToolOutputStore.get('tool', kb)).toBe('B')
  })

  it('reconnects only the failed server and resumes its own cursor', async () => {
    connectBoth()
    emit(sockets[0], 'sessions.activity', { sessions: {} }, 'server', 7)
    emit(sockets[1], 'sessions.activity', { sessions: {} }, 'server', 19)
    ;(sockets[0] as PiSocket).onclose?.({ code: 1006 })
    await vi.advanceTimersByTimeAsync(1000)
    ;(sockets[2] as PiSocket).onopen?.()
    expect(mocks.open).toHaveBeenCalledTimes(3)
    expect(new URL(mocks.open.mock.calls[2][0]).host).toBe('a.example.test')
    expect(JSON.parse(sockets[2].send.mock.lastCall![0]).cursors.server.sequence).toBe(7)
    expect(sockets[1].close).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalledWith(makeSessionKey(b, 'same'))
  })

  it('invalidates one endpoint and rejects its late frames without clearing its peer', () => {
    connectBoth()
    const command = { id: 'cmd', sessionId: 'same', type: 'prompt', submittedAt: '2026-01-01', status: 'accepted' }
    sockets.forEach(ws => emit(ws, 'command.updated', command))
    serverStore.updateServer(a, { url: 'https://new-a.example.test' })
    expect(sockets[0].close).toHaveBeenCalledOnce()
    emit(sockets[0], 'command.updated', command)
    expect(getPiCommandStore(a).get('cmd')).toBeNull()
    expect(getPiCommandStore(b).get('cmd')).not.toBeNull()
    expect(sockets[1].close).not.toHaveBeenCalled()
    getPiEventStream(a).connect('same')
    expect(new URL(mocks.open.mock.lastCall![0]).host).toBe('new-a.example.test')
  })
})
