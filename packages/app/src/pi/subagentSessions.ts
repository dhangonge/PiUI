import { useCallback, useSyncExternalStore } from 'react'
import { childAgentStore } from './childAgentStore'
import { piSessionInfoStore } from './piSessionInfoStore'

/**
 * 把 Agent 卡片的 `details.agentId` 映射到子代理会话。
 *
 * 两条来源，先活后盘：
 * 1. 活着的子会话：worker 转发 `subagents:child:*` 时补的 `sessionName`
 *    （插件设成 `<类型>#<agentId 前 8 位>`，agent-runner.ts:606）；
 * 2. 已落盘的子会话：会话列表里同名的 `SessionInfo`。落盘桥
 *    （pi-worker/src/runtime/subagent-sessions.ts）装成功后子代理会话就是
 *    正常会话，重启 PiUI 也还能点开。
 *
 * 落盘桥没装（`PIUI_SUBAGENT_SESSIONS=off` 或 SDK 变了）时两条都查不到，
 * 卡片就不给入口 —— 这时子代理转录确实没有可打开的东西。
 */

const SHORT_ID_LENGTH = 8

export function subagentNameSuffix(agentId: string): string {
  return `#${agentId.slice(0, SHORT_ID_LENGTH)}`
}

export function sessionNameMatchesAgent(name: string | undefined, agentId: string): boolean {
  return Boolean(name?.endsWith(subagentNameSuffix(agentId)))
}

/** 返回子会话 id（多后端下是 `serverId::sessionId` 作用域键，可直接导航）。 */
export function findSubagentSessionId(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined
  const live = childAgentStore.findByAgentId(agentId)
  if (live) return live.sessionId
  return piSessionInfoStore.getAll().find(info => sessionNameMatchesAgent(info.name, agentId))?.id
}

/** 订阅两个 store：子会话刚创建或被扫进会话列表时卡片入口要出现。 */
export function useSubagentSessionId(agentId: string | undefined): string | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const stopChild = childAgentStore.subscribe(listener)
    const stopSessions = piSessionInfoStore.subscribe(listener)
    return () => {
      stopChild()
      stopSessions()
    }
  }, [])
  const getSnapshot = useCallback(() => findSubagentSessionId(agentId), [agentId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
