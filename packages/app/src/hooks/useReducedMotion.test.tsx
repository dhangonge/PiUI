import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useReducedMotion } from './useReducedMotion'

/**
 * 可控的 matchMedia 替身：真机上偏好会随系统设置变化，
 * 所以监听的 'change' 事件必须能触发 useSyncExternalStore 重读快照。
 */
const changeListeners = new Set<() => void>()
let reduceMotion = false

function installMatchMedia() {
  const matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion: reduce') ? reduceMotion : false,
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'change') changeListeners.add(listener)
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'change') changeListeners.delete(listener)
      },
      addListener: (listener: () => void) => changeListeners.add(listener),
      removeListener: (listener: () => void) => changeListeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList

  window.matchMedia = matchMedia as typeof window.matchMedia
}

function setReducedMotion(reduced: boolean) {
  reduceMotion = reduced
  act(() => {
    changeListeners.forEach(listener => listener())
  })
}

describe('useReducedMotion', () => {
  beforeEach(() => {
    reduceMotion = false
    changeListeners.clear()
    installMatchMedia()
  })

  afterEach(() => {
    changeListeners.clear()
  })

  it('默认没有开启减少动态效果', () => {
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)
  })

  it('初始就开启时直接读到 true', () => {
    reduceMotion = true
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(true)
  })

  it('运行中切换偏好会即时生效', () => {
    const { result } = renderHook(() => useReducedMotion())
    expect(result.current).toBe(false)

    setReducedMotion(true)
    expect(result.current).toBe(true)

    setReducedMotion(false)
    expect(result.current).toBe(false)
  })

  it('卸载后不再订阅 matchMedia', () => {
    const { result, unmount } = renderHook(() => useReducedMotion())
    expect(changeListeners.size).toBe(1)

    unmount()
    expect(changeListeners.size).toBe(0)
    expect(result.current).toBe(false)
  })
})
