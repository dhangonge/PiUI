import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandRecord } from '@piui/protocol'
import { LOCAL_SERVER_ID, serverStore } from '../../store/serverStore'
import { makeSessionKey } from '../../utils/sessionKey'
import { getPiCommandStore, piCommandStore } from '../state/piCommandStore'
import {
  createPiSession,
  deletePiSession,
  fetchHostHealth,
  fetchPiRegistry,
  listAllPiSessions,
  listPiSessions,
  postHostCommand,
  postPiSessionCommand,
  previewPiSession,
  promptPi,
  waitHostCommand,
  createHostTerminal,
  issueHostTerminalToken,
  getHostTerminalWebSocketUrl,
  removeHostTerminal,
} from './index'

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>())
vi.mock('../../utils/tauri', () => ({ isTauri: () => true, getHttpFetch: async () => fetchMock }))

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}
function body(index: number) {
  return JSON.parse(String(fetchMock.mock.calls[index][1]?.body))
}
function command(status: CommandRecord['status']): CommandRecord {
  return { id: 'same-command', sessionId: 'same-session', type: 'prompt', status, submittedAt: '2026-01-01T00:00:00Z' }
}

describe('server-scoped Pi protocol transport', () => {
  let a: string
  let b: string

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => json({ data: [] }))
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test', token: 'test-a' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test', token: 'test-b' }).id
    serverStore.setActiveServer(a)
  })

  afterEach(() => {
    getPiCommandStore(a).clearAll()
    getPiCommandStore(b).clearAll()
    piCommandStore.clearAll()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
  })

  it('lists sessions on two servers without changing the active selection', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ id: 'same', cwd: '/a' }] }))
      .mockResolvedValueOnce(json({ data: [{ id: 'same', cwd: '/b' }] }))
    const [first, second] = await Promise.all([
      listAllPiSessions(undefined, a),
      listPiSessions({ cwd: '/b' }, undefined, b),
    ])
    expect(first[0].cwd).toBe('/a')
    expect(second[0].cwd).toBe('/b')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://a.example.test/api/v1/pi/commands/session.listAll',
      'https://b.example.test/api/v1/pi/commands/session.list',
    ])
    expect(body(1)).toEqual({ cwd: '/b' })
    expect(serverStore.getActiveServerId()).toBe(a)
  })

  it('routes a composite session key but sends only the raw session ID', async () => {
    fetchMock.mockResolvedValueOnce(json({ command: command('accepted') }, 202))
    await promptPi(makeSessionKey(b, 'same-session'), { text: 'hello' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://b.example.test/api/v1/pi/sessions/same-session/commands/prompt')
    expect(body(0)).toEqual({ text: 'hello' })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer test-b')
    expect(getPiCommandStore(b).get('same-command')?.status).toBe('accepted')
    expect(piCommandStore.get('same-command')).toBeNull()
  })

  it('does not collide when servers return the same command and session IDs', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ command: command('accepted') }, 202))
      .mockResolvedValueOnce(json({ command: command('completed') }, 202))
    await postPiSessionCommand('same-session', 'prompt', { text: 'a' }, undefined, a)
    await postPiSessionCommand('same-session', 'prompt', { text: 'b' }, undefined, b)
    expect(getPiCommandStore(a).getForSession('same-session')[0].status).toBe('accepted')
    expect(getPiCommandStore(b).getForSession('same-session')[0].status).toBe('completed')
    getPiCommandStore(a).clearAll()
    expect(getPiCommandStore(b).getSnapshot()).toHaveLength(1)
    expect(piCommandStore.getSnapshot()).toHaveLength(0)
  })

  it('preserves the unbound command store for existing single-server callers', async () => {
    fetchMock.mockResolvedValueOnce(json({ command: command('accepted') }, 202))
    await promptPi('same-session', { text: 'legacy' })
    expect(piCommandStore.get('same-command')?.status).toBe('accepted')
    expect(getPiCommandStore(a).getSnapshot()).toHaveLength(0)
  })

  it('strips the composite prefix in preview command bodies and honors explicit overrides', async () => {
    await previewPiSession(makeSessionKey(a, 'raw/session'), { limit: 10 }, undefined, b)
    expect(fetchMock.mock.calls[0][0]).toBe('https://b.example.test/api/v1/pi/commands/session.preview')
    expect(body(0)).toEqual({ sessionId: 'raw/session', limit: 10 })
    await postPiSessionCommand(makeSessionKey(a, 'raw/session'), 'state.get', undefined, undefined, b)
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://b.example.test/api/v1/pi/sessions/raw%2Fsession/commands/state.get',
    )
  })

  it('scopes create and delete commands without rewriting paths', async () => {
    await createPiSession('/b/workspace', undefined, b)
    await deletePiSession('/b/workspace', '/b/sessions/item.jsonl', undefined, b)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://b.example.test/api/v1/pi/commands/session.create',
      'https://b.example.test/api/v1/pi/commands/session.delete',
    ])
    expect(body(0)).toEqual({ cwd: '/b/workspace' })
    expect(body(1)).toEqual({ cwd: '/b/workspace', sessionFile: '/b/sessions/item.jsonl' })
  })

  it('scopes registry, health and host commands', async () => {
    await fetchPiRegistry(undefined, b)
    await fetchHostHealth(undefined, b)
    await postHostCommand('files.list', { workspacePath: '/b' }, undefined, b)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://b.example.test/api/v1/pi/registry',
      'https://b.example.test/api/v1/host/health',
      'https://b.example.test/api/v1/host/commands/files.list',
    ])
    expect(body(2)).toEqual({ workspacePath: '/b' })
  })

  it('polls accepted commands on their original server after a focus switch', async () => {
    fetchMock.mockResolvedValueOnce(json({ command: command('accepted') }, 202))
    const submitted = await postPiSessionCommand<CommandRecord>(makeSessionKey(b, 'same-session'), 'compact')
    expect(submitted.id).toBe(makeSessionKey(b, 'same-command'))
    serverStore.setActiveServer(a)
    fetchMock.mockResolvedValueOnce(json({ command: { ...command('completed'), result: { targetSessionId: 'fork' } } }))
    const result = await waitHostCommand(submitted.id)
    expect(fetchMock.mock.calls[1][0]).toBe('https://b.example.test/api/v1/host/commands/same-command')
    expect(result).toEqual({ targetSessionId: makeSessionKey(b, 'fork') })
    expect(getPiCommandStore(b).get('same-command')?.status).toBe('completed')
  })

  it('stops polling if the endpoint is edited between requests', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValue(json({ command: command('running') }))
      const pending = waitHostCommand(makeSessionKey(b, 'same-command'))
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      serverStore.updateServer(b, { url: 'https://replacement.example.test' })
      await vi.advanceTimersByTimeAsync(200)
      await rejected
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps terminal commands and websocket tickets on the owning server', async () => {
    await createHostTerminal('/same', { shell: 'sh' }, undefined, b)
    await issueHostTerminalToken('/same', makeSessionKey(b, 'term'))
    await removeHostTerminal('/same', makeSessionKey(b, 'term'))
    expect(fetchMock.mock.calls.every(([url]) => String(url).startsWith('https://b.example.test/'))).toBe(true)
    expect(body(1)).toEqual({ workspacePath: '/same', terminalId: 'term' })
    const url = new URL(getHostTerminalWebSocketUrl(makeSessionKey(b, 'term'), 'ticket', 7))
    expect(url.host).toBe('b.example.test')
    expect(url.pathname).toBe('/api/v1/host/terminals/term/stream')
    expect(url.searchParams.get('token')).toBe('test-b')
    expect(url.searchParams.get('cursor')).toBe('7')
  })

  it('preserves protocol error metadata for the requesting server', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'BACKEND_UNAVAILABLE' }, 503))
    await expect(listAllPiSessions(undefined, b)).rejects.toMatchObject({ status: 503, code: 'BACKEND_UNAVAILABLE' })
    expect(getPiCommandStore(a).getSnapshot()).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
