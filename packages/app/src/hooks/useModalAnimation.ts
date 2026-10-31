import { useEffect } from 'react'
import { OVERLAY_MOTION } from '../constants/animation'
import { useBackClose } from './useBackClose'
import { useModalVisibility } from './useModalVisibility'

/**
 * useModalAnimation - modal 打开/关闭动画逻辑
 *
 * 可见性生命周期（rAF 进场、退场等待、减少动态效果）由 useModalVisibility 统一提供，
 * 这里只补 ESC 关闭和系统返回键关闭。
 */
export function useModalAnimation(isOpen: boolean, onClose: () => void, delayMs = OVERLAY_MOTION.durationMs) {
  const { isVisible, shouldRender, reduceMotion } = useModalVisibility(isOpen, delayMs)

  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useBackClose(isOpen, onClose)

  return { isVisible, shouldRender, reduceMotion }
}
