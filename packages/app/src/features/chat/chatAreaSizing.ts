import type { ProcessTimelineItem } from './chatPageModel'

/** 单行估算高度（虚拟化的默认行高） */
export const ROW_ESTIMATE = 60
/** 过程壳 header 行高（Working / Worked 一行） */
const PROCESS_SHELL_HEADER = 36
const DEFAULT_BOTTOM_SPACER = 256

/** 内容等价判断：流式 chunk 只换数组引用时，复用旧 Map/Set 引用，
 *  否则 VirtualRow 的 memo 比较（含这三个引用）会被击穿，历史行跟着重渲染。 */
export function sameMap<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

export function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

export const bottomSpacerHeight = (bottomPadding: number) =>
  bottomPadding > 0 ? bottomPadding + 48 : DEFAULT_BOTTOM_SPACER

export function estimateTimelineItemSize(item: ProcessTimelineItem | undefined): number {
  if (!item) return ROW_ESTIMATE
  if (item.kind === 'message') return ROW_ESTIMATE
  // 进行中默认展开：header + 壳内消息（空回合至少占 header）
  if (item.isActive) {
    const body = Math.max(item.children.length, 1) * ROW_ESTIMATE
    return PROCESS_SHELL_HEADER + body
  }
  // 结束后默认折叠：只估 header + 壳外 final，避免刷新时 120→36 的假高度再回弹
  return PROCESS_SHELL_HEADER + (item.finalItem ? ROW_ESTIMATE : 0)
}

export function sessionCacheKey(sessionId: string, processCollapseEnabled: boolean): string {
  return `${sessionId}:${processCollapseEnabled ? 'process' : 'flat'}`
}
