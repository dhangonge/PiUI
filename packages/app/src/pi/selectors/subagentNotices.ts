import type { PiCustomMessageItem, PiTimelineItem } from '../domain'
import type { ToolResultMessage } from '@earendil-works/pi-ai'

/**
 * 合并 pi-subagents-lite 的完成通知到 Agent 工具卡片。
 *
 * 后台 agent 的工具调用在 spawn 时就返回了（结果是 `[Agent running] ... Agent
 * ID: <id>`，details.status = 'running'），真正的结束信号只出现在插件的
 * `subagent-result` 自定义消息里（spawn-coordinator.ts:186 emitIndividualNudge）：
 *
 *   content: `[Subagent "<type>" <agentId 前 8 位> <status>]\n\n<结果 + 状态注脚>`
 *   details: buildAgentDetails(record, { includeStats: true, includeStatus: true })
 *
 * 通知的 details 里没有 agentId、卡片的 details 里没有 status，两边唯一的钥匙
 * 是那把短 id（`SHORT_ID_LENGTH = 8`，types.ts:91）。所以这里按短 id 对表：
 * 把通知的结果正文与统计并进卡片的结果，再把通知条目从时间线上摘掉——
 * 否则卡片永远停在 running、停止按钮不消失，下面还多一张重复的结果卡。
 *
 * 对不上表的通知（会话里没有对应的工具卡片、或被合并的卡片落在其它分页）
 * 原样保留，由 SubagentResultView 兜底渲染。
 */

const SUBAGENT_HEADER = /^\[Subagent\s+"[^"]*"\s+(\S+)\s+([a-z_]+)\]\s*/
const SHORT_ID_LENGTH = 8

export interface SubagentNotice {
  /** 插件 agentId 的前 8 位，与卡片 `details.agentId` 对表 */
  shortId: string
  /** 插件 AgentStatus 七值之一 */
  status: string
  /** 去掉标题行后的正文（结果 + 错误说明 + 状态注脚） */
  body: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function messageText(item: PiCustomMessageItem): string {
  if (typeof item.content === 'string') return item.content
  return (item.content ?? [])
    .filter(block => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => (block as { text: string }).text)
    .join('\n')
}

/** 解析 `subagent-result` 通知；不是这个形状就返回 undefined（保底渲染）。 */
export function parseSubagentNotice(item: PiCustomMessageItem): SubagentNotice | undefined {
  if (item.customType !== 'subagent-result') return undefined
  const text = messageText(item)
  const match = SUBAGENT_HEADER.exec(text)
  if (!match) return undefined
  return {
    shortId: match[1].slice(0, SHORT_ID_LENGTH),
    status: match[2],
    body: text.slice(match[0].length).trim(),
  }
}

function mergeResult(
  result: ToolResultMessage | undefined,
  notice: SubagentNotice,
  noticeDetails: Record<string, unknown> | undefined,
  timestamp: number,
): ToolResultMessage {
  const toolDetails = asRecord(result?.details) ?? {}
  return {
    ...(result ?? { role: 'toolResult' as const, toolCallId: '', toolName: 'Agent' }),
    content: [{ type: 'text' as const, text: notice.body }],
    details: {
      ...toolDetails,
      ...(noticeDetails ?? {}),
      // 通知里的 status 是终态；agentId 只有卡片结果里有，保留以支持停止/追问
      status: notice.status,
    } as ToolResultMessage['details'],
    isError: notice.status === 'error',
    timestamp,
  }
}

/**
 * 就地重写 assistant 条目里配对的工具结果，并返回需要从时间线摘掉的通知条目。
 * 同一个 agent 多次追问（MessageAgent）会来多条通知：以最后一条为准，
 * 其余一并摘掉——卡片只保留一条最新结果。
 */
export function applySubagentNotices(items: PiTimelineItem[]): {
  items: PiTimelineItem[]
  merged: Set<string>
} {
  const notices = new Map<
    string,
    Array<{ entryId: string; timestamp: number; notice: SubagentNotice; details?: Record<string, unknown> }>
  >()
  for (const item of items) {
    if (item.kind !== 'custom_message') continue
    const notice = parseSubagentNotice(item)
    if (!notice) continue
    const bucket = notices.get(notice.shortId) ?? []
    bucket.push({ entryId: item.entryId, timestamp: item.timestamp, notice, details: asRecord(item.details) })
    notices.set(notice.shortId, bucket)
  }
  const merged = new Set<string>()
  if (notices.size === 0) return { items, merged }

  for (const item of items) {
    if (item.kind !== 'assistant_message') continue
    for (const block of item.blocks) {
      if (block.type !== 'toolCall') continue
      const result = item.toolResults[block.id]
      const agentId = asRecord(result?.details)?.agentId
      if (typeof agentId !== 'string') continue
      const bucket = notices.get(agentId.slice(0, SHORT_ID_LENGTH))
      if (!bucket?.length) continue
      const latest = bucket[bucket.length - 1]
      item.toolResults[block.id] = mergeResult(result, latest.notice, latest.details, latest.timestamp)
      for (const entry of bucket) merged.add(entry.entryId)
    }
  }

  if (merged.size === 0) return { items, merged }
  return { items: items.filter(item => !merged.has(item.entryId)), merged }
}
