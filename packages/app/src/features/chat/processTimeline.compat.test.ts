/**
 * 时间线差分兼容测试（H 独立验证，不改生产代码）。
 *
 * 期望值来自 `src/test/processTimelineReference.ts` —— 940844c5 旧实现的逐字冻结拷贝，
 * 不调用当前 production 计算期望。每个语料同时断言：
 *   1. production 输出与冻结参考深相等（行为等价）；
 *   2. 手写的 key / 壳属性（独立于两个实现，防止两边一起写错）；
 *   3. 输入不被就地改写、输出复用输入 item 引用（引用稳定契约）。
 *
 * 语料全部确定性（固定 id / 时间戳 / 回调），不读 wall-clock，不 mock 计时器。
 */
import { describe, expect, it } from 'vitest'
import { buildProcessTimeline, reuseProcessTimelineItems, type ProcessTimelineItem } from './processTimeline'
import {
  REFERENCE_SOURCE_COMMIT,
  referenceBuildProcessTimeline,
  referenceReuseProcessTimelineItems,
  type ReferenceProcessTimelineItem,
} from '../../test/processTimelineReference'
import {
  createAssistantItem,
  createTextBlock,
  createToolCall,
  createUserItem,
  rawEntry,
  toolResultFor,
} from '../../test/chatTimelineFixtures'
import type { PiAssistantMessageItem, PiTimelineItem } from '../../pi/domain/index.js'

const hasProcess = (item: PiAssistantMessageItem) =>
  item.blocks.some(b => b.type === 'toolCall' || b.type === 'thinking')
const hasFinal = (item: PiAssistantMessageItem) => item.blocks.some(b => b.type === 'text')

type BuildOptions = Parameters<typeof buildProcessTimeline>[1]

type ExpectedShell = {
  userMessageId: string
  isActive: boolean
  durationMs: number | undefined
  /** [entryId, processContentScope] */
  childScopes: Array<[string, string]>
  finalEntryId: string | null
}

type CorpusCase = {
  name: string
  items: PiTimelineItem[]
  options: BuildOptions
  expectedKeys: string[]
  expectedShells: ExpectedShell[]
}

function streaming(item: PiAssistantMessageItem): PiAssistantMessageItem {
  return { ...item, isStreaming: true }
}

function withToolResult(item: PiAssistantMessageItem, call: ReturnType<typeof createToolCall>, at: number) {
  return { ...item, toolResults: { [call.id]: toolResultFor(call, at) } }
}

function compactionItem(id: string, timestamp: number): PiTimelineItem {
  return {
    kind: 'compaction',
    entryId: id,
    timestamp,
    summary: `${id}-summary`,
    rawEntry: rawEntry(id, timestamp),
  } as unknown as PiTimelineItem
}

function readySet(ids: string[]): (id: string) => boolean {
  const set = new Set(ids)
  return id => set.has(id)
}

/** 确定性语料：覆盖 idle / busy / later-live / 多头助手 / 空 user / renderKey / 系统条目等。 */
function corpus(): CorpusCase[] {
  const base = { turnDurationMap: new Map<string, number>(), messageHasProcess: hasProcess, messageHasFinal: hasFinal }

  const pureFinalSettled: CorpusCase = {
    name: 'idle / 纯 final 正文收壳后平铺为一行',
    items: [createUserItem('user-1', 1000), createAssistantItem('assistant-1', [createTextBlock('hello')], 1001, 1100)],
    options: { ...base, sessionIsStreaming: false },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [],
  }

  const processThenFinal: CorpusCase = {
    name: 'idle / 过程行 + 末尾 final 出壳',
    items: [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001, 1200),
      createAssistantItem('assistant-2', [createToolCall('tool-2'), createTextBlock('done')], 1201, 1500),
    ],
    options: {
      ...base,
      turnDurationMap: new Map([['assistant-2', 500]]),
      sessionIsStreaming: false,
    },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: false,
        durationMs: 500,
        childScopes: [
          ['assistant-1', 'inline'],
          ['assistant-2', 'process'],
        ],
        finalEntryId: 'assistant-2',
      },
    ],
  }

  const busyMultiAssistant: CorpusCase = {
    name: 'busy / 同一回合多条助手：全部进壳，末条 process',
    items: [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('step')], 1001, 1200),
      streaming(createAssistantItem('assistant-2', [createToolCall('tool-2')], 1201)),
    ],
    options: { ...base, sessionIsStreaming: true },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: true,
        durationMs: undefined,
        childScopes: [
          ['assistant-1', 'inline'],
          ['assistant-2', 'process'],
        ],
        finalEntryId: null,
      },
    ],
  }

  const emptyUserNotReady: CorpusCase = {
    name: 'busy / 空 user 入场未完成：不挂空壳',
    items: [createUserItem('user-1', 1000)],
    options: { ...base, sessionIsStreaming: true, isUserEntryReady: readySet([]) },
    expectedKeys: ['user-1'],
    expectedShells: [],
  }

  const emptyUserReady: CorpusCase = {
    name: 'busy / 空 user 入场完成：挂空 Working 壳',
    items: [createUserItem('user-1', 1000)],
    options: { ...base, sessionIsStreaming: true, isUserEntryReady: readySet(['user-1']) },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: true,
        durationMs: undefined,
        childScopes: [],
        finalEntryId: null,
      },
    ],
  }

  const laterLive: CorpusCase = {
    name: 'later-live / 后轮 SSE live 一到，前轮立刻 Worked',
    items: [
      createUserItem('user-1', 1000),
      streaming(createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001)),
      createUserItem('user-2', 2000),
      streaming(createAssistantItem('assistant-2', [createToolCall('tool-2')], 2001)),
    ],
    options: { ...base, sessionIsStreaming: true },
    expectedKeys: ['user-1', 'process-shell:user-1', 'user-2', 'process-shell:user-2'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: false,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
      {
        userMessageId: 'user-2',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-2', 'process']],
        finalEntryId: null,
      },
    ],
  }

  const pageHeadAndRenderKey: CorpusCase = {
    name: '页首 assistant 平铺 + user renderKey 保持行身份',
    items: [
      createAssistantItem('assistant-leading', [createTextBlock('continued')], 500, 600),
      { ...createUserItem('user-1', 1000), renderKey: 'live-user' },
      streaming(createAssistantItem('assistant-1', [createTextBlock('hello')], 1001)),
    ],
    options: { ...base, sessionIsStreaming: true },
    expectedKeys: ['assistant-leading', 'live-user', 'process-shell:live-user'],
    expectedShells: [
      {
        userMessageId: 'live-user',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
    ],
  }

  const systemEntry: CorpusCase = {
    name: '系统条目就地保留，后续助手仍留在原回合壳内',
    items: [
      createUserItem('user-1', 1000),
      compactionItem('compaction-1', 1001),
      createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('answer')], 1002, 1200),
    ],
    options: { ...base, sessionIsStreaming: false },
    expectedKeys: ['user-1', 'process-shell:user-1', 'compaction-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: false,
        durationMs: 200,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: 'assistant-1',
      },
    ],
  }

  const toolResultDuration: CorpusCase = (() => {
    const call = createToolCall('tool-1')
    const assistant = withToolResult(createAssistantItem('assistant-1', [call], 1001, 1200), call, 1800)
    return {
      name: '工具结果时间晚于消息完成时间：耗时按工具结果算',
      items: [createUserItem('user-1', 1000), assistant],
      options: { ...base, sessionIsStreaming: false },
      expectedKeys: ['user-1', 'process-shell:user-1'],
      expectedShells: [
        {
          userMessageId: 'user-1',
          isActive: false,
          durationMs: 800,
          childScopes: [['assistant-1', 'process']],
          finalEntryId: null,
        },
      ],
    }
  })()

  const durationMapFallback: CorpusCase = {
    name: 'turnDurationMap 只命中前一条助手时仍可取到耗时',
    items: [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001, 1200),
      createAssistantItem('assistant-2', [createToolCall('tool-2'), createTextBlock('done')], 1201, 1500),
    ],
    options: {
      ...base,
      turnDurationMap: new Map([['assistant-1', 300]]),
      sessionIsStreaming: false,
    },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: false,
        durationMs: 300,
        childScopes: [
          ['assistant-1', 'inline'],
          ['assistant-2', 'process'],
        ],
        finalEntryId: 'assistant-2',
      },
    ],
  }

  const busyMultiStepGap: CorpusCase = {
    name: 'busy / 多步 agent 间隙：末回合保持 Working 不收壳',
    items: [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('看一眼')], 1001, 1500),
    ],
    options: { ...base, turnDurationMap: new Map([['assistant-1', 500]]), sessionIsStreaming: true },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
    ],
  }

  const abortedEmptyTurn: CorpusCase = {
    name: 'idle / 中止后空回合不留空壳',
    items: [createUserItem('user-1', 1000)],
    options: { ...base, sessionIsStreaming: false },
    expectedKeys: ['user-1'],
    expectedShells: [],
  }

  const queuedEmptyUser: CorpusCase = {
    name: 'busy / 连发两轮：只给最早回合挂 Working',
    items: [
      createUserItem('user-1', 1000),
      streaming(createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001)),
      createUserItem('user-2', 2000),
    ],
    options: {
      ...base,
      sessionIsStreaming: true,
      isUserEntryReady: readySet(['user-1', 'user-2']),
    },
    expectedKeys: ['user-1', 'process-shell:user-1', 'user-2'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
    ],
  }

  const streamingPureFinal: CorpusCase = {
    name: 'busy / 纯 final 流式中：行 key 与收壳后一致',
    items: [
      createUserItem('user-1', 1000),
      streaming(createAssistantItem('assistant-1', [createTextBlock('hel')], 1001)),
    ],
    options: { ...base, sessionIsStreaming: true },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
    ],
  }

  const durationMapNonPositive: CorpusCase = {
    name: 'turnDurationMap 里 0 值被忽略，回落到时间戳耗时',
    items: [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1'), createTextBlock('done')], 1001, 1200),
    ],
    options: {
      ...base,
      turnDurationMap: new Map([
        ['assistant-1', 0],
        ['assistant-0', -5],
      ]),
      sessionIsStreaming: false,
    },
    expectedKeys: ['user-1', 'process-shell:user-1'],
    expectedShells: [
      {
        userMessageId: 'user-1',
        isActive: false,
        durationMs: 200,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: 'assistant-1',
      },
    ],
  }

  const emptyTurnBeforeBusyTurn: CorpusCase = {
    name: 'busy / 空回合后面已出现助手：空回合收壳，不再挂 Working',
    items: [
      createUserItem('user-1', 1000),
      createUserItem('user-2', 2000),
      streaming(createAssistantItem('assistant-1', [createToolCall('tool-1')], 2001)),
    ],
    options: { ...base, sessionIsStreaming: true, isUserEntryReady: readySet(['user-1', 'user-2']) },
    expectedKeys: ['user-1', 'user-2', 'process-shell:user-2'],
    expectedShells: [
      {
        userMessageId: 'user-2',
        isActive: true,
        durationMs: undefined,
        childScopes: [['assistant-1', 'process']],
        finalEntryId: null,
      },
    ],
  }

  return [
    pureFinalSettled,
    processThenFinal,
    busyMultiAssistant,
    emptyUserNotReady,
    emptyUserReady,
    emptyTurnBeforeBusyTurn,
    laterLive,
    pageHeadAndRenderKey,
    systemEntry,
    toolResultDuration,
    durationMapFallback,
    durationMapNonPositive,
    busyMultiStepGap,
    abortedEmptyTurn,
    queuedEmptyUser,
    streamingPureFinal,
  ]
}

function shellOf(row: ReferenceProcessTimelineItem | ProcessTimelineItem) {
  return row.kind === 'process-shell' ? row : null
}

function shellSummary(row: ReferenceProcessTimelineItem | ProcessTimelineItem): ExpectedShell | null {
  const shell = shellOf(row)
  if (!shell) return null
  return {
    userMessageId: shell.userMessageId ?? '',
    isActive: shell.isActive,
    durationMs: shell.durationMs,
    childScopes: shell.children.map(child => [child.item.entryId, child.processContentScope]),
    finalEntryId: shell.finalItem?.entryId ?? null,
  }
}

/** 输出里的 item / children / finalItem 必须是输入对象本身，而不是拷贝。 */
function expectOutputSharesInputItems(
  rows: Array<ReferenceProcessTimelineItem | ProcessTimelineItem>,
  inputs: PiTimelineItem[],
) {
  const inputSet = new Set<PiTimelineItem>(inputs)
  for (const row of rows) {
    if (row.kind === 'message') {
      expect(inputSet.has(row.item)).toBe(true)
      continue
    }
    for (const child of row.children) expect(inputSet.has(child.item)).toBe(true)
    if (row.finalItem) expect(inputSet.has(row.finalItem)).toBe(true)
  }
}

describe(`buildProcessTimeline 兼容冻结基线 ${REFERENCE_SOURCE_COMMIT.slice(0, 8)}`, () => {
  it('参考实现自身自检：纯 final 回合按手算结果输出', () => {
    const items = [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createTextBlock('hello')], 1001, 1100),
    ]
    const rows = referenceBuildProcessTimeline(items, {
      turnDurationMap: new Map(),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    expect(rows.map(row => row.key)).toEqual(['user-1', 'process-shell:user-1'])
    expect(rows[1]).toStrictEqual({ kind: 'message', key: 'process-shell:user-1', item: items[1] })
  })

  it('参考实现自身自检：过程 + final 回合按手算壳属性输出', () => {
    const items = [
      createUserItem('user-1', 1000),
      createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001, 1200),
      createAssistantItem('assistant-2', [createToolCall('tool-2'), createTextBlock('done')], 1201, 1500),
    ]
    const rows = referenceBuildProcessTimeline(items, {
      turnDurationMap: new Map([['assistant-2', 500]]),
      sessionIsStreaming: false,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
    })
    expect(rows).toHaveLength(2)
    expect(shellSummary(rows[1])).toStrictEqual({
      userMessageId: 'user-1',
      isActive: false,
      durationMs: 500,
      childScopes: [
        ['assistant-1', 'inline'],
        ['assistant-2', 'process'],
      ],
      finalEntryId: 'assistant-2',
    })
    expect(rows[1].kind === 'process-shell' && rows[1].startedAt).toBe(1000)
  })

  for (const testCase of corpus()) {
    it(`旧 / 新输出等价：${testCase.name}`, () => {
      const before = structuredClone(testCase.items)
      const production = buildProcessTimeline(testCase.items, testCase.options)
      const reference = referenceBuildProcessTimeline(testCase.items, testCase.options)

      // 1. 行为深等价（参考来自 940844c5 冻结拷贝）
      expect(production).toStrictEqual(reference)

      // 2. 独立手写期望：key 序列与壳属性
      expect(production.map(row => row.key)).toEqual(testCase.expectedKeys)
      expect(reference.map(row => row.key)).toEqual(testCase.expectedKeys)
      expect(production.map(shellSummary).filter(Boolean)).toStrictEqual(testCase.expectedShells)

      // 3. 输入未被改写，输出复用输入 item 引用
      expect(testCase.items).toStrictEqual(before)
      expectOutputSharesInputItems(production, testCase.items)
      expectOutputSharesInputItems(reference, testCase.items)
    })
  }

  it('重复调用同一输入得到相同输出，且不污染输入', () => {
    for (const testCase of corpus()) {
      const before = structuredClone(testCase.items)
      const first = buildProcessTimeline(testCase.items, testCase.options)
      const second = buildProcessTimeline(testCase.items, testCase.options)
      expect(second).toStrictEqual(first)
      expect(testCase.items).toStrictEqual(before)
    }
  })
})

type ReuseSignature = {
  returnedPreviousArray: boolean
  returnedNextArray: boolean
  reusedPreviousIndex: boolean[]
}

function signatureOf(
  result: Array<ReferenceProcessTimelineItem | ProcessTimelineItem>,
  previous: Array<ReferenceProcessTimelineItem | ProcessTimelineItem>,
  next: Array<ReferenceProcessTimelineItem | ProcessTimelineItem>,
): ReuseSignature {
  return {
    returnedPreviousArray: result === previous,
    returnedNextArray: result === next,
    reusedPreviousIndex: previous.map((row, index) => result[index] === row),
  }
}

describe(`reuseProcessTimelineItems 兼容冻结基线 ${REFERENCE_SOURCE_COMMIT.slice(0, 8)}`, () => {
  const settledItems = () => [
    createUserItem('user-1', 1000),
    createAssistantItem('assistant-1', [createToolCall('tool-1')], 1001, 1200),
    createAssistantItem('assistant-2', [createToolCall('tool-2'), createTextBlock('done')], 1201, 1500),
    createUserItem('user-2', 2000),
    createAssistantItem('assistant-3', [createTextBlock('second')], 2001, 2100),
  ]
  const options: BuildOptions = {
    turnDurationMap: new Map(),
    sessionIsStreaming: false,
    messageHasProcess: hasProcess,
    messageHasFinal: hasFinal,
  }

  function viaProduction(items: PiTimelineItem[]) {
    const previous = buildProcessTimeline(items, options)
    const next = buildProcessTimeline(items, options)
    return { previous, next, result: reuseProcessTimelineItems(previous, next) }
  }

  function viaReference(items: PiTimelineItem[]) {
    const previous = referenceBuildProcessTimeline(items, options)
    const next = referenceBuildProcessTimeline(items, options)
    return { previous, next, result: referenceReuseProcessTimelineItems(previous, next) }
  }

  it('无变化时两个实现都返回 previous 数组引用', () => {
    // 同一批输入 item 引用 → 行对象深等价后按 key 复用
    const items = settledItems()
    const production = viaProduction(items)
    const reference = viaReference(items)
    expect(signatureOf(production.result, production.previous, production.next)).toStrictEqual(
      signatureOf(reference.result, reference.previous, reference.next),
    )
    expect(production.result).toBe(production.previous)
    expect(reference.result).toBe(reference.previous)
  })

  it('流式只脏最后一行时，两个实现的复用位置一致', () => {
    const liveOptions: BuildOptions = { ...options, sessionIsStreaming: true }
    const items = settledItems()
    const liveItems = items.map((item, index) => (index === 4 ? streaming(item as PiAssistantMessageItem) : item))

    const previous = buildProcessTimeline(items, options)
    const next = buildProcessTimeline(liveItems, liveOptions)
    const productionResult = reuseProcessTimelineItems(previous, next)

    const referencePrevious = referenceBuildProcessTimeline(items, options)
    const referenceNext = referenceBuildProcessTimeline(liveItems, liveOptions)
    const referenceResult = referenceReuseProcessTimelineItems(referencePrevious, referenceNext)

    expect(signatureOf(productionResult, previous, next)).toStrictEqual(
      signatureOf(referenceResult, referencePrevious, referenceNext),
    )
    // 最后一行必须换新对象，前面行保持 previous 引用
    expect(productionResult.at(-1)).not.toBe(previous.at(-1))
    for (let i = 0; i < previous.length - 1; i++) expect(productionResult[i]).toBe(previous[i])
  })

  it('previous 为空时直接返回 next（两个实现一致）', () => {
    const items = settledItems()
    const next = buildProcessTimeline(items, options)
    const referenceNext = referenceBuildProcessTimeline(items, options)
    expect(reuseProcessTimelineItems(undefined, next)).toBe(next)
    expect(referenceReuseProcessTimelineItems(undefined, referenceNext)).toBe(referenceNext)
    expect(reuseProcessTimelineItems([], next)).toBe(next)
  })
})

/**
 * 定种随机差分：语料表只覆盖手挑组合，这里按固定种子生成一批随机时间线，
 * 逐条比旧 / 新输出。种子固定 → 可复现，失败用例的 shape 打印在断言消息里。
 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type RandomTimeline = {
  items: PiTimelineItem[]
  options: BuildOptions
  label: string
}

function randomTimeline(seed: number): RandomTimeline {
  const rnd = mulberry32(seed)
  const pick = <T>(values: T[]): T => values[Math.floor(rnd() * values.length)]
  const items: PiTimelineItem[] = []
  const count = Math.floor(rnd() * 9)
  let clock = 1000
  let userIndex = 0
  let assistantIndex = 0

  for (let i = 0; i < count; i++) {
    const kind = pick(['user', 'user', 'assistant', 'assistant', 'assistant', 'system'] as const)
    clock += 10 + Math.floor(rnd() * 50)
    if (kind === 'user') {
      const id = `user-${++userIndex}`
      items.push(rnd() < 0.25 ? { ...createUserItem(id, clock), renderKey: `live-${id}` } : createUserItem(id, clock))
      continue
    }
    if (kind === 'system') {
      items.push(
        rnd() < 0.5
          ? compactionItem(`compaction-${i}`, clock)
          : {
              kind: 'custom_message',
              entryId: `custom-${i}`,
              timestamp: clock,
              rawEntry: rawEntry(`custom-${i}`, clock),
              customType: 'piui-test',
              content: `custom-${i}`,
              display: true,
            },
      )
      continue
    }
    const id = `assistant-${++assistantIndex}`
    const blockRoll = rnd()
    const blocks =
      blockRoll < 0.3
        ? [createTextBlock(`text-${id}`)]
        : blockRoll < 0.6
          ? [createToolCall(id)]
          : [createToolCall(id), createTextBlock(`text-${id}`)]
    const completed = rnd() < 0.45 ? clock + Math.floor(rnd() * 200) : undefined
    const built = createAssistantItem(id, blocks, clock, completed)
    items.push(rnd() < 0.3 ? { ...built, isStreaming: true } : built)
  }

  const turnDurationMap = new Map<string, number>()
  for (let i = 1; i <= assistantIndex; i++) {
    if (rnd() < 0.5) turnDurationMap.set(`assistant-${i}`, 50 + Math.floor(rnd() * 1000))
  }
  const readyIds = new Set<string>()
  for (let i = 1; i <= userIndex; i++) if (rnd() < 0.5) readyIds.add(`user-${i}`)

  return {
    items,
    label: `seed=${seed} kinds=[${items.map(item => item.kind).join(',')}]`,
    options: {
      turnDurationMap,
      sessionIsStreaming: rnd() < 0.5,
      messageHasProcess: hasProcess,
      messageHasFinal: hasFinal,
      isUserEntryReady: id => readyIds.has(id),
    },
  }
}

describe('buildProcessTimeline 定种随机差分', () => {
  it('200 条随机时间线：旧 / 新输出逐条深等价且不破坏输入', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const scenario = randomTimeline(seed)
      const before = structuredClone(scenario.items)
      const production = buildProcessTimeline(scenario.items, scenario.options)
      const reference = referenceBuildProcessTimeline(scenario.items, scenario.options)
      expect(production, scenario.label).toStrictEqual(reference)
      expect(scenario.items, scenario.label).toStrictEqual(before)
      expectOutputSharesInputItems(production, scenario.items)
    }
  })

  it('流式把最后一条助手弄脏时，复用位置与旧实现一致', () => {
    for (let seed = 201; seed <= 260; seed++) {
      const scenario = randomTimeline(seed)
      const lastAssistant = [...scenario.items].reverse().find(item => item.kind === 'assistant_message')
      if (!lastAssistant) continue
      const dirtyItems = scenario.items.map(item =>
        item === lastAssistant ? streaming(item as PiAssistantMessageItem) : item,
      )

      const previous = buildProcessTimeline(scenario.items, scenario.options)
      const next = buildProcessTimeline(dirtyItems, scenario.options)
      const productionResult = reuseProcessTimelineItems(previous, next)

      const referencePrevious = referenceBuildProcessTimeline(scenario.items, scenario.options)
      const referenceNext = referenceBuildProcessTimeline(dirtyItems, scenario.options)
      const referenceResult = referenceReuseProcessTimelineItems(referencePrevious, referenceNext)

      expect(signatureOf(productionResult, previous, next), scenario.label).toStrictEqual(
        signatureOf(referenceResult, referencePrevious, referenceNext),
      )
      expect(productionResult, scenario.label).toStrictEqual(referenceResult)
    }
  })
})
