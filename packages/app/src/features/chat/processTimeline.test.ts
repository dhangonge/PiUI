import { describe, expect, it } from 'vitest'
import { buildProcessTimeline, reuseProcessTimelineItems } from './processTimeline'
import { buildTurnDurationMap } from './chatPageModel'
import {
  createAssistantItem,
  createTextBlock,
  createToolCall,
  createUserItem,
  rawEntry,
} from '../../test/chatTimelineFixtures'
import type { PiAssistantMessageItem, PiTimelineItem } from '../../pi/domain/index.js'

describe('reuseProcessTimelineItems', () => {
  const hasProcess = (item: PiAssistantMessageItem) =>
    item.blocks.some(b => b.type === 'toolCall' || b.type === 'thinking')
  const hasFinal = (item: PiAssistantMessageItem) => item.blocks.some(b => b.type === 'text')

  it('keeps historical timeline item identity when only the last message streams', () => {
    const items = [
      { ...createUserItem('user-1', 1), blocks: [{ type: 'text' as const, text: 'prompt' }] },
      createAssistantItem('assistant-1', [createTextBlock('old')], 2, 3),
      { ...createUserItem('user-2', 4), blocks: [{ type: 'text' as const, text: 'next' }] },
      createAssistantItem('assistant-2', [createTextBlock('hello')], 5),
    ]

    const first = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 1000]]),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })

    const streamingItem = items[items.length - 1] as PiAssistantMessageItem
    const nextItems = [...items.slice(0, -1), { ...streamingItem, blocks: [createTextBlock('hello world')] }]
    const rebuilt = buildProcessTimeline(nextItems, {
      turnDurationMap: new Map([['assistant-1', 1000]]),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    const reused = reuseProcessTimelineItems(first, rebuilt)

    expect(reused.length).toBe(first.length)
    for (let i = 0; i < reused.length - 1; i++) {
      expect(reused[i]).toBe(first[i])
    }
    expect(reused.at(-1)).not.toBe(first.at(-1))
    expect(reused.at(-1)?.key).toBe(first.at(-1)?.key)
  })

  it('returns the previous array reference when nothing changed', () => {
    const items = [
      { ...createUserItem('user-1', 1), blocks: [{ type: 'text' as const, text: 'prompt' }] },
      createAssistantItem('assistant-1', [createTextBlock('done')], 2, 3),
    ]
    const first = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 500]]),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    const rebuilt = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 500]]),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    expect(reuseProcessTimelineItems(first, rebuilt)).toBe(first)
  })
})

describe('buildProcessTimeline', () => {
  const hasProcess = (item: PiAssistantMessageItem) =>
    item.blocks.some(b => b.type === 'toolCall' || b.type === 'thinking')
  const hasFinal = (item: PiAssistantMessageItem) => item.blocks.some(b => b.type === 'text')

  it('delays empty Working shell until entry-ready gate opens', () => {
    const items = [createUserItem('user-1', 1000)]
    // ChatArea 会在 user 入场完成后再额外 delay，再把 id 放进 ready 集合
    const ready = new Set<string>()
    const early = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => ready.has(id),
    })
    expect(early).toHaveLength(1)
    expect(early[0]).toMatchObject({ kind: 'message', key: 'user-1' })

    ready.add('user-1')
    const after = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => ready.has(id),
    })
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({
      kind: 'process-shell',
      isActive: true,
      startedAt: 1000,
      children: [],
    })
  })

  it('shows Working shell immediately once any assistant content exists', () => {
    const mid: PiAssistantMessageItem = {
      ...createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001),
      isStreaming: true,
    }
    const items = [createUserItem('user-1', 1000), mid]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      // 用户入场未完成也不拦：有 assistant 就立刻挂
      isUserEntryReady: () => false,
    })
    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeTruthy()
    if (shell?.kind === 'process-shell') {
      expect(shell.children.map(c => c.item.entryId)).toEqual(['assistant-1'])
    }
  })

  it('drops empty Working shell after abort when no assistant ever arrived', () => {
    const items = [createUserItem('user-1', 1000)]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({ kind: 'message', key: 'user-1' })
  })

  it('keeps only the earliest pending Working shell when a later user is queued', () => {
    // 第一轮仍 live，第二轮 user 已发出 → 只挂 user-1 的 Working，user-2 暂不挂空壳
    const mid: PiAssistantMessageItem = {
      ...createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001),
      isStreaming: true,
    }
    const items = [createUserItem('user-1', 1000), mid, createUserItem('user-2', 2000)]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => id === 'user-2',
    })

    const shells = timeline.filter(item => item.kind === 'process-shell')
    expect(shells).toHaveLength(1)
    expect(shells[0]).toMatchObject({
      kind: 'process-shell',
      isActive: true,
      userMessageId: 'user-1',
    })
    if (shells[0].kind === 'process-shell') {
      expect(shells[0].children.map(c => c.item.entryId)).toEqual(['assistant-1'])
    }
    // user-2 只作为消息出现，不挂 Working
    expect(timeline.some(i => i.kind === 'message' && i.key === 'user-2')).toBe(true)
  })

  it('only arms the earliest empty turn when multiple users are pending', () => {
    // 快速连发：两轮都还没 assistant → 只在最早 user 下挂 Working
    const items = [createUserItem('user-1', 1000), createUserItem('user-2', 1500)]
    const ready = new Set(['user-1', 'user-2'])
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => ready.has(id),
    })

    const shells = timeline.filter(item => item.kind === 'process-shell')
    expect(shells).toHaveLength(1)
    expect(shells[0]).toMatchObject({
      kind: 'process-shell',
      isActive: true,
      userMessageId: 'user-1',
      children: [],
    })
    expect(timeline.filter(i => i.kind === 'message').map(i => i.key)).toEqual(['user-1', 'user-2'])
  })

  it('closes earlier turn when later turn gets SSE live, even if earlier still looks live', () => {
    // 关键竞态：前轮 completed 常晚到；后轮 live 一到，前轮立刻 Worked
    const earlierStillFlaggedLive: PiAssistantMessageItem = {
      ...createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001),
      isStreaming: true,
    }
    const laterLive: PiAssistantMessageItem = {
      ...createAssistantItem('assistant-2', [createToolCall('tool-2')], 2001),
      isStreaming: true,
    }
    const items = [createUserItem('user-1', 1000), earlierStillFlaggedLive, createUserItem('user-2', 2000), laterLive]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })

    const shells = timeline.filter(item => item.kind === 'process-shell')
    expect(shells).toHaveLength(2)
    expect(shells[0]).toMatchObject({ userMessageId: 'user-1', isActive: false })
    expect(shells[1]).toMatchObject({ userMessageId: 'user-2', isActive: true })
  })

  it('keeps the last turn Working while the session is still busy (multi-step gap)', () => {
    // 上一步已 completed、下一步还没到，但会话仍 busy —— 多步 agent 的常态。
    // 这一刻判成 Worked 就会先收壳，下一步内容到了再展开，看着像提前收工。
    const stepped = createAssistantItem(
      'assistant-1',
      [createToolCall('tool-1'), createTextBlock('看一眼')],
      1001,
      1500,
    )
    const items = [createUserItem('user-1', 1000), stepped]
    const busy = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 500]]),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    expect(busy.find(item => item.kind === 'process-shell')).toMatchObject({
      kind: 'process-shell',
      isActive: true,
    })

    // busy 摘掉（idle）→ 收壳，并显示总耗时
    const settled = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 500]]),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    expect(settled.find(item => item.kind === 'process-shell')).toMatchObject({
      kind: 'process-shell',
      isActive: false,
      durationMs: 500,
    })
  })

  it('settles the previous turn once the next user turn lands, even while busy', () => {
    // 发送瞬间：busy 已 true、新 user 已入列 → 上一轮立刻 Worked，不能闪回 Working
    const settled = createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('done')], 1001, 1500)
    const items = [createUserItem('user-1', 1000), settled, createUserItem('user-2', 2000)]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 500]]),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    const shells = timeline.filter(item => item.kind === 'process-shell')
    expect(shells[0]).toMatchObject({ userMessageId: 'user-1', isActive: false })
    expect(shells[1]).toMatchObject({ userMessageId: 'user-2', isActive: true })
  })

  it('settles shell with process inside and final answer outside', () => {
    const processOnly = createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001, 1200)
    const finalAnswer = createAssistantItem(
      'assistant-2',
      [createToolCall('tool-2'), createTextBlock('done')],
      1201,
      1500,
    )
    const items = [createUserItem('user-1', 1000), processOnly, finalAnswer]
    const durationMap = buildTurnDurationMap(items, items)
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: durationMap,
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })

    const shell = timeline.find(item => item.kind === 'process-shell')
    expect(shell).toBeTruthy()
    if (shell?.kind !== 'process-shell') return
    expect(shell.isActive).toBe(false)
    expect(shell.durationMs).toBe(500)
    expect(shell.children.map(c => [c.item.entryId, c.processContentScope])).toEqual([
      ['assistant-1', 'inline'],
      ['assistant-2', 'process'],
    ])
    expect(shell.finalItem?.entryId).toBe('assistant-2')
  })

  it('does not reopen an aborted empty turn when streaming starts before the next user lands', () => {
    // 用户发了第一条、打断、再发：streaming 先 true，新 user 未入列，最新仍是空的 user-1
    // 若 isUserEntryReady(user-1) 仍 true（上次 Working 闸门残留），旧空壳会瞬间闪一下
    const items = [createUserItem('user-1', 1000)]
    const staleReady = new Set(['user-1'])
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      // 模拟 idle 后闸门已清空：旧 user 不应再 armed
      isUserEntryReady: id => staleReady.has(id) && false,
    })
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({ kind: 'message', key: 'user-1' })

    // 闸门未清空时的错误形态（回归文档）：ready 仍在 → 会挂空壳
    const leaked = buildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => staleReady.has(id),
    })
    // 有 ready 时仍允许挂（当前发送周期内合法）；关键是 ChatArea idle 时清空 ready
    // 这里只断言：无 ready 时绝不挂
    expect(timeline.some(i => i.kind === 'process-shell')).toBe(false)
    expect(leaked.some(i => i.kind === 'process-shell')).toBe(true)
  })

  it('does not wrap pure final answer turns in an empty process shell', () => {
    const plain = createAssistantItem('assistant-1', [createTextBlock('hello')], 1001, 1100)
    const items = [createUserItem('user-1', 1000), plain]
    const timeline = buildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-1', 100]]),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })

    expect(timeline.map(item => item.kind)).toEqual(['message', 'message'])
    expect(timeline[1]).toMatchObject({ kind: 'message', key: 'process-shell:user-1' })
  })

  it('keeps a pure text response row key stable when streaming settles', () => {
    const liveUser = createUserItem('live-user', 1000)
    const streaming = {
      ...createAssistantItem('assistant-1', [createTextBlock('hello')], 1001),
      isStreaming: true,
    }
    const active = buildProcessTimeline([liveUser, streaming], {
      turnDurationMap: new Map(),
      sessionIsStreaming: true,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    const persistedUser = {
      ...createUserItem('user-1', 1000),
      renderKey: liveUser.entryId,
    }
    const completed = buildProcessTimeline(
      [persistedUser, createAssistantItem('assistant-1', [createTextBlock('hello')], 1001, 1200)],
      {
        turnDurationMap: new Map([['assistant-1', 200]]),
        sessionIsStreaming: false,
        messageHasProcess: hasProcess,
        messageHasFinal: hasFinal,
      },
    )

    expect(active.map(item => item.key)).toEqual(['live-user', 'process-shell:live-user'])
    expect(completed.map(item => item.key)).toEqual(active.map(item => item.key))
    expect(completed[1]).toMatchObject({ kind: 'message', item: { entryId: 'assistant-1' } })
  })

  // 回归：系统条目（compaction / custom_message / bash 组）曾把后续助手踢出壳，
  // 且被整体提前到所有用户消息之前——过程内容于是显示在用户气泡上方且不折叠。
  it('keeps a system entry in place and keeps its turn inside the shell', () => {
    const compaction = {
      kind: 'compaction' as const,
      entryId: 'compaction-1',
      timestamp: 1001,
      summary: 'sum',
      rawEntry: rawEntry('compaction-1', 1001),
    } as unknown as PiTimelineItem
    const timeline = buildProcessTimeline(
      [
        createUserItem('user-1', 1000),
        compaction,
        createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('answer')], 1002, 1200),
      ],
      {
        turnDurationMap: new Map(),
        sessionIsStreaming: false,
        messageHasProcess: hasProcess,
        messageHasFinal: hasFinal,
      },
    )
    expect(timeline.map(item => item.key)).toEqual(['user-1', 'process-shell:user-1', 'compaction-1'])
    expect(timeline[1]).toMatchObject({
      kind: 'process-shell',
      isActive: false,
      children: [{ item: { entryId: 'assistant-1' } }],
    })
  })

  it('keeps a flat assistant at the page head in position instead of hoisting it', () => {
    const timeline = buildProcessTimeline(
      [
        createAssistantItem('assistant-leading', [createTextBlock('continued')], 500, 600),
        createUserItem('user-1', 1000),
        createAssistantItem('assistant-1', [createTextBlock('answer')], 1001, 1200),
      ],
      {
        turnDurationMap: new Map(),
        sessionIsStreaming: false,
        messageHasProcess: hasProcess,
        messageHasFinal: hasFinal,
      },
    )
    expect(timeline.map(item => item.key)).toEqual(['assistant-leading', 'user-1', 'process-shell:user-1'])
  })
})
