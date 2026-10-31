/**
 * 冻结的旧 Diff 计算参考实现（H 独立验证用）。
 *
 * 来源：`d13bc984` `packages/app/src/components/DiffViewer.tsx`（Diff Computation 段，逻辑冻结）
 *
 * 规则：
 * - 只拷贝算 expected 所必需的纯计算：paired / unified 行、word diff、碎片阈值、上下文折叠。
 *   不 import 生产 `components/DiffViewer.tsx` 或提取后的 diff 模型，避免「用新实现验证新实现」。
 * - `diff` 依赖按原样直接调用（与旧文件同一 import），函数体逐字保持；调用次数由测试侧
 *   对 `diff` 模块打点统计，本文件不插入计数器，保证行为面与旧文件一致。
 * - 生产实现变动后不要同步本文件；差分失败说明行为变了，由测试暴露而不是抹平。
 * - 本文件只在测试内使用（vitest coverage 已排除 src/test/**）。
 *
 * 只重命名导出函数（加 `reference` 前缀）与类型（加 `Reference` 前缀）；六个函数体经 AST 核验与
 * `d13bc984` 一致（见 `components/DiffViewer.compat.test.tsx` 的 AST 指纹断言）。
 */
import { diffLines, diffWordsWithSpace } from 'diff'

export const REFERENCE_SOURCE_COMMIT = 'd13bc984'

export type ReferenceLineType = 'add' | 'delete' | 'context' | 'empty'

export interface ReferenceDiffLine {
  type: ReferenceLineType
  content: string
  lineNo?: number
  wordDiffSegments?: ReferenceWordDiffSegment[]
}

export interface ReferenceWordDiffSegment {
  text: string
  diffType?: 'add' | 'delete'
}

export interface ReferencePairedLine {
  left: ReferenceDiffLine
  right: ReferenceDiffLine
}

export interface ReferenceCollapsedPairedLine {
  collapsed: true
  count: number
  id: number
  isFirst: boolean
  isLast: boolean
  chunked: boolean
}

export type ReferencePairedLineOrCollapsed = ReferencePairedLine | ReferenceCollapsedPairedLine

export interface ReferenceUnifiedLine extends ReferenceDiffLine {
  oldLineNo?: number
  newLineNo?: number
}

export interface ReferenceCollapsedUnifiedLine {
  collapsed: true
  count: number
  id: number
  isFirst: boolean
  isLast: boolean
  chunked: boolean
}

export type ReferenceUnifiedLineOrCollapsed = ReferenceUnifiedLine | ReferenceCollapsedUnifiedLine

export interface ReferenceExpansionRegion {
  fromStart: number
  fromEnd: number
}

const CONTEXT_LINES = 3
const EXPANSION_LINE_COUNT = 100

export const REFERENCE_CONTEXT_LINES = CONTEXT_LINES
export const REFERENCE_EXPANSION_LINE_COUNT = EXPANSION_LINE_COUNT

type WordDiffChange = ReturnType<typeof diffWordsWithSpace>[number]

/** 将连续 context 行折叠，只保留变更前后各 CONTEXT_LINES 行 */
export function referenceCollapseContextPaired(
  lines: ReferencePairedLine[],
  expandedRegions?: ReadonlyMap<number, ReferenceExpansionRegion>,
): ReferencePairedLineOrCollapsed[] {
  if (lines.length === 0) return []

  const result: ReferencePairedLineOrCollapsed[] = []
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

export function referenceCollapseContextUnified(
  lines: ReferenceUnifiedLine[],
  expandedRegions?: ReadonlyMap<number, ReferenceExpansionRegion>,
): ReferenceUnifiedLineOrCollapsed[] {
  if (lines.length === 0) return []

  const result: ReferenceUnifiedLineOrCollapsed[] = []
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

export function referenceComputePairedLines(
  before: string,
  after: string,
  skipWordDiff: boolean,
): ReferencePairedLine[] {
  const changes = diffLines(before, after)
  const result: ReferencePairedLine[] = []
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

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

          let leftSegments: ReferenceWordDiffSegment[] | undefined
          let rightSegments: ReferenceWordDiffSegment[] | undefined

          if (!skipWordDiff && oldLine !== undefined && newLine !== undefined) {
            const wordDiff = referenceComputeWordDiff(oldLine, newLine)
            if (!referenceIsTooFragmented(wordDiff.changes)) {
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

export function referenceComputeUnifiedLines(before: string, after: string): ReferenceUnifiedLine[] {
  const changes = diffLines(before, after)
  const result: ReferenceUnifiedLine[] = []
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')

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

export function referenceIsTooFragmented(changes: WordDiffChange[]): boolean {
  let commonLength = 0,
    totalLength = 0
  for (const change of changes) {
    totalLength += change.value.length
    if (!change.added && !change.removed) commonLength += change.value.length
  }
  return totalLength > 10 && commonLength / totalLength < 0.4
}

export function referenceComputeWordDiff(
  oldLine: string,
  newLine: string,
): { left: ReferenceWordDiffSegment[]; right: ReferenceWordDiffSegment[]; changes: WordDiffChange[] } {
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

  const left: ReferenceWordDiffSegment[] = []
  const right: ReferenceWordDiffSegment[] = []
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
