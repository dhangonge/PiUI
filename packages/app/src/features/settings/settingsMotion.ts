import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { MOTION_EASE_OUT } from '../../constants/animation'
import { useReducedMotion } from '../../hooks/useReducedMotion'

/**
 * 设置页动效规格（只属于 settings 模块，不扩共享 token）。
 *
 * 曲线仍取共享的 `MOTION_EASE_OUT`；共享常量与 index.css 由其他工作包独占，
 * 这里只读值。Tailwind 只认静态字面量，所以下面的类字符串必须手写数字，
 * 与 `MOTION_EASE_OUT` 的一致性由 settingsMotion.test.ts 守住。
 *
 * 时长分工：
 *   - 颜色 / 描边 / 文字色：150ms，属于状态反馈，减少动态效果时保留
 *   - 位移类（滑块、箭头、分段指示条、披露行高）：200ms，减少动态效果时归零
 *   - 指针切换 tab 的内容 opacity：160ms，本轮唯一新增动效
 *
 * 焦点环与 hover ring 不列进去：它们是 box-shadow，属于「焦点已到」的即时反馈，
 * 补间反而让键盘用户看到一圈慢慢长出来的描边。
 */
export const SETTINGS_STATE_MS = 150
export const SETTINGS_MOVE_MS = 200
export const SETTINGS_DISCLOSURE_MS = 200
export const SETTINGS_TAB_FEEDBACK_MS = 160

/** 指针切换 tab 时内容从半透明淡回实色（不透明度起点） */
export const SETTINGS_TAB_FEEDBACK_FROM_OPACITY = 0.55

/** JS（WAAPI）用的缓动字符串，与 CSS 侧同一个曲线 */
export const SETTINGS_EASE_OUT = `cubic-bezier(${MOTION_EASE_OUT.join(',')})`

/** 颜色类状态反馈：显式列属性，不用 transition-all，也不带 ring / shadow */
export const SETTINGS_COLOR_TRANSITION_CLASS =
  'transition-[background-color,border-color,color,outline-color] duration-[150ms] ease-[cubic-bezier(0.23,1,0.32,1)]'

/** 位移类反馈：箭头 / 开关滑块 / 分段指示条。减少动态效果即时到位 */
export const SETTINGS_MOVE_TRANSITION_CLASS =
  'transition-transform duration-[200ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none'

/** 披露块：真实布局行高，与箭头同步；减少动态效果即时展开 */
export const SETTINGS_DISCLOSURE_PANEL_CLASS =
  'grid transition-[grid-template-rows] duration-[200ms] ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none'

export interface SettingsTabFade {
  /** 指针切换 tab 后调用：给已存在的 panel 一次 160ms opacity 反馈 */
  flashTabContent: () => void
  /** 取消在跑的反馈（面板卸载 / 偏好切换 / 关闭） */
  cancelTabFeedback: () => void
}

/**
 * 动画是否还在推进。`finished` / `idle` 都是「已结束或已取消」，
 * 这两种状态下元素已经是静止态的实色，不能拿它去续接。
 */
function isRunning(animation: Animation | null): boolean {
  if (!animation) return false
  return animation.playState === 'running' || animation.playState === 'paused'
}

/**
 * 读一次当前可见不透明度。
 * 读不到（老 WebView 返回空串、异常值）时返回 null，由调用方回落到规格起点，
 * 不把一个不可信的值当成真实进度。
 */
function readVisibleOpacity(element: HTMLElement): number | null {
  const raw = window.getComputedStyle(element).opacity
  if (typeof raw !== 'string' || raw === '') return null
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, value))
}

/**
 * useSettingsTabFade — 设置 tab 内容切换的轻量 opacity 反馈。
 *
 * 约定：
 *   - 只动画既有的 tabpanel 元素，不加布局 wrapper、不留两份页面
 *   - 不延迟 setTab / 滚动 / focus：调用方先改状态，这里只负责视觉
 *   - 中断从当前状态继续：上一条还在跑时先读一次当前可见不透明度，再 cancel，
 *     从那个值淡回 1（不跌回起点）；已结束 / 已取消的不算 active，回到规格起点
 *   - 每次点击至多一次样式读，不轮询、不用 rAF 采样
 *   - 不排队：新的一次直接接管上一条
 *   - 运行中打开「减少动态效果」立刻取消，内容直接显示（不读值、不起动画）
 *   - 老 WebView 没有 WAAPI 时直接返回，内容照常显示
 *
 * 注意：本 hook 保证的是属性 / 时长 / 取消语义。jsdom 的 WAAPI 替身不产生真实帧，
 * 流畅度需要在浏览器或真机上验。
 */
export function useSettingsTabFade(panelRef: RefObject<HTMLElement | null>): SettingsTabFade {
  const reducedMotion = useReducedMotion()
  const animationRef = useRef<Animation | null>(null)
  const reducedRef = useRef(reducedMotion)

  const cancelTabFeedback = useCallback(() => {
    animationRef.current?.cancel()
    animationRef.current = null
  }, [])

  // 偏好运行中变化：立即取消，后续切换不再动画
  useEffect(() => {
    reducedRef.current = reducedMotion
    if (reducedMotion) cancelTabFeedback()
  }, [reducedMotion, cancelTabFeedback])

  // 卸载不停掉在跑的动画会留下继续写样式的 ticker
  useEffect(() => cancelTabFeedback, [cancelTabFeedback])

  const flashTabContent = useCallback(() => {
    const element = panelRef.current
    if (!element) return

    // 减少动态效果 / 没有 WAAPI：只需要让内容立刻回到实色，不读值不起动画
    if (reducedRef.current || typeof element.animate !== 'function') {
      cancelTabFeedback()
      return
    }

    // 中断从当前状态继续：先读再 cancel（cancel 会立刻回到静止态，读晚就拿不到进度）。
    // 只在动画真的还在跑时读，已结束 / 已取消的按规格起点重新开始。
    const resumeFrom = isRunning(animationRef.current) ? readVisibleOpacity(element) : null
    cancelTabFeedback()

    const animation = element.animate([{ opacity: resumeFrom ?? SETTINGS_TAB_FEEDBACK_FROM_OPACITY }, { opacity: 1 }], {
      duration: SETTINGS_TAB_FEEDBACK_MS,
      easing: SETTINGS_EASE_OUT,
    })
    animationRef.current = animation
    // 跑完就放手，避免对着已结束的动画反复 cancel
    animation.onfinish = () => {
      if (animationRef.current === animation) animationRef.current = null
    }
    // cancel() 会让 finished 走 reject，先接住，别在控制台留未处理拒绝
    animation.finished.then(undefined, () => {})
  }, [cancelTabFeedback, panelRef])

  return { flashTabContent, cancelTabFeedback }
}
