/**
 * 全局「正在滚动」信号。
 *
 * 用法：document 上一次 capture 阶段的 scroll 监听就够了（见 `attachScrollActivity`），
 * 任何元素滚动都会经过它。滚动期间给 <html> 挂 `data-scroll-active`，
 * 停下 IDLE_MS 后摘掉；CSS 用这个属性把毛玻璃退成实色。
 *
 * 为什么需要：backdrop-filter 元素压在 composited scrolling 的内容上时，
 * Chromium 每帧都要重新渲染背板再模糊一次；它和同层的邻居（Header、输入区 footer、
 * todo 卡片）共享合成层，于是整层被一起重新光栅化，邻居会出现一帧的未完成绘制。
 * 表现出来的就是「滚动时所有叠加层一起闪」。滚动期间索性不用 blur。
 */

const ACTIVE_ATTR = 'data-scroll-active'

/** 最后一次滚动到摘属性的间隔。留够余量，避免惯性滚动末尾来回切。 */
export const SCROLL_IDLE_MS = 220

let lastScrollAt = 0
let frame: number | null = null

function tick(): void {
  frame = null
  if (Date.now() - lastScrollAt < SCROLL_IDLE_MS) {
    frame = window.requestAnimationFrame(tick)
    return
  }
  lastScrollAt = 0
  document.documentElement.removeAttribute(ACTIVE_ATTR)
}

/** 标记「此刻有滚动」。每帧可多次调用，只有第一次会挂属性。 */
export function markScrollActive(): void {
  if (typeof document === 'undefined') return
  const now = Date.now()
  lastScrollAt = now
  if (frame !== null) return
  document.documentElement.setAttribute(ACTIVE_ATTR, '')
  frame = window.requestAnimationFrame(tick)
}

/** 挂全局监听（幂等）。返回卸载函数。 */
export function attachScrollActivity(): () => void {
  if (typeof document === 'undefined') return () => undefined
  const handler = () => markScrollActive()
  document.addEventListener('scroll', handler, { capture: true, passive: true })
  return () => {
    document.removeEventListener('scroll', handler, { capture: true })
    if (frame !== null) {
      window.cancelAnimationFrame(frame)
      frame = null
    }
    lastScrollAt = 0
    document.documentElement.removeAttribute(ACTIVE_ATTR)
  }
}

/** 测试用：清掉内部状态。 */
export function resetScrollActivity(): void {
  if (frame !== null) {
    window.cancelAnimationFrame(frame)
    frame = null
  }
  lastScrollAt = 0
  if (typeof document !== 'undefined') document.documentElement.removeAttribute(ACTIVE_ATTR)
}
