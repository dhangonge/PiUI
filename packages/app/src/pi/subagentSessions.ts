import { useCallback, useSyncExternalStore } from 'react'
import { sessionKeyToSessionId } from '../utils/sessionKey'
import { childAgentStore } from './childAgentStore'
import { piSessionInfoStore } from './piSessionInfoStore'

/**
 * 把 Agent 卡片映射到子代理会话。
 *
 * 三把钥匙，前两把要 agentId，第三把不要：
 * 1. 活着的子会话：worker 转发 `subagents:child:*` 时补的 `sessionName`
 *    （插件设成 `<类型>#<agentId 前 8 位>`，agent-runner.ts:606）；
 * 2. 已落盘的子会话：会话列表里同名的 `SessionInfo`；
 * 3. 前置 agent（`run_in_background` 未开）的工具结果里**没有** agentId
 *    （插件 buildAgentDetails 只在后台分支补 agentId，tool-execution.ts:265），
 *    只能靠「子会话名 `<类型>#<短 id>` + 首条用户消息就是 Agent 卡片的 prompt」
 *    认人。prompt 有歧义（同一任务跑两次）时宁可不给入口，交父会话链裁决。
 *
 * 落盘桥没装（`PIUI_SUBAGENT_SESSIONS=off` 或 SDK 变了）时三条都查不到，
 * 卡片就不给入口 —— 这时子代理转录确实没有可打开的东西。
 */

const SHORT_ID_LENGTH = 8

export interface SubagentLinkKeys {
  /** 后台 agent 的工具结果 details.agentId */
  agentId?: string
  /** 卡片上的 agent 类型（details.type / 工具入参 agent） */
  type?: string
  /** Agent 工具入参 prompt：子代理会话的首条用户消息 */
  prompt?: string
  /** 父会话（作用域键或裸 id），用于按父子链消歧 */
  parentSessionId?: string | null
}

export function subagentNameSuffix(agentId: string): string {
  return `#${agentId.slice(0, SHORT_ID_LENGTH)}`
}

export function sessionNameMatchesAgent(name: string | undefined, agentId: string): boolean {
  return Boolean(name?.endsWith(subagentNameSuffix(agentId)))
}

/** 子会话名 `<类型>#<短 id>`；插件的 baseName 取 agent 配置名，可能不等于类型。 */
function sessionNameMatchesType(name: string | undefined, type: string | undefined): boolean {
  if (!type) return false
  return Boolean(name?.startsWith(`${type}#`))
}

function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 当前会话的落盘路径，用来把候选子会话锁在同一个父会话下。 */
function resolveSessionFile(sessionId: string | null | undefined): string | undefined {
  if (!sessionId) return undefined
  const bareId = sessionKeyToSessionId(sessionId) || sessionId
  return piSessionInfoStore.getAll().find(info => sessionKeyToSessionId(info.id) === bareId)?.path
}

function findSessionIdByPrompt(keys: SubagentLinkKeys): string | undefined {
  const prompt = keys.prompt?.trim()
  if (!prompt) return undefined
  const wanted = normalizePrompt(prompt)
  const parentFile = resolveSessionFile(keys.parentSessionId)

  const byPrompt = piSessionInfoStore
    .getAll()
    .filter(info => normalizePrompt(info.firstMessage ?? '') === wanted)
    .filter(info => (parentFile ? info.parentSessionPath === parentFile : true))

  const byType = byPrompt.filter(info => sessionNameMatchesType(info.name, keys.type))
  if (byType.length === 1) return byType[0].id
  if (byType.length > 1) return undefined
  // 类型对不上时只有「同父 + prompt 一字不差且唯一」才认：自定义 agent 的
  // baseName 取配置名，可能不等于类型；但同名任务跑两遍就宁可不给入口。
  if (!parentFile) return undefined
  return byPrompt.length === 1 ? byPrompt[0].id : undefined
}

/** 返回子会话 id（多后端下是 `serverId::sessionId` 作用域键，可直接导航）。 */
export function findSubagentSessionId(lookup: SubagentLinkKeys | string | undefined): string | undefined {
  if (!lookup) return undefined
  const keys: SubagentLinkKeys = typeof lookup === 'string' ? { agentId: lookup } : lookup

  if (keys.agentId) {
    const live = childAgentStore.findByAgentId(keys.agentId)
    if (live) return live.sessionId
    const persisted = piSessionInfoStore
      .getAll()
      .find(info => sessionNameMatchesAgent(info.name, keys.agentId as string))
    if (persisted) return persisted.id
  }

  return findSessionIdByPrompt(keys)
}

/** 订阅两个 store：子会话刚创建、被扫进会话列表或写完首条消息时卡片入口要出现。 */
export function useSubagentSessionId(lookup: SubagentLinkKeys | string | undefined): string | undefined {
  const keys: SubagentLinkKeys = typeof lookup === 'string' ? { agentId: lookup } : (lookup ?? {})
  const { agentId, type, prompt, parentSessionId } = keys
  const subscribe = useCallback((listener: () => void) => {
    const stopChild = childAgentStore.subscribe(listener)
    const stopSessions = piSessionInfoStore.subscribe(listener)
    return () => {
      stopChild()
      stopSessions()
    }
  }, [])
  const getSnapshot = useCallback(
    () => findSubagentSessionId({ agentId, type, prompt, parentSessionId }),
    [agentId, type, prompt, parentSessionId],
  )
  return useSyncExternalStore(subscribe, getSnapshot)
}
