import { useSyncExternalStore } from 'react'
import { useSessionNavigation } from '../contexts/SessionNavigationContext'
import { sessionKeyToSessionId } from '../utils/sessionKey'

/**
 * 子代理会话的存活状态。
 *
 * pi-subagents-lite 通过 `pi.events` 广播子代理会话的生命周期
 * （`subagents:child:created|bound|disposed`），payload 只有 sessionId；
 * worker 会额外补 `sessionFile`/`sessionName`（子代理落盘桥装成功时）。
 *
 * 公告里没有 agentId，但子会话名是 `<类型>#<agentId 前 8 位>`，所以卡片可以
 * 用短 id 把 agentId 与子会话对上（见 findByAgentId）。这里按父会话聚合，
 * 默认视图只关心「现在有几个还活着」。
 */
export interface ChildAgentSession {
  sessionId: string
  phase: 'created' | 'bound' | 'disposed'
  /** 子会话落盘后 worker 补上的文件路径（PIUI_SUBAGENT_SESSIONS=off 时没有） */
  sessionFile?: string
  /** 插件设的子会话名，形如 `Explore#a1b2c3d4`；后缀就是 agentId 前 8 位 */
  sessionName?: string
}

export interface SubagentChildPayload {
  phase?: unknown
  sessionId?: unknown
  parentSessionId?: unknown
  owningSessionId?: unknown
  sessionFile?: unknown
  sessionName?: unknown
}

const byParent = new Map<string, Map<string, ChildAgentSession>>()
// 已结束的子会话也要能查（卡片要能点开它的转录），所以除了 byParent 的存活
// 集合，再留一份不随 disposed 删除的身份记录。
const known = new Map<string, ChildAgentSession>()
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
    const sessionFile = typeof payload.sessionFile === 'string' ? payload.sessionFile : undefined
    const sessionName = typeof payload.sessionName === 'string' ? payload.sessionName : undefined
    const identity = known.get(sessionId)
    if (sessionFile || sessionName || phase !== 'disposed') {
      known.set(sessionId, {
        sessionId,
        phase,
        ...((sessionFile ?? identity?.sessionFile) ? { sessionFile: sessionFile ?? identity?.sessionFile } : {}),
        ...((sessionName ?? identity?.sessionName) ? { sessionName: sessionName ?? identity?.sessionName } : {}),
      })
    }

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
    sessions.set(sessionId, {
      sessionId,
      phase,
      ...(sessionFile ? { sessionFile } : {}),
      ...(sessionName ? { sessionName } : {}),
    })
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

  /**
   * 按 agentId 前 8 位找子会话：插件的子会话名是 `<类型>#<短 id>`，
   * 与卡片 `details.agentId` 同一把钥匙。
   */
  findByAgentId(agentId: string | undefined): ChildAgentSession | undefined {
    if (!agentId) return undefined
    const suffix = `#${agentId.slice(0, 8)}`
    for (const session of known.values()) if (session.sessionName?.endsWith(suffix)) return session
    return undefined
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
    known.clear()
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
