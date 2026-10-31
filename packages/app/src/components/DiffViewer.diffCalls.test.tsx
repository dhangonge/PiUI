import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 只统计调用次数，实现仍走真实 diff 库（不用假返回值），
// 这样「算了几次」和「算出来对不对」都能在同一组用例里断言。
const calls = vi.hoisted(() => ({ diffLines: 0, diffWordsWithSpace: 0 }))

vi.mock('diff', async importOriginal => {
  const actual = await importOriginal<typeof import('diff')>()
  return {
    ...actual,
    diffLines: (...args: Parameters<typeof actual.diffLines>) => {
      calls.diffLines += 1
      return actual.diffLines(...args)
    },
    diffWordsWithSpace: (...args: Parameters<typeof actual.diffWordsWithSpace>) => {
      calls.diffWordsWithSpace += 1
      return actual.diffWordsWithSpace(...args)
    },
  }
})

// 高亮走 worker，这里与 DiffViewer.test.tsx 一样替身掉，只观察 diff 计算。
vi.mock('../hooks/useSyntaxHighlight', () => ({
  useSyntaxHighlight: (code: string, options?: { mode?: 'html' | 'tokens' }) => ({
    output: options?.mode === 'tokens' ? code.split('\n').map(line => [{ content: line, color: '#fff' }]) : null,
    isLoading: false,
  }),
}))

import { useDiffViewerData } from './DiffViewer'

const before = ['const a = 1', 'keep', 'const b = 2'].join('\n')
const after = ['const a = 1', 'keep', 'const c = 2'].join('\n')

/** replace 行的词级标记（唯一一处会触发 diffWordsWithSpace 的行） */
function replaceSegments(data: { pairedLines: { left: { wordDiffSegments?: unknown } }[] }) {
  return data.pairedLines[2]?.left.wordDiffSegments
}

describe('useDiffViewerData 的行级 diff 复用', () => {
  beforeEach(() => {
    calls.diffLines = 0
    calls.diffWordsWithSpace = 0
  })

  it('单次渲染只做一次行级 diff（抽取前 paired/unified 各一次 = 2）', () => {
    const { result } = renderHook(() => useDiffViewerData(before, after))

    expect(calls.diffLines).toBe(1)
    // 真实库计算：两侧结果都在，且 replace 行同时带左右词级标记
    expect(result.current.pairedLines).toHaveLength(3)
    expect(result.current.unifiedLines.map(line => line.type)).toEqual(['context', 'context', 'delete', 'add'])
    expect(replaceSegments(result.current)).toEqual([
      { text: 'const ' },
      { text: 'b', diffType: 'delete' },
      { text: ' = 2' },
    ])
    expect(result.current.pairedLines[2].right.wordDiffSegments).toEqual([
      { text: 'const ' },
      { text: 'c', diffType: 'add' },
      { text: ' = 2' },
    ])
    expect(calls.diffWordsWithSpace).toBe(1)
  })

  it('isResizing 切换不重做行级 diff，只影响词级与 paired 结果', () => {
    const { result, rerender } = renderHook(
      ({ resizing }: { resizing: boolean }) => useDiffViewerData(before, after, 'text', resizing),
      { initialProps: { resizing: false } },
    )

    const unifiedBefore = result.current.unifiedLines
    expect(calls.diffLines).toBe(1)
    expect(calls.diffWordsWithSpace).toBe(1)

    rerender({ resizing: true })

    expect(calls.diffLines).toBe(1) // 行级没有重算
    expect(calls.diffWordsWithSpace).toBe(1) // resize 期间跳过词级
    expect(replaceSegments(result.current)).toBeUndefined()
    expect(result.current.pairedLines[2].left.content).toBe('const b = 2')
    // unified 与行级模型都复用同一份 memo，引用不变
    expect(result.current.unifiedLines).toBe(unifiedBefore)

    rerender({ resizing: false })

    expect(calls.diffLines).toBe(1)
    expect(calls.diffWordsWithSpace).toBe(2) // 结束后补算一次
    expect(replaceSegments(result.current)).toHaveLength(3)
    expect(result.current.unifiedLines).toBe(unifiedBefore)
  })

  it('输入不变的重复渲染不触发任何 diff 计算', () => {
    const { rerender } = renderHook(() => useDiffViewerData(before, after))
    expect(calls.diffLines).toBe(1)

    rerender()
    rerender()

    expect(calls.diffLines).toBe(1)
    expect(calls.diffWordsWithSpace).toBe(1)
  })

  it('before/after 变化时只重算一次行级 diff，并带上新内容', () => {
    const { result, rerender } = renderHook(({ b, a }: { b: string; a: string }) => useDiffViewerData(b, a), {
      initialProps: { b: before, a: after },
    })
    expect(calls.diffLines).toBe(1)

    rerender({ b: before, a: `${after}\nconst d = 4` })
    expect(calls.diffLines).toBe(2)
    expect(result.current.unifiedLines.at(-1)).toMatchObject({
      type: 'add',
      content: 'const d = 4',
      newLineNo: 4,
    })

    rerender({ b: 'const a = 1\nkeep\nconst b = 9', a: after })
    expect(calls.diffLines).toBe(3)
    expect(result.current.pairedLines[2].left.content).toBe('const b = 9')
    expect(result.current.unifiedLines.map(line => [line.type, line.content])).toEqual([
      ['context', 'const a = 1'],
      ['context', 'keep'],
      ['delete', 'const b = 9'],
      ['add', 'const c = 2'],
    ])
  })

  it('enabled=false 时不做任何行级/词级计算', () => {
    const { result } = renderHook(() => useDiffViewerData(before, after, 'text', false, false))

    expect(calls.diffLines).toBe(0)
    expect(calls.diffWordsWithSpace).toBe(0)
    expect(result.current.pairedLines).toEqual([])
    expect(result.current.unifiedLines).toEqual([])
    // 关闭时按空输入算行号宽度（与原实现 enabled ? before : '' 一致）
    const empty = renderHook(() => useDiffViewerData('', '', 'text', false, true))
    expect(result.current.lineNumberWidth).toBe(empty.result.current.lineNumberWidth)
  })

  it('enabled 由 false 转 true 时补做一次行级 diff', () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useDiffViewerData(before, after, 'text', false, enabled),
      { initialProps: { enabled: false } },
    )
    expect(calls.diffLines).toBe(0)

    rerender({ enabled: true })
    expect(calls.diffLines).toBe(1)
  })

  it('CRLF 与单边 diff 在单次行级计算下仍保持原输出', () => {
    const { result } = renderHook(() => useDiffViewerData('a\r\nb\r\n', 'a\r\nc\r\n', 'text', false, true))
    expect(calls.diffLines).toBe(1)
    expect(result.current.pairedLines).toHaveLength(2)
    expect(result.current.unifiedLines.map(line => [line.type, line.content])).toEqual([
      ['context', 'a\r'],
      ['delete', 'b\r'],
      ['add', 'c\r'],
    ])

    calls.diffLines = 0
    const oneSided = renderHook(() => useDiffViewerData('', 'only\nadd', 'text', false, true))
    expect(calls.diffLines).toBe(1)
    expect(oneSided.result.current.pairedLines.every(pair => pair.left.type === 'empty')).toBe(true)
    expect(oneSided.result.current.unifiedLines.map(line => line.type)).toEqual(['add', 'add'])
  })
})
