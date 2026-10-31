import { useEffect, useState } from 'react'
import { OVERLAY_MOTION } from '../constants/animation'
import { useDelayedRender } from './useDelayedRender'
import { useReducedMotion } from './useReducedMotion'

export interface ModalVisibilityState {
  /** 进场目标值：驱动面板的 opacity / transform */
  isVisible: boolean
  /** 是否还要渲染 DOM（含退场延迟期） */
  shouldRender: boolean
  /** 系统「减少动态效果」偏好，运行中切换当帧生效 */
  reduceMotion: boolean
}

/**
 * useModalVisibility — 弹层的可见性生命周期（纯状态，不含样式）
 *
 * 只负责三件事，外观留给调用方：
 *   - useDelayedRender 决定 mount / unmount 窗口；退场要等过渡跑完才卸载
 *   - requestAnimationFrame 把进场目标值推到下一帧，让面板先在隐藏态落一次
 *     paint，进场过渡才会真的跑（同帧内改两次只保留最后一次意图）
 *   - 「减少动态效果」时退场不再空等完整时长，只等缩短后的淡出
 *
 * 中断语义：每次依赖变化都先取消上一帧再排新帧，所以上一个待执行帧不可能
 * 把刚 reopen 的弹层又写回隐藏；关闭中重开由 CSS transition 从当前计算值
 * retarget，不跳回起点重播。
 */
export function useModalVisibility(
  isOpen: boolean,
  durationMs: number = OVERLAY_MOTION.durationMs,
): ModalVisibilityState {
  const reduceMotion = useReducedMotion()
  const exitDelayMs = reduceMotion ? OVERLAY_MOTION.reducedDurationMs + OVERLAY_MOTION.reducedExitGuardMs : durationMs
  const shouldRender = useDelayedRender(isOpen, exitDelayMs)
  const [isVisible, setIsVisible] = useState(false)

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsVisible(shouldRender && isOpen)
    })

    // 依赖变化或卸载都取消未执行的帧，不留继续写样式的尾巴
    return () => cancelAnimationFrame(frameId)
  }, [shouldRender, isOpen])

  return { isVisible, shouldRender, reduceMotion }
}
