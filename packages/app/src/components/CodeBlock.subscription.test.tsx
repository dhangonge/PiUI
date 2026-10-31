import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeBlock } from './CodeBlock'
import { highlightTokensInWorker } from '../lib/shikiWorkerClient'

/**
 * CodeBlock 的主题订阅粒度测试。
 *
 * 这里用一个可写的最小 themeStore 替身（subscribe / getSnapshot / getState），
 * 真的触发订阅通知，而不是断言某个 selector 长什么样：
 * - 无关主题字段变化不能让代码块重渲染；
 * - 换行开关变化要立刻生效；
 * - 代码块主题（子组件 useSyntaxHighlight 自己的订阅键）变化仍要到达 worker。
 *
 * useSyntaxHighlight / useStreamingSyntaxHighlight 用真实实现，只把 worker 客户端换成
 * 立即响应的替身，所以「子组件自己的语法主题订阅」是被真实跑到的。
 */

const themeHarness = vi.hoisted(() => {
  const initial = {
    codeWordWrap: false,
    codeBlockThemeLight: 'github-light-default',
    codeBlockThemeDark: 'github-dark-default',
    presetId: 'pi',
    customCSS: '',
    fontSizeScale: 1,
  }
  let state: Record<string, unknown> = { ...initial }
  const listeners = new Set<() => void>()

  const themeStore = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    getState: () => state,
  }

  return {
    themeStore,
    commit(patch: Record<string, unknown>) {
      state = { ...state, ...patch }
      listeners.forEach(listener => listener())
    },
    reset() {
      state = { ...initial }
    },
    listenerCount() {
      return listeners.size
    },
  }
})

const useInputCapabilitiesMock = vi.fn(() => ({
  canHover: true,
  hasCoarsePointer: false,
  hasTouch: false,
  preferTouchUi: false,
}))
const useInViewMock = vi.fn(() => ({ ref: vi.fn(), inView: false }))

vi.mock('../store/themeStore', () => ({ themeStore: themeHarness.themeStore }))

vi.mock('../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => useInputCapabilitiesMock(),
}))

vi.mock('../hooks/useInView', () => ({
  useInView: () => useInViewMock(),
}))

vi.mock('../lib/shikiWorkerClient', () => ({
  disposeShikiWorkerKey: vi.fn(),
  highlightHtmlInWorker: vi.fn(async ({ text }: { text: string }) => ({ id: 1, html: `<pre>${text}</pre>` })),
  highlightTokensInWorker: vi.fn(async ({ text }: { text: string; theme: string }) => ({
    id: 1,
    code: text,
    tokens: [[{ content: text, color: '#fff' }]],
  })),
}))

vi.mock('./ui', () => ({
  CopyButton: ({ className }: { className?: string }) => (
    <button aria-label="Copy to clipboard" className={className}>
      copy
    </button>
  ),
}))

/** Object.is 之外的主题字段变化用来验证「无关设置不重渲染」 */
const unrelatedThemePatch = { customCSS: '.probe { color: red }', presetId: 'probe', fontSizeScale: 1.25 }

function renderCount() {
  return useInputCapabilitiesMock.mock.calls.length
}

beforeEach(() => {
  themeHarness.reset()
  useInputCapabilitiesMock.mockClear()
  useInputCapabilitiesMock.mockReturnValue({
    canHover: true,
    hasCoarsePointer: false,
    hasTouch: false,
    preferTouchUi: false,
  })
  useInViewMock.mockReset()
  useInViewMock.mockReturnValue({ ref: vi.fn(), inView: false })
  vi.mocked(highlightTokensInWorker).mockClear()
})

describe('CodeBlock 主题订阅粒度', () => {
  it('无关主题设置变化不重渲染代码块', () => {
    const { container } = render(<CodeBlock code="const value = 1" language="ts" />)
    const mountedRenders = renderCount()
    // 组件与子 hook 都在订阅，说明下面的「没重渲染」不是因为通知没发出去
    expect(themeHarness.listenerCount()).toBeGreaterThan(0)

    act(() => themeHarness.commit(unrelatedThemePatch))

    expect(renderCount()).toBe(mountedRenders)
    expect(container.querySelector('pre')).toBeInTheDocument()
  })

  it('换行开关变化仍然更新代码块', () => {
    const { container } = render(<CodeBlock code="const value = 1" language="ts" />)
    const mountedRenders = renderCount()
    expect(container.querySelector('pre')?.className).not.toContain('whitespace-pre-wrap')

    act(() => themeHarness.commit({ codeWordWrap: true }))

    expect(renderCount()).toBeGreaterThan(mountedRenders)
    expect(container.querySelector('pre')?.className).toContain('whitespace-pre-wrap')
    expect(container.querySelector('pre')?.className).toContain('[overflow-wrap:anywhere]')
  })

  it('显式 wordwrap 仍然覆盖主题设置', () => {
    act(() => themeHarness.commit({ codeWordWrap: true }))

    const { container } = render(<CodeBlock code="const value = 1" language="ts" wordwrap={false} />)

    expect(container.querySelector('pre')?.className).not.toContain('whitespace-pre-wrap')
  })

  it('代码块主题变化仍通过语法高亮自己的订阅到达 worker', async () => {
    useInViewMock.mockReturnValue({ ref: vi.fn(), inView: true })

    render(<CodeBlock code="const value = 1" language="ts" />)

    await waitFor(() =>
      expect(highlightTokensInWorker).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'github-light-default', language: 'ts' }),
      ),
    )

    vi.mocked(highlightTokensInWorker).mockClear()
    act(() => themeHarness.commit({ codeBlockThemeLight: 'vitesse-light' }))

    await waitFor(() =>
      expect(highlightTokensInWorker).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'vitesse-light', language: 'ts' }),
      ),
    )
  })
})
