import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { attachScrollActivity, markScrollActive, resetScrollActivity, SCROLL_IDLE_MS } from './scrollActivity'

const ATTR = 'data-scroll-active'

function hasAttr(): boolean {
  return document.documentElement.hasAttribute(ATTR)
}

describe('scrollActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    let frame = 0
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame += 1
      // 用宏任务驱动，配合 advanceTimersByTime 推进
      setTimeout(() => cb(performance.now()), 16)
      return frame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    resetScrollActivity()
  })

  afterEach(() => {
    resetScrollActivity()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('marks the document while scrolling and clears after the idle window', () => {
    markScrollActive()
    expect(hasAttr()).toBe(true)

    // 滚动持续期间（每 16ms 一次）标记必须一直存在
    for (let i = 0; i < 20; i += 1) {
      act(() => void vi.advanceTimersByTime(16))
      markScrollActive()
      expect(hasAttr()).toBe(true)
    }

    // 停止滚动：超过 idle 窗口后摘掉
    act(() => void vi.advanceTimersByTime(SCROLL_IDLE_MS + 64))
    expect(hasAttr()).toBe(false)
  })

  it('does not touch the DOM again for repeated calls in the same frame', () => {
    const setSpy = vi.spyOn(document.documentElement, 'setAttribute')
    markScrollActive()
    markScrollActive()
    markScrollActive()
    expect(setSpy.mock.calls.filter(([name]) => name === ATTR)).toHaveLength(1)
    setSpy.mockRestore()
  })

  it('captures scroll from any element and cleans up on detach', () => {
    const detach = attachScrollActivity()
    const scroller = document.createElement('div')
    document.body.append(scroller)

    scroller.dispatchEvent(new Event('scroll'))
    expect(hasAttr()).toBe(true)

    detach()
    scroller.remove()
    expect(hasAttr()).toBe(false)

    // 卸载后不再响应
    const other = document.createElement('div')
    document.body.append(other)
    other.dispatchEvent(new Event('scroll'))
    expect(hasAttr()).toBe(false)
    other.remove()
  })
})
