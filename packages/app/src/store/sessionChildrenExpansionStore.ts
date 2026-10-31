import { useSyncExternalStore } from 'react'

/**
 * 侧栏里「父会话下的子代理」默认收起：只记住用户手动点开过的父会话，
 * 刷新列表、切换会话都不会丢。用版本号做快照，避免每次返回新对象。
 */
const expandedParentIds = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

function emit() {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const sessionChildrenExpansionStore = {
  subscribe,
  getVersion: () => version,
  isExpanded: (parentSessionId: string) => expandedParentIds.has(parentSessionId),
  toggle(parentSessionId: string) {
    if (expandedParentIds.has(parentSessionId)) expandedParentIds.delete(parentSessionId)
    else expandedParentIds.add(parentSessionId)
    emit()
  },
  collapse(parentSessionId: string) {
    if (!expandedParentIds.delete(parentSessionId)) return
    emit()
  },
  clear() {
    if (expandedParentIds.size === 0) return
    expandedParentIds.clear()
    emit()
  },
}

export function useSessionChildrenExpanded(parentSessionId: string): boolean {
  useSyncExternalStore(subscribe, sessionChildrenExpansionStore.getVersion, sessionChildrenExpansionStore.getVersion)
  return expandedParentIds.has(parentSessionId)
}

/** 列表里逐行用：一次订阅拿到全部展开态，避免 map 里调 hook */
export function useExpandedParentIds(): Set<string> {
  useSyncExternalStore(subscribe, sessionChildrenExpansionStore.getVersion, sessionChildrenExpansionStore.getVersion)
  return expandedParentIds
}
