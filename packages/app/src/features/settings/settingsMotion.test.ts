import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOTION_EASE_OUT } from '../../constants/animation'
import {
  SETTINGS_COLOR_TRANSITION_CLASS,
  SETTINGS_DISCLOSURE_MS,
  SETTINGS_DISCLOSURE_PANEL_CLASS,
  SETTINGS_EASE_OUT,
  SETTINGS_MOVE_MS,
  SETTINGS_MOVE_TRANSITION_CLASS,
  SETTINGS_STATE_MS,
  SETTINGS_TAB_FEEDBACK_FROM_OPACITY,
  SETTINGS_TAB_FEEDBACK_MS,
  useSettingsTabFade,
} from './settingsMotion'

/**
 * 可控的 matchMedia 替身：真机上减少动态效果会随系统开关变化，
 * 这里必须能触发 'change' 让 useSyncExternalStore 重读快照。
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

interface FakeAnimation {
  animation: Animation
  cancel: ReturnType<typeof vi.fn>
  finishPlayback: () => void
}

/**
 * WAAPI 替身：只记录调用与取消，不产生任何真实帧。
 * 本文件断言的是属性、时长、缓动与取消语义；流畅度不能在这里声称。
 */
function createFakeAnimation(): FakeAnimation {
  let rejectFinished: (reason: unknown) => void = () => {}
  const finished = new Promise<Animation>((_resolve, reject) => {
    rejectFinished = reject
  })
  const fake = {
    playState: 'running' as AnimationPlayState,
    onfinish: null as null | (() => void),
    finished,
    cancel: vi.fn(() => {
      fake.playState = 'idle'
      rejectFinished(new Error('cancelled'))
    }),
  }
  return {
    animation: fake as unknown as Animation,
    cancel: fake.cancel,
    finishPlayback: () => {
      fake.playState = 'finished'
      fake.onfinish?.()
    },
  }
}

interface AnimateCall {
  self: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions | undefined
  fake: FakeAnimation
}

function installAnimate(element: HTMLElement): AnimateCall[] {
  const calls: AnimateCall[] = []
  const animate = function (this: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions): Animation {
    const fake = createFakeAnimation()
    calls.push({ self: this, keyframes, options, fake })
    return fake.animation
  }
  element.animate = animate as unknown as Element['animate']
  return calls
}

function createPanel(): HTMLElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

describe('settings motion spec', () => {
  it('keeps the Tailwind literals aligned with the shared easing token', () => {
    const easing = `ease-[cubic-bezier(${MOTION_EASE_OUT.join(',')})]`

    expect(SETTINGS_EASE_OUT).toBe('cubic-bezier(0.23,1,0.32,1)')
    expect(SETTINGS_STATE_MS).toBe(150)
    expect(SETTINGS_MOVE_MS).toBe(200)
    expect(SETTINGS_DISCLOSURE_MS).toBe(SETTINGS_MOVE_MS)
    expect(SETTINGS_TAB_FEEDBACK_MS).toBe(160)

    for (const className of [
      SETTINGS_COLOR_TRANSITION_CLASS,
      SETTINGS_MOVE_TRANSITION_CLASS,
      SETTINGS_DISCLOSURE_PANEL_CLASS,
    ]) {
      expect(className).toContain(easing)
      expect(className).not.toContain('transition-all')
    }

    expect(SETTINGS_COLOR_TRANSITION_CLASS).toContain(`duration-[${SETTINGS_STATE_MS}ms]`)
    expect(SETTINGS_COLOR_TRANSITION_CLASS).toContain('background-color')
    expect(SETTINGS_COLOR_TRANSITION_CLASS).not.toContain('motion-reduce')
    // 焦点环 / hover ring 是 box-shadow：即时到位，不做补间
    expect(SETTINGS_COLOR_TRANSITION_CLASS).not.toContain('box-shadow')

    // 位移类反馈在减少动态效果下即时到位
    expect(SETTINGS_MOVE_TRANSITION_CLASS).toContain('transition-transform')
    expect(SETTINGS_MOVE_TRANSITION_CLASS).toContain(`duration-[${SETTINGS_MOVE_MS}ms]`)
    expect(SETTINGS_MOVE_TRANSITION_CLASS).toContain('motion-reduce:transition-none')

    // 披露块保留真实布局高度，不用 scale 顶替
    expect(SETTINGS_DISCLOSURE_PANEL_CLASS).toContain('grid')
    expect(SETTINGS_DISCLOSURE_PANEL_CLASS).toContain('transition-[grid-template-rows]')
    expect(SETTINGS_DISCLOSURE_PANEL_CLASS).toContain(`duration-[${SETTINGS_DISCLOSURE_MS}ms]`)
    expect(SETTINGS_DISCLOSURE_PANEL_CLASS).toContain('motion-reduce:transition-none')
  })
})

describe('useSettingsTabFade', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(() => {
    reduceMotion = false
    changeListeners.clear()
    installMatchMedia()
  })

  afterEach(() => {
    changeListeners.clear()
    document.body.innerHTML = ''
    window.matchMedia = originalMatchMedia
  })

  it('fades the existing panel with the named duration, curve and properties', () => {
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())

    expect(calls).toHaveLength(1)
    expect(calls[0].self).toBe(panel)
    expect(calls[0].keyframes).toEqual([{ opacity: SETTINGS_TAB_FEEDBACK_FROM_OPACITY }, { opacity: 1 }])
    expect(calls[0].options).toEqual({ duration: SETTINGS_TAB_FEEDBACK_MS, easing: SETTINGS_EASE_OUT })
    // 只碰 opacity，不写布局、不留内联样式让内容停在中途
    expect(panel.style.opacity).toBe('')
    expect(panel.getAttribute('style')).toBeNull()
  })

  it('cancels the previous fade when tabs are switched quickly', () => {
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())
    act(() => result.current.flashTabContent())

    expect(calls).toHaveLength(2)
    expect(calls[0].fake.cancel).toHaveBeenCalledTimes(1)
    expect(calls[1].fake.cancel).not.toHaveBeenCalled()
  })

  it('does not keep cancelling an animation that already finished', () => {
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())
    act(() => calls[0].fake.finishPlayback())
    act(() => result.current.flashTabContent())

    expect(calls[0].fake.cancel).not.toHaveBeenCalled()
    expect(calls).toHaveLength(2)
  })

  it('skips the fade when the panel is not mounted yet', () => {
    const calls = installAnimate(createPanel())
    const { result } = renderHook(() => useSettingsTabFade({ current: null }))

    expect(() => act(() => result.current.flashTabContent())).not.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('shows the content as-is when the WebView has no WAAPI', () => {
    const panel = createPanel()
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    expect(panel.animate).toBeUndefined()
    expect(() => act(() => result.current.flashTabContent())).not.toThrow()
    expect(panel.getAttribute('style')).toBeNull()
  })

  it('never animates when reduced motion is already on', () => {
    reduceMotion = true
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())

    expect(calls).toHaveLength(0)
  })

  it('cancels a running fade the moment reduced motion turns on', () => {
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())
    setReducedMotion(true)
    expect(calls[0].fake.cancel).toHaveBeenCalledTimes(1)

    // 之后的切换不再起动画
    act(() => result.current.flashTabContent())
    expect(calls).toHaveLength(1)
  })

  it('cancels the fade on unmount', () => {
    const panel = createPanel()
    const calls = installAnimate(panel)
    const { result, unmount } = renderHook(() => useSettingsTabFade({ current: panel }))

    act(() => result.current.flashTabContent())
    unmount()

    expect(calls[0].fake.cancel).toHaveBeenCalledTimes(1)
  })
})
