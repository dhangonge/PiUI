import type { JsonObject, JsonValue } from '@piui/protocol'
import { isJsonObject } from '@piui/protocol'
import type { SessionHead } from './pagination.js'

/**
 * mock 会话状态的两个形状：
 * - catalog 预览（只读、条目来自文件）
 * - 活会话（由 MockPiSession 的实时字段推导）
 * 字段顺序即协议输出顺序，两者必须与真实 SDK 的 getState 对齐。
 */
/** 每次现造一份：状态对象会被上游改动，不能共享同一个字面量 */
function mockContextUsage(): JsonObject {
  return { tokens: 0, contextWindow: 200000, percent: 0 }
}

export interface MockPreviewStateParams {
  sessionId: string
  sessionFile: string
  sessionName: JsonValue
  cwd: string
  entries: JsonObject[]
  head: SessionHead
}

export function mockPreviewState(params: MockPreviewStateParams): JsonObject {
  const { sessionId, sessionFile, sessionName, cwd, entries, head } = params
  return {
    sessionId,
    sessionFile,
    sessionName,
    cwd,
    model: null,
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    messageCount: entries.length,
    pendingMessageCount: 0,
    availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    isIdle: true,
    isBashRunning: false,
    hasPendingBashMessages: false,
    isRetrying: false,
    retryAttempt: 0,
    queue: { steering: [], followUp: [], steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time' },
    supportsThinking: true,
    activeTools: [],
    scopedModels: [],
    sessionStats: {
      sessionFile,
      sessionId,
      userMessages: entries.filter(entry => isJsonObject(entry.message) && entry.message.role === 'user').length,
      assistantMessages: entries.filter(entry => isJsonObject(entry.message) && entry.message.role === 'assistant')
        .length,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: entries.length,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    contextUsage: mockContextUsage(),
    retry: null,
    compaction: null,
    head,
  }
}

export interface MockLiveStateParams {
  sessionId: string
  sessionFile: string | undefined
  sessionName: JsonValue
  cwd: string
  model: JsonValue
  thinkingLevel: string
  streaming: boolean
  compacting: boolean
  steeringMode: string
  followUpMode: string
  autoCompactionEnabled: boolean
  autoRetryEnabled: boolean
  entriesLength: number
  steeringQueue: readonly string[]
  followUpQueue: readonly string[]
  activeTools: readonly string[]
  head: SessionHead
}

export function mockLiveState(params: MockLiveStateParams): JsonObject {
  const sessionFile = params.sessionFile ?? null
  return {
    sessionId: params.sessionId,
    sessionFile,
    sessionName: params.sessionName,
    cwd: params.cwd,
    model: params.model,
    thinkingLevel: params.thinkingLevel,
    isStreaming: params.streaming,
    isCompacting: params.compacting,
    steeringMode: params.steeringMode,
    followUpMode: params.followUpMode,
    autoCompactionEnabled: params.autoCompactionEnabled,
    autoRetryEnabled: params.autoRetryEnabled,
    messageCount: params.entriesLength,
    pendingMessageCount: params.steeringQueue.length + params.followUpQueue.length,
    availableThinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    isIdle: !params.streaming,
    isBashRunning: false,
    hasPendingBashMessages: false,
    isRetrying: false,
    retryAttempt: 0,
    queue: {
      steering: [...params.steeringQueue],
      followUp: [...params.followUpQueue],
      steeringMode: params.steeringMode,
      followUpMode: params.followUpMode,
    },
    supportsThinking: true,
    activeTools: [...params.activeTools],
    scopedModels: [],
    // 与真实 SDK getSessionStats/getContextUsage 形状一致（mock 无真实消耗）
    sessionStats: {
      sessionFile,
      sessionId: params.sessionId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: params.entriesLength,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    contextUsage: mockContextUsage(),
    retry: { phase: 'idle', autoEnabled: params.autoRetryEnabled },
    compaction: { autoEnabled: params.autoCompactionEnabled, operation: { type: 'none' } },
    head: params.head,
  }
}
