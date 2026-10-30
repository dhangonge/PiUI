import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useViewportHeight } from './useViewportHeight'

type VisualViewportMock = EventTarget & {
  height: number
  offsetTop: number
}

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')

function installVisualViewportMock({
  innerHeight,
  viewportHeight,
  offsetTop = 0,
}: {
  innerHeight: number
  viewportHeight: number
  offsetTop?: number
}) {
  const viewport = new EventTarget() as VisualViewportMock

  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: innerHeight,
  })
  Object.defineProperty(viewport, 'height', {
    configurable: true,
    value: viewportHeight,
  })
  Object.defineProperty(viewport, 'offsetTop', {
    configurable: true,
    value: offsetTop,
  })
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: viewport,
  })

  return viewport
}

function restoreWindowProperty(name: 'innerHeight' | 'visualViewport', descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor)
  } else {
    Reflect.deleteProperty(window, name)
  }
}

function setInnerHeight(value: number) {
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value,
  })
}

function readRootVar(name: string) {
  return document.documentElement.style.getPropertyValue(name)
}

describe('useViewportHeight', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    restoreWindowProperty('innerHeight', originalInnerHeight)
    restoreWindowProperty('visualViewport', originalVisualViewport)
  })

  it('clears stale keyboard inset after an editable element blurs without a visualViewport resize', () => {
    vi.useFakeTimers()
    installVisualViewportMock({ innerHeight: 800, viewportHeight: 500 })
    const textarea = document.createElement('textarea')
    document.body.append(textarea)

    renderHook(() => useViewportHeight())

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset-bottom')).toBe('300px')

    act(() => {
      textarea.focus()
      textarea.blur()
      vi.runAllTimers()
    })

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset-bottom')).toBe('0px')
  })

  it('keeps the keyboard inset when focus moves between text inputs', () => {
    vi.useFakeTimers()
    installVisualViewportMock({ innerHeight: 800, viewportHeight: 500 })
    const textarea = document.createElement('textarea')
    const input = document.createElement('input')
    document.body.append(textarea, input)

    renderHook(() => useViewportHeight())

    act(() => {
      textarea.focus()
      input.focus()
      vi.runAllTimers()
    })

    expect(document.documentElement.style.getPropertyValue('--keyboard-inset-bottom')).toBe('300px')
  })
})

/**
 * Tauri Android 分支的契约（对 48344fd3 的原实现成立）：
 * 原生 MainActivity 用 setPadding 处理底部（键盘与系统栏取较大值），
 * 并注入 --safe-area-inset-* 全 0。Web 侧只跟踪 --app-height，
 * 不能再叠一层 --keyboard-inset-bottom 或 safe-area padding。
 */
describe('useViewportHeight (Tauri Android)', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('style')
    restoreWindowProperty('innerHeight', originalInnerHeight)
    restoreWindowProperty('visualViewport', originalVisualViewport)
  })

  function renderTauriViewport() {
    document.documentElement.classList.add('tauri-app')
    return renderHook(() => useViewportHeight())
  }

  it('writes only --app-height from window.innerHeight', () => {
    setInnerHeight(915)

    renderTauriViewport()

    expect(readRootVar('--app-height')).toBe('915px')
    expect(readRootVar('--keyboard-inset-bottom')).toBe('')
    expect(readRootVar('--safe-area-inset-bottom')).toBe('')
    // 浏览器分支临时插入的 safe-area probe 不得在 Tauri 分支出现或泄漏。
    expect(document.body.querySelectorAll('div[style*="-9999px"]')).toHaveLength(0)
  })

  it('tracks window resize because the native layer resizes the WebView', () => {
    setInnerHeight(915)
    renderTauriViewport()

    act(() => {
      setInnerHeight(560)
      window.dispatchEvent(new Event('resize'))
    })

    expect(readRootVar('--app-height')).toBe('560px')
  })

  it('never derives a keyboard inset even when visualViewport loses height', () => {
    vi.useFakeTimers()
    const viewport = installVisualViewportMock({ innerHeight: 915, viewportHeight: 615 })

    renderTauriViewport()

    // 键盘高度 300px 远超浏览器分支的 100px 阈值：Tauri 分支必须完全不理会。
    act(() => {
      viewport.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('scroll'))
      document.dispatchEvent(new Event('focusin'))
      vi.runAllTimers()
    })

    expect(readRootVar('--keyboard-inset-bottom')).toBe('')
    expect(readRootVar('--app-height')).toBe('915px')
  })

  it('removes the resize listener on unmount', () => {
    setInnerHeight(915)
    const { unmount } = renderTauriViewport()

    unmount()

    act(() => {
      setInnerHeight(500)
      window.dispatchEvent(new Event('resize'))
    })

    expect(readRootVar('--app-height')).toBe('915px')
  })

  it('leaves the browser keyboard inset path off for Tauri even after a resize', () => {
    const viewport = installVisualViewportMock({ innerHeight: 800, viewportHeight: 500 })

    renderTauriViewport()

    act(() => {
      window.dispatchEvent(new Event('resize'))
      viewport.dispatchEvent(new Event('resize'))
    })

    expect(readRootVar('--keyboard-inset-bottom')).toBe('')
  })
})
