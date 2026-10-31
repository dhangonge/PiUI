import { useRef, useLayoutEffect, useEffect } from 'react'
import { animate } from 'motion/mini'
import { useDelayedRender } from './useDelayedRender'
import { useReducedMotion } from './useReducedMotion'
import { MOTION_EASE_OUT } from '../constants/animation'

type AnimationStyle = Record<string, string | number>

interface UsePresenceOptions {
  /** 入场初始状态 */
  from: AnimationStyle
  /** 入场目标状态（退场时反向回到 from） */
  to: AnimationStyle
  /** 动画时长（秒） */
  duration?: number
}

/**
 * usePresence — 命令式 mount/unmount 动画
 *
 * 基于 useDelayedRender 延迟卸载 + motion/mini animate() 驱动入场/退场。
 * 返回 { shouldRender, ref }:
 *   - shouldRender: 是否应该渲染 DOM（包含退场延迟期）
 *   - ref: 绑定到动画目标元素
 *
 * 用法:
 *   const { shouldRender, ref } = usePresence(isOpen, {
 *     from: { opacity: 0, transform: 'translateY(8px)' },
 *     to: { opacity: 1, transform: 'translateY(0px)' },
 *   })
 *   if (!shouldRender) return null
 *   return <div ref={ref}>...</div>
 *
 * 生命周期约定：
 *   - 只有首次入场才写 from；关闭中重开从被打断的当前值继续，不跳回起点重播。
 *   - 卸载停掉在跑的动画，不留下继续写样式的 ticker。
 *   - 减少动态效果（含运行中切换）直接落到目标状态，退场不等原动画时长。
 */
export function usePresence<T extends HTMLElement = HTMLDivElement>(show: boolean, options: UsePresenceOptions) {
  const { from, to, duration = 0.15 } = options
  const ref = useRef<T>(null)
  const animRef = useRef<ReturnType<typeof animate> | null>(null)
  const elementRef = useRef<T | null>(null)
  const enteredRef = useRef(false)
  const reduceMotion = useReducedMotion()

  // 减少动态效果时不空等原时长：延迟卸载改为 0，delayMs 变化会让 useDelayedRender 重排定时器
  const delayMs = reduceMotion ? 0 : Math.round(duration * 1000) + 50
  const shouldRender = useDelayedRender(show, delayMs)

  useLayoutEffect(() => {
    const element = ref.current

    if (!shouldRender || !element) {
      animRef.current?.stop()
      animRef.current = null
      elementRef.current = null
      enteredRef.current = false
      return
    }

    // 换节点（key 变化 / 条件渲染）按全新入场处理
    const isNewElement = elementRef.current !== element
    elementRef.current = element

    // 先停在跑的动画：关闭中重开时只保留一条，并且接着当前值走
    animRef.current?.stop()
    animRef.current = null

    if (reduceMotion) {
      Object.assign(element.style, toInlineStyle(show ? to : from))
      if (show) enteredRef.current = true
      return
    }

    if (show) {
      // 首次入场才写 from；否则会从起点重播，丢掉被打断的当前位置
      if (isNewElement || !enteredRef.current) Object.assign(element.style, toInlineStyle(from))
      if (!isAtStyle(element, to)) {
        animRef.current = animate(element, to, { duration, ease: MOTION_EASE_OUT })
      }
      enteredRef.current = true
      return
    }

    if (enteredRef.current && !isAtStyle(element, from)) {
      animRef.current = animate(element, from, { duration, ease: MOTION_EASE_OUT })
    }
  }, [show, shouldRender, reduceMotion]) // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载清理：motion 不会自己回收动画，必须在卸载时停掉
  useEffect(() => {
    return () => {
      animRef.current?.stop()
      animRef.current = null
    }
  }, [])

  return { shouldRender, ref }
}

/** 把数值样式转成 el.style 可赋值的字符串 */
function toInlineStyle(style: AnimationStyle): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(style)) {
    result[key] = typeof value === 'number' ? `${value}` : value
  }
  return result
}

function toCssProperty(property: string): string {
  return property.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)
}

/** 内联样式是否已经停在目标状态（偏好切换时避免无意义的重复动画） */
function isAtStyle(element: HTMLElement, style: AnimationStyle): boolean {
  const inline = toInlineStyle(style)
  return Object.entries(inline).every(
    ([property, value]) => element.style.getPropertyValue(toCssProperty(property)) === value,
  )
}
