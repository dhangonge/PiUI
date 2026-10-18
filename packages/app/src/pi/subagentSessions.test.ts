import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { childAgentStore } from './childAgentStore'
import { piSessionInfoStore } from './piSessionInfoStore'
import { findSubagentSessionId, sessionNameMatchesAgent, subagentNameSuffix } from './subagentSessions'

const AGENT_ID = 'a1b2c3d4-1111-2222-3333-444455556666'

function sessionInfo(id: string, name: string | undefined, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    path: `/tmp/${id}.jsonl`,
    cwd: '/tmp',
    name,
    created: new Date(0),
    modified: new Date(0),
    messageCount: 1,
    firstMessage: '',
    allMessagesText: '',
    ...extra,
  } as SessionInfo
}

afterEach(() => {
  childAgentStore.clearAll()
  piSessionInfoStore.clear()
})

describe('sessionNameMatchesAgent', () => {
  it('matches the short-id suffix the plugin appends to the child session name', () => {
    expect(subagentNameSuffix(AGENT_ID)).toBe('#a1b2c3d4')
    expect(sessionNameMatchesAgent('Explore#a1b2c3d4', AGENT_ID)).toBe(true)
    expect(sessionNameMatchesAgent('general-purpose#a1b2c3d4', AGENT_ID)).toBe(true)
  })

  it('rejects other agents and missing names', () => {
    expect(sessionNameMatchesAgent('Explore#deadbeef', AGENT_ID)).toBe(false)
    expect(sessionNameMatchesAgent(undefined, AGENT_ID)).toBe(false)
  })
})

describe('findSubagentSessionId', () => {
  it('prefers a live child session forwarded by the worker', () => {
    childAgentStore.receive(
      { phase: 'created', sessionId: 'child-live', sessionName: 'Explore#a1b2c3d4' },
      'server::parent',
    )
    piSessionInfoStore.replaceForServer('server', [sessionInfo('server::child-live', 'Explore#a1b2c3d4')])

    expect(findSubagentSessionId(AGENT_ID)).toBe('child-live')
  })

  it('falls back to the persisted session list once the child is gone', () => {
    piSessionInfoStore.replaceForServer('server', [
      sessionInfo('server::child-1', 'Explore#deadbeef'),
      sessionInfo('server::child-2', 'Explore#a1b2c3d4'),
    ])

    expect(findSubagentSessionId(AGENT_ID)).toBe('server::child-2')
  })

  it('keeps the child identity after it is disposed so the card can still open it', () => {
    childAgentStore.receive(
      { phase: 'created', sessionId: 'child-live', sessionName: 'Explore#a1b2c3d4' },
      'server::parent',
    )
    childAgentStore.receive({ phase: 'disposed', sessionId: 'child-live' }, 'server::parent')

    expect(childAgentStore.list('parent')).toHaveLength(0)
    expect(findSubagentSessionId(AGENT_ID)).toBe('child-live')
  })

  it('returns nothing without an agent id or without a matching session', () => {
    expect(findSubagentSessionId(undefined)).toBeUndefined()
    expect(findSubagentSessionId('ffffffff-1111-2222-3333-444455556666')).toBeUndefined()
  })
})

// 前置 agent：插件的工具结果 details 里没有 agentId（buildAgentDetails 只在后台
// 分支补），只能靠「子会话名 <类型>#<短 id> + 首条用户消息 = Agent 卡片 prompt」认人。
describe('findSubagentSessionId for foreground agents', () => {
  const PROMPT = '统计模块规模\n\n只读操作，不要改文件。'
  const parent = sessionInfo('server::parent', '更新', { path: '/work/parent.jsonl' })

  it('links by session type prefix plus the identical first user message', () => {
    piSessionInfoStore.replaceForServer('server', [
      parent,
      sessionInfo('server::child-fg', 'general-purpose#a037f104', {
        firstMessage: '统计模块规模   只读操作，不要改文件。',
        parentSessionPath: '/work/parent.jsonl',
      }),
    ])

    expect(
      findSubagentSessionId({
        type: 'general-purpose',
        prompt: PROMPT,
        parentSessionId: 'server::parent',
      }),
    ).toBe('server::child-fg')
  })

  it('rejects a session of another type or another first message', () => {
    piSessionInfoStore.replaceForServer('server', [
      parent,
      sessionInfo('server::other-type', 'Explore#a037f104', { firstMessage: PROMPT }),
      sessionInfo('server::other-prompt', 'general-purpose#bbbbbbbb', { firstMessage: '别的任务' }),
    ])

    expect(
      findSubagentSessionId({
        type: 'general-purpose',
        prompt: PROMPT,
        parentSessionId: 'server::parent',
      }),
    ).toBeUndefined()
  })

  it('refuses to guess when the same prompt ran twice', () => {
    piSessionInfoStore.replaceForServer('server', [
      sessionInfo('server::dup-1', 'general-purpose#aaaaaaaa', { firstMessage: PROMPT }),
      sessionInfo('server::dup-2', 'general-purpose#bbbbbbbb', { firstMessage: PROMPT }),
    ])

    expect(findSubagentSessionId({ type: 'general-purpose', prompt: PROMPT })).toBeUndefined()
  })

  it('uses the parent session file to pick between identical prompts', () => {
    piSessionInfoStore.replaceForServer('server', [
      parent,
      sessionInfo('server::elsewhere', 'general-purpose#aaaaaaaa', {
        firstMessage: PROMPT,
        parentSessionPath: '/work/other.jsonl',
      }),
      sessionInfo('server::mine', 'general-purpose#bbbbbbbb', {
        firstMessage: PROMPT,
        parentSessionPath: '/work/parent.jsonl',
      }),
    ])

    expect(
      findSubagentSessionId({
        type: 'general-purpose',
        prompt: PROMPT,
        parentSessionId: 'server::parent',
      }),
    ).toBe('server::mine')
  })

  it('falls back to the parent chain when the agent config name differs from the type', () => {
    piSessionInfoStore.replaceForServer('server', [
      parent,
      sessionInfo('server::custom', 'builder#c0ffee00', {
        firstMessage: PROMPT,
        parentSessionPath: '/work/parent.jsonl',
      }),
    ])

    expect(
      findSubagentSessionId({
        type: 'general-purpose',
        prompt: PROMPT,
        parentSessionId: 'server::parent',
      }),
    ).toBe('server::custom')
  })
})
