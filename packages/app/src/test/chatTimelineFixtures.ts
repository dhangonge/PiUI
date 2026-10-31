/**
 * Pi 时间线测试夹具（create*Item / 工具调用块等）。
 *
 * 放在 src/test 下：只被测试引用，且 vitest 的 coverage.exclude 已排除 src/test/**，
 * 不会把测试夹具算进覆盖率分母。纯工厂函数，无共享可变状态，测试文件之间互不污染。
 */
import type { SessionMessageEntry } from '@earendil-works/pi-coding-agent'
import type { ToolCall, ToolResultMessage } from '@earendil-works/pi-ai'
import type { PiAssistantMessageItem, PiUserMessageItem } from '../pi/domain/index.js'

// ─── Pi timeline fixtures ───────────────────────────────────────

export function rawEntry(id: string, timestamp = 1): SessionMessageEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role: 'user', content: '', timestamp },
  }
}

export function createUserItem(id: string, created: number): PiUserMessageItem {
  return {
    kind: 'user_message',
    entryId: id,
    timestamp: created,
    rawEntry: rawEntry(id, created),
    message: { role: 'user', content: '', timestamp: created },
    blocks: [],
  }
}

export function toolResultFor(call: ToolCall, timestamp = 2): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: '/workspace' }],
    isError: false,
    timestamp,
  }
}

export function createAssistantItem(
  id: string,
  blocks: PiAssistantMessageItem['blocks'],
  created = 1,
  completed?: number,
  error?: { stopReason: 'error' | 'aborted'; errorMessage: string },
): PiAssistantMessageItem {
  const toolCalls = blocks.filter((b): b is ToolCall => b.type === 'toolCall')
  const toolResults: Record<string, ToolResultMessage> = {}
  for (const call of toolCalls) toolResults[call.id] = toolResultFor(call)
  return {
    kind: 'assistant_message',
    entryId: id,
    timestamp: created,
    rawEntry: rawEntry(id, created),
    message: {
      role: 'assistant',
      content: blocks,
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'model-1',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: error?.stopReason ?? 'stop',
      errorMessage: error?.errorMessage,
      timestamp: completed ?? created,
    },
    blocks,
    toolResults,
    isStreaming: completed == null ? undefined : undefined,
  }
}

export function createToolCall(id: string): ToolCall {
  return { type: 'toolCall', id: `call-${id}`, name: 'bash', arguments: { command: 'pwd' } }
}

export function createTextBlock(text: string): Extract<PiAssistantMessageItem['blocks'][number], { type: 'text' }> {
  return { type: 'text', text }
}
