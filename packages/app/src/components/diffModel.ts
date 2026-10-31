/**
 * diffModel - DiffViewer 的纯 diff 计算模型
 *
 * 只依赖 diff 库与纯函数：不碰 React / DOM / i18n / 主题，便于单独断言输出。
 * DiffViewer 从这里拿行级、词级与上下文折叠结果；渲染结构仍留在组件里。
 *
 * 纯增删/空输入/CRLF/尾换行等边界都由 diff 库的原始语义决定，这里不额外归一化。
 */

import { diffLines, diffWordsWithSpace } from 'diff'

// ============================================
// Types
// ============================================

export type LineType = 'add' | 'delete' | 'context' | 'empty'

export interface DiffLine {
  type: LineType
  content: string
  lineNo?: number
  /** 词级别 diff 标记（结构化），与 syntax token 共存 */
  wordDiffSegments?: WordDiffSegment[]
}

/** 词级别 diff 的单个片段 */
export interface WordDiffSegment {
  text: string
  /** 'add' | 'delete' 表示增删标记，undefined 表示无变化 */
  diffType?: 'add' | 'delete'
}

export interface PairedLine {
  left: DiffLine
  right: DiffLine
}

/** 折叠的 context 行占位 */
export interface CollapsedPairedLine {
  collapsed: true
  count: number
  /** 在原始 lines 数组中的起始索引，用于展开 */
  id: number
  isFirst: boolean
  isLast: boolean
  chunked: boolean
}

export type PairedLineOrCollapsed = PairedLine | CollapsedPairedLine

export interface UnifiedLine extends DiffLine {
  oldLineNo?: number
  newLineNo?: number
}

export interface CollapsedUnifiedLine {
  collapsed: true
  count: number
  id: number
  isFirst: boolean
  isLast: boolean
  chunked: boolean
}

export type UnifiedLineOrCollapsed = UnifiedLine | CollapsedUnifiedLine

export type ExpandDirection = 'up' | 'down' | 'both'

export interface ExpansionRegion {
  fromStart: number
  fromEnd: number
}

// ============================================
// 上下文折叠
// ============================================

/** 上下文行保留数：变更前后各保留 CONTEXT_LINES 行 */
export const CONTEXT_LINES = 3
export const EXPANSION_LINE_COUNT = 100

export function isCollapsed(
  line: PairedLineOrCollapsed | UnifiedLineOrCollapsed,
): line is CollapsedPairedLine | CollapsedUnifiedLine {
  return 'collapsed' in line && line.collapsed === true
}

export function expandRegion(
  prev: ReadonlyMap<number, ExpansionRegion>,
  id: number,
  direction: ExpandDirection,
): Map<number, ExpansionRegion> {
  const next = new Map(prev)
  const current = next.get(id) ?? { fromStart: 0, fromEnd: 0 }
  next.set(id, {
    fromStart: current.fromStart + (direction === 'up' || direction === 'both' ? EXPANSION_LINE_COUNT : 0),
    fromEnd: current.fromEnd + (direction === 'down' || direction === 'both' ? EXPANSION_LINE_COUNT : 0),
  })
  return next
}

/** 将连续 context 行折叠，只保留变更前后各 CONTEXT_LINES 行 */
export function collapseContextPaired(
  lines: PairedLine[],
  expandedRegions?: ReadonlyMap<number, ExpansionRegion>,
): PairedLineOrCollapsed[] {
  if (lines.length === 0) return []

  const result: PairedLineOrCollapsed[] = []
  let contextStart = -1

  for (let i = 0; i <= lines.length; i++) {
    const isCtx = i < lines.length && lines[i].left.type === 'context' && lines[i].right.type === 'context'

    if (isCtx) {
      if (contextStart === -1) contextStart = i
    } else {
      if (contextStart !== -1) {
        const ctxLen = i - contextStart
        const minToCollapse = CONTEXT_LINES * 2 + 2
        if (ctxLen > minToCollapse) {
          const isFirst = contextStart === 0
          const isLast = i === lines.length
          const keepBefore = isFirst ? 0 : CONTEXT_LINES
          const keepAfter = isLast ? 0 : CONTEXT_LINES
          const expanded = expandedRegions?.get(contextStart) ?? { fromStart: 0, fromEnd: 0 }
          const prefixCount = Math.min(ctxLen, keepBefore + expanded.fromStart)
          const suffixStart = Math.max(prefixCount, ctxLen - keepAfter - expanded.fromEnd)

          for (let j = contextStart; j < contextStart + prefixCount; j++) result.push(lines[j])
          if (suffixStart > prefixCount) {
            const count = suffixStart - prefixCount
            result.push({
              collapsed: true,
              count,
              id: contextStart,
              isFirst,
              isLast,
              chunked: count > EXPANSION_LINE_COUNT,
            })
          }
          for (let j = contextStart + suffixStart; j < i; j++) result.push(lines[j])
        } else {
          for (let j = contextStart; j < i; j++) result.push(lines[j])
        }
        contextStart = -1
      }
      if (i < lines.length) result.push(lines[i])
    }
  }

  return result
}

export function collapseContextUnified(
  lines: UnifiedLine[],
  expandedRegions?: ReadonlyMap<number, ExpansionRegion>,
): UnifiedLineOrCollapsed[] {
  if (lines.length === 0) return []

  const result: UnifiedLineOrCollapsed[] = []
  let contextStart = -1

  for (let i = 0; i <= lines.length; i++) {
    const isCtx = i < lines.length && lines[i].type === 'context'

    if (isCtx) {
      if (contextStart === -1) contextStart = i
    } else {
      if (contextStart !== -1) {
        const ctxLen = i - contextStart
        const minToCollapse = CONTEXT_LINES * 2 + 2
        if (ctxLen > minToCollapse) {
          const isFirst = contextStart === 0
          const isLast = i === lines.length
          const keepBefore = isFirst ? 0 : CONTEXT_LINES
          const keepAfter = isLast ? 0 : CONTEXT_LINES
          const expanded = expandedRegions?.get(contextStart) ?? { fromStart: 0, fromEnd: 0 }
          const prefixCount = Math.min(ctxLen, keepBefore + expanded.fromStart)
          const suffixStart = Math.max(prefixCount, ctxLen - keepAfter - expanded.fromEnd)

          for (let j = contextStart; j < contextStart + prefixCount; j++) result.push(lines[j])
          if (suffixStart > prefixCount) {
            const count = suffixStart - prefixCount
            result.push({
              collapsed: true,
              count,
              id: contextStart,
              isFirst,
              isLast,
              chunked: count > EXPANSION_LINE_COUNT,
            })
          }
          for (let j = contextStart + suffixStart; j < i; j++) result.push(lines[j])
        } else {
          for (let j = contextStart; j < i; j++) result.push(lines[j])
        }
        contextStart = -1
      }
      if (i < lines.length) result.push(lines[i])
    }
  }

  return result
}

// ============================================
// 词级 diff
// ============================================

export type WordDiffChange = ReturnType<typeof diffWordsWithSpace>[number]

export function isTooFragmented(changes: WordDiffChange[]): boolean {
  let commonLength = 0,
    totalLength = 0
  for (const change of changes) {
    totalLength += change.value.length
    if (!change.added && !change.removed) commonLength += change.value.length
  }
  return totalLength > 10 && commonLength / totalLength < 0.4
}

export function computeWordDiff(
  oldLine: string,
  newLine: string,
): { left: WordDiffSegment[]; right: WordDiffSegment[]; changes: WordDiffChange[] } {
  const changes = diffWordsWithSpace(oldLine, newLine)

  const mergedChanges: WordDiffChange[] = []
  for (let i = 0; i < changes.length; i++) {
    const current = changes[i]
    const prev = mergedChanges[mergedChanges.length - 1]

    if (prev && !current.added && !current.removed && /^\s*$/.test(current.value)) {
      const next = changes[i + 1]
      if ((prev.removed && next?.removed) || (prev.added && next?.added)) {
        prev.value += current.value
        continue
      }
    }

    if (prev && ((prev.added && current.added) || (prev.removed && current.removed))) {
      prev.value += current.value
    } else {
      mergedChanges.push({ ...current })
    }
  }

  const left: WordDiffSegment[] = []
  const right: WordDiffSegment[] = []
  for (const change of mergedChanges) {
    if (change.removed) left.push({ text: change.value, diffType: 'delete' })
    else if (change.added) right.push({ text: change.value, diffType: 'add' })
    else {
      left.push({ text: change.value })
      right.push({ text: change.value })
    }
  }

  return { left, right, changes: mergedChanges }
}

// ============================================
// 行级 diff
//
// 行级 diff 只做一次：paired（左右配对）与 unified（单列）从同一份
// DiffLineModel 派生，拖拽 resize 只影响词级标记，不会重跑 diffLines。
// ============================================

export type DiffLineChange = ReturnType<typeof diffLines>[number]

/** 一次 diffLines 的结果 + 两侧按行切分后的数组 */
export interface DiffLineModel {
  changes: DiffLineChange[]
  beforeLines: string[]
  afterLines: string[]
}

/** 行级 diff 的唯一入口：一次 diffLines，一次 split */
export function computeLineDiff(before: string, after: string): DiffLineModel {
  return {
    changes: diffLines(before, after),
    beforeLines: before.split('\n'),
    afterLines: after.split('\n'),
  }
}

export interface BuildPairedLinesOptions {
  /** 是否计算词级 diff，默认 true；拖拽 resize 期间传 false */
  wordDiff?: boolean
}

export function buildPairedLines(model: DiffLineModel, options: BuildPairedLinesOptions = {}): PairedLine[] {
  const skipWordDiff = options.wordDiff === false
  const { changes, beforeLines, afterLines } = model
  const result: PairedLine[] = []

  let oldIdx = 0,
    newIdx = 0,
    i = 0

  while (i < changes.length) {
    const change = changes[i]
    const count = change.count || 0

    if (change.removed) {
      const next = changes[i + 1]
      if (next?.added) {
        const addCount = next.count || 0
        const maxCount = Math.max(count, addCount)

        for (let j = 0; j < maxCount; j++) {
          const oldLine = j < count ? beforeLines[oldIdx + j] : undefined
          const newLine = j < addCount ? afterLines[newIdx + j] : undefined

          let leftSegments: WordDiffSegment[] | undefined
          let rightSegments: WordDiffSegment[] | undefined

          if (!skipWordDiff && oldLine !== undefined && newLine !== undefined) {
            const wordDiff = computeWordDiff(oldLine, newLine)
            if (!isTooFragmented(wordDiff.changes)) {
              leftSegments = wordDiff.left
              rightSegments = wordDiff.right
            }
          }

          result.push({
            left:
              oldLine !== undefined
                ? { type: 'delete', content: oldLine, lineNo: oldIdx + j + 1, wordDiffSegments: leftSegments }
                : { type: 'empty', content: '' },
            right:
              newLine !== undefined
                ? { type: 'add', content: newLine, lineNo: newIdx + j + 1, wordDiffSegments: rightSegments }
                : { type: 'empty', content: '' },
          })
        }

        oldIdx += count
        newIdx += addCount
        i += 2
        continue
      }

      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'delete', content: beforeLines[oldIdx + j] || '', lineNo: oldIdx + j + 1 },
          right: { type: 'empty', content: '' },
        })
      }
      oldIdx += count
    } else if (change.added) {
      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'empty', content: '' },
          right: { type: 'add', content: afterLines[newIdx + j] || '', lineNo: newIdx + j + 1 },
        })
      }
      newIdx += count
    } else {
      for (let j = 0; j < count; j++) {
        result.push({
          left: { type: 'context', content: beforeLines[oldIdx + j] || '', lineNo: oldIdx + j + 1 },
          right: { type: 'context', content: afterLines[newIdx + j] || '', lineNo: newIdx + j + 1 },
        })
      }
      oldIdx += count
      newIdx += count
    }
    i++
  }

  return result
}

export function buildUnifiedLines(model: DiffLineModel): UnifiedLine[] {
  const { changes, beforeLines, afterLines } = model
  const result: UnifiedLine[] = []

  let oldIdx = 0,
    newIdx = 0

  for (const change of changes) {
    const count = change.count || 0

    if (change.removed) {
      for (let j = 0; j < count; j++) {
        result.push({ type: 'delete', content: beforeLines[oldIdx + j] || '', oldLineNo: oldIdx + j + 1 })
      }
      oldIdx += count
    } else if (change.added) {
      for (let j = 0; j < count; j++) {
        result.push({ type: 'add', content: afterLines[newIdx + j] || '', newLineNo: newIdx + j + 1 })
      }
      newIdx += count
    } else {
      for (let j = 0; j < count; j++) {
        result.push({
          type: 'context',
          content: afterLines[newIdx + j] || '',
          oldLineNo: oldIdx + j + 1,
          newLineNo: newIdx + j + 1,
        })
      }
      oldIdx += count
      newIdx += count
    }
  }

  return result
}

/**
 * 旧签名便捷入口（before/after 直接给）：内部只做一次行级 diff。
 * 保留它便于按输入直接对照/回归，不必自己拼 DiffLineModel。
 */
export function computePairedLines(before: string, after: string, skipWordDiff = false): PairedLine[] {
  return buildPairedLines(computeLineDiff(before, after), { wordDiff: !skipWordDiff })
}

export function computeUnifiedLines(before: string, after: string): UnifiedLine[] {
  return buildUnifiedLines(computeLineDiff(before, after))
}
