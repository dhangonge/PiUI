import { useEffect, useState, useRef, useCallback, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { CloseIcon } from '../Icons'
import { OVERLAY_MOTION } from '../../constants/animation'
import { useBackClose } from '../../hooks/useBackClose'
import { useModalVisibility } from '../../hooks/useModalVisibility'

interface DialogProps {
  isOpen: boolean
  onClose: () => void
  title?: React.ReactNode
  ariaLabel?: string
  children: React.ReactNode
  width?: string | number
  className?: string
  showCloseButton?: boolean
  /** 跳过默认的 header 和 content 包裹，children 直接作为面板内容 */
  rawContent?: boolean
  fullscreen?: boolean
  /** 允许触摸设备点击遮罩关闭，默认关闭以避免误触 */
  allowTouchBackdropClose?: boolean
}

export function Dialog({
  isOpen,
  onClose,
  title,
  ariaLabel,
  children,
  width = 400,
  className = '',
  showCloseButton = true,
  rawContent = false,
  fullscreen = false,
  allowTouchBackdropClose = false,
}: DialogProps) {
  const { t } = useTranslation(['common'])
  // 可见性生命周期（首帧先在隐藏态落一次 paint、退场等过渡、偏好减少动态效果）
  const { isVisible, shouldRender, reduceMotion } = useModalVisibility(isOpen)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const previousFocusedElementRef = useRef<HTMLElement | null>(null)
  const previousFocusedElementIdRef = useRef<string | null>(null)
  const restoreFocusTimerRef = useRef<number | null>(null)
  const handoffFocusTimerRef = useRef<number | null>(null)

  // 拖拽条区域 ref —— 下滑关闭只从这个区域开始
  const dragHandleRef = useRef<HTMLDivElement>(null)

  // 触摸下滑关闭手势（只从拖拽条开始）
  const touchStartY = useRef<number | null>(null)
  const touchStartX = useRef<number | null>(null)
  const dragOffsetY = useRef(0)
  const [dragY, setDragY] = useState(0)
  const isDragging = useRef(false)
  const [isDraggingActive, setIsDraggingActive] = useState(false)

  const focusFirstFocusable = useCallback((container: ParentNode) => {
    const focusable = container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )

    const target = focusable[0] ?? (container instanceof HTMLElement ? container : null)
    target?.focus()
  }, [])

  const getTopOpenDialog = useCallback(
    () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"][data-dialog-open="true"]'),
      ).at(-1),
    [],
  )

  const restorePreviousFocus = useCallback(() => {
    const previousFocusedElement = previousFocusedElementRef.current
    if (previousFocusedElement && document.contains(previousFocusedElement)) {
      previousFocusedElement.focus()
      return
    }

    const previousFocusedElementId = previousFocusedElementIdRef.current
    if (!previousFocusedElementId) return

    const replacement = document.getElementById(previousFocusedElementId)
    replacement?.focus()
  }, [])

  const requestClose = useCallback(() => {
    onClose()
    if (handoffFocusTimerRef.current !== null) {
      clearTimeout(handoffFocusTimerRef.current)
    }
    handoffFocusTimerRef.current = window.setTimeout(() => {
      handoffFocusTimerRef.current = null
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
      const latestDialog = dialogs.at(-1)
      if (latestDialog && latestDialog !== dialogRef.current) {
        focusFirstFocusable(latestDialog)
      }
    }, 0)
    if (restoreFocusTimerRef.current !== null) {
      clearTimeout(restoreFocusTimerRef.current)
    }
    restoreFocusTimerRef.current = window.setTimeout(() => {
      restoreFocusTimerRef.current = null
      const activeDialog = getTopOpenDialog()
      if (activeDialog) {
        if (activeDialog.contains(previousFocusedElementRef.current)) {
          restorePreviousFocus()
        } else {
          focusFirstFocusable(activeDialog)
        }
        return
      }
      restorePreviousFocus()
    }, 200)
  }, [onClose, restorePreviousFocus, focusFirstFocusable, getTopOpenDialog])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // 只有从拖拽条区域开始的触摸才能触发下滑关闭
    const handle = dragHandleRef.current
    if (!handle || !handle.contains(e.target as Node)) return

    touchStartY.current = e.touches[0].clientY
    touchStartX.current = e.touches[0].clientX
    dragOffsetY.current = 0
    isDragging.current = false
    setIsDraggingActive(false)
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartY.current === null || touchStartX.current === null) return

    const deltaY = e.touches[0].clientY - touchStartY.current
    const deltaX = Math.abs(e.touches[0].clientX - touchStartX.current)

    // 只在向下拖且垂直方向为主时触发
    if (deltaY > 10 && deltaY > deltaX) {
      isDragging.current = true
      setIsDraggingActive(true)
      dragOffsetY.current = deltaY
      setDragY(deltaY)
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (isDragging.current && dragOffsetY.current > 100) {
      // 下滑超过 100px，关闭
      requestClose()
    }
    touchStartY.current = null
    touchStartX.current = null
    dragOffsetY.current = 0
    isDragging.current = false
    setIsDraggingActive(false)
    setDragY(0)
  }, [requestClose])

  // 防止背景误触：
  // 1. 只有 pointerdown 和 click 都发生在背景上才关闭
  // 2. 触摸设备上不通过背景关闭（避免滚动/滑动时误触）
  const mouseDownOnBackdrop = useRef(false)
  const handleBackdropPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'touch' && !allowTouchBackdropClose) return
      mouseDownOnBackdrop.current = e.target === e.currentTarget
    },
    [allowTouchBackdropClose],
  )
  const handleBackdropClick = useCallback(
    (_e: React.MouseEvent) => {
      if (mouseDownOnBackdrop.current) {
        requestClose()
      }
      mouseDownOnBackdrop.current = false
    },
    [requestClose],
  )

  const focusDialogContent = useCallback(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (dialog.contains(document.activeElement) && document.activeElement !== dialog) return
    focusFirstFocusable(dialog)
  }, [focusFirstFocusable])

  // Focus trap
  const handleFocusTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return

    const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (e.shiftKey) {
      if (document.activeElement === first || !dialogRef.current.contains(document.activeElement)) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last || !dialogRef.current.contains(document.activeElement)) {
        e.preventDefault()
        first.focus()
      }
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return

    if (restoreFocusTimerRef.current !== null) {
      clearTimeout(restoreFocusTimerRef.current)
      restoreFocusTimerRef.current = null
    }

    // 只在「开」的那一次抓 opener：这个 effect 的依赖只有 isOpen。
    // 打开期间父级重渲染（onClose 通常是内联箭头）或系统切换「减少动态效果」
    // 都会让组件重渲染，若把捕获挂在每次渲染上，会把面板内的当前焦点
    // 误记成 opener，关闭后焦点就回不去了。
    const activeElement = document.activeElement
    // 快速关→开时面板还没卸载、焦点仍在面板内：保留上一次抓到的真正 opener。
    if (activeElement instanceof HTMLElement && dialogRef.current?.contains(activeElement)) return

    previousFocusedElementRef.current = activeElement instanceof HTMLElement ? activeElement : null
    previousFocusedElementIdRef.current = previousFocusedElementRef.current?.id || null
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const topDialog = getTopOpenDialog()
      if (topDialog && topDialog !== dialogRef.current) return

      if (e.key === 'Escape') {
        requestClose()
        return
      }
      handleFocusTrap(e)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, requestClose, handleFocusTrap, getTopOpenDialog])

  useBackClose(isOpen, requestClose)

  useEffect(() => {
    if (!isOpen || !isVisible) return

    focusDialogContent()
  }, [isOpen, isVisible, focusDialogContent])

  useEffect(() => {
    if (isOpen || shouldRender) return

    const timerId = window.setTimeout(() => {
      const activeDialog = getTopOpenDialog()
      if (activeDialog) {
        if (activeDialog.contains(previousFocusedElementRef.current)) {
          restorePreviousFocus()
        } else {
          focusFirstFocusable(activeDialog)
        }
        return
      }
      restorePreviousFocus()
    }, 0)

    return () => clearTimeout(timerId)
  }, [isOpen, shouldRender, restorePreviousFocus, focusFirstFocusable, getTopOpenDialog])

  useEffect(() => {
    return () => {
      if (restoreFocusTimerRef.current !== null) {
        clearTimeout(restoreFocusTimerRef.current)
      }
      if (handoffFocusTimerRef.current !== null) {
        clearTimeout(handoffFocusTimerRef.current)
      }
    }
  }, [])

  if (!shouldRender) return null

  // 只列真正会变的属性：transition-all 会把布局属性也带进去。
  // 拖拽期间必须没有过渡，否则手指位移会被缓动拖慢。
  const panelTransition = isDraggingActive
    ? 'none'
    : reduceMotion
      ? `opacity ${OVERLAY_MOTION.reducedDurationMs}ms ease-out`
      : `opacity ${OVERLAY_MOTION.durationMs}ms ease-out, transform ${OVERLAY_MOTION.durationMs}ms ease-out`

  // 减少动态效果时去掉自动位移 / 缩放；拖拽位移是手势直驱，保留。
  const hiddenTransform = reduceMotion ? 'none' : 'scale(0.95) translateY(8px)'
  const shownTransform = reduceMotion
    ? dragY > 0
      ? `translateY(${dragY}px)`
      : 'none'
    : `scale(1) translateY(${dragY}px)`

  return createPortal(
    <div
      className="fixed inset-0 z-[300]"
      style={{
        backgroundColor: isVisible ? 'hsl(var(--always-black) / 0.2)' : 'hsl(var(--always-black) / 0)',
        transition: 'background-color 150ms ease-out',
      }}
      onPointerDown={handleBackdropPointerDown}
      onClick={handleBackdropClick}
    >
      <div
        className="dialog-safe-region absolute inset-x-0 bottom-0 flex items-center justify-center p-4"
        style={
          fullscreen
            ? {
                paddingTop: 0,
                paddingLeft: 'var(--safe-area-inset-left, 0px)',
                paddingRight: 'var(--safe-area-inset-right, 0px)',
                paddingBottom: 'var(--safe-area-inset-bottom, 0px)',
              }
            : undefined
        }
        onPointerDown={e => {
          handleBackdropPointerDown(e)
          e.stopPropagation()
        }}
        onClick={e => {
          handleBackdropClick(e)
          e.stopPropagation()
        }}
      >
        {/* Dialog Panel */}
        <div
          ref={dialogRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className={`
            relative glass border border-border-200/60 rounded-xl shadow-lg 
            flex flex-col overflow-hidden
            ${fullscreen ? '!rounded-none' : ''} ${className}
          `}
          style={{
            width: fullscreen ? '100%' : typeof width === 'number' ? `${width}px` : width,
            height: fullscreen ? '100%' : undefined,
            maxWidth: '100%',
            maxHeight: '100%',
            opacity: isVisible ? (dragY > 0 ? Math.max(0.3, 1 - dragY / 300) : 1) : 0,
            transform: isVisible ? shownTransform : hiddenTransform,
            transition: panelTransition,
          }}
          role="dialog"
          aria-modal="true"
          data-dialog-open={isOpen || undefined}
          aria-labelledby={!rawContent && title ? titleId : undefined}
          aria-label={rawContent ? ariaLabel || (typeof title === 'string' && title ? title : undefined) : ariaLabel}
          tabIndex={-1}
          onClick={e => e.stopPropagation()}
        >
          {/* Drag Handle (mobile) - 触摸下滑关闭的唯一触发区域 */}
          <div
            ref={dragHandleRef}
            className={
              fullscreen
                ? 'hidden'
                : 'md:hidden flex justify-center pt-3 pb-2 shrink-0 cursor-grab active:cursor-grabbing'
            }
          >
            <div className="w-10 h-1 rounded-full bg-bg-300" />
          </div>

          {rawContent ? (
            /* rawContent 模式：children 控制内部布局，wrapper 只提供可滚动高度边界 */
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          ) : (
            <>
              {/* Header */}
              {(title || showCloseButton) && (
                <div className="flex items-center justify-between px-5 pt-5">
                  <div
                    id={title ? titleId : undefined}
                    className="text-[length:var(--fs-heading-2)] font-semibold text-text-100"
                  >
                    {title}
                  </div>
                  {showCloseButton && (
                    <button
                      type="button"
                      onClick={requestClose}
                      aria-label={t('common:close')}
                      className="hidden md:block p-2 text-text-400 hover:text-text-200 hover:bg-bg-100 rounded-md transition-colors"
                      title={t('common:close')}
                    >
                      <CloseIcon size={18} />
                    </button>
                  )}
                </div>
              )}

              {/* Content */}
              <div className="p-5 overflow-y-auto custom-scrollbar max-h-[80vh]">{children}</div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
