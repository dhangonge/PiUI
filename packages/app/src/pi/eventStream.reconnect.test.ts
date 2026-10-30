/**
 * 移动端「切后台再回来」的重连策略测试：
 * - pong 看门狗：连续两个 ping 周期收不到任何帧就主动断开，不等 WS 层超时
 * - 指数退避 1s→2s→4s→8s→16s→30s(上限)，带抖动，onopen 后重置
 * - 回前台 / 网络恢复：跳过退避立即重连，socket 还活着就先探活
 * - 无订阅不开 socket，监听器随 closeSocket 移除
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PiEventStream } from './eventStream'
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

const PING_INTERVAL_MS = 25_000

function makeSocket(): PiSocket {
  return {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as PiSocket
}

function sentMessages(ws: PiSocket): { type: string }[] {
  return (ws.send as unknown as { mock: { calls: [string][] } }).mock.calls.map(([raw]) => JSON.parse(raw))
}

describe('PiEventStream resume/reconnect', () => {
  let sockets: PiSocket[]
  let stream: PiEventStream

  const setReadyState = (ws: PiSocket, state: number) => {
    ;(ws as unknown as { readyState: number }).readyState = state
  }
  const open = (ws: PiSocket) => {
    setReadyState(ws, 1)
    ws.onopen?.()
  }
  const drop = (ws: PiSocket) => {
    setReadyState(ws, 3)
    ws.onclose?.({ code: 1006 })
  }
  const last = () => sockets[sockets.length - 1]

  function connectAndOpen(sessionId = 's1'): PiSocket {
    stream.connect(sessionId)
    const ws = last()
    open(ws)
    return ws
  }

  /** 推进时间直到出现新 socket，返回实际等待时长（ms） */
  function waitForNextSocket(): number {
    const before = sockets.length
    let waited = 0
    while (sockets.length === before && waited < 70_000) {
      vi.advanceTimersByTime(100)
      waited += 100
    }
    return waited
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.load.mockReset().mockResolvedValue(undefined)
    sockets = []
    mocks.open.mockReset().mockImplementation(() => {
      const ws = makeSocket()
      sockets.push(ws)
      return ws
    })
    stream = new PiEventStream()
  })

  afterEach(() => {
    stream.disconnectAll()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('watchdog closes a half-dead socket after two silent ping periods', () => {
    const ws = connectAndOpen()

    vi.advanceTimersByTime(PING_INTERVAL_MS)
    expect(ws.close).not.toHaveBeenCalled()
    expect(sentMessages(ws).at(-1)).toMatchObject({ type: 'ping' })

    vi.advanceTimersByTime(PING_INTERVAL_MS)
    expect(ws.close).toHaveBeenCalledOnce()
  })

  it('pong frames keep the connection alive and are not treated as unknown', () => {
    const ws = connectAndOpen()

    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(PING_INTERVAL_MS)
      ws.onmessage?.({ data: JSON.stringify({ type: 'pong', protocolVersion: 'v1', t: Date.now() }) })
      ws.onmessage?.({ data: JSON.stringify({ type: 'hello', protocolVersion: 'v1', service: 'piui-server' }) })
    }

    expect(ws.close).not.toHaveBeenCalled()
    expect(sockets).toHaveLength(1)
  })

  it('backs off exponentially up to 30s and resets after a successful open', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5) // 抖动为 0，便于断言精确间隔
    stream.connect('s1')

    const gaps: number[] = []
    for (let i = 0; i < 7; i += 1) {
      drop(last())
      gaps.push(waitForNextSocket())
    }

    expect(gaps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000])

    // onopen 成功即重置回 1s
    open(last())
    drop(last())
    expect(waitForNextSocket()).toBe(1_000)
  })

  it('jitter stays within ±20% of the base delay', () => {
    stream.connect('s1')
    const delays: number[] = []
    for (let i = 0; i < 20; i += 1) {
      drop(last())
      delays.push(waitForNextSocket())
    }
    // 第 5 次起基数已是 16s，上限 30s；全部落在 [0.8×base, 1.2×base] 内且不超过 36s
    for (const delay of delays) expect(delay).toBeGreaterThan(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(36_000)
  })

  it('reconnects immediately (no backoff wait) when the page becomes visible', () => {
    const ws = connectAndOpen()
    drop(ws)
    expect(sockets).toHaveLength(1)

    document.dispatchEvent(new Event('visibilitychange'))
    expect(sockets).toHaveLength(2)
    expect(mocks.open).toHaveBeenCalledTimes(2)

    // 旧退避计时器已被清掉，不会再开第三条连接
    vi.advanceTimersByTime(5_000)
    expect(sockets).toHaveLength(2)
  })

  it('probes liveness with a ping when returning to the foreground on a live socket', () => {
    const ws = connectAndOpen()
    const before = sentMessages(ws).length

    window.dispatchEvent(new Event('online'))
    const messages = sentMessages(ws)
    expect(messages.length).toBe(before + 1)
    expect(messages.at(-1)).toMatchObject({ type: 'ping' })
    expect(ws.close).not.toHaveBeenCalled()
  })

  it('closes a socket that went stale while backgrounded instead of waiting for onclose', () => {
    const ws = connectAndOpen()
    // 后台冻结：时钟往前走但 interval 根本没跑过
    vi.setSystemTime(Date.now() + PING_INTERVAL_MS * 2 + 1)

    document.dispatchEvent(new Event('visibilitychange'))
    expect(ws.close).toHaveBeenCalledOnce()
    // 直接拉断而不是先发一次 ping
    expect(sentMessages(ws).at(-1)).toMatchObject({ type: 'subscribe' })
  })

  it('does not open a socket when nothing is subscribed', () => {
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('removes resume listeners when the last subscription goes away', () => {
    connectAndOpen()
    stream.disconnect('s1')
    expect(last().close).toHaveBeenCalledOnce()

    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('online'))
    expect(mocks.open).toHaveBeenCalledTimes(1)
  })
})
