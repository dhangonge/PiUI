import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { EventBus } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@piui/protocol'
import { forwardChildSessionEvents, toChildSessionEvent } from './real-session.ts'

/** 最小 EventBus：只记录频道与处理器，不涉及 SDK 内部实现 */
function fakeBus(): EventBus & { fire: (channel: string, payload: unknown) => void; channels: string[] } {
  const handlers = new Map<string, Array<(payload: unknown) => void>>()
  return {
    channels: [],
    emit() {},
    on(channel: string, handler: (payload: unknown) => void) {
      const list = handlers.get(channel) ?? []
      list.push(handler)
      handlers.set(channel, list)
      return () => {
        const remaining = (handlers.get(channel) ?? []).filter(fn => fn !== handler)
        handlers.set(channel, remaining)
      }
    },
    fire(channel: string, payload: unknown) {
      this.channels.push(channel)
      for (const handler of handlers.get(channel) ?? []) handler(payload)
    },
  } as unknown as EventBus & { fire: (channel: string, payload: unknown) => void; channels: string[] }
}

describe('toChildSessionEvent', () => {
  it('normalises the agreed payload shape', () => {
    assert.deepEqual(toChildSessionEvent({ sessionId: 's1', parentSessionId: 'p1' }, 'created'), {
      phase: 'created',
      sessionId: 's1',
      parentSessionId: 'p1',
    })
  })

  it('nulls a missing parent instead of dropping the event', () => {
    assert.deepEqual(toChildSessionEvent({ sessionId: 's1' }, 'bound'), {
      phase: 'bound',
      sessionId: 's1',
      parentSessionId: null,
    })
  })

  it('drops payloads without a session id', () => {
    assert.equal(toChildSessionEvent({ parentSessionId: 'p1' }, 'created'), undefined)
    assert.equal(toChildSessionEvent(undefined, 'created'), undefined)
    assert.equal(toChildSessionEvent('nope', 'created'), undefined)
  })
})

describe('forwardChildSessionEvents', () => {
  it('subscribes each lifecycle channel and maps it to its phase', () => {
    const bus = fakeBus()
    const events: JsonObject[] = []
    const unsubs = forwardChildSessionEvents(bus, event => events.push(event))
    assert.equal(unsubs.length, 3)

    bus.fire('subagents:child:session-created', { sessionId: 's1', parentSessionId: 'p1' })
    bus.fire('subagents:child:bound', { sessionId: 's1', parentSessionId: 'p1' })
    bus.fire('subagents:child:disposed', { sessionId: 's1' })

    assert.deepEqual(
      events.map(event => [event.phase, event.sessionId, event.parentSessionId]),
      [
        ['created', 's1', 'p1'],
        ['bound', 's1', 'p1'],
        ['disposed', 's1', null],
      ],
    )
  })

  it('stops forwarding once every channel is unsubscribed', () => {
    const bus = fakeBus()
    const events: JsonObject[] = []
    for (const unsub of forwardChildSessionEvents(bus, event => events.push(event))) unsub()

    bus.fire('subagents:child:session-created', { sessionId: 's1' })

    assert.deepEqual(events, [])
  })

  it('ignores unrelated channels', () => {
    const bus = fakeBus()
    const events: JsonObject[] = []
    forwardChildSessionEvents(bus, event => events.push(event))

    bus.fire('some:other:channel', { sessionId: 's1' })

    assert.deepEqual(events, [])
  })
})
