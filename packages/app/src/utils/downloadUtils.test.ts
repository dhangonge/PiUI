import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceDownloadUrl, downloadWorkspaceFile } from './downloadUtils'

const { isTauriMock, getHttpFetchMock, openMock, writeFileMock, saveMock, handleWriteMock, handleCloseMock } =
  vi.hoisted(() => ({
    isTauriMock: vi.fn(() => true),
    getHttpFetchMock: vi.fn(),
    openMock: vi.fn(),
    writeFileMock: vi.fn(async (_path: string, _data: Uint8Array) => {}),
    saveMock: vi.fn(async (_options?: unknown): Promise<string | null> => '/sdcard/Download/report.bin'),
    handleWriteMock: vi.fn(async (_data: Uint8Array) => {}),
    handleCloseMock: vi.fn(async () => {}),
  }))

vi.mock('./tauri', () => ({
  isTauri: () => isTauriMock(),
  getHttpFetch: async () => getHttpFetchMock,
}))

vi.mock('../pi/httpClient', () => ({
  getApiBase: () => 'http://192.168.1.9:8788',
  getPiAuthToken: () => 'tok en/1',
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (options?: unknown) => saveMock(options),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  open: (path: string, options?: unknown) => openMock(path, options),
  writeFile: (path: string, data: Uint8Array) => writeFileMock(path, data),
}))

function streamResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

const OPTIONS = { workspacePath: '/home/u/my repo', path: 'dist/报告 1.bin', fileName: '报告 1.bin' }

describe('buildWorkspaceDownloadUrl', () => {
  it('encodes every query parameter and appends the token for browser downloads', () => {
    expect(buildWorkspaceDownloadUrl(OPTIONS)).toBe(
      'http://192.168.1.9:8788/api/v1/host/files/download' +
        `?workspacePath=${encodeURIComponent('/home/u/my repo')}` +
        `&path=${encodeURIComponent('dist/报告 1.bin')}` +
        '&token=tok%20en%2F1',
    )
  })

  it('omits the token when the request authenticates with a header', () => {
    expect(buildWorkspaceDownloadUrl(OPTIONS, false)).not.toContain('token=')
  })
})

describe('downloadWorkspaceFile', () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true)
    saveMock.mockClear()
    openMock.mockReset()
    handleWriteMock.mockClear()
    handleCloseMock.mockClear()
    writeFileMock.mockClear()
    getHttpFetchMock.mockReset()
  })

  it('streams the response body into the picked file chunk by chunk', async () => {
    openMock.mockResolvedValue({ write: handleWriteMock, close: handleCloseMock })
    getHttpFetchMock.mockResolvedValue(streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])]))

    await downloadWorkspaceFile(OPTIONS)

    expect(saveMock).toHaveBeenCalledTimes(1)
    expect(openMock).toHaveBeenCalledWith('/sdcard/Download/report.bin', expect.objectContaining({ write: true }))
    expect(handleWriteMock).toHaveBeenCalledTimes(2)
    expect(handleCloseMock).toHaveBeenCalledTimes(1)
    expect(writeFileMock).not.toHaveBeenCalled()

    const [url, init] = getHttpFetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).not.toContain('token=')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok en/1')
  })

  it('falls back to a whole-file write when streaming is unavailable', async () => {
    openMock.mockRejectedValue(new Error('open is not allowed on content://'))
    getHttpFetchMock.mockImplementation(async () => streamResponse([new Uint8Array([9, 9, 9])]))

    await downloadWorkspaceFile(OPTIONS)

    await vi.waitFor(() => expect(writeFileMock).toHaveBeenCalledTimes(1))
    const [path, data] = writeFileMock.mock.calls[0] as [string, Uint8Array]
    expect(path).toBe('/sdcard/Download/report.bin')
    expect(Array.from(data)).toEqual([9, 9, 9])
  })

  it('rejects with the server problem code instead of silently succeeding', async () => {
    getHttpFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 'FILE_TOO_LARGE', message: 'too big' }), { status: 413 }),
    )

    await expect(downloadWorkspaceFile(OPTIONS)).rejects.toThrow(/FILE_TOO_LARGE/)
  })

  it('does nothing when the save dialog is cancelled', async () => {
    saveMock.mockResolvedValue(null)

    await downloadWorkspaceFile(OPTIONS)

    expect(getHttpFetchMock).not.toHaveBeenCalled()
  })

  it('uses an <a download> link in the browser so the bytes never enter JS memory', async () => {
    isTauriMock.mockReturnValue(false)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    await downloadWorkspaceFile(OPTIONS)

    expect(getHttpFetchMock).not.toHaveBeenCalled()
    expect(click).toHaveBeenCalledTimes(1)
    click.mockRestore()
  })
})
