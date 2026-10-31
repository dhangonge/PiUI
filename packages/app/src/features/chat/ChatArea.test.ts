import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildChatPages,
  buildExpandedPageSelection,
  buildPageRenderSegments,
  buildTurnDurationMap,
  buildTurnLatestAssistantIdSet,
  computeAnchorRestoreScrollDelta,
  computeExpandedPageRange,
  estimateMessageRenderWeight,
  expandSelectionWithPageKeys,
  findMessageSequenceOffset,
  reconcileStableChatPages,
  seedMeasuredPageHeightsFromPreviousPages,
} from './chatPageModel'
import { getStreamingHotIndexes, getTimelineRowYClass, mergeVirtualRangeIndexes } from './chatAreaUtils'
import { FAR_FROM_BOTTOM_PX, NEAR_BOTTOM_PX, resolveAtBottom } from './virtual/atBottomHysteresis'
import {
  buildVisibleTimelineEntries,
  getVisibleTimelineForkTargetId,
  clearVisibleTimelineMergeCache,
} from './chatAreaVisibility'
import { createAssistantItem, createTextBlock, createToolCall, createUserItem } from '../../test/chatTimelineFixtures'
import type { Message, MessageError, Part } from '../../types/message'
import type { PiAssistantMessageItem } from '../../pi/domain/index.js'

function createUserMessage(id: string, created: number): Message {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'user',
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
      time: { created },
    },
    parts: [],
    isStreaming: false,
  }
}

function createAssistantMessage(
  id: string,
  parts: Part[],
  created = 1,
  completed?: number,
  error?: MessageError,
): Message {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      parentID: 'user-1',
      modelID: 'model-1',
      providerID: 'provider-1',
      mode: 'chat',
      agent: 'build',
      path: { cwd: '/workspace', root: '/workspace' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: completed == null ? { created } : { created, completed },
      error,
    },
    parts,
    isStreaming: false,
  }
}

function createTextPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  }
}

describe('buildVisibleTimelineEntries', () => {
  beforeEach(() => clearVisibleTimelineMergeCache())

  it('keeps source ids for merged assistant tool messages', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])

    const entries = buildVisibleTimelineEntries([first, second])

    expect(entries).toHaveLength(1)
    expect(entries[0].sourceIds).toEqual(['assistant-1', 'assistant-2'])
    expect((entries[0].item as PiAssistantMessageItem).blocks).toHaveLength(2)
  })

  it('merges when first message ends with tool followed by empty thinking', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1'), { type: 'thinking', thinking: '' }])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])

    const entries = buildVisibleTimelineEntries([first, second])

    expect(entries).toHaveLength(1)
    expect(entries[0].sourceIds).toEqual(['assistant-1', 'assistant-2'])
  })

  it('uses the latest merged assistant message as fork target', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])

    const entries = buildVisibleTimelineEntries([first, second])

    expect(entries).toHaveLength(1)
    expect(getVisibleTimelineForkTargetId(entries[0])).toBe('assistant-2')
  })

  it('keeps the merged source anchor stable when older tool history is prepended', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])
    const previousEntry = buildVisibleTimelineEntries([first, second])[0]
    const older = createAssistantItem('assistant-older', [createToolCall('tool-older')])
    const nextEntry = buildVisibleTimelineEntries([older, first, second])[0]

    expect(previousEntry.item.entryId).toBe('assistant-1')
    expect(nextEntry.item.entryId).toBe('assistant-older')
    expect(getVisibleTimelineForkTargetId(previousEntry)).toBe('assistant-2')
    expect(getVisibleTimelineForkTargetId(nextEntry)).toBe('assistant-2')
  })

  it('stabilizes merged visible item id when older tool history is prepended', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])
    const previous = buildVisibleTimelineEntries([first, second])
    const older = createAssistantItem('assistant-older', [createToolCall('tool-older')])
    const next = buildVisibleTimelineEntries([older, first, second])

    expect(previous[0].item.entryId).toBe('assistant-1')
    expect(next[0].item.entryId).toBe('assistant-older')
    expect(next[0].sourceIds).toEqual(['assistant-older', 'assistant-1', 'assistant-2'])
    expect((next[0].item as PiAssistantMessageItem).blocks).toHaveLength(3)
  })

  it('keeps aborted assistant messages that already have renderable blocks', () => {
    const item = createAssistantItem('assistant-aborted-with-tool', [createToolCall('tool-1')], 1, 2, {
      stopReason: 'aborted',
      errorMessage: 'Aborted',
    })

    const entries = buildVisibleTimelineEntries([item])

    expect(entries).toHaveLength(1)
    expect(entries[0].item.entryId).toBe('assistant-aborted-with-tool')
  })

  it('reuses the same merged object when input item references are unchanged (streaming chunks)', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])

    const entries1 = buildVisibleTimelineEntries([first, second])
    // 流式 chunk：新数组，但历史 item 引用不变（timelineCache 语义）
    const entries2 = buildVisibleTimelineEntries([first, second])
    const entries3 = buildVisibleTimelineEntries([first, second])

    expect(entries1[0].item).toBe(entries2[0].item)
    expect(entries2[0].item).toBe(entries3[0].item)
  })

  it('rebuilds the merged object when a participant item reference changes', () => {
    const first = createAssistantItem('assistant-1', [createToolCall('tool-1')])
    const second = createAssistantItem('assistant-2', [createToolCall('tool-2')])

    const before = buildVisibleTimelineEntries([first, second])
    // second 内容更新（新引用）——比如 tool result 落盘
    const secondUpdated = createAssistantItem('assistant-2', [createToolCall('tool-2'), createTextBlock('done')])
    const after = buildVisibleTimelineEntries([first, secondUpdated])

    expect(before[0].item).not.toBe(after[0].item)
    expect((after[0].item as PiAssistantMessageItem).blocks).toHaveLength(3)
  })

  it('hides aborted assistant messages without renderable blocks', () => {
    const item = createAssistantItem('assistant-empty-abort', [{ type: 'thinking', thinking: '' }], 1, 2, {
      stopReason: 'aborted',
      errorMessage: 'Aborted',
    })

    const entries = buildVisibleTimelineEntries([item])

    expect(entries).toHaveLength(0)
  })
})

describe('buildTurnDurationMap', () => {
  it('assigns each turn duration to the latest visible assistant message in that turn', () => {
    const items = [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [], 1001, 1200),
      createAssistantItem('assistant-2', [], 1201, 1500),
      createUserItem('user-2', 2000),
      createAssistantItem('assistant-3', [], 2001, 2600),
    ]

    const visibleItems = [items[1], items[2], items[4]]
    const durationMap = buildTurnDurationMap(items, visibleItems)

    expect(durationMap.get('assistant-2')).toBe(500)
    expect(durationMap.get('assistant-3')).toBe(600)
    expect(durationMap.has('assistant-1')).toBe(false)
  })
})

describe('buildTurnLatestAssistantIdSet', () => {
  it('keeps only the latest visible assistant id per user turn', () => {
    const items = [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [], 1001, 1200),
      createAssistantItem('assistant-2', [], 1201, 1500),
      createUserItem('user-2', 2000),
      createAssistantItem('assistant-3', [], 2001, 2600),
    ]
    // 需要包含 user 消息才能划分回合边界
    const latest = buildTurnLatestAssistantIdSet(items)

    expect(latest.has('assistant-1')).toBe(false)
    expect(latest.has('assistant-2')).toBe(true)
    expect(latest.has('assistant-3')).toBe(true)
  })
})

describe('streaming virtual range helpers', () => {
  it('pins the last one or two timeline indexes while streaming', () => {
    expect(getStreamingHotIndexes(0, true)).toEqual([])
    expect(getStreamingHotIndexes(5, false)).toEqual([])
    expect(getStreamingHotIndexes(1, true)).toEqual([0])
    expect(getStreamingHotIndexes(5, true)).toEqual([3, 4])
  })

  it('merges pinned indexes into the virtual range without duplicates', () => {
    expect(mergeVirtualRangeIndexes([1, 2, 3], [], [])).toEqual([1, 2, 3])
    expect(mergeVirtualRangeIndexes([1, 2, 3], [8, 9], [3, 9])).toEqual([1, 2, 3, 8, 9])
  })
})

describe('getTimelineRowYClass', () => {
  it('keeps turn padding on user rows and process shells', () => {
    const user = { kind: 'message' as const, key: 'user-1', item: createUserItem('user-1', 1) }
    const shell = {
      kind: 'process-shell' as const,
      key: 'process-shell:user-1',
      userMessageId: 'user-1',
      startedAt: 1,
      isActive: false,
      children: [],
    }
    expect(getTimelineRowYClass(user)).toBe('py-3')
    expect(getTimelineRowYClass(shell)).toBe('py-3')
  })

  it('tightens vertical padding between consecutive assistant rows', () => {
    const prev = {
      kind: 'message' as const,
      key: 'assistant-1',
      item: createAssistantItem('assistant-1', [], 1, 2),
    }
    const current = {
      kind: 'message' as const,
      key: 'assistant-2',
      item: createAssistantItem('assistant-2', [], 3, 4),
    }
    const next = {
      kind: 'message' as const,
      key: 'assistant-3',
      item: createAssistantItem('assistant-3', [], 5, 6),
    }
    const user = { kind: 'message' as const, key: 'user-2', item: createUserItem('user-2', 7) }

    expect(getTimelineRowYClass(current, prev, next)).toBe('py-1')
    expect(getTimelineRowYClass(current, user, next)).toBe('pt-3 pb-1')
    expect(getTimelineRowYClass(current, prev, user)).toBe('pt-1 pb-3')
    expect(getTimelineRowYClass(current, user, user)).toBe('py-3')
  })
})

describe('buildChatPages', () => {
  it('chunks messages into render-order pages while preserving assistant groups', () => {
    const messages = [
      createUserMessage('user-1', 1),
      createAssistantMessage('assistant-1', [], 2, 3),
      createAssistantMessage('assistant-2', [], 4, 5),
      createUserMessage('user-2', 6),
      createAssistantMessage('assistant-3', [], 7, 8),
    ]

    const pages = buildChatPages(messages, 2)

    // render order: newest page first
    expect(pages).toHaveLength(3)
    expect(pages[0].messageIds).toEqual(['user-2', 'assistant-3'])
    // assistant-1 + assistant-2 应该保持在同一个 group/page，不被拆开
    expect(pages[1].messageIds).toEqual(['assistant-1', 'assistant-2'])
    expect(pages[2].messageIds).toEqual(['user-1'])
  })

  it('uses twenty visible messages as the default page size', () => {
    const messages = Array.from({ length: 25 }, (_unused, index) => createUserMessage(`user-${index}`, index))

    const pages = buildChatPages(messages)

    expect(pages).toHaveLength(2)
    expect(pages.map(page => page.messageIds.length)).toEqual([20, 5])
  })

  it('uses render weight only as an extreme page limit', () => {
    const largeMarkdown = Array.from(
      { length: 12 },
      (_unused, index) => `\`\`\`ts\nconst value${index} = ${index}\n\`\`\``,
    ).join('\n\n')
    const messages = [
      createUserMessage('user-1', 1),
      createAssistantMessage('assistant-heavy', [createTextPart('text-heavy', 'assistant-heavy', largeMarkdown)], 2, 3),
      createUserMessage('user-2', 4),
    ]

    const pages = buildChatPages(messages, 20, 12)

    expect(pages).toHaveLength(3)
    expect(pages[1].messageIds).toEqual(['assistant-heavy'])
    expect(pages[1].renderWeight).toBeGreaterThan(12)
  })

  it('counts blank lines before fenced code independently of indentation', () => {
    const suffix = '```ts\nconst value = 1\n```'
    const withoutIndent = createAssistantMessage('assistant-plain-lines', [
      createTextPart('text-plain-lines', 'assistant-plain-lines', `${'\n'.repeat(100)}${suffix}`),
    ])
    const withIndent = createAssistantMessage('assistant-indented-lines', [
      createTextPart('text-indented-lines', 'assistant-indented-lines', `${' \n'.repeat(100)}${suffix}`),
    ])

    expect(estimateMessageRenderWeight(withIndent)).toBe(estimateMessageRenderWeight(withoutIndent))
  })

  it('splits an oversized assistant group without breaking its visual continuation', () => {
    const messages = Array.from({ length: 8 }, (_unused, index) =>
      createAssistantMessage(`assistant-${index}`, [], index, index + 1),
    )

    const pages = buildChatPages(messages, 6)

    expect(pages).toHaveLength(2)
    expect(pages[0].messageIds).toEqual(['assistant-6', 'assistant-7'])
    expect(pages[1].messageIds).toEqual(messages.slice(0, 6).map(message => message.info.id))
    expect(pages[0].rows[0].continuesFromPrevious).toBe(true)
    expect(pages[1].rows[0].continuesToNext).toBe(true)
    const unsplitHeight = buildChatPages(messages.slice(0, 6), 6)[0].rows[0].estimatedHeight
    expect(pages[0].rows[0].estimatedHeight).toBe(buildChatPages(messages.slice(6), 6)[0].rows[0].estimatedHeight - 4)
    expect(pages[1].rows[0].estimatedHeight).toBe(unsplitHeight - 12)
  })
})

describe('computeExpandedPageRange', () => {
  it('preloads pages within two viewports around the visible range', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 1000 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 1000 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 1000 },
      { key: 'page-3', rows: [], messageIds: ['m3'], estimatedHeight: 1000 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: {},
      scrollOffsetFromBottom: 1450,
      viewportHeight: 300,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 2 })
  })

  it('keeps the next coarse page mounted even when the current page is taller than pixel overscan', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 8286 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 3664 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: { 'page-0': 8286 },
      scrollOffsetFromBottom: 0,
      viewportHeight: 900,
      adjacentPageCount: 1,
      adjacentPageMaxSourceHeight: 10800,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 1 })
  })

  it('does not preload an adjacent page from an extremely tall source page', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 4000 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 4000 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: { 'page-0': 78312 },
      scrollOffsetFromBottom: 0,
      viewportHeight: 900,
      adjacentPageCount: 1,
      adjacentPageMaxSourceHeight: 10800,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 0 })
  })

  it('keeps adjacent pages mounted near a page boundary', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 1000 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 1000 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 1000 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: {},
      scrollOffsetFromBottom: 850,
      viewportHeight: 300,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 1 })
  })

  it('does not mount adjacent pages in the middle of a tall page', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 2000 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 2000 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 2000 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: {},
      scrollOffsetFromBottom: 1000,
      viewportHeight: 300,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 0 })
  })

  it('treats the overscan end as an exclusive boundary', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 400 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 400 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: {},
      scrollOffsetFromBottom: 0,
      viewportHeight: 200,
      overscanPx: 200,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 0 })
  })

  it('keeps the viewport range narrow for far jump targets', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 400 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 400 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 400 },
      { key: 'page-3', rows: [], messageIds: ['m3'], estimatedHeight: 400 },
    ]

    const range = computeExpandedPageRange({
      pages,
      measuredPageHeights: {},
      scrollOffsetFromBottom: 0,
      viewportHeight: 200,
    })

    expect(range).toEqual({ startIndex: 0, endIndex: 1 })
    expect(Array.from(buildExpandedPageSelection(range, 3))).toEqual([0, 1, 3])
  })
})

describe('buildPageRenderSegments', () => {
  it('aggregates collapsed pages on both sides of the expanded range', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 100 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 110 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 120 },
      { key: 'page-3', rows: [], messageIds: ['m3'], estimatedHeight: 130 },
      { key: 'page-4', rows: [], messageIds: ['m4'], estimatedHeight: 140 },
    ]

    const segments = buildPageRenderSegments({
      pages,
      expandedPageSelection: buildExpandedPageSelection({ startIndex: 1, endIndex: 3 }),
      measuredPageHeights: { 'page-4': 200 },
    })

    expect(segments).toEqual([
      { kind: 'collapsed', key: 'collapsed:page-0:page-0', height: 100 },
      { kind: 'expanded', key: 'page-1', page: pages[1], measuredHeight: 110 },
      { kind: 'expanded', key: 'page-2', page: pages[2], measuredHeight: 120 },
      { kind: 'expanded', key: 'page-3', page: pages[3], measuredHeight: 130 },
      { kind: 'collapsed', key: 'collapsed:page-4:page-4', height: 200 },
    ])
  })

  it('keeps collapsed aggregates between the current page and a far jump target', () => {
    const pages = [
      { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 100 },
      { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 110 },
      { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 120 },
      { key: 'page-3', rows: [], messageIds: ['m3'], estimatedHeight: 130 },
    ]

    const segments = buildPageRenderSegments({
      pages,
      expandedPageSelection: buildExpandedPageSelection({ startIndex: 0, endIndex: 0 }, 3),
      measuredPageHeights: {},
    })

    expect(segments).toEqual([
      { kind: 'expanded', key: 'page-0', page: pages[0], measuredHeight: 100 },
      { kind: 'collapsed', key: 'collapsed:page-1:page-2', height: 230 },
      { kind: 'expanded', key: 'page-3', page: pages[3], measuredHeight: 130 },
    ])
  })
})

describe('lightweight render selection', () => {
  const pages = [
    { key: 'page-0', rows: [], messageIds: ['m0'], estimatedHeight: 100 },
    { key: 'page-1', rows: [], messageIds: ['m1'], estimatedHeight: 110 },
    { key: 'page-2', rows: [], messageIds: ['m2'], estimatedHeight: 120 },
    { key: 'page-3', rows: [], messageIds: ['m3'], estimatedHeight: 130 },
    { key: 'page-4', rows: [], messageIds: ['m4'], estimatedHeight: 140 },
  ]

  it('expands explicit page keys without widening unrelated pages', () => {
    const selection = expandSelectionWithPageKeys({
      pages,
      expandedPageSelection: buildExpandedPageSelection({ startIndex: 1, endIndex: 1 }),
      pageKeys: new Set(['page-4']),
    })

    expect(Array.from(selection)).toEqual([1, 4])
  })
})

describe('findMessageSequenceOffset', () => {
  it('finds the old message sequence inside the new one', () => {
    expect(findMessageSequenceOffset(['a', 'b', 'c', 'd'], ['b', 'c'])).toBe(1)
  })

  it('returns -1 when the old sequence is not contiguous', () => {
    expect(findMessageSequenceOffset(['a', 'b', 'x', 'c'], ['b', 'c'])).toBe(-1)
  })
})

describe('seedMeasuredPageHeightsFromPreviousPages', () => {
  it('carries measured height forward when a page appends to measured content', () => {
    const previousPages = [{ key: 'old-page', rows: [], messageIds: ['user-1', 'assistant-1'], estimatedHeight: 240 }]
    const pages = [{ key: 'new-page', rows: [], messageIds: ['user-1', 'assistant-1', 'user-2'], estimatedHeight: 320 }]
    const measuredPageHeights = { 'old-page': 980 }

    const seeded = seedMeasuredPageHeightsFromPreviousPages({ pages, previousPages, measuredPageHeights })

    expect(seeded).not.toBe(measuredPageHeights)
    expect(seeded['new-page']).toBe(1060)
  })

  it('does not seed from partial page overlap', () => {
    const previousPages = [{ key: 'old-page', rows: [], messageIds: ['user-1', 'assistant-1'], estimatedHeight: 240 }]
    const pages = [{ key: 'new-page', rows: [], messageIds: ['assistant-1', 'user-2'], estimatedHeight: 220 }]
    const measuredPageHeights = { 'old-page': 980 }

    const seeded = seedMeasuredPageHeightsFromPreviousPages({ pages, previousPages, measuredPageHeights })

    expect(seeded).toBe(measuredPageHeights)
    expect(seeded['new-page']).toBeUndefined()
  })
})

describe('reconcileStableChatPages', () => {
  const alloc = (() => {
    let index = 0
    return () => `page-${index++}`
  })()

  it('preserves existing page keys when loading older history', () => {
    const currentMessages = [
      createUserMessage('user-2', 6),
      createAssistantMessage('assistant-3', [], 7, 8),
      createUserMessage('user-3', 9),
      createAssistantMessage('assistant-4', [], 10, 11),
    ]
    const currentPages = reconcileStableChatPages({
      currentPages: [],
      nextMessages: currentMessages,
      allocateKey: alloc,
      pageMessageCount: 2,
    })

    const nextMessages = [
      createUserMessage('user-1', 1),
      createAssistantMessage('assistant-1', [], 2, 3),
      createAssistantMessage('assistant-2', [], 4, 5),
      ...currentMessages,
    ]
    const nextPages = reconcileStableChatPages({
      currentPages,
      nextMessages,
      allocateKey: alloc,
      pageMessageCount: 2,
    })

    expect(nextPages.slice(0, currentPages.length).map(page => page.key)).toEqual(currentPages.map(page => page.key))
  })

  it('only rebuilds the newest page segment when appending new messages', () => {
    const currentMessages = [
      createUserMessage('user-1', 1),
      createAssistantMessage('assistant-1', [], 2, 3),
      createUserMessage('user-2', 4),
      createAssistantMessage('assistant-2', [], 5, 6),
    ]
    const currentPages = reconcileStableChatPages({
      currentPages: [],
      nextMessages: currentMessages,
      allocateKey: alloc,
      pageMessageCount: 2,
    })

    const nextMessages = [
      ...currentMessages,
      createUserMessage('user-3', 7),
      createAssistantMessage('assistant-3', [], 8, 9),
    ]
    const nextPages = reconcileStableChatPages({
      currentPages,
      nextMessages,
      allocateKey: alloc,
      pageMessageCount: 2,
    })

    // 老的第二页 key 应该保住，避免整段历史一起重切
    expect(nextPages[nextPages.length - 1].key).toBe(currentPages[currentPages.length - 1].key)
  })

  it('keeps assistant continuation markers when an append crosses a page boundary', () => {
    const currentMessages = Array.from({ length: 8 }, (_unused, index) =>
      createAssistantMessage(`assistant-${index}`, [], index, index + 1),
    )
    const currentPages = reconcileStableChatPages({
      currentPages: [],
      nextMessages: currentMessages,
      allocateKey: alloc,
      pageMessageCount: 6,
    })
    const nextMessages = [
      ...currentMessages,
      ...Array.from({ length: 5 }, (_unused, index) =>
        createAssistantMessage(`assistant-${index + 8}`, [], index + 8, index + 9),
      ),
    ]

    const nextPages = reconcileStableChatPages({
      currentPages,
      nextMessages,
      allocateKey: alloc,
      pageMessageCount: 6,
    })

    expect(nextPages).toHaveLength(3)
    expect(nextPages[0].rows[0].continuesFromPrevious).toBe(true)
    expect(nextPages[1].rows[0].continuesFromPrevious).toBe(true)
    expect(nextPages[1].rows[0].continuesToNext).toBe(true)
    expect(nextPages[2].rows[0].continuesToNext).toBe(true)
  })

  it('keeps assistant continuation markers when prepending older history', () => {
    const currentMessages = Array.from({ length: 8 }, (_unused, index) =>
      createAssistantMessage(`assistant-${index + 2}`, [], index + 2, index + 3),
    )
    const currentPages = reconcileStableChatPages({
      currentPages: [],
      nextMessages: currentMessages,
      allocateKey: alloc,
      pageMessageCount: 6,
    })
    const olderMessages = [
      createAssistantMessage('assistant-0', [], 0, 1),
      createAssistantMessage('assistant-1', [], 1, 2),
    ]

    const nextPages = reconcileStableChatPages({
      currentPages,
      nextMessages: [...olderMessages, ...currentMessages],
      allocateKey: alloc,
      pageMessageCount: 6,
    })

    expect(nextPages).toHaveLength(3)
    // 已有页引用保持不变；continuation 只标在新 prepend 的老页上
    expect(nextPages[0]).toBe(currentPages[0])
    expect(nextPages[1]).toBe(currentPages[1])
    expect(nextPages[2].rows[0].continuesToNext).toBe(true)
  })

  it('does not rebuild existing pages when older turns are prepended', () => {
    const currentMessages = Array.from({ length: 8 }, (_unused, index) => [
      createUserMessage(`user-${index + 2}`, (index + 2) * 2),
      createAssistantMessage(`assistant-${index + 2}`, [], (index + 2) * 2 + 1, (index + 2) * 2 + 2),
    ]).flat()
    const currentPages = reconcileStableChatPages({
      currentPages: [],
      nextMessages: currentMessages,
      allocateKey: alloc,
      pageMessageCount: 4,
    })
    const olderMessages = [
      createUserMessage('user-0', 0),
      createAssistantMessage('assistant-0', [], 1, 2),
      createUserMessage('user-1', 3),
      createAssistantMessage('assistant-1', [], 4, 5),
    ]

    const nextPages = reconcileStableChatPages({
      currentPages,
      nextMessages: [...olderMessages, ...currentMessages],
      allocateKey: alloc,
      pageMessageCount: 4,
    })

    expect(nextPages.length).toBeGreaterThan(currentPages.length)
    expect(nextPages.slice(0, currentPages.length).map(page => page.key)).toEqual(currentPages.map(page => page.key))
    for (let index = 0; index < currentPages.length; index++) {
      expect(nextPages[index]).toBe(currentPages[index])
    }
  })
})

describe('computeAnchorRestoreScrollDelta', () => {
  it('returns the amount the anchor drifted downward', () => {
    expect(computeAnchorRestoreScrollDelta(24, 180)).toBe(156)
  })

  it('returns a negative value when the anchor drifted upward', () => {
    expect(computeAnchorRestoreScrollDelta(180, 24)).toBe(-156)
  })
})

describe('resolveAtBottom（输入区收起滞回）', () => {
  // 底部附近来回蹭：dist 从 0 蹭到 20px 再回 0，信号不能翻转
  it('keeps the previous state when the distance stays inside the hysteresis band', () => {
    let atBottom = true
    atBottom = resolveAtBottom(atBottom, 20, true)
    expect(atBottom).toBe(true)
    atBottom = resolveAtBottom(atBottom, 0, true)
    expect(atBottom).toBe(true)
  })

  it('reports away from bottom only past the far threshold, and returns below the near threshold', () => {
    const far = resolveAtBottom(true, FAR_FROM_BOTTOM_PX + 12, true)
    expect(far).toBe(false)
    expect(resolveAtBottom(far, 30, true)).toBe(false)
    expect(resolveAtBottom(far, NEAR_BOTTOM_PX - 5, true)).toBe(true)
  })

  it('treats the bottom-following state as at bottom regardless of distance', () => {
    // userScrolled=false：程序滚动 / 流式长高那一帧 dist 越线也不算离底
    expect(resolveAtBottom(false, 500, false)).toBe(true)
    expect(resolveAtBottom(true, 500, false)).toBe(true)
  })

  it('accepts custom thresholds', () => {
    expect(resolveAtBottom(true, 20, true, { nearPx: 10, farPx: 16 })).toBe(false)
    expect(resolveAtBottom(false, 20, true, { nearPx: 24, farPx: 48 })).toBe(true)
  })
})
