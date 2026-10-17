import { getLoadedSdk } from '../sdk-host.js'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * 子代理会话落盘桥。
 *
 * pi-subagents-lite 用 `SessionManager.inMemory(cwd)`（agent-runner.ts:554）建
 * 子会话，转录只存在于子代理那次运行的内存里：宿主既读不到内容，会话列表也
 * 看不见它，卡片上只剩「有没有活着」这件事。
 *
 * 这里把 SDK 命名空间上的 `SessionManager.inMemory` 换成 `create`：子会话写进
 * 正常 session 目录，header 里 `parentSession` 指向父会话文件。于是
 * - PiUI 左侧会话管理按 `parentSessionPath` 自动把它嵌在父会话下
 *   （`linkPiSessionForks` + `SessionChildrenSlot`）；
 * - 点开就是完整时间线（pi 会用同一个 SessionManager 读那个文件）；
 * - pi TUI 的会话树也嵌套显示，不污染顶层。
 *
 * 代价：这是 monkeypatch SDK 内部静态方法，SDK 升级后签名/语义变化就失效。
 * 所以任何一步失败都回落原实现（子代理照旧能跑，只是不落盘），并且可以用
 * `PIUI_SUBAGENT_SESSIONS=off` 整体关掉。
 */

export const SUBAGENT_SESSIONS_ENV = 'PIUI_SUBAGENT_SESSIONS'

export interface SubagentPersistenceStatus {
  installed: boolean
  reason?: string
}

export interface SubagentParentAnchor {
  /** 父会话的工作目录；子代理通常也在同一个 cwd 起跑，用来在多会话进程里分表 */
  cwd?: string
  /** 父会话文件路径，写进子会话 header 的 `parentSession` */
  sessionFile?: string
  /** 父会话所在目录，子会话写同一目录才会被会话列表扫到 */
  sessionDir?: string
}

export interface SubagentSessionInfo {
  sessionFile: string
  sessionName?: string
}

// 一个 worker 进程可以同时挂多个会话（entry.ts openRuntime → runtimes），
// 所以锚点按父会话 cwd 分表；cwd 对不上时（子代理在 worktree 等别处起跑）
// 退回最近一次设置的父会话。
const anchors = new Map<string, SubagentParentAnchor>()
let lastAnchor: SubagentParentAnchor | undefined
let installed = false
let status: SubagentPersistenceStatus = { installed: false, reason: 'not installed' }
const managers = new Map<string, SessionManager>()

function anchorKey(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function isSubagentSessionPersistenceEnabled(): boolean {
  return process.env[SUBAGENT_SESSIONS_ENV]?.trim().toLowerCase() !== 'off'
}

/**
 * 记住当前父会话。子代理由插件在会话回合里 spawn，宿主拿不到它的调用栈，
 * 所以用「当前活动会话」作为父：每次回合开始与开启会话时都会刷新一次。
 */
export function setSubagentParentAnchor(next: SubagentParentAnchor | undefined): void {
  if (!next?.sessionFile) {
    anchors.clear()
    lastAnchor = undefined
    return
  }
  lastAnchor = next
  if (next.cwd) anchors.set(anchorKey(next.cwd), next)
  else anchors.clear()
}

/** 幂等安装；返回安装状态（失败时子代理行为与打补丁前完全一致）。 */
export function installSubagentSessionPersistence(): SubagentPersistenceStatus {
  if (installed) return status
  if (!isSubagentSessionPersistenceEnabled()) {
    status = { installed: false, reason: `disabled by ${SUBAGENT_SESSIONS_ENV}` }
    return status
  }
  let SessionManagerClass: typeof SessionManager | undefined
  try {
    SessionManagerClass = getLoadedSdk().sdk.SessionManager
  } catch (error) {
    status = { installed: false, reason: error instanceof Error ? error.message : String(error) }
    return status
  }
  const original = SessionManagerClass?.inMemory
  if (typeof original !== 'function') {
    status = { installed: false, reason: 'SessionManager.inMemory is unavailable' }
    return status
  }
  try {
    SessionManagerClass.inMemory = function inMemory(cwd, options, entries) {
      // 带 entries 的调用是「用内存里的转录续一个会话」，换成落盘会丢内容。
      if (Array.isArray(entries) && entries.length > 0) return original.call(this, cwd, options, entries)
      const current = (typeof cwd === 'string' && cwd ? anchors.get(anchorKey(cwd)) : undefined) ?? lastAnchor
      try {
        const manager = SessionManagerClass.create(
          typeof cwd === 'string' && cwd ? cwd : process.cwd(),
          current?.sessionDir,
          current?.sessionFile ? { ...(options ?? {}), parentSession: current.sessionFile } : options,
        )
        managers.set(manager.getSessionId(), manager)
        return manager
      } catch {
        return original.call(this, cwd, options, entries)
      }
    }
  } catch (error) {
    status = { installed: false, reason: `patch failed: ${error instanceof Error ? error.message : String(error)}` }
    return status
  }
  installed = true
  status = { installed: true }
  return status
}

/** 查子代理会话的落盘位置与显示名（名字由插件设成 `Explore#<短 id>`）。 */
export function describeSubagentSession(sessionId: string): SubagentSessionInfo | undefined {
  const manager = managers.get(sessionId)
  if (!manager) return undefined
  try {
    const sessionFile = manager.getSessionFile()
    if (!sessionFile) return undefined
    const sessionName = manager.getSessionName()
    return sessionName ? { sessionFile, sessionName } : { sessionFile }
  } catch {
    return undefined
  }
}

/** 子代理结束（disposed）后忘掉句柄，避免长会话里 Map 无限增长。 */
export function forgetSubagentSession(sessionId: string): void {
  managers.delete(sessionId)
}

/** 测试用：清空状态（不还原已打的补丁，SDK 类在进程内只有一份）。 */
export function resetSubagentSessions(): void {
  managers.clear()
  anchors.clear()
  lastAnchor = undefined
}
