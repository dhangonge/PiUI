import type { JsonObject, SessionActivityStatus } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'
import { toJson } from './native-json.js'

/**
 * 会话影子状态：Pi SDK 的事件流是"变更通知"，但宿主需要读快照
 * （getState / 活动状态）。这里把事件累积成可读的 retry/compaction 视图，
 * 只依赖事件字段与开关值，不碰会话内部对象，方便单独推演。
 */
export interface SessionShadow {
  isCompacting: boolean
  retry: JsonObject
  compaction: JsonObject
}

/** 会话当前生效的自动压缩/自动重试开关（每帧从会话读取，保证是最新值） */
export interface SessionShadowFlags {
  autoCompactionEnabled: boolean
  autoRetryEnabled: boolean
}

export interface ActivityFlags {
  streaming: boolean
  retrying: boolean
  compacting: boolean
}

/**
 * 开会话时的初值：retry 特意不带 autoEnabled——在第一个事件之前
 * getState 输出保持历史形状，避免客户端在首帧前看到多余字段。
 */
export function initialSessionShadow(): SessionShadow {
  return {
    isCompacting: false,
    retry: { phase: 'idle' },
    compaction: { autoEnabled: true, operation: { type: 'none' } },
  }
}

/** 会话被替换/重载后重建影子状态：此时会话已能给出自动压缩/重试开关 */
export function resetSessionShadow(flags: SessionShadowFlags): SessionShadow {
  return {
    isCompacting: false,
    retry: { phase: 'idle', autoEnabled: flags.autoRetryEnabled },
    compaction: { autoEnabled: flags.autoCompactionEnabled, operation: { type: 'none' } },
  }
}

/** 把一个原生事件累积进影子状态；返回新对象，不修改入参 */
export function trackSessionShadow(
  shadow: SessionShadow,
  event: { type: string; [key: string]: unknown },
  flags: SessionShadowFlags,
  now = Date.now(),
): SessionShadow {
  if (event.type === 'compaction_start') {
    return {
      isCompacting: true,
      retry: shadow.retry,
      compaction: {
        autoEnabled: flags.autoCompactionEnabled,
        operation: {
          type: 'compaction',
          phase: 'running',
          reason: toJson(event.reason) ?? null,
        },
        lastAborted: null,
        lastError: null,
        lastNotice: null,
      },
    }
  }
  if (event.type === 'compaction_end') {
    return {
      isCompacting: false,
      retry: shadow.retry,
      compaction: {
        ...shadow.compaction,
        autoEnabled: flags.autoCompactionEnabled,
        operation: { type: 'none' },
        lastResult: toJson(event.result) ?? shadow.compaction.lastResult ?? null,
        lastAborted: Boolean(event.aborted),
        lastError: toJson(event.errorMessage) ?? null,
      },
    }
  }
  if (event.type === 'auto_retry_start') {
    return {
      ...shadow,
      retry: {
        phase: 'waiting',
        autoEnabled: flags.autoRetryEnabled,
        attempt: Number(event.attempt),
        maxAttempts: Number(event.maxAttempts),
        delayMs: Number(event.delayMs),
        nextAttemptAt: new Date(now + Number(event.delayMs)).toISOString(),
        errorMessage: toJson(event.errorMessage) ?? null,
      },
    }
  }
  if (event.type === 'agent_start' && shadow.retry.phase === 'waiting') {
    return {
      ...shadow,
      retry: {
        phase: 'running',
        autoEnabled: flags.autoRetryEnabled,
        attempt: shadow.retry.attempt ?? 0,
        maxAttempts: shadow.retry.maxAttempts ?? 0,
      },
    }
  }
  if (event.type === 'agent_start' && shadow.retry.phase === 'finished') {
    return { ...shadow, retry: { phase: 'idle', autoEnabled: flags.autoRetryEnabled } }
  }
  if (event.type === 'auto_retry_end') {
    return {
      ...shadow,
      retry: {
        phase: 'finished',
        autoEnabled: flags.autoRetryEnabled,
        success: Boolean(event.success),
        attempt: Number(event.attempt),
        finalError: toJson(event.finalError) ?? null,
      },
    }
  }
  if (event.type === 'summarization_retry_scheduled') {
    const operation = isJsonObject(shadow.compaction.operation) ? shadow.compaction.operation : undefined
    if (!operation || operation.type === 'none') return shadow
    return {
      ...shadow,
      compaction: {
        ...shadow.compaction,
        operation: {
          ...operation,
          phase: 'retrying',
          attempt: Number(event.attempt),
          maxAttempts: Number(event.maxAttempts),
          delayMs: Number(event.delayMs),
          errorMessage: toJson(event.errorMessage) ?? null,
        },
      },
    }
  }
  if (event.type === 'summarization_retry_attempt_start') {
    const operation = isJsonObject(shadow.compaction.operation) ? shadow.compaction.operation : undefined
    if (!operation || operation.type === 'none') return shadow
    return {
      ...shadow,
      compaction: {
        ...shadow.compaction,
        operation: { ...operation, phase: 'running' },
      },
    }
  }
  return shadow
}

/** 由同步状态位推导活动状态；返回 null 表示空闲 */
export function activityStatus(
  flags: ActivityFlags,
  shadow: SessionShadow,
  retryAttempt: unknown,
): SessionActivityStatus | null {
  if (flags.retrying) {
    const nextAtIso = typeof shadow.retry.nextAttemptAt === 'string' ? shadow.retry.nextAttemptAt : undefined
    const nextAt = nextAtIso ? Date.parse(nextAtIso) : 0
    return {
      type: 'retry',
      attempt: typeof shadow.retry.attempt === 'number' ? shadow.retry.attempt : Number(retryAttempt ?? 1),
      message: typeof shadow.retry.errorMessage === 'string' ? shadow.retry.errorMessage : '',
      next: Number.isFinite(nextAt) ? nextAt : 0,
    }
  }
  if (flags.streaming) return { type: 'busy' }
  // 压缩中没有 LLM 流，但会话确实在干活——让宿主把它标为工作中
  if (flags.compacting) return { type: 'compacting' }
  return null
}

/** 分支总结（navigateTree + summarize）在原生流程外多挂一个 running 操作 */
export function withBranchSummaryRunning(shadow: SessionShadow, entryId: string): SessionShadow {
  return {
    ...shadow,
    isCompacting: true,
    compaction: {
      ...shadow.compaction,
      operation: { type: 'branchSummary', phase: 'running', targetEntryId: entryId },
    },
  }
}

export function withBranchSummaryFinished(shadow: SessionShadow): SessionShadow {
  return {
    ...shadow,
    isCompacting: false,
    compaction: { ...shadow.compaction, operation: { type: 'none' } },
  }
}
