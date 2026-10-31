import { beforeEach, describe, expect, it } from 'vitest'
import { childAgentStore } from './childAgentStore'

describe('childAgentStore', () => {
  beforeEach(() => {
    childAgentStore.clearAll()
  })

  it('tracks created and bound children under their parent', () => {
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1', parentSessionId: 'parent-1' }, 'parent-1')
    childAgentStore.receive({ phase: 'bound', sessionId: 'child-1', parentSessionId: 'parent-1' }, 'parent-1')

    expect(childAgentStore.list('parent-1')).toEqual([{ sessionId: 'child-1', phase: 'bound' }])
    expect(childAgentStore.count('parent-1')).toBe(1)
  })

  it('drops a child once it is disposed', () => {
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1', parentSessionId: 'parent-1' }, 'parent-1')
    childAgentStore.receive({ phase: 'disposed', sessionId: 'child-1', parentSessionId: 'parent-1' }, 'parent-1')

    expect(childAgentStore.count('parent-1')).toBe(0)
  })

  it('falls back to the owning session when the payload has no parent', () => {
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1' }, 'parent-1')

    expect(childAgentStore.count('parent-1')).toBe(1)
  })

  it('keys scoped session ids by their bare id', () => {
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1', parentSessionId: 'parent-1' }, 'parent-1')

    expect(childAgentStore.count('server-a::parent-1')).toBe(1)
  })

  it('ignores malformed payloads and unknown phases', () => {
    childAgentStore.receive({ phase: 'created' }, 'parent-1')
    childAgentStore.receive({ phase: 'exploded', sessionId: 'child-1' }, 'parent-1')

    expect(childAgentStore.count('parent-1')).toBe(0)
  })

  it('notifies subscribers only on real changes', () => {
    let calls = 0
    const unsubscribe = childAgentStore.subscribe(() => {
      calls += 1
    })

    childAgentStore.receive({ phase: 'created', sessionId: 'child-1' }, 'parent-1')
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1' }, 'parent-1')
    childAgentStore.receive({ phase: 'disposed', sessionId: 'missing' }, 'parent-1')
    expect(calls).toBe(1)
    childAgentStore.receive({ phase: 'disposed', sessionId: 'child-1' }, 'parent-1')

    expect(calls).toBe(2)
    unsubscribe()
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1' }, 'parent-1')
    expect(calls).toBe(2)
  })

  it('clears one session without touching the others', () => {
    childAgentStore.receive({ phase: 'created', sessionId: 'child-1' }, 'parent-1')
    childAgentStore.receive({ phase: 'created', sessionId: 'child-2' }, 'parent-2')

    childAgentStore.clearSession('parent-1')

    expect(childAgentStore.count('parent-1')).toBe(0)
    expect(childAgentStore.count('parent-2')).toBe(1)
  })
})
