import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listDirectory } from './files'
import { listHostFiles } from './transport/index.js'
import { LOCAL_SERVER_ID, serverStore } from '../store/serverStore'

vi.mock('./transport/index.js', () => ({ listHostFiles: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

describe('server-bound project directory browsing', () => {
  let a: string, b: string
  beforeEach(() => {
    vi.resetAllMocks()
    a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
  })
  afterEach(() => {
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
  })

  it('keeps paginated requests on their original server after focus changes', async () => {
    const first = deferred<Awaited<ReturnType<typeof listHostFiles>>>()
    vi.mocked(listHostFiles)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ path: '', entries: [], total: 0, truncated: false })
    const result = listDirectory('/a', undefined, a)
    serverStore.setActiveServer(b)
    first.resolve({ path: '', entries: [], total: 0, truncated: true, nextCursor: 'a-page-2' })
    await expect(result).resolves.toEqual([])
    expect(listHostFiles).toHaveBeenLastCalledWith('/a', { path: '', limit: 2000, cursor: 'a-page-2' }, undefined, a)
    expect(vi.mocked(listHostFiles).mock.calls.every(call => call[3] === a)).toBe(true)
  })

  it('does not send an old pagination cursor to a replacement endpoint', async () => {
    const first = deferred<Awaited<ReturnType<typeof listHostFiles>>>()
    vi.mocked(listHostFiles).mockReturnValueOnce(first.promise)
    const result = listDirectory('/a', undefined, a)
    serverStore.updateServer(a, { url: 'https://replacement.example.test' })
    first.resolve({ path: '', entries: [], total: 0, truncated: true, nextCursor: 'old-cursor' })
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(listHostFiles).toHaveBeenCalledTimes(1)
  })
})
