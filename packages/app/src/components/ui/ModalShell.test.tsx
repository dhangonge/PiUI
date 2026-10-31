import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_MOTION } from '../../constants/animation'
import { ModalShell } from './ModalShell'

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)'
const motionListeners = new Set<() => void>()
let reducePref = false
let originalMatchMedia: typeof window.matchMedia

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

function setReducedMotion(reduced: boolean) {
  reducePref = reduced
  act(() => {
    motionListeners.forEach(listener => listener())
  })
}

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

function renderShell(isOpen: boolean, onClose: () => void = vi.fn()) {
  return render(
    <ModalShell isOpen={isOpen} onClose={onClose}>
      <div data-testid="shell-content">shell body</div>
    </ModalShell>,
  )
}

describe('ModalShell', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb =>
      window.setTimeout(() => cb(performance.now()), 0),
    )
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
      clearTimeout(id)
    })
    reducePref = false
    motionListeners.clear()
    installMatchMedia()
  })

  afterEach(() => {
    window.matchMedia = originalMatchMedia
    motionListeners.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('把内容渲染到 body 下的模态层', () => {
    renderShell(true)

    const shell = screen.getByRole('dialog')
    expect(shell).toHaveAttribute('aria-modal', 'true')
    expect(shell.parentElement).toBe(document.body)
    expect(screen.getByTestId('shell-content')).toBeInTheDocument()
  })

  it('只过渡 opacity：不给自己挂 transform，避免玻璃层祖先采样错位', () => {
    renderShell(true)
    advanceFrame()

    const shell = screen.getByRole('dialog')
    expect(shell.style.opacity).toBe('1')
    expect(shell.style.transform).toBe('')
    expect(shell.style.transition).toBe(`opacity ${OVERLAY_MOTION.durationMs}ms ease-out`)
    expect(shell.className).not.toContain('transition-all')
  })

  it('退场时先淡出再卸载', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <ModalShell isOpen={true} onClose={onClose}>
        <div>shell body</div>
      </ModalShell>,
    )
    advanceFrame()
    expect(screen.getByRole('dialog').style.opacity).toBe('1')

    rerender(
      <ModalShell isOpen={false} onClose={onClose}>
        <div>shell body</div>
      </ModalShell>,
    )
    advanceFrame()
    expect(screen.getByRole('dialog').style.opacity).toBe('0')

    advance(OVERLAY_MOTION.durationMs - 1)
    expect(screen.queryByRole('dialog')).toBeInTheDocument()

    advance(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('ESC 关闭，卸载后不再响应键盘', () => {
    const onClose = vi.fn()
    const { unmount } = renderShell(true, onClose)
    advanceFrame()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    unmount()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('减少动态效果时只缩短淡出，不引入 transform', () => {
    reducePref = true
    renderShell(true)
    advanceFrame()

    const shell = screen.getByRole('dialog')
    expect(shell.style.transition).toBe(`opacity ${OVERLAY_MOTION.reducedDurationMs}ms ease-out`)
    expect(shell.style.transform).toBe('')
  })

  it('运行中切换偏好会即时改时长，且不重挂节点', () => {
    renderShell(true)
    advanceFrame()

    const shell = screen.getByRole('dialog')
    setReducedMotion(true)

    expect(screen.getByRole('dialog')).toBe(shell)
    expect(shell.style.transition).toBe(`opacity ${OVERLAY_MOTION.reducedDurationMs}ms ease-out`)
    expect(shell.style.opacity).toBe('1')
  })

  it('减少动态效果下退场等待缩短', () => {
    reducePref = true
    const onClose = vi.fn()
    const { rerender } = render(
      <ModalShell isOpen={true} onClose={onClose}>
        <div>shell body</div>
      </ModalShell>,
    )
    advanceFrame()

    rerender(
      <ModalShell isOpen={false} onClose={onClose}>
        <div>shell body</div>
      </ModalShell>,
    )
    advanceFrame()

    const shortenedDelay = OVERLAY_MOTION.reducedDurationMs + OVERLAY_MOTION.reducedExitGuardMs
    advance(shortenedDelay - 1)
    expect(screen.queryByRole('dialog')).toBeInTheDocument()

    advance(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
