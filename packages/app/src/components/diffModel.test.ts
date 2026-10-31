import { describe, expect, it } from 'vitest'
import {
  EXPANSION_LINE_COUNT,
  collapseContextPaired,
  collapseContextUnified,
  computePairedLines,
  computeUnifiedLines,
  computeWordDiff,
  expandRegion,
  isCollapsed,
  isTooFragmented,
} from './diffModel'

/** 把 paired 行压成便于断言的元组 */
function pairRows(before: string, after: string, skipWordDiff = false) {
  return computePairedLines(before, after, skipWordDiff).map(row => [
    row.left.type,
    row.left.content,
    row.left.lineNo ?? null,
    row.right.type,
    row.right.content,
    row.right.lineNo ?? null,
  ])
}

function unifiedRows(before: string, after: string) {
  return computeUnifiedLines(before, after).map(line => [
    line.type,
    line.content,
    line.oldLineNo ?? null,
    line.newLineNo ?? null,
  ])
}

describe('diffModel 行级 diff', () => {
  it('空输入不产生任何行', () => {
    expect(computePairedLines('', '', false)).toEqual([])
    expect(computeUnifiedLines('', '')).toEqual([])
    expect(collapseContextPaired(computePairedLines('', '', false))).toEqual([])
    expect(collapseContextUnified(computeUnifiedLines('', ''))).toEqual([])
  })

  it('单边新增只占右侧，左侧留空且不带行号', () => {
    expect(pairRows('', 'x\n')).toEqual([['empty', '', null, 'add', 'x', 1]])
    expect(unifiedRows('', 'x\n')).toEqual([['add', 'x', null, 1]])
  })

  it('单边删除只占左侧', () => {
    expect(pairRows('a\nb\nc\nd', 'a\nX\nY\nZ\nW')).toHaveLength(5)
    expect(pairRows('x', '')).toEqual([['delete', 'x', 1, 'empty', '', null]])
    expect(unifiedRows('x', '')).toEqual([['delete', 'x', 1, null]])
  })

  it('只含换行的输入保留空行内容', () => {
    expect(pairRows('\n', '')).toEqual([['delete', '', 1, 'empty', '', null]])
    expect(pairRows('', '\n')).toEqual([['empty', '', null, 'add', '', 1]])
  })

  it('删除多于新增时，多出来的行右侧为空', () => {
    expect(pairRows('a\nb\nc\nd', 'a\nB')).toEqual([
      ['context', 'a', 1, 'context', 'a', 1],
      ['delete', 'b', 2, 'add', 'B', 2],
      ['delete', 'c', 3, 'empty', '', null],
      ['delete', 'd', 4, 'empty', '', null],
    ])
  })

  it('新增多于删除时，多出来的行左侧为空', () => {
    expect(pairRows('a\nb\nc\nd', 'a\nX\nY\nZ\nW')).toEqual([
      ['context', 'a', 1, 'context', 'a', 1],
      ['delete', 'b', 2, 'add', 'X', 2],
      ['delete', 'c', 3, 'add', 'Y', 3],
      ['delete', 'd', 4, 'add', 'Z', 4],
      ['empty', '', null, 'add', 'W', 5],
    ])
  })

  it('CRLF 输入按 \\n 切行，行内容保留 \\r', () => {
    expect(unifiedRows('a\r\nb\r\n', 'a\r\nc\r\n')).toEqual([
      ['context', 'a\r', 1, 1],
      ['delete', 'b\r', 2, null],
      ['add', 'c\r', null, 2],
    ])
  })

  it('尾换行差异算一次替换而不是内容相同的上下文', () => {
    // 'a\n' 与 'a' 在 diff 库里是两个不同的块，折成一行左右配对
    expect(unifiedRows('a\n', 'a')).toEqual([
      ['delete', 'a', 1, null],
      ['add', 'a', null, 1],
    ])
    expect(pairRows('a\n', 'a')).toEqual([['delete', 'a', 1, 'add', 'a', 1]])
  })

  it('unified 的 context 内容取新文件侧', () => {
    // 两侧 context 内容相同，取哪边都一样；这里固定断言以防实现漂移
    expect(unifiedRows('same\nold', 'same\nnew')).toEqual([
      ['context', 'same', 1, 1],
      ['delete', 'old', 2, null],
      ['add', 'new', null, 2],
    ])
  })
})

describe('diffModel 词级 diff', () => {
  it('合并同向相邻片段，空白差异单独成段', () => {
    const diff = computeWordDiff('a  b', 'a b')
    expect(diff.left).toEqual([{ text: 'a' }, { text: '  ', diffType: 'delete' }, { text: 'b' }])
    expect(diff.right).toEqual([{ text: 'a' }, { text: ' ', diffType: 'add' }, { text: 'b' }])
  })

  it('夹在两次删除之间的空白被并入前一段', () => {
    const diff = computeWordDiff('node_modules .git .gitignore', 'node_modules root .gitignore')
    expect(diff.left).toEqual([
      { text: 'node_modules ' },
      { text: '.git', diffType: 'delete' },
      { text: ' .gitignore' },
    ])
    expect(diff.right).toEqual([{ text: 'node_modules ' }, { text: 'root', diffType: 'add' }, { text: ' .gitignore' }])
  })

  it('中文按字符切分，保留共同前后缀', () => {
    const diff = computeWordDiff('中文旧值', '中文新值')
    expect(diff.left).toEqual([{ text: '中文' }, { text: '旧', diffType: 'delete' }, { text: '值' }])
    expect(diff.right).toEqual([{ text: '中文' }, { text: '新', diffType: 'add' }, { text: '值' }])
  })

  it('碎片化判定：总长 >10 且共同内容占比 <0.4', () => {
    expect(isTooFragmented(computeWordDiff('aaaa bbbb cccc dddd', 'AAAA BBBB CCCC DDDD').changes)).toBe(true)
    expect(isTooFragmented(computeWordDiff('const x = 1', 'const y = 1').changes)).toBe(false)
    // 总长不足 10 时即便共同占比为 0 也不算碎片
    expect(isTooFragmented(computeWordDiff('ab', 'cd').changes)).toBe(false)
  })

  it('过度碎片化的行不带词级标记，但行级内容保持不变', () => {
    const pairs = computePairedLines('aaaa bbbb cccc dddd', 'AAAA BBBB CCCC DDDD', false)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].left.wordDiffSegments).toBeUndefined()
    expect(pairs[0].right.wordDiffSegments).toBeUndefined()
    expect(pairs[0].left.content).toBe('aaaa bbbb cccc dddd')
    expect(pairs[0].right.content).toBe('AAAA BBBB CCCC DDDD')
  })

  it('skipWordDiff 跳过全部词级计算，行级结果不变', () => {
    const withSegments = computePairedLines('const x = 1', 'const y = 1', false)
    const withoutSegments = computePairedLines('const x = 1', 'const y = 1', true)
    expect(withSegments[0].left.wordDiffSegments).toHaveLength(3)
    expect(withoutSegments[0].left.wordDiffSegments).toBeUndefined()
    expect(withoutSegments.map(row => [row.left.type, row.left.content, row.right.content])).toEqual(
      withSegments.map(row => [row.left.type, row.left.content, row.right.content]),
    )
  })
})

describe('diffModel 上下文折叠', () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n')
  const after = before.replace('l10', 'X')

  it('分别折叠首尾两段过长的 context', () => {
    const folded = collapseContextUnified(computeUnifiedLines(before, after))
    expect(folded[0]).toEqual({ collapsed: true, count: 6, id: 0, isFirst: true, isLast: false, chunked: false })
    expect(folded.at(-1)).toEqual({ collapsed: true, count: 7, id: 11, isFirst: false, isLast: true, chunked: false })
    expect(folded.filter(item => !isCollapsed(item)).map(item => item.content)).toEqual([
      'l7',
      'l8',
      'l9',
      'l10',
      'X',
      'l11',
      'l12',
      'l13',
    ])
  })

  it('paired 折叠与 unified 折叠在等价输入上给出同样块位置与行数', () => {
    const paired = collapseContextPaired(computePairedLines(before, after, true))
    const unified = collapseContextUnified(computeUnifiedLines(before, after))
    // paired 把 replace 折成一行、unified 折成两行，行数组长度不同；
    // 但折叠块的数量、块大小与首尾标记必须一致。
    const blocks = (items: ReturnType<typeof collapseContextPaired> | ReturnType<typeof collapseContextUnified>) =>
      items.filter(isCollapsed).map(item => ({ count: item.count, isFirst: item.isFirst, isLast: item.isLast }))
    expect(blocks(paired)).toEqual(blocks(unified))
    expect(blocks(paired)).toEqual([
      { count: 6, isFirst: true, isLast: false },
      { count: 7, isFirst: false, isLast: true },
    ])
  })

  it('context 不足以折叠时原样输出', () => {
    const shortBefore = 'a\nb\nc'
    const folded = collapseContextUnified(computeUnifiedLines(shortBefore, 'a\nB\nc'))
    expect(folded.every(item => !isCollapsed(item))).toBe(true)
    // 'a\nb\nc' → 'a\nB\nc' 是 1 行 context + 1 删 + 1 增 + 1 行 context
    expect(folded).toHaveLength(4)
  })

  it('展开区按 id 提升保留行数', () => {
    const folded = collapseContextUnified(
      computeUnifiedLines(before, after),
      new Map([[0, { fromStart: 3, fromEnd: 0 }]]),
    )
    // 首段原本保留 0 行（isFirst），fromStart 3 让前 3 行常驻，折叠块从 6 缩到 3
    expect(folded.slice(0, 3).map(item => isCollapsed(item))).toEqual([false, false, false])
    expect(folded[3]).toEqual({ collapsed: true, count: 3, id: 0, isFirst: true, isLast: false, chunked: false })
  })

  it('折叠块超过单次展开量时标记 chunked', () => {
    const longBefore = Array.from({ length: 120 }, (_, i) => `l${i + 1}`).join('\n')
    const folded = collapseContextUnified(computeUnifiedLines(longBefore, longBefore.replace('l118', 'X')))
    const block = folded[0]
    expect(isCollapsed(block)).toBe(true)
    expect(isCollapsed(block) && block.count).toBeGreaterThan(EXPANSION_LINE_COUNT)
    expect(isCollapsed(block) && block.chunked).toBe(true)
  })

  it('expandRegion 逐方向累加且不修改入参', () => {
    const initial = new Map<number, { fromStart: number; fromEnd: number }>()
    const up = expandRegion(initial, 7, 'up')
    expect(initial.size).toBe(0)
    expect(up.get(7)).toEqual({ fromStart: EXPANSION_LINE_COUNT, fromEnd: 0 })
    const both = expandRegion(up, 7, 'both')
    expect(both.get(7)).toEqual({ fromStart: EXPANSION_LINE_COUNT * 2, fromEnd: EXPANSION_LINE_COUNT })
    expect(up.get(7)).toEqual({ fromStart: EXPANSION_LINE_COUNT, fromEnd: 0 })
  })
})
