import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent'
import { loadPiSdk } from '../sdk-host.ts'
import {
  describeSubagentSession,
  forgetSubagentSession,
  installSubagentSessionPersistence,
  resetSubagentSessions,
  setSubagentParentAnchor,
  SUBAGENT_SESSIONS_ENV,
} from './subagent-sessions.ts'

await loadPiSdk()

const root = mkdtempSync(path.join(tmpdir(), 'piui-subagent-sessions-'))
const sessionDir = path.join(root, 'sessions')
process.env[SUBAGENT_SESSIONS_ENV] = 'on'

after(() => rmSync(root, { recursive: true, force: true }))

describe('subagent session persistence bridge', () => {
  it('turns the plugin in-memory session into a persisted child of the current session', () => {
    const parent = SessionManager.create(root, sessionDir)
    const parentFile = parent.getSessionFile()
    assert.ok(parentFile)

    // 锚点要在 spawn 之前指向父会话：子会话 header 的 parentSession 用它
    setSubagentParentAnchor({ sessionFile: parentFile, sessionDir })
    const status = installSubagentSessionPersistence()
    assert.equal(status.installed, true, status.reason)

    const child = SessionManager.inMemory(root)
    const childFile = child.getSessionFile()
    assert.ok(childFile, 'child session must be persisted')
    assert.equal(path.dirname(childFile), sessionDir)
    // 会话列表按 parentSessionPath 建树：必须指向父会话文件
    assert.equal(child.getHeader()?.parentSession, parentFile)

    const described = describeSubagentSession(child.getSessionId())
    assert.equal(described?.sessionFile, childFile)

    // 插件 spawn 后第一件事就是给子会话命名（AgentSession.setSessionName →
    // appendSessionInfo）；SDK 只在出现 user/assistant 消息时才真正建文件
    child.appendSessionInfo('Explore#deadbeef')
    assert.equal(child.getSessionName(), 'Explore#deadbeef')
    child.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] } as never)
    assert.equal(existsSync(childFile), true)
    assert.equal(describeSubagentSession(child.getSessionId())?.sessionName, 'Explore#deadbeef')

    forgetSubagentSession(child.getSessionId())
    assert.equal(describeSubagentSession(child.getSessionId()), undefined)
  })

  it('keeps in-memory semantics for callers that supply their own entries', () => {
    // 插件只有在“拿内存里的转录续一个会话”时才会传 entries；这时换成落盘
    // 会丢掉调用方手里的内容，所以必须透传原实现。
    const entries: FileEntry[] = [
      {
        type: 'label',
        id: 'label-1',
        parentId: null,
        timestamp: new Date().toISOString(),
        targetId: 'entry-1',
        label: 'supplied by caller',
      } as unknown as FileEntry,
    ]

    const resumed = SessionManager.inMemory(root, undefined, entries)
    assert.equal(resumed.getSessionFile(), undefined)
    assert.equal(resumed.getEntries().length, 1)
  })

  it('falls back to the original in-memory session without an anchor', () => {
    setSubagentParentAnchor(undefined)
    const detached = SessionManager.inMemory(root)
    const file = detached.getSessionFile()
    assert.ok(file, 'without an anchor it still persists, only the parent link is missing')
    assert.equal(detached.getHeader()?.parentSession, undefined)
    resetSubagentSessions()
  })

  it('attributes subagents to the session of the matching cwd when one worker hosts several', () => {
    const other = mkdtempSync(path.join(tmpdir(), 'piui-subagent-other-'))
    const otherDir = path.join(other, 'sessions')
    const first = SessionManager.create(root, sessionDir)
    const second = SessionManager.create(other, otherDir)

    setSubagentParentAnchor({
      cwd: root,
      sessionFile: first.getSessionFile(),
      sessionDir,
    })
    setSubagentParentAnchor({
      cwd: other,
      sessionFile: second.getSessionFile(),
      sessionDir: otherDir,
    })

    // 两个回合交错推进时，子代理应该跟着自己的 cwd 落到父会话下面
    const childOfFirst = SessionManager.inMemory(root)
    assert.equal(childOfFirst.getHeader()?.parentSession, first.getSessionFile())
    assert.equal(path.dirname(childOfFirst.getSessionFile()!), sessionDir)

    const childOfSecond = SessionManager.inMemory(other)
    assert.equal(childOfSecond.getHeader()?.parentSession, second.getSessionFile())

    // 子代理在别处起跑（比如 worktree）时退回最近一次父会话
    const stray = SessionManager.inMemory(path.join(root, 'worktree'))
    assert.equal(stray.getHeader()?.parentSession, second.getSessionFile())
    rmSync(other, { recursive: true, force: true })
  })
})
