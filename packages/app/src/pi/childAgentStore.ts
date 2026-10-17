import { useSyncExternalStore } from 'react'
import { useSessionNavigation } from '../contexts/SessionNavigationContext'
import { sessionKeyToSessionId } from '../utils/sessionKey'

/**
 * 子代理会话的存活状态。
 *
 * pi-subagents-lite 用 `SessionManager.inMemory(cwd)` 跑子代理，转录既不落盘
 * 也不暴露给宿主；插件只通过 `pi.events` 广播会话 id（`subagents:child:*`），
 * 于是 UI 能确定的只有「某个父会话下有几个子会话活着」，没有逐卡片对应关系：
 * 公告里不带 agentId，卡片上的 agentId 与子会话 id 无法互查。
 *
 * 所以这里按父会话聚合，卡片只报数量，不做匹配。
 */
export interface ChildAgentSession {
  sessionId: string
  phase: 'created' | 'bound' | 'disposed'
}

export interface SubagentChildPayload {
  phase?: unknown
  sessionId?: unknown
  parentSessionId?: unknown
  owningSessionId?: unknown
}

const byParent = new Map<string, Map<string, ChildAgentSession>>()
// useSyncExternalStore 要求快照引用稳定：每次 list() 新建数组会让 React
// 判定状态一直在变，直接无限重渲染。变更时统一失效重建。
const snapshots = new Map<string, readonly ChildAgentSession[]>()
const listeners = new Set<() => void>()

const EMPTY: readonly ChildAgentSession[] = []

function notify(): void {
  snapshots.clear()
  for (const listener of listeners) listener()
}

/**
 * 事件里的 parentSessionId 是裸 sessionId；UI 侧 currentSessionId 在多后端
 * 下是 `serverId::sessionId` 的键，两边要用同一形状才对得上。
 */
function parentKey(parentSessionId: string | null | undefined, fallback: string): string {
  return sessionKeyToSessionId(parentSessionId ?? fallback)
}

export const childAgentStore = {
  /** 处理 worker 转发的 `subagent.child` 事件 */
  receive(payload: SubagentChildPayload, owningSessionId: string): void {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined
    if (!sessionId) return
    const phase = payload.phase
    if (phase !== 'created' && phase !== 'bound' && phase !== 'disposed') return
    const key = parentKey(
      typeof payload.parentSessionId === 'string' ? payload.parentSessionId : undefined,
      owningSessionId,
    )

    if (phase === 'disposed') {
      const sessions = byParent.get(key)
      if (!sessions?.delete(sessionId)) return
      if (sessions.size === 0) byParent.delete(key)
      notify()
      return
    }

    let sessions = byParent.get(key)
    if (!sessions) {
      sessions = new Map()
      byParent.set(key, sessions)
    }
    const previous = sessions.get(sessionId)
    if (previous?.phase === phase) return
    sessions.set(sessionId, { sessionId, phase })
    notify()
  },

  list(parentSessionId: string | null | undefined): readonly ChildAgentSession[] {
    if (!parentSessionId) return EMPTY
    const key = sessionKeyToSessionId(parentSessionId)
    const sessions = byParent.get(key)
    if (!sessions) return EMPTY
    const cached = snapshots.get(key)
    if (cached) return cached
    const snapshot = Array.from(sessions.values())
    snapshots.set(key, snapshot)
    return snapshot
  },

  count(parentSessionId: string | null | undefined): number {
    return this.list(parentSessionId).length
  },

  clearSession(parentSessionId: string): void {
    if (byParent.delete(sessionKeyToSessionId(parentSessionId))) notify()
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  clearAll(): void {
    byParent.clear()
    notify()
  },
}

/** 订阅当前会话下存活的子代理会话 */
export function useChildAgentSessions(): readonly ChildAgentSession[] {
  const { currentSessionId } = useSessionNavigation()
  return useSyncExternalStore(childAgentStore.subscribe, () =>
    childAgentStore.list(currentSessionId ? sessionKeyToSessionId(currentSessionId) : undefined),
  )
}
