/**
 * ModalShell - 全屏层基础设施
 *
 * 职责极简：
 * - Portal 渲染到 body
 * - ESC 关闭
 * - useDelayedRender 控制 mount/unmount
 * - 淡入/淡出动画（仅 opacity）
 *
 * 只动 opacity，不挂 transform：这一层是 .glass 的祖先，
 * 祖先 transform 会让子级 backdrop-filter 采样错位。
 * 全屏层默认使用应用背景；遮罩由 children 自行决定。
 * 容器 fixed inset-0 铺满视口。
 */

import { memo, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { OVERLAY_MOTION } from '../../constants/animation'
import { useModalAnimation } from '../../hooks/useModalAnimation'

interface ModalShellProps {
  isOpen: boolean
  onClose: () => void
  children: ReactNode
  /** z-index，默认 100 */
  zIndex?: number
  /** 外层容器样式，允许调用方限制覆盖范围 */
  style?: CSSProperties
}

export const ModalShell = memo(function ModalShell({
  isOpen,
  onClose,
  children,
  zIndex = 100,
  style,
}: ModalShellProps) {
  const { isVisible, shouldRender, reduceMotion } = useModalAnimation(isOpen, onClose)

  if (!shouldRender) return null

  const fadeMs = reduceMotion ? OVERLAY_MOTION.reducedDurationMs : OVERLAY_MOTION.durationMs

  return createPortal(
    <div
      className="fixed inset-0 flex flex-col bg-bg-100"
      style={{
        zIndex,
        opacity: isVisible ? 1 : 0,
        transition: `opacity ${fadeMs}ms ease-out`,
        ...style,
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="modal-shell-safe-content">{children}</div>
    </div>,
    document.body,
  )
})
