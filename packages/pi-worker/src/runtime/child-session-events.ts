import type { EventBus } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'

/**
 * 子代理会话公告的三个约定频道（顺序即生命周期），payload 由插件定义：
 * `{ sessionId, parentSessionId? }`。改名或加字段都会破坏
 * subagent-integration 约定。
 */
export type ChildSessionPhase = 'created' | 'bound' | 'disposed'

export const CHILD_SESSION_CHANNELS = [
  ['subagents:child:session-created', 'created'],
  ['subagents:child:bound', 'bound'],
  ['subagents:child:disposed', 'disposed'],
] as const

/**
 * 把插件的子代理会话公告规整成宿主可用的事件。
 *
 * 约定不可改：频道名与字段由 subagent-integration 规定，payload 只有
 * { sessionId, parentSessionId? }。没有 sessionId 的公告直接丢弃（无法定位）。
 */
export function toChildSessionEvent(payload: unknown, phase: ChildSessionPhase): JsonObject | undefined {
  const record = isJsonObject(payload) ? payload : undefined
  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId : undefined
  if (!sessionId) return undefined
  return {
    phase,
    sessionId,
    parentSessionId: typeof record?.parentSessionId === 'string' ? record.parentSessionId : null,
  }
}

/** 订阅三个生命周期频道；返回全部退订函数 */
export function forwardChildSessionEvents(bus: EventBus, emit: (event: JsonObject) => void): Array<() => void> {
  return CHILD_SESSION_CHANNELS.map(([channel, phase]) =>
    bus.on(channel, payload => {
      const event = toChildSessionEvent(payload, phase)
      if (event) emit(event)
    }),
  )
}
