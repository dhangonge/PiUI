import type { SessionInfo } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { childAgentStore } from './childAgentStore'
import { piSessionInfoStore } from './piSessionInfoStore'
import { findSubagentSessionId, sessionNameMatchesAgent, subagentNameSuffix } from './subagentSessions'

const AGENT_ID = 'a1b2c3d4-1111-2222-3333-444455556666'

function sessionInfo(id: string, name: string | undefined): SessionInfo {
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
