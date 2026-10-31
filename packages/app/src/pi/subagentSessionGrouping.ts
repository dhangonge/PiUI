import type { UiSession } from '../types/session'

/**
 * pi-subagents-lite 给子代理会话起名 `<类型>#<agentId 前 8 位>`（agent-runner.ts 里
 * `session.setSessionName()`），并在 header.parentSession 写父会话路径。
 * 只有「带父路径 + 名字符合这个后缀」的会话才当作子代理，避免把用户 fork 也收起来。
 */
const SUBAGENT_SESSION_NAME_RE = /^.+#[0-9a-f]{8}$/i

export interface SubagentSessionGroups {
  /** 顶层会话：父会话 + 不是子代理的 fork */
  roots: UiSession[]
  /** 父会话 id -> 直接子会话（深层嵌套由调用方用同一张表递归） */
  childrenByParentId: Map<string, UiSession[]>
}

export function isSubagentChildSession(session: UiSession): boolean {
  if (!session.parentSessionPath) return false
  if (!session.isNamed) return false
  return SUBAGENT_SESSION_NAME_RE.test(session.title)
}

/**
 * 把子代理会话从顶层列表里摘出来，挂到父会话下。
 * 父会话不在本批数据里（被搜索过滤掉、或跨目录）时，子会话仍作为顶层条目出现，
 * 这样搜索结果里依然能直接看到命中的子代理。
 */
export function groupSubagentSessions(sessions: UiSession[], keepIds?: Set<string>): SubagentSessionGroups {
  const knownIds = new Set(sessions.map(session => session.id))
  const roots: UiSession[] = []
  const childrenByParentId = new Map<string, UiSession[]>()

  for (const session of sessions) {
    const parentId = session.forkParentId
    if (
      !parentId ||
      parentId === session.id ||
      !knownIds.has(parentId) ||
      !isSubagentChildSession(session) ||
      keepIds?.has(session.id)
    ) {
      roots.push(session)
      continue
    }
    const siblings = childrenByParentId.get(parentId)
    if (siblings) siblings.push(session)
    else childrenByParentId.set(parentId, [session])
  }

  return { roots, childrenByParentId }
}
