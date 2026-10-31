import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_MOTION } from '../../constants/animation'
import { Dialog } from './Dialog'

// ---------------------------------------------------------------------------
// 可控 matchMedia：减少动态效果要能「初始就有」和「运行中切换」两种验法。
// ---------------------------------------------------------------------------
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const motionListeners = new Set<() => void>()
let reducePref = false
let originalMatchMedia: typeof window.matchMedia | null = null

function installMatchMedia() {
  originalMatchMedia = window.matchMedia
  window.matchMedia = ((query: string) =>
    ({
      matches: query.includes(REDUCE_QUERY) ? reducePref : false,
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'change') motionListeners.add(listener)
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'change') motionListeners.delete(listener)
      },
      addListener: (listener: () => void) => motionListeners.add(listener),
      removeListener: (listener: () => void) => motionListeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList) as typeof window.matchMedia
}

function restoreMatchMedia() {
  if (originalMatchMedia) window.matchMedia = originalMatchMedia
  originalMatchMedia = null
  motionListeners.clear()
  reducePref = false
}

function setReducedMotion(reduced: boolean) {
  reducePref = reduced
  act(() => {
    motionListeners.forEach(listener => listener())
  })
}

/** 推进一帧（rAF 在 jsdom 里被替换成 0ms 定时器，不占用退场计时） */
function advanceFrame() {
  act(() => {
    vi.advanceTimersByTime(0)
  })
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('Dialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 0),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders content and unmounts after close transition', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )

    expect(screen.getByRole('dialog', { name: 'Test Dialog' })).toBeInTheDocument()
    expect(screen.getByText('Test Dialog')).toBeInTheDocument()
    expect(screen.getByText('dialog body')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(
      <Dialog isOpen={false} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )

    act(() => {
      vi.advanceTimersByTime(199)
    })
    expect(screen.getByText('dialog body')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('dialog body')).not.toBeInTheDocument()
  })

  it('can close from touch backdrop when enabled', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog" allowTouchBackdropClose>
        <div>dialog body</div>
      </Dialog>,
    )

    const backdrop = screen.getByRole('dialog').parentElement
    expect(backdrop).not.toBeNull()

    fireEvent.pointerDown(backdrop as HTMLElement, { pointerType: 'touch' })
    fireEvent.click(backdrop as HTMLElement)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog when it opens', async () => {
    function Harness() {
      const [isOpen, setIsOpen] = useState(true)

      return (
        <>
          <button id="dialog-trigger" type="button">
            Open dialog
          </button>
          <Dialog isOpen={isOpen} onClose={() => setIsOpen(false)} title="Test Dialog">
            <button type="button">Inner action</button>
          </Dialog>
        </>
      )
    }

    render(<Harness />)

    const trigger = screen.getByRole('button', { name: 'Open dialog' })
    trigger.focus()

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })
  })

  it('uses aria-label for rawContent dialogs', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} ariaLabel="Settings" rawContent showCloseButton={false}>
        <div>settings body</div>
      </Dialog>,
    )

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  })

  it('traps focus using enabled roving-tabindex controls only', async () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} ariaLabel="Settings" rawContent showCloseButton={false}>
        <button type="button">First</button>
        <button type="button" tabIndex={-1}>
          Inactive tab
        </button>
        <button type="button">Last</button>
        <button type="button" disabled>
          Disabled action
        </button>
      </Dialog>,
    )

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first).toHaveFocus()
  })

  it('does not steal focus back when another dialog opens during close', async () => {
    function Harness() {
      const [isFirstOpen, setIsFirstOpen] = useState(true)
      const [isSecondOpen, setIsSecondOpen] = useState(false)

      return (
        <>
          <button id="first-trigger" type="button">
            First trigger
          </button>
          <Dialog
            isOpen={isFirstOpen}
            onClose={() => {
              setIsFirstOpen(false)
              setIsSecondOpen(true)
            }}
            title="First Dialog"
          >
            <button type="button">First action</button>
          </Dialog>
          <Dialog isOpen={isSecondOpen} onClose={() => setIsSecondOpen(false)} title="Second Dialog">
            <button type="button">Second action</button>
          </Dialog>
        </>
      )
    }

    render(<Harness />)

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(screen.getByRole('dialog', { name: 'Second Dialog' })).toBeInTheDocument()
    expect(document.getElementById('first-trigger')).not.toHaveFocus()
  })

  it('only closes the topmost dialog on Escape when dialogs are stacked', () => {
    const firstClose = vi.fn()
    const secondClose = vi.fn()

    render(
      <>
        <Dialog isOpen={true} onClose={firstClose} title="First Dialog">
          <button type="button">First action</button>
        </Dialog>
        <Dialog isOpen={true} onClose={secondClose} title="Second Dialog">
          <button type="button">Second action</button>
        </Dialog>
      </>,
    )

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(firstClose).not.toHaveBeenCalled()
  })

  it('内侧对话框关闭后焦点落在外层对话框里，而不是页面背景', async () => {
    function Harness() {
      const [innerOpen, setInnerOpen] = useState(true)

      return (
        <>
          <button id="page-button" type="button">
            Page button
          </button>
          <Dialog isOpen={true} onClose={() => {}} title="Outer Dialog">
            <button type="button">Outer action</button>
          </Dialog>
          <Dialog isOpen={innerOpen} onClose={() => setInnerOpen(false)} title="Inner Dialog">
            <button type="button">Inner action</button>
          </Dialog>
        </>
      )
    }

    render(<Harness />)

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    // 外层先开，内层后开，ESC 归最上层
    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    const outer = screen.getByRole('dialog', { name: 'Outer Dialog' })
    expect(outer).toContainElement(document.activeElement as HTMLElement)
  })

  // -------------------------------------------------------------------------
  // 动效：只列显式属性、首帧隐藏、减少动态效果（初始 + 运行中）
  // -------------------------------------------------------------------------

  it('面板过渡只列 opacity / transform，不再用 transition-all', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )

    const panel = screen.getByRole('dialog')
    expect(panel).not.toHaveClass('transition-all')
    expect(panel.className).not.toContain('transition-all')

    const transition = panel.style.transition
    expect(transition).toBe(
      `opacity ${OVERLAY_MOTION.durationMs}ms ease-out, transform ${OVERLAY_MOTION.durationMs}ms ease-out`,
    )
    // 没有 all / 布局属性，只有会重合成的两个
    expect(transition).not.toContain('all')
    expect(transition).not.toContain('width')
    expect(transition).not.toContain('background')
  })

  it('进场先在隐藏态落一帧，下一帧才到静止态', () => {
    render(
      <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )

    const panel = screen.getByRole('dialog')
    expect(panel.style.opacity).toBe('0')
    expect(panel.style.transform).toBe('scale(0.95) translateY(8px)')

    advanceFrame()
    expect(panel.style.opacity).toBe('1')
    expect(panel.style.transform).toBe('scale(1) translateY(0px)')
  })

  it('减少动态效果：去掉自动位移 / 缩放，保留一截更短的 opacity 淡出', () => {
    installMatchMedia()
    try {
      reducePref = true
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          <div>dialog body</div>
        </Dialog>,
      )

      const panel = screen.getByRole('dialog')
      expect(panel.style.transform).toBe('none')

      advanceFrame()
      expect(panel.style.opacity).toBe('1')
      expect(panel.style.transform).toBe('none')
      expect(panel.style.transition).toBe(`opacity ${OVERLAY_MOTION.reducedDurationMs}ms ease-out`)
    } finally {
      restoreMatchMedia()
    }
  })

  it('运行中切换减少动态效果即时生效，且不重挂面板', () => {
    installMatchMedia()
    try {
      render(
        <Dialog isOpen={true} onClose={vi.fn()} title="Test Dialog">
          <div>dialog body</div>
        </Dialog>,
      )
      advanceFrame()

      const panel = screen.getByRole('dialog')
      expect(panel.style.transform).toBe('scale(1) translateY(0px)')

      setReducedMotion(true)
      expect(screen.getByRole('dialog')).toBe(panel)
      expect(panel.style.transform).toBe('none')
      expect(panel.style.opacity).toBe('1')
      expect(panel.style.transition).toBe(`opacity ${OVERLAY_MOTION.reducedDurationMs}ms ease-out`)

      setReducedMotion(false)
      expect(panel.style.transform).toBe('scale(1) translateY(0px)')
      expect(panel.style.transition).toBe(
        `opacity ${OVERLAY_MOTION.durationMs}ms ease-out, transform ${OVERLAY_MOTION.durationMs}ms ease-out`,
      )
    } finally {
      restoreMatchMedia()
    }
  })

  it('关闭中重开不重挂面板，也不被待执行的隐藏帧写回', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advanceFrame()
    const panel = screen.getByRole('dialog')

    rerender(
      <Dialog isOpen={false} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advance(100)
    // 退场窗口内：还没卸载，目标已切到隐藏
    expect(screen.getByRole('dialog')).toBe(panel)
    expect(panel.style.opacity).toBe('0')

    rerender(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advanceFrame()
    expect(screen.getByRole('dialog')).toBe(panel)
    expect(panel.style.opacity).toBe('1')

    // 原来的退场定时器不会在 200ms 后把节点卸掉
    advance(OVERLAY_MOTION.durationMs)
    expect(screen.getByText('dialog body')).toBeInTheDocument()
  })

  it('卸载时取消待执行的帧，并摘掉键盘监听', () => {
    const onClose = vi.fn()
    const frameSpy = vi.spyOn(window, 'requestAnimationFrame')
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const { unmount } = render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    // 首帧的进场帧还没执行
    const pendingFrameId = frameSpy.mock.results.at(-1)?.value
    expect(pendingFrameId).toBeDefined()

    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(pendingFrameId)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('关闭后焦点回到打开它的元素', async () => {
    function Harness() {
      const [isOpen, setIsOpen] = useState(false)

      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>
            Open dialog
          </button>
          <Dialog isOpen={isOpen} onClose={() => setIsOpen(false)} title="Test Dialog">
            <button type="button">Inner action</button>
          </Dialog>
        </>
      )
    }

    render(<Harness />)

    const opener = screen.getByRole('button', { name: 'Open dialog' })
    opener.focus()
    fireEvent.click(opener)

    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {
      vi.runAllTimers()
      await Promise.resolve()
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('打开期间切到减少动态效果 / 父级重渲染，不会把 opener 覆盖成面板内焦点', async () => {
    installMatchMedia()
    try {
      function Harness() {
        const [isOpen, setIsOpen] = useState(false)

        return (
          <>
            <button type="button" onClick={() => setIsOpen(true)}>
              Open dialog
            </button>
            <Dialog isOpen={isOpen} onClose={() => setIsOpen(false)} title="Test Dialog">
              <button type="button">Inner action</button>
            </Dialog>
          </>
        )
      }

      const { rerender } = render(<Harness />)

      const opener = screen.getByRole('button', { name: 'Open dialog' })
      opener.focus()
      fireEvent.click(opener)

      await act(async () => {
        vi.runAllTimers()
        await Promise.resolve()
      })
      const panel = screen.getByRole('dialog')
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

      // 偏好切换重渲染同一实例；onClose 是内联箭头，父级重渲染会换引用。
      // 两者都不能让捕获 opener 的副作用重跑（此时焦点已在面板内）。
      setReducedMotion(true)
      rerender(<Harness />)
      expect(screen.getByRole('dialog')).toBe(panel)
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()

      fireEvent.keyDown(document, { key: 'Escape' })
      await act(async () => {
        vi.runAllTimers()
        await Promise.resolve()
      })

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    } finally {
      restoreMatchMedia()
    }
  })

  // -------------------------------------------------------------------------
  // 触摸手势：背景默认不关、只有拖拽条起手、纵向优先、>100px 才关
  // -------------------------------------------------------------------------

  it('触摸设备点击背景默认不关闭，鼠标点击仍然关闭', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )

    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement

    fireEvent.pointerDown(backdrop, { pointerType: 'touch' })
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.pointerDown(backdrop, { pointerType: 'mouse' })
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('下滑关闭只认拖拽条起手，内容区滑动不关闭', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advanceFrame()

    const panel = screen.getByRole('dialog')
    const content = screen.getByText('dialog body')

    fireEvent.touchStart(content, { touches: [{ clientY: 100, clientX: 50 }] })
    fireEvent.touchMove(content, { touches: [{ clientY: 260, clientX: 50 }] })
    fireEvent.touchEnd(content)

    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('scale(1) translateY(0px)')
  })

  it('拖拽条下滑：超过 10px 才跟手，未到 100px 松手不关闭', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advanceFrame()

    const panel = screen.getByRole('dialog')
    const handle = panel.firstElementChild as HTMLElement

    fireEvent.touchStart(handle, { touches: [{ clientY: 100, clientX: 50 }] })
    fireEvent.touchMove(handle, { touches: [{ clientY: 106, clientX: 50 }] })
    // 未过 10px：不进入拖拽，保持过渡
    expect(panel.style.transform).toBe('scale(1) translateY(0px)')
    expect(panel.style.transition).not.toBe('none')

    fireEvent.touchMove(handle, { touches: [{ clientY: 160, clientX: 50 }] })
    expect(panel.style.transform).toBe('scale(1) translateY(60px)')
    // 拖拽期间关掉过渡，位移跟手
    expect(panel.style.transition).toBe('none')

    fireEvent.touchEnd(handle)
    expect(onClose).not.toHaveBeenCalled()
    expect(panel.style.transform).toBe('scale(1) translateY(0px)')
    expect(panel.style.transition).toBe(
      `opacity ${OVERLAY_MOTION.durationMs}ms ease-out, transform ${OVERLAY_MOTION.durationMs}ms ease-out`,
    )
  })

  it('拖拽条下滑超过 100px 才关闭，横向为主时不识别', () => {
    const onClose = vi.fn()
    render(
      <Dialog isOpen={true} onClose={onClose} title="Test Dialog">
        <div>dialog body</div>
      </Dialog>,
    )
    advanceFrame()

    const panel = screen.getByRole('dialog')
    const handle = panel.firstElementChild as HTMLElement

    // 纵向 40 / 横向 200：纵向不占优，不识别为下滑
    fireEvent.touchStart(handle, { touches: [{ clientY: 100, clientX: 50 }] })
    fireEvent.touchMove(handle, { touches: [{ clientY: 140, clientX: 250 }] })
    fireEvent.touchEnd(handle)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.touchStart(handle, { touches: [{ clientY: 100, clientX: 50 }] })
    fireEvent.touchMove(handle, { touches: [{ clientY: 210, clientX: 50 }] })
    fireEvent.touchEnd(handle)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
