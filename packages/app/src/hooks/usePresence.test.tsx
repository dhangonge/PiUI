import { StrictMode } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePresence } from './usePresence'

// ---------------------------------------------------------------------------
// jsdom 没有 Web Animations API（Element.prototype.animate 不存在），而
// motion/mini 对 DOM 元素完全走 WAAPI：animate(el, values) 会拆成每个属性
// 一次 element.animate({ [prop]: [from, to] }, timing)。
//
// 所以这里不 mock motion，而是补一个最小但语义真实的 WAAPI 实现：
//  - 按时间推进插值，并把当前值写回内联样式。这等价于浏览器里
//    getComputedStyle 能读到动画当前值、以及 stop() 时 commitStyles 落盘的结果；
//    因此「打断后从当前值继续」「stop 之后残留的内联样式」能被真实断言到，
//    而不是被 mock 抹平成「总是从 from 开始」。
//  - 支持 cancel / commitStyles / finish / playState / finished / onfinish。
//  - 采样固定 16ms 步进，不还原缓动曲线：断言的只是端点与区间，不看曲线形状。
// ---------------------------------------------------------------------------

type FakePlayState = 'idle' | 'running' | 'paused' | 'finished'

const TICK_MS = 16
const NUMBER_RE = /-?\d*\.?\d+/

interface AnimateCall {
  prop: string
  frames: string[]
  durationMs: number
}

const animateCalls: AnimateCall[] = []
const liveAnimations = new Set<FakeAnimation>()
let tickerId: number | null = null

function startTicker() {
  if (tickerId !== null) return
  tickerId = window.setInterval(() => {
    for (const animation of [...liveAnimations]) animation.tick(TICK_MS)
  }, TICK_MS)
}

function stopTickerIfIdle() {
  if (liveAnimations.size > 0 || tickerId === null) return
  window.clearInterval(tickerId)
  tickerId = null
}

function splitNumeric(value: string) {
  const match = NUMBER_RE.exec(value)
  if (!match) return null
  const num = Number(match[0])
  if (!Number.isFinite(num)) return null
  return { prefix: value.slice(0, match.index), num, suffix: value.slice(match.index + match[0].length) }
}

function sampleFrames(frames: string[], progress: number): string {
  const first = frames[0]
  const last = frames[frames.length - 1]
  if (first === undefined || last === undefined) return ''
  if (frames.length < 2) return last

  const a = splitNumeric(first)
  const b = splitNumeric(last)
  // 无法插值（单位/结构不同）时退化成阶跃，避免假装动画成立
  if (!a || !b || a.prefix !== b.prefix || a.suffix !== b.suffix) return last

  const value = a.num + (b.num - a.num) * progress
  return `${a.prefix}${Number(value.toFixed(4))}${a.suffix}`
}

class FakeAnimation {
  readonly prop: string
  readonly element: HTMLElement
  readonly effect: { getComputedTiming: () => { duration: number } }
  readonly finished: Promise<FakeAnimation>
  readonly frames: string[]
  readonly durationMs: number
  readonly delayMs: number
  playState: FakePlayState = 'running'
  playbackRate = 1
  startTime = 0
  currentTime = 0
  onfinish: (() => void) | null = null
  resolveFinished: (animation: FakeAnimation) => void = () => {}

  constructor(element: HTMLElement, prop: string, frames: string[], durationMs: number, delayMs: number) {
    this.element = element
    this.prop = prop
    this.frames = frames
    this.durationMs = durationMs
    this.delayMs = delayMs
    this.effect = { getComputedTiming: () => ({ duration: durationMs }) }
    this.finished = new Promise(resolve => {
      this.resolveFinished = resolve
    })

    // fill: both —— 起点立刻可见
    this.apply(sampleFrames(frames, 0))
    liveAnimations.add(this)
    startTicker()
  }

  private progress(): number {
    if (this.durationMs <= 0) return 1
    const elapsed = (this.currentTime - this.delayMs) / this.durationMs
    return Math.min(1, Math.max(0, elapsed))
  }

  private apply(value: string) {
    if (value === '') return
    this.element.style.setProperty(this.prop, value)
  }

  tick(deltaMs: number) {
    if (this.playState !== 'running') return

    this.currentTime += deltaMs * this.playbackRate
    const total = this.delayMs + this.durationMs

    if (this.currentTime >= total) {
      this.currentTime = total
      this.playState = 'finished'
      this.apply(sampleFrames(this.frames, 1))
      liveAnimations.delete(this)
      stopTickerIfIdle()
      this.onfinish?.()
      this.resolveFinished(this)
      return
    }

    this.apply(sampleFrames(this.frames, this.progress()))
  }

  commitStyles() {
    this.apply(sampleFrames(this.frames, this.playState === 'finished' ? 1 : this.progress()))
  }

  cancel() {
    this.playState = 'idle'
    liveAnimations.delete(this)
    stopTickerIfIdle()
  }

  finish() {
    this.tick(Math.max(0, this.delayMs + this.durationMs - this.currentTime))
  }

  pause() {
    if (this.playState === 'running') this.playState = 'paused'
  }

  play() {
    if (this.playState === 'paused') this.playState = 'running'
  }
}

function installWaapi() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: function (
      this: HTMLElement,
      keyframes: Record<string, unknown>,
      timing?: { duration?: number; delay?: number },
    ) {
      const prop = Object.keys(keyframes).find(
        key => key !== 'offset' && key !== 'easing' && key !== 'composite' && key !== 'pseudoElement',
      )
      if (!prop) throw new Error('unexpected keyframes shape')

      const raw = keyframes[prop]
      const frames = (Array.isArray(raw) ? raw : [raw]).map(value => String(value))
      const durationMs = Number(timing?.duration ?? 0)
      const delayMs = Number(timing?.delay ?? 0)

      animateCalls.push({ prop, frames, durationMs })
      return new FakeAnimation(this, prop, frames, durationMs, delayMs)
    },
  })
}

function lastCall(prop: string): AnimateCall {
  const calls = animateCalls.filter(call => call.prop === prop)
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1]
}

function liveCount(prop: string) {
  return [...liveAnimations].filter(animation => animation.prop === prop).length
}

// ---------------------------------------------------------------------------
// 减少动态效果开关：需要能模拟「初始开启」和「运行中切换」
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 被测组件
// ---------------------------------------------------------------------------

const FROM = { opacity: 0, transform: 'translateY(8px)' }
const TO = { opacity: 1, transform: 'translateY(0px)' }
const DURATION = 0.2
const UNMOUNT_DELAY_MS = DURATION * 1000 + 50

function Probe({ show }: { show: boolean }) {
  const { shouldRender, ref } = usePresence<HTMLDivElement>(show, { from: FROM, to: TO, duration: DURATION })
  if (!shouldRender) return null
  return <div data-testid="probe" ref={ref} />
}

function probe(): HTMLDivElement | null {
  return screen.queryByTestId('probe')
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('usePresence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    reduceMotion = false
    changeListeners.clear()
    animateCalls.length = 0
    liveAnimations.clear()
    if (tickerId !== null) {
      window.clearInterval(tickerId)
      tickerId = null
    }
    installWaapi()
    installMatchMedia()
  })

  afterEach(() => {
    vi.useRealTimers()
    liveAnimations.clear()
    if (tickerId !== null) {
      window.clearInterval(tickerId)
      tickerId = null
    }
    delete (Element.prototype as { animate?: unknown }).animate
  })

  it('入场：先落到 from，再从 from 动画到 to', () => {
    render(<Probe show />)

    const element = probe()
    expect(element).not.toBeNull()
    expect(element!.style.opacity).toBe('0')
    expect(element!.style.transform).toBe('translateY(8px)')

    expect(lastCall('opacity').frames).toEqual(['0', '1'])
    expect(lastCall('transform').frames).toEqual(['translateY(8px)', 'translateY(0px)'])

    advance(DURATION * 1000 + TICK_MS)

    expect(element!.style.opacity).toBe('1')
    expect(element!.style.transform).toBe('translateY(0px)')
    // 动画跑完即从「在跑」集合里移除，没有残留 ticker
    expect(liveCount('opacity')).toBe(0)
    expect(tickerId).toBeNull()
  })

  it('退场：从当前值动画回 from，延迟卸载后才移除 DOM', () => {
    const { rerender } = render(<Probe show />)
    advance(DURATION * 1000 + TICK_MS)

    rerender(<Probe show={false} />)

    // 延迟卸载窗口内 DOM 还在，退场从当前值(1)出发
    expect(probe()).not.toBeNull()
    expect(lastCall('opacity').frames).toEqual(['1', '0'])

    // 退场跑完（多留一个 tick 的余量，采样按 16ms 步进）
    advance(DURATION * 1000 + 2 * TICK_MS)
    expect(probe()!.style.opacity).toBe('0')
    expect(probe()).not.toBeNull()

    advance(UNMOUNT_DELAY_MS - (DURATION * 1000 + 2 * TICK_MS))
    expect(probe()).toBeNull()
  })

  it('关闭中重开：不重置回 from，从被中断的当前值继续', () => {
    const { rerender } = render(<Probe show />)
    advance(100)

    const midEntry = Number(probe()!.style.opacity)
    expect(midEntry).toBeGreaterThan(0.2)
    expect(midEntry).toBeLessThan(0.8)

    rerender(<Probe show={false} />)
    // 退场起点就是被打断时的可见值
    expect(Number(lastCall('opacity').frames[0])).toBeCloseTo(midEntry, 5)

    advance(32)
    const interrupted = Number(probe()!.style.opacity)
    expect(interrupted).toBeLessThan(midEntry)

    rerender(<Probe show />)

    const restart = lastCall('opacity')
    expect(Number(restart.frames[0])).toBeCloseTo(interrupted, 5)
    // 关键回归：没有跳回 from(0) 再重播
    expect(Number(restart.frames[0])).toBeGreaterThan(0.05)
    expect(Number(probe()!.style.opacity)).toBeCloseTo(interrupted, 5)

    advance(DURATION * 1000 + TICK_MS)
    expect(probe()!.style.opacity).toBe('1')
  })

  it('卸载：停掉在跑的动画，之后不再写样式', () => {
    const { unmount } = render(<Probe show />)
    advance(64)

    const element = probe()!
    const frozenStyles = element.style.cssText
    expect(liveCount('opacity')).toBe(1)

    unmount()

    expect(liveCount('opacity')).toBe(0)
    expect(liveCount('transform')).toBe(0)
    expect(tickerId).toBeNull()
    expect(element.style.cssText).toBe(frozenStyles)

    advance(500)
    expect(element.style.cssText).toBe(frozenStyles)
  })

  it('完全卸载后重新打开，重新从 from 入场', () => {
    const { rerender } = render(<Probe show />)
    advance(DURATION * 1000 + TICK_MS)
    rerender(<Probe show={false} />)
    advance(UNMOUNT_DELAY_MS)
    expect(probe()).toBeNull()

    rerender(<Probe show />)

    expect(probe()!.style.opacity).toBe('0')
    expect(lastCall('opacity').frames).toEqual(['0', '1'])
  })

  it('StrictMode 双跑 effect：不叠加动画，最终落到 to', () => {
    render(
      <StrictMode>
        <Probe show />
      </StrictMode>,
    )

    expect(screen.getAllByTestId('probe')).toHaveLength(1)
    expect(liveCount('opacity')).toBe(1)
    expect(liveCount('transform')).toBe(1)

    advance(DURATION * 1000 + TICK_MS)

    expect(probe()!.style.opacity).toBe('1')
    expect(liveCount('opacity')).toBe(0)
  })

  it('减少动态效果初始开启：不跑 JS 动画，直接到 to，关闭立即卸载', () => {
    reduceMotion = true
    const { rerender } = render(<Probe show />)

    expect(animateCalls).toHaveLength(0)
    expect(probe()!.style.opacity).toBe('1')
    expect(probe()!.style.transform).toBe('translateY(0px)')

    rerender(<Probe show={false} />)

    expect(probe()!.style.opacity).toBe('0')
    advance(1)
    expect(probe()).toBeNull()
  })

  it('运行中切到减少动态效果：停掉当前动画直接收敛，退场不等原时长', () => {
    const { rerender } = render(<Probe show />)
    advance(64)

    expect(liveCount('opacity')).toBe(1)

    setReducedMotion(true)

    expect(liveCount('opacity')).toBe(0)
    expect(liveCount('transform')).toBe(0)
    expect(probe()!.style.opacity).toBe('1')
    expect(probe()!.style.transform).toBe('translateY(0px)')

    rerender(<Probe show={false} />)
    expect(probe()!.style.opacity).toBe('0')

    advance(1)
    expect(probe()).toBeNull()
  })

  it('从减少动态效果切回普通模式：已停在 to 时不重播入场', () => {
    reduceMotion = true
    render(<Probe show />)
    expect(animateCalls).toHaveLength(0)

    setReducedMotion(false)

    // 已经在目标状态，不需要再跑一遍 from → to
    expect(animateCalls).toHaveLength(0)
    expect(liveCount('opacity')).toBe(0)
    expect(probe()!.style.opacity).toBe('1')
  })
})
