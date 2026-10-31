import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OVERLAY_MOTION } from '../constants/animation'
import { useModalVisibility } from './useModalVisibility'

// ---------------------------------------------------------------------------
// 可控 matchMedia：偏好会随系统设置运行中变化，监听必须能触发重读快照。
// ---------------------------------------------------------------------------
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

describe('useModalVisibility', () => {
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

  it('首帧先停在隐藏态，下一帧才转成可见', () => {
    const { result } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    expect(result.current.shouldRender).toBe(true)
    expect(result.current.isVisible).toBe(false)

    advanceFrame()
    expect(result.current.isVisible).toBe(true)
  })

  it('关闭后仍保留 DOM，满一个常规时长才卸载', () => {
    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    advanceFrame()
    expect(result.current.isVisible).toBe(true)

    rerender({ isOpen: false })
    advanceFrame()
    expect(result.current.isVisible).toBe(false)
    expect(result.current.shouldRender).toBe(true)

    advance(OVERLAY_MOTION.durationMs - 1)
    expect(result.current.shouldRender).toBe(true)

    advance(1)
    expect(result.current.shouldRender).toBe(false)
  })

  it('退场窗口内重开不休眠：节点未卸载且重新可见', () => {
    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    advanceFrame()
    rerender({ isOpen: false })
    advanceFrame()
    advance(100)
    expect(result.current.shouldRender).toBe(true)
    expect(result.current.isVisible).toBe(false)

    rerender({ isOpen: true })
    advanceFrame()
    expect(result.current.isVisible).toBe(true)

    // 原来的退场定时器已经被取消，不会在 200ms 后把节点卸掉
    advance(OVERLAY_MOTION.durationMs)
    expect(result.current.shouldRender).toBe(true)
    expect(result.current.isVisible).toBe(true)
  })

  it('关掉又立刻打开时，待执行的隐藏帧不会把可见状态写回去', () => {
    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    advanceFrame()
    expect(result.current.isVisible).toBe(true)

    rerender({ isOpen: false })
    // 隐藏帧还没跑就重开
    rerender({ isOpen: true })
    advanceFrame()
    expect(result.current.isVisible).toBe(true)
  })

  it('卸载会取消还没执行的帧', () => {
    const frameSpy = vi.spyOn(window, 'requestAnimationFrame')
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame')

    const { unmount } = renderHook(() => useModalVisibility(true))
    const pendingId = frameSpy.mock.results.at(-1)?.value

    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(pendingId)
  })

  it('初始就减少动态效果时不空等：退场等待缩短到淡出时长加余量', () => {
    reducePref = true

    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    expect(result.current.reduceMotion).toBe(true)
    advanceFrame()

    rerender({ isOpen: false })
    advanceFrame()
    expect(result.current.shouldRender).toBe(true)

    const shortenedDelay = OVERLAY_MOTION.reducedDurationMs + OVERLAY_MOTION.reducedExitGuardMs
    expect(shortenedDelay).toBeLessThan(OVERLAY_MOTION.durationMs)

    advance(shortenedDelay - 1)
    expect(result.current.shouldRender).toBe(true)

    advance(1)
    expect(result.current.shouldRender).toBe(false)
  })

  it('运行中切换偏好当帧生效，并改变退场等待', () => {
    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen), {
      initialProps: { isOpen: true },
    })

    advanceFrame()
    expect(result.current.reduceMotion).toBe(false)
    expect(result.current.isVisible).toBe(true)

    setReducedMotion(true)
    expect(result.current.reduceMotion).toBe(true)

    rerender({ isOpen: false })
    advanceFrame()
    advance(OVERLAY_MOTION.reducedDurationMs + OVERLAY_MOTION.reducedExitGuardMs)
    expect(result.current.shouldRender).toBe(false)
  })

  it('尊重调用方传入的常规时长', () => {
    const { result, rerender } = renderHook(({ isOpen }) => useModalVisibility(isOpen, 400), {
      initialProps: { isOpen: true },
    })

    advanceFrame()
    rerender({ isOpen: false })
    advanceFrame()
    advance(399)
    expect(result.current.shouldRender).toBe(true)

    advance(1)
    expect(result.current.shouldRender).toBe(false)
  })
})
