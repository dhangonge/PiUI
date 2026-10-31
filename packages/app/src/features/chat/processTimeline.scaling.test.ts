/**
 * 规模回归：buildProcessTimeline 的后缀判断必须线性增长。
 *
 * 记录基线（`timeline-baseline.json`，`09769ff8`，Node 纯模型探针，未计浏览器代价）：
 * 已结束 100 / 1000 / 5000 回合分别读 `isStreaming` 5250 / 502500 / 12512500 次，
 * 尾部 live 为 5050 / 500500 / 12502500 次——每轮向后扫后缀造成的二次增长。
 *
 * 这里只断言确定性的访问次数上界与规模比例，不做 wall-clock 断言：计时受主机负载影响，
 * 不能用来证明收益，访问次数可以。
 */
import { describe, expect, it } from 'vitest'
import { buildProcessTimeline } from './processTimeline'
import { createAssistantItem, createTextBlock, createToolCall, createUserItem } from '../../test/chatTimelineFixtures'
import type { PiAssistantMessageItem, PiTimelineItem } from '../../pi/domain/index.js'

/** 每个助手 / 回合允许的读取次数上界；线性实现实际约为 2 × 助手数 */
const LINEAR_READS_PER_ITEM = 3

/** 10 倍规模下允许的读取次数比例（线性 ≈ 10，二次 ≈ 100） */
const GROWTH_RATIO_LIMIT = 12

type Scenario =
  'settled' | 'tail-live' | 'idle-empty-users' | 'busy-empty-users' | 'multi-assistant' | 'gapped' | 'leading-flat'

const SCENARIOS: Scenario[] = [
  'settled',
  'tail-live',
  'idle-empty-users',
  'busy-empty-users',
  'multi-assistant',
  'gapped',
  'leading-flat',
]

type Fixture = {
  items: PiTimelineItem[]
  turns: number
  assistants: number
  reads: () => number
  sessionIsStreaming: boolean
}

const hasProcess = (item: PiAssistantMessageItem) =>
  item.blocks.some(b => b.type === 'toolCall' || b.type === 'thinking')
const hasFinal = (item: PiAssistantMessageItem) => item.blocks.some(b => b.type === 'text')

/**
 * 固定样例；助手带 `isStreaming` 读取计数。计数只在被测实现访问该字段时增长，
 * 因此同一份样例在旧实现和新实现之间可直接比较访问次数。
 */
function buildFixture(turns: number, scenario: Scenario): Fixture {
  let reads = 0
  const items: PiTimelineItem[] = []
  let assistants = 0

  const pushAssistant = (
    id: string,
    blocks: PiAssistantMessageItem['blocks'],
    created: number,
    completed: number | undefined,
    streaming: boolean,
  ) => {
    const counted: PiAssistantMessageItem = { ...createAssistantItem(id, blocks, created, completed) }
    Object.defineProperty(counted, 'isStreaming', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1
        return streaming
      },
    })
    items.push(counted)
    assistants += 1
  }

  const sessionIsStreaming = scenario === 'tail-live' || scenario === 'busy-empty-users'
  // 页首无 user 的助手：平铺，不参与回合聚合
  if (scenario === 'leading-flat') {
    pushAssistant('leading', [createToolCall('leading'), createTextBlock('continued')], 500, 600, false)
  }

  for (let index = 0; index < turns; index++) {
    const time = 1000 + index * 10
    items.push(createUserItem(`user-${index}`, time))
    if (scenario === 'idle-empty-users' || scenario === 'busy-empty-users') continue

    const streaming = scenario === 'tail-live' && index === turns - 1
    if (scenario === 'multi-assistant') {
      pushAssistant(`assistant-${index}-0`, [createToolCall(`t-${index}-0`)], time + 1, time + 2, false)
      pushAssistant(
        `assistant-${index}-1`,
        [createToolCall(`t-${index}-1`), createTextBlock('answer')],
        time + 3,
        time + 4,
        false,
      )
      continue
    }
    if (scenario === 'gapped' && index % 4 !== 0) continue
    pushAssistant(
      `assistant-${index}`,
      [createToolCall(`t-${index}`), createTextBlock('answer')],
      time + 1,
      streaming ? undefined : time + 2,
      streaming,
    )
  }

  return { items, turns, assistants, reads: () => reads, sessionIsStreaming }
}

function build(fixture: Fixture) {
  return buildProcessTimeline(fixture.items, {
    turnDurationMap: new Map(),
    sessionIsStreaming: fixture.sessionIsStreaming,
    messageHasProcess: hasProcess,
    messageHasFinal: hasFinal,
  })
}

function activeShells(timeline: ReturnType<typeof build>): number {
  return timeline.filter(item => item.kind === 'process-shell' && item.isActive).length
}

function expectLinearReads(fixture: Fixture, label: string) {
  const reads = fixture.reads()
  const budget = LINEAR_READS_PER_ITEM * (fixture.turns + fixture.assistants)
  expect(reads, `${label}: isStreaming 读取 ${reads} 次超出线性上界 ${budget}`).toBeLessThanOrEqual(budget)
  return reads
}

describe('buildProcessTimeline 规模', () => {
  it('每轮后缀扫描不再随历史长度二次增长', () => {
    // 已结束回合：旧实现在 1000 回合读 502500 次、5000 回合读 12512500 次
    for (const turns of [1000, 5000]) {
      const fixture = buildFixture(turns, 'settled')
      const timeline = build(fixture)
      expect(timeline).toHaveLength(turns * 2)
      expect(activeShells(timeline)).toBe(0)
      const reads = expectLinearReads(fixture, `settled/${turns}`)
      expect(reads, `settled/${turns}: 应远低于记录基线`).toBeLessThan(turns * 10)
    }
  })

  it('10 倍规模只增加约 10 倍读取次数（各场景）', () => {
    for (const scenario of SCENARIOS) {
      const small = buildFixture(100, scenario)
      build(small)
      const large = buildFixture(1000, scenario)
      build(large)

      const smallReads = expectLinearReads(small, `${scenario}/100`)
      const largeReads = expectLinearReads(large, `${scenario}/1000`)
      expect(
        largeReads,
        `${scenario}: 100→1000 回合读取 ${smallReads}→${largeReads} 次，超过线性比例 ${GROWTH_RATIO_LIMIT}`,
      ).toBeLessThanOrEqual(GROWTH_RATIO_LIMIT * smallReads)
    }
  })

  it('尾部 live、多空 user、多助手都各自只挂一个 Working', () => {
    const expectations: Array<{ scenario: Scenario; rows: (turns: number) => number; active: number }> = [
      { scenario: 'tail-live', rows: turns => turns * 2, active: 1 },
      { scenario: 'busy-empty-users', rows: turns => turns + 1, active: 1 },
      { scenario: 'idle-empty-users', rows: turns => turns, active: 0 },
      { scenario: 'multi-assistant', rows: turns => turns * 2, active: 0 },
      { scenario: 'gapped', rows: turns => turns + Math.ceil(turns / 4), active: 0 },
      { scenario: 'leading-flat', rows: turns => turns * 2 + 1, active: 0 },
    ]
    for (const { scenario, rows, active } of expectations) {
      const turns = 200
      const fixture = buildFixture(turns, scenario)
      const timeline = build(fixture)
      expect(timeline, `${scenario}: 行数`).toHaveLength(rows(turns))
      expect(activeShells(timeline), `${scenario}: Working 壳数量`).toBe(active)
      expectLinearReads(fixture, scenario)
    }
  })

  it('空助手历史不读取 isStreaming', () => {
    const fixture = buildFixture(500, 'idle-empty-users')
    build(fixture)
    expect(fixture.assistants).toBe(0)
    expect(expectLinearReads(fixture, 'idle-empty-users/500')).toBe(0)
  })
})
