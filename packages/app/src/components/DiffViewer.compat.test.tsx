/**
 * Diff 计算差分兼容测试（H 独立验证，不改生产代码）。
 *
 * 期望来源：`src/test/diffModelReference.ts` —— `d13bc984`
 * `packages/app/src/components/DiffViewer.tsx` 中 Diff Computation 段落的逻辑冻结。
 * 生产差分只把冻结参考当期望，不反过来用生产输出定义期望。
 *
 * 阶段 1（冻结基准本身可复现）：
 *   1. 六个函数体的 AST 指纹与 `d13bc984` 一致（防冻结走样）；
 *   2. 固定语料 CRLF / 尾换行 / 中文 / 空与单边 / 替换 / 碎片阈值 / resize 的输出；
 *   3. 与实现无关的行结构不变量（行号连续、content 可重建原文、word diff 分段拼接等于整行）；
 *   4. 调用次数基线：单视图各 1 次 `diffLines`，baseline split+unified 合计 2 次。
 *
 * 阶段 2（G 的纯模型 cherry-pick 进本 worktree 作为被测依赖后）：
 *   5. 同一语料 + 补充边界输入上，生产 `diffModel` 的 paired / unified / word diff / 碎片阈值 / 折叠
 *      输出与冻结参考逐字段相等；
 *   6. 调用次数：`computeLineDiff` 一次 `diffLines`，split/unified 从同一模型派生、resize 只重算词级；
 *      旧签名入口各自一次；折叠不碰 diff。
 */
import { createHash } from 'node:crypto'
import * as ts from 'typescript'
import type { ChangeObject } from 'diff'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPairedLines,
  buildUnifiedLines,
  collapseContextPaired,
  collapseContextUnified,
  computeLineDiff,
  computePairedLines,
  computeUnifiedLines,
  computeWordDiff,
  isTooFragmented,
} from './diffModel'
import referenceSource from '../test/diffModelReference.ts?raw'
import {
  REFERENCE_SOURCE_COMMIT,
  referenceCollapseContextPaired,
  referenceCollapseContextUnified,
  referenceComputePairedLines,
  referenceComputeUnifiedLines,
  referenceComputeWordDiff,
  referenceIsTooFragmented,
  type ReferenceDiffLine,
  type ReferenceExpansionRegion,
  type ReferenceLineType,
  type ReferencePairedLine,
  type ReferencePairedLineOrCollapsed,
  type ReferenceUnifiedLine,
  type ReferenceUnifiedLineOrCollapsed,
} from '../test/diffModelReference'

// ============================================
// diff 调用计数（包边界打点，参考实现本身不插桩）
// ============================================

const diffCalls = vi.hoisted(() => ({ diffLines: 0, diffWordsWithSpace: 0 }))

vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return {
    ...actual,
    diffLines: (...args: Parameters<typeof actual.diffLines>) => {
      diffCalls.diffLines += 1
      return actual.diffLines(...args)
    },
    diffWordsWithSpace: (...args: Parameters<typeof actual.diffWordsWithSpace>) => {
      diffCalls.diffWordsWithSpace += 1
      return actual.diffWordsWithSpace(...args)
    },
  }
})

beforeEach(() => {
  diffCalls.diffLines = 0
  diffCalls.diffWordsWithSpace = 0
})

// ============================================
// 1. AST 指纹：冻结不走样
// ============================================

/**
 * `d13bc984` 上六个计算函数体的 AST 指纹。
 *
 * 生成方式：`git show d13bc984:packages/app/src/components/DiffViewer.tsx` 与
 * `packages/app/src/test/diffModelReference.ts` 各自 `ts.createSourceFile`，
 * 用 `ts.createPrinter({ removeComments: true })` 打印单个 `FunctionDeclaration`，
 * 再做名称归一（去掉 `export`、`Reference*` → `*`、`reference` + 大写 → 小写驼峰），
 * 压缩空白后取 sha256。基线侧 6/6 与参考侧相等后才记录本表。
 */
const FROZEN_AST_HASHES: Record<string, string> = {
  computePairedLines: '27a1470a74a6bfc15d29a87729297d22fbb7cd755a9e31d82c81b0e67251944d',
  computeUnifiedLines: '7947f3098a90555554e216d9c1df9bb98a8ea48fa2909187f08183554b2868d9',
  isTooFragmented: 'ffdecd71b877feaddcb200434040d866376bdb43e9ac9b3c16018ae86b290402',
  computeWordDiff: 'bb07625cde61c345968ff573aa0466bdd24711a946e125a99b2fc1b962a595cd',
  collapseContextPaired: 'f881fe2d5c362b5b94d19e99c591260088fbe03d1f9994b48af51da2f79ce336',
  collapseContextUnified: 'c27c6fe2a3d093a7bf1a4d006b55acca3054e885453dc1c7d1604faeb1c358d6',
}

/** [d13bc984 里的函数名, 冻结参考里的函数名] */
const FROZEN_FUNCTION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['computePairedLines', 'referenceComputePairedLines'],
  ['computeUnifiedLines', 'referenceComputeUnifiedLines'],
  ['isTooFragmented', 'referenceIsTooFragmented'],
  ['computeWordDiff', 'referenceComputeWordDiff'],
  ['collapseContextPaired', 'referenceCollapseContextPaired'],
  ['collapseContextUnified', 'referenceCollapseContextUnified'],
]

const printer = ts.createPrinter({ removeComments: true })

function printedFunction(sourceFile: ts.SourceFile, name: string): string {
  let target: ts.FunctionDeclaration | null = null
  sourceFile.forEachChild(node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) target = node
  })
  if (!target) throw new Error(`函数 ${name} 未在冻结参考中找到`)
  return printer.printNode(ts.EmitHint.Unspecified, target, sourceFile)
}

/** 名称归一到 `d13bc984` 的命名空间：去 `export`、去冻结点前缀、函数名回到小驼峰。 */
function normalizeFrozenFunctionText(text: string): string {
  return text
    .replace(/^export\s+/, '')
    .replace(/\bReference([A-Z]\w*)/g, '$1')
    .replace(/\breference([A-Z]\w*)/g, (_match, rest: string) => rest[0].toLowerCase() + rest.slice(1))
    .replace(/\s+/g, ' ')
    .trim()
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('frozen diff reference provenance', () => {
  it('records the baseline commit', () => {
    expect(REFERENCE_SOURCE_COMMIT).toBe('d13bc984')
  })

  it('keeps all six computation bodies AST-identical to d13bc984', () => {
    const sourceFile = ts.createSourceFile(
      'diffModelReference.ts',
      referenceSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )

    for (const [baselineName, referenceName] of FROZEN_FUNCTION_PAIRS) {
      const normalized = normalizeFrozenFunctionText(printedFunction(sourceFile, referenceName))
      expect(sha256(normalized), `${baselineName} 函数体与 d13bc984 不一致`).toBe(FROZEN_AST_HASHES[baselineName])
    }
  })
})

// ============================================
// 2. 语料
// ============================================

/** [type, content, lineNo]（empty 侧的 lineNo 为 null） */
type ExpectedCell = readonly [ReferenceLineType, string, number | null]
/** [oldLineNo, newLineNo] */
type ExpectedUnifiedRow = readonly [ReferenceLineType, string, number | null, number | null]

interface CorpusCase {
  name: string
  before: string
  after: string
  expectedPaired: ReadonlyArray<readonly [ExpectedCell, ExpectedCell]>
  expectedUnified: ReadonlyArray<ExpectedUnifiedRow>
  /** 输入无尾换行时，行的 content 必须能逐字重建原文 */
  reconstructable: boolean
  /** 期望出现 word diff 分段的 paired 行号（0 基，按 paired 行） */
  wordDiffRows: readonly number[]
}

const CORPUS: readonly CorpusCase[] = [
  {
    // CRLF 原样留在行内容里（jsdiff 只按 \n 切行，\r 不是分隔符）
    name: 'crlf',
    before: 'a\r\nb\r\n',
    after: 'a\r\nc\r\n',
    expectedPaired: [
      [
        ['context', 'a\r', 1],
        ['context', 'a\r', 1],
      ],
      [
        ['delete', 'b\r', 2],
        ['add', 'c\r', 2],
      ],
    ],
    expectedUnified: [
      ['context', 'a\r', 1, 1],
      ['delete', 'b\r', 2, null],
      ['add', 'c\r', null, 2],
    ],
    reconstructable: false,
    wordDiffRows: [1],
  },
  {
    // 只差尾换行：旧算法把它算成一对 delete/add，内容相同因此没有增删分段
    name: 'trailing newline',
    before: 'a\nb\n',
    after: 'a\nb',
    expectedPaired: [
      [
        ['context', 'a', 1],
        ['context', 'a', 1],
      ],
      [
        ['delete', 'b', 2],
        ['add', 'b', 2],
      ],
    ],
    expectedUnified: [
      ['context', 'a', 1, 1],
      ['delete', 'b', 2, null],
      ['add', 'b', null, 2],
    ],
    reconstructable: false,
    wordDiffRows: [1],
  },
  {
    name: 'both empty',
    before: '',
    after: '',
    expectedPaired: [],
    expectedUnified: [],
    reconstructable: true,
    wordDiffRows: [],
  },
  {
    // 单边新增：split 的另一侧全是 empty，组件层会降级 unified（模型层只看行）
    name: 'add only',
    before: '',
    after: 'x\ny',
    expectedPaired: [
      [
        ['empty', '', null],
        ['add', 'x', 1],
      ],
      [
        ['empty', '', null],
        ['add', 'y', 2],
      ],
    ],
    expectedUnified: [
      ['add', 'x', null, 1],
      ['add', 'y', null, 2],
    ],
    reconstructable: true,
    wordDiffRows: [],
  },
  {
    name: 'delete only',
    before: 'x\ny',
    after: '',
    expectedPaired: [
      [
        ['delete', 'x', 1],
        ['empty', '', null],
      ],
      [
        ['delete', 'y', 2],
        ['empty', '', null],
      ],
    ],
    expectedUnified: [
      ['delete', 'x', 1, null],
      ['delete', 'y', 2, null],
    ],
    reconstructable: true,
    wordDiffRows: [],
  },
  {
    name: 'replacement',
    before: 'one\ntwo\nthree',
    after: 'one\nTWO\nthree',
    expectedPaired: [
      [
        ['context', 'one', 1],
        ['context', 'one', 1],
      ],
      [
        ['delete', 'two', 2],
        ['add', 'TWO', 2],
      ],
      [
        ['context', 'three', 3],
        ['context', 'three', 3],
      ],
    ],
    expectedUnified: [
      ['context', 'one', 1, 1],
      ['delete', 'two', 2, null],
      ['add', 'TWO', null, 2],
      ['context', 'three', 3, 3],
    ],
    reconstructable: true,
    wordDiffRows: [1],
  },
  {
    // 删多于增：按索引配对，多出来的删除行右侧留空
    name: 'uneven replacement',
    before: 'a\nb\nc\nd',
    after: 'a\nX',
    expectedPaired: [
      [
        ['context', 'a', 1],
        ['context', 'a', 1],
      ],
      [
        ['delete', 'b', 2],
        ['add', 'X', 2],
      ],
      [
        ['delete', 'c', 3],
        ['empty', '', null],
      ],
      [
        ['delete', 'd', 4],
        ['empty', '', null],
      ],
    ],
    expectedUnified: [
      ['context', 'a', 1, 1],
      ['delete', 'b', 2, null],
      ['delete', 'c', 3, null],
      ['delete', 'd', 4, null],
      ['add', 'X', null, 2],
    ],
    reconstructable: true,
    wordDiffRows: [1],
  },
  {
    name: 'chinese',
    before: '你好世界\n第二行',
    after: '你好世界\n第二行改',
    expectedPaired: [
      [
        ['context', '你好世界', 1],
        ['context', '你好世界', 1],
      ],
      [
        ['delete', '第二行', 2],
        ['add', '第二行改', 2],
      ],
    ],
    expectedUnified: [
      ['context', '你好世界', 1, 1],
      ['delete', '第二行', 2, null],
      ['add', '第二行改', null, 2],
    ],
    reconstructable: true,
    wordDiffRows: [1],
  },
  {
    // 整行替换、公共字符占比过低 → 超碎片阈值，不产出 word diff 分段
    name: 'fragmented replacement',
    before: 'abcdefghijklmnop',
    after: 'qrstuvwxyz012345',
    expectedPaired: [
      [
        ['delete', 'abcdefghijklmnop', 1],
        ['add', 'qrstuvwxyz012345', 1],
      ],
    ],
    expectedUnified: [
      ['delete', 'abcdefghijklmnop', 1, null],
      ['add', 'qrstuvwxyz012345', null, 1],
    ],
    reconstructable: true,
    wordDiffRows: [],
  },
]

function projectPairedCell(cell: ReferenceDiffLine): ExpectedCell {
  return [cell.type, cell.content, cell.lineNo ?? null]
}

function projectPairedRow(row: ReferencePairedLine): readonly [ExpectedCell, ExpectedCell] {
  return [projectPairedCell(row.left), projectPairedCell(row.right)]
}

function projectUnifiedRow(row: ReferenceUnifiedLine): ExpectedUnifiedRow {
  return [row.type, row.content, row.oldLineNo ?? null, row.newLineNo ?? null]
}

/**
 * 与实现无关的行结构不变量：
 * - empty 侧没有行号、内容为空；
 * - 每侧行号从 1 连续递增；
 * - 无尾换行输入可逐字重建原文；
 * - word diff 分段拼接等于整行内容，且删/增分段成对出现，无空分段。
 */
function expectPairedInvariants(before: string, after: string, rows: readonly ReferencePairedLine[]) {
  let nextOld = 1
  let nextNew = 1

  for (const row of rows) {
    for (const cell of [row.left, row.right]) {
      if (cell.type === 'empty') {
        expect(cell.content).toBe('')
        expect(cell.lineNo).toBeUndefined()
        expect(cell.wordDiffSegments).toBeUndefined()
      } else if (cell.wordDiffSegments) {
        expect(cell.wordDiffSegments.map(segment => segment.text).join('')).toBe(cell.content)
        for (const segment of cell.wordDiffSegments) expect(segment.text.length).toBeGreaterThan(0)
      }
    }

    if (row.left.type !== 'empty') expect(row.left.lineNo).toBe(nextOld++)
    if (row.right.type !== 'empty') expect(row.right.lineNo).toBe(nextNew++)

    const leftDiffTypes = row.left.wordDiffSegments?.flatMap(segment => (segment.diffType ? [segment.diffType] : []))
    const rightDiffTypes = row.right.wordDiffSegments?.flatMap(segment => (segment.diffType ? [segment.diffType] : []))
    // 左侧不会出现 add 分段，右侧不会出现 delete 分段；
    // 哪些行该有分段由语料的 `wordDiffRows` 断言（碎片阈值/单边/resize 各自不同）。
    expect(leftDiffTypes ?? []).not.toContain('add')
    expect(rightDiffTypes ?? []).not.toContain('delete')
  }

  if (!before.endsWith('\n')) {
    expect(
      rows
        .map(row => row.left)
        .filter(cell => cell.type !== 'empty')
        .map(cell => cell.content)
        .join('\n'),
    ).toBe(before)
  }
  if (!after.endsWith('\n')) {
    expect(
      rows
        .map(row => row.right)
        .filter(cell => cell.type !== 'empty')
        .map(cell => cell.content)
        .join('\n'),
    ).toBe(after)
  }
}

function expectUnifiedInvariants(before: string, after: string, rows: readonly ReferenceUnifiedLine[]) {
  let nextOld = 1
  let nextNew = 1

  for (const row of rows) {
    if (row.type === 'delete') {
      expect(row.oldLineNo).toBe(nextOld++)
      expect(row.newLineNo).toBeUndefined()
    } else if (row.type === 'add') {
      expect(row.newLineNo).toBe(nextNew++)
      expect(row.oldLineNo).toBeUndefined()
    } else if (row.type === 'context') {
      expect(row.oldLineNo).toBe(nextOld++)
      expect(row.newLineNo).toBe(nextNew++)
    }

    if (row.wordDiffSegments) {
      expect(row.wordDiffSegments.map(segment => segment.text).join('')).toBe(row.content)
    }
  }

  if (!before.endsWith('\n')) {
    expect(
      rows
        .filter(row => row.type !== 'add')
        .map(row => row.content)
        .join('\n'),
    ).toBe(before)
  }
  if (!after.endsWith('\n')) {
    expect(
      rows
        .filter(row => row.type !== 'delete')
        .map(row => row.content)
        .join('\n'),
    ).toBe(after)
  }
}

describe('frozen diff reference corpus', () => {
  for (const testCase of CORPUS) {
    it(`pairs split rows for ${testCase.name}`, () => {
      const rows = referenceComputePairedLines(testCase.before, testCase.after, false)

      expect(rows.map(projectPairedRow)).toEqual(testCase.expectedPaired)
      expect(testCase.reconstructable).toBe(!testCase.before.endsWith('\n') && !testCase.after.endsWith('\n'))
      expectPairedInvariants(testCase.before, testCase.after, rows)

      const rowsWithWordDiff = rows.flatMap((row, index) => (row.left.wordDiffSegments ? [index] : []))
      expect(rowsWithWordDiff).toEqual([...testCase.wordDiffRows])
    })

    it(`emits unified rows for ${testCase.name}`, () => {
      const rows = referenceComputeUnifiedLines(testCase.before, testCase.after)

      expect(rows.map(projectUnifiedRow)).toEqual(testCase.expectedUnified)
      expectUnifiedInvariants(testCase.before, testCase.after, rows)
    })
  }

  it('keeps resize (skipWordDiff) output free of word diff and of word-diff calls', () => {
    const rows = referenceComputePairedLines('one\ntwo\nthree', 'one\nTWO\nthree', true)

    expect(rows.map(projectPairedRow)).toEqual([
      [
        ['context', 'one', 1],
        ['context', 'one', 1],
      ],
      [
        ['delete', 'two', 2],
        ['add', 'TWO', 2],
      ],
      [
        ['context', 'three', 3],
        ['context', 'three', 3],
      ],
    ])
    for (const row of rows) {
      expect(row.left.wordDiffSegments).toBeUndefined()
      expect(row.right.wordDiffSegments).toBeUndefined()
    }
    expect(diffCalls.diffLines).toBe(1)
    expect(diffCalls.diffWordsWithSpace).toBe(0)
  })

  it('keeps CJK word diff segments aligned with both sides', () => {
    const [row] = referenceComputePairedLines('你好世界\n第二行', '你好世界\n第二行改', false).slice(1)

    const leftSegments = row.left.wordDiffSegments ?? []
    const rightSegments = row.right.wordDiffSegments ?? []
    expect(leftSegments.map(segment => segment.text).join('')).toBe('第二行')
    expect(rightSegments.map(segment => segment.text).join('')).toBe('第二行改')
    // 中文单字追加：左侧没有 delete 分段，右侧有 add 分段
    expect(leftSegments.some(segment => segment.diffType === 'delete')).toBe(false)
    expect(rightSegments).toContainEqual({ text: '改', diffType: 'add' })
  })
})

// ============================================
// 3. 碎片阈值
// ============================================

function change(value: string, kind: 'common' | 'added' | 'removed'): ChangeObject<string> {
  return kind === 'common' ? { value } : kind === 'added' ? { value, added: true } : { value, removed: true }
}

describe('frozen fragmentation threshold', () => {
  it('only collapses word diff when total length exceeds 10', () => {
    expect(referenceIsTooFragmented([change('0123456789', 'removed')])).toBe(false)
  })

  it('applies the strict 0.4 common-ratio boundary', () => {
    // 4/11 ≈ 0.36 → 超碎片
    expect(referenceIsTooFragmented([change('abcd', 'common'), change('1234567', 'removed')])).toBe(true)
    // 6/15 === 0.4 → 不超碎片（判据是严格小于）
    expect(referenceIsTooFragmented([change('abcdef', 'common'), change('123456789', 'removed')])).toBe(false)
    // 5/11 ≈ 0.45 → 不超碎片
    expect(referenceIsTooFragmented([change('abcde', 'common'), change('123456', 'removed')])).toBe(false)
  })
})

// ============================================
// 4. 上下文折叠
// ============================================

function pairedContextRow(n: number): ReferencePairedLine {
  return {
    left: { type: 'context', content: `c${n}`, lineNo: n },
    right: { type: 'context', content: `c${n}`, lineNo: n },
  }
}

function pairedAddRow(n: number): ReferencePairedLine {
  return { left: { type: 'empty', content: '' }, right: { type: 'add', content: `a${n}`, lineNo: n } }
}

function unifiedContextRow(n: number): ReferenceUnifiedLine {
  return { type: 'context', content: `c${n}`, oldLineNo: n, newLineNo: n }
}

function unifiedAddRow(n: number): ReferenceUnifiedLine {
  return { type: 'add', content: `a${n}`, newLineNo: n }
}

function contextRun(length: number): ReferencePairedLine[] {
  return Array.from({ length }, (_unused, index) => pairedContextRow(index + 1))
}

type PairedDescriptor =
  { row: ReferenceLineType } | { collapsed: number; id: number; isFirst: boolean; isLast: boolean; chunked: boolean }

function describePairedItems(items: readonly ReferencePairedLineOrCollapsed[]): PairedDescriptor[] {
  return items.map(item =>
    'collapsed' in item
      ? { collapsed: item.count, id: item.id, isFirst: item.isFirst, isLast: item.isLast, chunked: item.chunked }
      : { row: item.left.type === 'empty' ? item.right.type : item.left.type },
  )
}

type UnifiedDescriptor =
  { row: ReferenceLineType } | { collapsed: number; id: number; isFirst: boolean; isLast: boolean; chunked: boolean }

function describeUnifiedItems(items: readonly ReferenceUnifiedLineOrCollapsed[]): UnifiedDescriptor[] {
  return items.map(item =>
    'collapsed' in item
      ? { collapsed: item.count, id: item.id, isFirst: item.isFirst, isLast: item.isLast, chunked: item.chunked }
      : { row: item.type },
  )
}

const ROW: { row: ReferenceLineType } = { row: 'context' }
const ADD_ROW: { row: ReferenceLineType } = { row: 'add' }

function collapsed(
  count: number,
  id: number,
  isFirst = false,
  isLast = false,
  chunked = false,
): { collapsed: number; id: number; isFirst: boolean; isLast: boolean; chunked: boolean } {
  return { collapsed: count, id, isFirst, isLast, chunked }
}

function expansion(region: ReferenceExpansionRegion): ReadonlyMap<number, ReferenceExpansionRegion> {
  return new Map([[1, region]])
}

describe('frozen paired context collapse', () => {
  it('returns no rows for empty input', () => {
    expect(referenceCollapseContextPaired([])).toEqual([])
  })

  it('keeps a run of exactly 8 context rows intact', () => {
    const items = referenceCollapseContextPaired([pairedAddRow(1), ...contextRun(8), pairedAddRow(2)])

    expect(describePairedItems(items)).toEqual([ADD_ROW, ...Array.from({ length: 8 }, () => ROW), ADD_ROW])
  })

  it('collapses 9 context rows down to the first and last 3', () => {
    const items = referenceCollapseContextPaired([pairedAddRow(1), ...contextRun(9), pairedAddRow(2)])

    expect(describePairedItems(items)).toEqual([ADD_ROW, ROW, ROW, ROW, collapsed(3, 1), ROW, ROW, ROW, ADD_ROW])
  })

  it('drops the leading keep-window when the run starts the file', () => {
    const items = referenceCollapseContextPaired([...contextRun(10), pairedAddRow(1)])

    expect(describePairedItems(items)).toEqual([collapsed(7, 0, true), ROW, ROW, ROW, ADD_ROW])
  })

  it('drops the trailing keep-window when the run ends the file', () => {
    const items = referenceCollapseContextPaired([pairedAddRow(1), ...contextRun(10)])

    expect(describePairedItems(items)).toEqual([ADD_ROW, ROW, ROW, ROW, collapsed(7, 1, false, true)])
  })

  it('grows the visible window from the expansion region', () => {
    // fromStart=5 把可见前缀从 3 拉到 8，隐藏段只剩 1 行（9 起为尾窗 3 行）
    const fromStart = referenceCollapseContextPaired(
      [pairedAddRow(1), ...contextRun(12), pairedAddRow(2)],
      expansion({ fromStart: 5, fromEnd: 0 }),
    )
    expect(describePairedItems(fromStart)).toEqual([
      ADD_ROW,
      ...Array.from({ length: 8 }, () => ROW),
      collapsed(1, 1),
      ROW,
      ROW,
      ROW,
      ADD_ROW,
    ])

    const both = referenceCollapseContextPaired(
      [pairedAddRow(1), ...contextRun(12), pairedAddRow(2)],
      expansion({ fromStart: 5, fromEnd: 5 }),
    )
    expect(describePairedItems(both)).toEqual([ADD_ROW, ...Array.from({ length: 12 }, () => ROW), ADD_ROW])
  })

  it('marks runs longer than 100 hidden rows as chunked', () => {
    const items = referenceCollapseContextPaired([pairedAddRow(1), ...contextRun(120), pairedAddRow(2)])

    expect(describePairedItems(items)).toEqual([
      ADD_ROW,
      ROW,
      ROW,
      ROW,
      collapsed(114, 1, false, false, true),
      ROW,
      ROW,
      ROW,
      ADD_ROW,
    ])
  })
})

describe('frozen unified context collapse', () => {
  it('collapses only context runs and keeps change rows', () => {
    const items = referenceCollapseContextUnified([
      unifiedAddRow(1),
      ...Array.from({ length: 9 }, (_unused, index) => unifiedContextRow(index + 1)),
      unifiedAddRow(2),
    ])

    expect(describeUnifiedItems(items)).toEqual([ADD_ROW, ROW, ROW, ROW, collapsed(3, 1), ROW, ROW, ROW, ADD_ROW])
  })

  it('treats a delete row as a change boundary', () => {
    const items = referenceCollapseContextUnified([
      ...Array.from({ length: 9 }, (_unused, index) => unifiedContextRow(index + 1)),
      { type: 'delete', content: 'gone', oldLineNo: 10 },
      unifiedAddRow(1),
    ])

    expect(describeUnifiedItems(items)).toEqual([collapsed(6, 0, true), ROW, ROW, ROW, { row: 'delete' }, ADD_ROW])
  })
})

// ============================================
// 5. 调用次数与确定性基线
// ============================================

describe('frozen reference call counts', () => {
  const before = 'one\ntwo\nthree'
  const after = 'one\nTWO\nthree'

  it('calls diffLines exactly once per view and word diff once per replaced row', () => {
    referenceComputePairedLines(before, after, false)
    expect(diffCalls.diffLines).toBe(1)
    expect(diffCalls.diffWordsWithSpace).toBe(1)

    referenceComputeUnifiedLines(before, after)
    expect(diffCalls.diffLines).toBe(2)
    expect(diffCalls.diffWordsWithSpace).toBe(1)
  })

  it('documents the pre-extraction cost: split + unified diff the same input twice', () => {
    referenceComputePairedLines(before, after, true)
    referenceComputeUnifiedLines(before, after)

    // 阶段 2 的目标：生产模型对同一输入只做一次 diffLines，本表跟着下降。
    expect(diffCalls.diffLines).toBe(2)
  })

  it('is deterministic: repeated calls return equal rows and never cache', () => {
    const first = referenceComputePairedLines(before, after, false)
    const second = referenceComputePairedLines(before, after, false)

    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(diffCalls.diffLines).toBe(2)
    expect(diffCalls.diffWordsWithSpace).toBe(2)
  })

  it('does not touch diff for pure collapse work', () => {
    referenceCollapseContextPaired([pairedAddRow(1), ...contextRun(12), pairedAddRow(2)])
    referenceCollapseContextUnified([unifiedAddRow(1)])

    expect(diffCalls.diffLines).toBe(0)
    expect(diffCalls.diffWordsWithSpace).toBe(0)
  })
})

// ============================================
// 6. 生产模型与冻结参考的差分（阶段 2）
// ============================================

/** 语料之外再补几条边界输入：只做生产/参考差分，不在这里手写期望 */
const PARITY_INPUTS: ReadonlyArray<{ name: string; before: string; after: string }> = [
  { name: 'whitespace only', before: 'a  b\nkeep', after: 'a b\nkeep' },
  { name: 'blank lines', before: 'a\n\n\nb', after: 'a\n\nb' },
  { name: 'carriage returns without newline', before: 'a\rb\r', after: 'a\rc\r' },
  { name: 'long single line', before: 'x'.repeat(400), after: `${'x'.repeat(399)}y` },
  { name: 'no trailing newline on both sides', before: 'a\nb', after: 'a\nc' },
]

/**
 * 生产入口（旧签名 + `computeLineDiff` 派生）与冻结参考逐字段相等。
 * 期望全部来自 `referenceCompute*`，生产实现只作为被比较的一侧。
 */
function expectModelMatchesReference(before: string, after: string) {
  expect(computePairedLines(before, after, false)).toStrictEqual(referenceComputePairedLines(before, after, false))
  expect(computePairedLines(before, after, true)).toStrictEqual(referenceComputePairedLines(before, after, true))
  expect(computeUnifiedLines(before, after)).toStrictEqual(referenceComputeUnifiedLines(before, after))

  // 阶段 2 的接入方式：一次行级 diff，split/unified/resize 都从同一模型派生
  const model = computeLineDiff(before, after)
  expect(buildPairedLines(model)).toStrictEqual(referenceComputePairedLines(before, after, false))
  expect(buildPairedLines(model, { wordDiff: false })).toStrictEqual(referenceComputePairedLines(before, after, true))
  expect(buildUnifiedLines(model)).toStrictEqual(referenceComputeUnifiedLines(before, after))
}

describe('production diff model parity with the frozen reference', () => {
  for (const testCase of [...CORPUS, ...PARITY_INPUTS]) {
    it(`derives paired, unified and model rows like the reference for ${testCase.name}`, () => {
      expectModelMatchesReference(testCase.before, testCase.after)
    })
  }

  it('keeps the strict fragmentation boundary at exactly 10 characters', () => {
    const atTen = [change('0123456789', 'removed')]
    // 基线是 `> 10` 且共同占比 0 → 恰好 10 个字符不算碎片
    expect(referenceIsTooFragmented(atTen)).toBe(false)
    expect(isTooFragmented(atTen)).toBe(false)

    for (const changes of [
      atTen,
      [change('abcd', 'common'), change('1234567', 'removed')],
      [change('abcdef', 'common'), change('123456789', 'removed')],
      [change('abcde', 'common'), change('123456', 'removed')],
    ]) {
      expect(isTooFragmented(changes)).toBe(referenceIsTooFragmented(changes))
    }
  })

  it('matches reference word diff segments for whitespace and CJK lines', () => {
    const pairs = [
      ['a  b', 'a b'],
      ['node_modules .git .gitignore', 'node_modules root .gitignore'],
      ['中文旧值', '中文新值'],
      ['', 'added'],
      ['deleted', ''],
    ] as const

    for (const [oldLine, newLine] of pairs) {
      expect(computeWordDiff(oldLine, newLine)).toStrictEqual(referenceComputeWordDiff(oldLine, newLine))
    }
  })
})

describe('production context collapse parity', () => {
  // 直接对同一批手写行跑两份实现；期望来自冻结参考，不来自生产折叠代码。
  // 8/9 是折叠门槛（`ctxLen > 8`），106/107 是 chunked 门槛（隐藏 100/101 行）。
  for (const length of [0, 8, 9, 10, 106, 107, 120]) {
    it(`collapses a ${length}-row paired context run like the reference`, () => {
      const rows = [pairedAddRow(1), ...contextRun(length), pairedAddRow(2)]

      for (const expanded of [
        undefined,
        expansion({ fromStart: 5, fromEnd: 0 }),
        expansion({ fromStart: 5, fromEnd: 5 }),
      ]) {
        expect(collapseContextPaired(rows, expanded)).toStrictEqual(referenceCollapseContextPaired(rows, expanded))
      }
    })
  }

  for (const length of [8, 9, 106]) {
    it(`collapses a ${length}-row unified context run like the reference`, () => {
      const rows = [
        unifiedAddRow(1),
        ...Array.from({ length }, (_unused, index) => unifiedContextRow(index + 1)),
        { type: 'delete' as const, content: 'gone', oldLineNo: length + 1 },
        unifiedAddRow(2),
      ]

      for (const expanded of [undefined, expansion({ fromStart: 2, fromEnd: 2 })]) {
        expect(collapseContextUnified(rows, expanded)).toStrictEqual(referenceCollapseContextUnified(rows, expanded))
      }
    })
  }
})

describe('production call counts', () => {
  const before = 'one\ntwo\nthree'
  const after = 'one\nTWO\nthree'

  it('derives split and unified from one diffLines and one word diff per replaced row', () => {
    const model = computeLineDiff(before, after)
    expect(diffCalls.diffLines).toBe(1)
    expect(diffCalls.diffWordsWithSpace).toBe(0)

    buildPairedLines(model)
    expect(diffCalls.diffWordsWithSpace).toBe(1)

    // unified 与 resize 的 paired 都复用同一模型：不再产生 diffLines / 新的词级调用
    buildUnifiedLines(model)
    buildPairedLines(model, { wordDiff: false })
    expect(diffCalls.diffLines).toBe(1)
    expect(diffCalls.diffWordsWithSpace).toBe(1)
  })

  it('charges one diffLines per old-signature entry and none for collapse', () => {
    const paired = computePairedLines(before, after, true)
    const unified = computeUnifiedLines(before, after)
    expect(diffCalls.diffLines).toBe(2)

    collapseContextPaired(paired)
    collapseContextUnified(unified)
    expect(diffCalls.diffLines).toBe(2)
    expect(diffCalls.diffWordsWithSpace).toBe(0)
  })
})
