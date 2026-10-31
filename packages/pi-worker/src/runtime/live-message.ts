import { randomUUID } from 'node:crypto'
import type { JsonObject } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'
import type { LiveMessage } from './pagination.js'
import { toJson } from './native-json.js'

/**
 * 实时消息快照（liveMessage）：客户端在事件流之外还要渲染"正在写的那条"。
 * 这里记录快照内容、对应的原生消息身份，以及结束时刻的条目水位线——
 * 水位线用来判断落盘是否真的发生了（消息可能被扩展拦下或丢弃）。
 */
export interface LiveMessageCheckpoint {
  value: LiveMessage
  messageIdentity: unknown
  entriesBeforeEnd: number
  provisional: boolean
}

const TRACKED_ROLES = ['user', 'assistant', 'toolResult'] as const

function roleOf(message: unknown): string | undefined {
  return isJsonObject(message) ? (typeof message.role === 'string' ? message.role : undefined) : undefined
}

function isTracked(role: string | undefined): boolean {
  return role !== undefined && (TRACKED_ROLES as readonly string[]).includes(role)
}

/**
 * 由 message_start/update/end 推进快照：
 * - 同一角色、仍在 streaming，且（上一快照是采样来的或本帧不是 start）→ 复用 id，revision+1；
 * - 否则新 id、revision 归 1；
 * - message_end 进入 persisting 并记下条目水位线。
 */
export function nextLiveMessageCheckpoint(
  previous: LiveMessageCheckpoint | undefined,
  event: { type: string; message?: unknown },
  nativeEvent: JsonObject,
  entriesLength: number,
): LiveMessageCheckpoint | undefined {
  const nativeMessage = isJsonObject(nativeEvent.message) ? nativeEvent.message : undefined
  const nativeRole = roleOf(nativeMessage)
  if (!isTracked(nativeRole)) return previous
  if (event.type !== 'message_start' && event.type !== 'message_update' && event.type !== 'message_end') return previous
  const isStart = event.type === 'message_start'
  const currentMessage = previous && isJsonObject(previous.value.message) ? previous.value.message : undefined
  const currentRole = roleOf(currentMessage)
  const reusedCheckpoint =
    previous && currentRole === nativeRole && previous.value.phase === 'streaming' && (previous.provisional || !isStart)
  return {
    value: {
      id: reusedCheckpoint ? previous.value.id : randomUUID(),
      revision: reusedCheckpoint ? previous.value.revision + 1 : 1,
      phase: event.type === 'message_end' ? 'persisting' : 'streaming',
      message: nativeMessage ?? null,
    },
    messageIdentity: event.message,
    entriesBeforeEnd: event.type === 'message_end' ? entriesLength : (previous?.entriesBeforeEnd ?? entriesLength),
    provisional: false,
  }
}

/**
 * 采样会话同步状态里的 streamingMessage：扩展把 message_start 拦下时，
 * 原生事件还没到，但客户端已经可以显示这条消息了（provisional）。
 * 内容没变就不推进 revision，避免每个 tick 都广播。
 */
export function provisionalLiveMessageCheckpoint(
  previous: LiveMessageCheckpoint | undefined,
  streamingMessage: unknown,
  entriesLength: number,
): LiveMessageCheckpoint | undefined {
  const message = toJson(streamingMessage)
  const role = roleOf(message)
  if (!streamingMessage || !isJsonObject(message) || !isTracked(role)) return previous
  if (previous?.value.phase === 'persisting') return previous
  const currentRole = roleOf(previous?.value.message)
  const reusedCheckpoint =
    previous && currentRole === role && previous.value.phase === 'streaming' ? previous : undefined
  if (reusedCheckpoint && JSON.stringify(reusedCheckpoint.value.message) === JSON.stringify(message)) return previous
  return {
    value: {
      id: reusedCheckpoint?.value.id ?? randomUUID(),
      revision: reusedCheckpoint ? reusedCheckpoint.value.revision + 1 : 1,
      phase: 'streaming',
      message,
    },
    messageIdentity: streamingMessage,
    entriesBeforeEnd: entriesLength,
    provisional: true,
  }
}

/**
 * 结束时刻之后是否真的落盘了：只有 persisting 快照需要校验，
 * 水位线之后出现同一条原生消息条目才算落盘，否则保留快照（客户端仍在写）。
 */
export function shouldClearPersistedLiveMessage(
  checkpoint: LiveMessageCheckpoint,
  entries: ReadonlyArray<{ type?: string; message?: unknown }>,
): boolean {
  if (checkpoint.value.phase !== 'persisting') return false
  return entries
    .slice(checkpoint.entriesBeforeEnd)
    .some(entry => entry.type === 'message' && entry.message === checkpoint.messageIdentity)
}
