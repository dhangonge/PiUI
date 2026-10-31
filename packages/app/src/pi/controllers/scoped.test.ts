import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import { serverStore, LOCAL_SERVER_ID } from '../../store/serverStore'
import { loadPiSessions, loadPiSessionsForCwd, loadPiModels } from './index'
import { piSessionInfoStore } from '../piSessionInfoStore'
import { getPiModelsStore } from '../state/piModelsStore'
import { makeSessionKey } from '../../utils/sessionKey'
import { resolveWorkspacePath, resetWorkspaceResolutionCache } from '../workspaces'
import { autoDetectPathStyle, getDetectedPathStyle, resetPathModeCache } from '../../utils/directoryUtils'

const transport = vi.hoisted(() => ({
  listAllPiSessions: vi.fn(),
  listPiSessions: vi.fn(),
  listPiModels: vi.fn(),
  postHostCommand: vi.fn(),
}))
vi.mock('../transport/index.js', () => transport)

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}
const info = (name: string): SessionInfo => ({
  id: 'same',
  path: '/same.jsonl',
  cwd: '/same',
  name,
  created: new Date(),
  modified: new Date(),
  firstMessage: '',
  allMessagesText: '',
  messageCount: 0,
})

describe('server-scoped controller caches', () => {
  let a: string, b: string
  beforeEach(() => {
    vi.clearAllMocks()
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
  })
  afterEach(() => {
    piSessionInfoStore.clear()
    getPiModelsStore(a).clear()
    getPiModelsStore(b).clear()
    resetWorkspaceResolutionCache()
    resetPathModeCache()
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
  })

  it('merges independent list responses even after focus changes and separates equal cwd caches', async () => {
    const pending = deferred<SessionInfo[]>()
    transport.listAllPiSessions.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([info('B')])
    const first = loadPiSessions(undefined, a)
    await loadPiSessions(undefined, b)
    serverStore.setActiveServer(b)
    pending.resolve([info('A')])
    await first
    expect(
      piSessionInfoStore
        .getAll()
        .map(item => item.id)
        .sort(),
    ).toEqual([makeSessionKey(a, 'same'), makeSessionKey(b, 'same')].sort())
    transport.listPiSessions.mockResolvedValueOnce([info('A')]).mockResolvedValueOnce([info('B')])
    await loadPiSessionsForCwd('/same', undefined, a)
    await loadPiSessionsForCwd('/same', undefined, b)
    expect(piSessionInfoStore.getForCwd('/same', a)[0].name).toBe('A')
    expect(piSessionInfoStore.getForCwd('/same', b)[0].name).toBe('B')
  })

  it('does not cache late results after an endpoint edit and revert', async () => {
    const pending = deferred<SessionInfo[]>()
    transport.listAllPiSessions.mockReturnValueOnce(pending.promise)
    const first = loadPiSessions(undefined, a)
    serverStore.updateServer(a, { url: 'https://replacement.example.test' })
    serverStore.updateServer(a, { url: 'https://a.example.test' })
    pending.resolve([info('stale')])
    await first
    expect(piSessionInfoStore.getAll()).toEqual([])
  })

  it('does not share model flights or results between servers', async () => {
    const first = deferred<unknown[]>()
    transport.listPiModels.mockReturnValueOnce(first.promise).mockResolvedValueOnce([{ id: 'B' }])
    const pending = loadPiModels(undefined, a)
    await loadPiModels(undefined, b)
    serverStore.setActiveServer(b)
    first.resolve([{ id: 'A' }])
    await pending
    expect(getPiModelsStore(a).getModels()[0].id).toBe('A')
    expect(getPiModelsStore(b).getModels()[0].id).toBe('B')
  })

  it('never continues an unbound workspace operation on the newly focused server', async () => {
    const first = deferred<unknown>()
    transport.postHostCommand.mockReturnValueOnce(first.promise)
    const pending = resolveWorkspacePath('/same')
    serverStore.setActiveServer(b)
    first.resolve({ workspace: { path: '/same' } })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(transport.postHostCommand).toHaveBeenCalledTimes(1)
  })

  it('detects background Windows paths without changing the focused Linux shard', () => {
    autoDetectPathStyle('/home/project', a)
    autoDetectPathStyle('C:\\project', b)
    expect(getDetectedPathStyle(a)).toBe('unix')
    expect(getDetectedPathStyle(b)).toBe('windows')
    serverStore.setActiveServer(b)
    expect(getDetectedPathStyle()).toBe('windows')
  })
})
