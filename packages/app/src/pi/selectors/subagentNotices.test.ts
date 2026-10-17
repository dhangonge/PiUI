import { describe, expect, it } from 'vitest'
import type { PiCustomMessageItem, PiTimelineItem } from '../domain'
import { applySubagentNotices, parseSubagentNotice } from './subagentNotices'

function noticeItem(
  entryId: string,
  shortId: string,
  status: string,
  body: string,
  details?: Record<string, unknown>,
): PiCustomMessageItem {
  return {
    kind: 'custom_message',
    entryId,
    timestamp: 100,
    rawEntry: {},
    customType: 'subagent-result',
    display: true,
    content: `[Subagent "Explore" ${shortId} ${status}]\n\n${body}`,
    details,
  } as unknown as PiCustomMessageItem
}

function agentCallItem(entryId: string, toolCallId: string, agentId: string): PiTimelineItem {
  return {
    kind: 'assistant_message',
    entryId,
    timestamp: 10,
    rawEntry: {},
    blocks: [{ type: 'toolCall', id: toolCallId, name: 'Agent', arguments: {} }],
    toolResults: {
      [toolCallId]: {
        role: 'toolResult',
        toolCallId,
        toolName: 'Agent',
        content: [{ type: 'text', text: `[Agent running] Success! Spawned. Agent ID: ${agentId}` }],
        details: { agentId, status: 'running', description: '后台长任务' },
        isError: false,
        timestamp: 11,
      },
    },
  } as unknown as PiTimelineItem
}

describe('parseSubagentNotice', () => {
  it('splits the header line off the notice body', () => {
    const notice = parseSubagentNotice(noticeItem('e2', 'a1b2c3d4', 'completed', '统计完成：42 个模块'))
    expect(notice).toEqual({ shortId: 'a1b2c3d4', status: 'completed', body: '统计完成：42 个模块' })
  })

  it('truncates a full agent id to the short id used by the card', () => {
    const notice = parseSubagentNotice(noticeItem('e2', 'a1b2c3d4ffffffff', 'error', 'boom'))
    expect(notice?.shortId).toBe('a1b2c3d4')
    expect(notice?.status).toBe('error')
  })

  it('ignores custom messages that are not subagent results', () => {
    const item = { ...noticeItem('e2', 'a1b2c3d4', 'completed', 'x'), customType: 'other' }
    expect(parseSubagentNotice(item as PiCustomMessageItem)).toBeUndefined()
  })

  it('ignores a subagent-result without the expected header', () => {
    const item = { ...noticeItem('e2', 'a1b2c3d4', 'completed', 'x'), content: 'just text' }
    expect(parseSubagentNotice(item as PiCustomMessageItem)).toBeUndefined()
  })
})

describe('applySubagentNotices', () => {
  it('merges a background agent notice into its tool card and drops the notice entry', () => {
    const agentId = 'a1b2c3d4-1111-2222-3333-444455556666'
    const items = [
      agentCallItem('e1', 'call-1', agentId),
      noticeItem('e2', 'a1b2c3d4', 'completed', '统计完成：42 个模块', { turnCount: 7 }),
    ]

    const result = applySubagentNotices(items)

    expect(result.merged.has('e2')).toBe(true)
    expect(result.items).toHaveLength(1)
    const merged = result.items[0]
    if (merged.kind !== 'assistant_message') throw new Error('expected assistant item')
    const toolResult = merged.toolResults['call-1']
    expect(toolResult.content).toEqual([{ type: 'text', text: '统计完成：42 个模块' }])
    expect(toolResult.isError).toBe(false)
    // status 以通知为准；agentId 只有卡片结果里有，必须留着才能停止/追问
    expect(toolResult.details).toMatchObject({ status: 'completed', agentId, description: '后台长任务', turnCount: 7 })
  })

  it('marks the card as errored when the notice reports an error status', () => {
    const agentId = 'deadbeef-1111-2222-3333-444455556666'
    const items = [
      agentCallItem('e1', 'call-1', agentId),
      noticeItem('e2', 'deadbeef', 'error', 'Error: boom', { stopReason: 'error' }),
    ]

    const result = applySubagentNotices(items)

    const merged = result.items[0]
    if (merged.kind !== 'assistant_message') throw new Error('expected assistant item')
    expect(merged.toolResults['call-1'].isError).toBe(true)
    expect(merged.toolResults['call-1'].details).toMatchObject({ status: 'error', agentId })
  })

  it('keeps only the latest notice when the agent was followed up', () => {
    const agentId = 'feedface-1111-2222-3333-444455556666'
    const items = [
      agentCallItem('e1', 'call-1', agentId),
      noticeItem('e2', 'feedface', 'completed', 'first result'),
      noticeItem('e3', 'feedface', 'stopped', 'final result'),
    ]

    const result = applySubagentNotices(items)

    expect([...result.merged]).toEqual(['e2', 'e3'])
    expect(result.items).toHaveLength(1)
    const merged = result.items[0]
    if (merged.kind !== 'assistant_message') throw new Error('expected assistant item')
    expect(merged.toolResults['call-1'].content).toEqual([{ type: 'text', text: 'final result' }])
    expect(merged.toolResults['call-1'].details).toMatchObject({ status: 'stopped' })
  })

  it('leaves unmatched notices in place for the fallback result view', () => {
    const agentId = 'aaaa1111-1111-2222-3333-444455556666'
    const items = [noticeItem('e2', 'bbbb2222', 'completed', 'no card for this agent')]

    const result = applySubagentNotices(items)

    expect(result.merged.size).toBe(0)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].kind).toBe('custom_message')
    // 通知没配对时连 agentId 都不会被碰
    expect(agentId).toBe('aaaa1111-1111-2222-3333-444455556666')
  })

  it('returns the input untouched when there are no notices', () => {
    const items = [agentCallItem('e1', 'call-1', 'a1b2c3d4-1111-2222-3333-444455556666')]

    const result = applySubagentNotices(items)

    expect(result.items).toBe(items)
    expect(result.merged.size).toBe(0)
  })
})
