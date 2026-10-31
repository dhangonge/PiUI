import { useSyncExternalStore } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/**
 * 每次现读 matchMedia，而不是模块级缓存 MediaQueryList：
 * 缓存会把旧的订阅对象钉死，偏好监听和测试替换都会失效。
 */
function readReducedMotion(): boolean {
  if (!hasMatchMedia()) return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => {}

  // Android WebView 基线（Chrome 45+）已支持 addEventListener，不再走 addListener
  const queryList = window.matchMedia(REDUCED_MOTION_QUERY)
  queryList.addEventListener('change', onChange)
  return () => queryList.removeEventListener('change', onChange)
}

/**
 * useReducedMotion — 系统「减少动态效果」偏好
 *
 * 用 useSyncExternalStore 订阅，偏好运行中变化会立刻反映到渲染结果，
 * 不需要在 effect 里补一次 setState（首帧就是正确值）。
 * 不支持的 WebView 视为未开启。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, readReducedMotion, () => false)
}
