import type { JsonObject } from '@piui/protocol'
import type { PiEventMeta } from '../runtime.js'

export interface PiEventFrame {
  event: JsonObject
  meta: PiEventMeta
  /** 入队时的 sessionId：flush 发生在入队之后，不能改用「当前」会话身份 */
  sessionId: string
}

export interface EventCoalescer<T> {
  push(frame: T): void
  flush(): void
  dispose(): void
}

export const DEFAULT_MESSAGE_UPDATE_INTERVAL_MS = 80
/** 低于一帧（~16ms）的窗口没有意义，只会把每帧切成两半 */
export const MIN_MESSAGE_UPDATE_INTERVAL_MS = 16

export function resolveMessageUpdateIntervalMs(raw?: string | number): number {
  const value = typeof raw === 'number' ? raw : raw === undefined ? Number.NaN : Number(raw.trim())
  if (!Number.isFinite(value) || value < MIN_MESSAGE_UPDATE_INTERVAL_MS) return DEFAULT_MESSAGE_UPDATE_INTERVAL_MS
  return Math.floor(value)
}

/**
 * SDK 的流式 delta 间隔约 10–20ms，且每帧都携带完整累积消息——逐帧出站会让
 * 单条长回复的 WS 字节量随回复长度 O(n²) 增长。这里只保留窗口内最新的
 * message_update（trailing edge，最后一帧一定会发出，不丢内容），其余事件
 * 发送前先 flush 挂起帧，保证 pi.event 通道的顺序不被合流打乱。
 */
export function createPiEventCoalescer(
  send: (frame: PiEventFrame) => void,
  options: { intervalMs?: string | number } = {},
): EventCoalescer<PiEventFrame> {
  const intervalMs = resolveMessageUpdateIntervalMs(options.intervalMs ?? process.env.PIUI_MESSAGE_UPDATE_INTERVAL_MS)
  let pending: PiEventFrame | undefined
  let timer: NodeJS.Timeout | undefined
  let disposed = false

  const clearTimer = (): void => {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  const flush = (): void => {
    clearTimer()
    const frame = pending
    pending = undefined
    if (frame) send(frame)
  }

  const push = (frame: PiEventFrame): void => {
    if (disposed) return
    if (frame.event.type !== 'message_update') {
      flush()
      send(frame)
      return
    }
    pending = frame
    if (timer) return
    timer = setTimeout(flush, intervalMs)
    // 进程退出不该被一帧挂起数据挡住（dispose 会先 flush，这里只是兜底）
    timer.unref()
  }

  return {
    push,
    flush,
    dispose(): void {
      flush()
      disposed = true
    },
  }
}
