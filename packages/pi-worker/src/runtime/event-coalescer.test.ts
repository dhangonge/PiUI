import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createPiEventCoalescer,
  DEFAULT_MESSAGE_UPDATE_INTERVAL_MS,
  resolveMessageUpdateIntervalMs,
  type PiEventFrame,
} from './event-coalescer.ts'
import { stripDuplicatePartial } from './real-session.ts'
import type { JsonObject } from '@piui/protocol'

const realSetTimeout = globalThis.setTimeout
const delay = (ms: number) => new Promise<void>(resolve => realSetTimeout(resolve, ms))

let sequence = 0

/** assistantMessageEvent 的形状取自 SDK 的 AssistantMessageEvent（text_delta 变体） */
function messageUpdateFrame(text: string, revision = ++sequence): PiEventFrame {
  const message: JsonObject = {
    role: 'assistant',
    timestamp: 1_700_000_000_000,
    provider: 'faux',
    model: 'faux-1',
    stopReason: 'stop',
    content: [{ type: 'text', text }],
  }
  return {
    sessionId: 'session-1',
    meta: { epoch: 'epoch-1', sequence: revision, liveMessage: { id: 'live-1', revision } },
    event: {
      type: 'message_update',
      message,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text.slice(-1), partial: message },
    },
  }
}

function frame(type: string, sequence: number): PiEventFrame {
  return {
    sessionId: 'session-1',
    meta: { epoch: 'epoch-1', sequence },
    event: { type, message: { role: 'assistant', content: [] } },
  }
}

function collect() {
  const frames: PiEventFrame[] = []
  return { frames, send: (frame: PiEventFrame) => frames.push(frame) }
}

describe('stripDuplicatePartial', () => {
  it('drops the duplicated partial but keeps the rest of assistantMessageEvent', () => {
    const frame = messageUpdateFrame('hello')
    const before = JSON.stringify(frame.event.message).length
    stripDuplicatePartial(frame.event)
    const assistantEvent = frame.event.assistantMessageEvent as JsonObject
    assert.equal(assistantEvent.partial, undefined)
    assert.deepEqual(assistantEvent, { type: 'text_delta', contentIndex: 0, delta: 'o' })
    // message 本身原样保留：客户端只读它
    assert.deepEqual(frame.event.message, {
      role: 'assistant',
      timestamp: 1_700_000_000_000,
      provider: 'faux',
      model: 'faux-1',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'hello' }],
    })
    assert.ok(JSON.stringify(frame.event.assistantMessageEvent).length < before)
  })

  it('leaves other event types and partial-less updates alone', () => {
    const start: JsonObject = {
      type: 'message_start',
      message: { role: 'user' },
      assistantMessageEvent: { partial: 1 },
    }
    stripDuplicatePartial(start)
    assert.deepEqual(start.assistantMessageEvent, { partial: 1 })

    const malformed: JsonObject = { type: 'message_update', message: { role: 'assistant' } }
    stripDuplicatePartial(malformed)
    assert.deepEqual(malformed, { type: 'message_update', message: { role: 'assistant' } })
  })
})

describe('createPiEventCoalescer', () => {
  it('emits only the latest message_update once per window', async () => {
    const { frames, send } = collect()
    const coalescer = createPiEventCoalescer(send, { intervalMs: 40 })
    try {
      coalescer.push(messageUpdateFrame('a', 1))
      coalescer.push(messageUpdateFrame('ab', 2))
      coalescer.push(messageUpdateFrame('abc', 3))
      assert.equal(frames.length, 0, 'window must hold the frames back')
      await delay(80)
      assert.equal(frames.length, 1)
      const sent = frames[0]!
      assert.equal(sent.meta.sequence, 3)
      assert.equal(sent.meta.liveMessage?.revision, 3)
      assert.deepEqual((sent.event.message as JsonObject).content, [{ type: 'text', text: 'abc' }])
    } finally {
      coalescer.dispose()
    }
  })

  it('flushes the pending frame before any other event and keeps the order', async () => {
    const { frames, send } = collect()
    const coalescer = createPiEventCoalescer(send, { intervalMs: 40 })
    try {
      coalescer.push(messageUpdateFrame('a', 1))
      coalescer.push(messageUpdateFrame('ab', 2))
      coalescer.push(frame('message_end', 3))
      coalescer.push(frame('agent_settled', 4))
      assert.deepEqual(
        frames.map(item => [item.event.type, item.meta.sequence]),
        [
          ['message_update', 2],
          ['message_end', 3],
          ['agent_settled', 4],
        ],
      )
      // 已经 flush 过：定时器不该再补发一帧
      await delay(80)
      assert.equal(frames.length, 3)
    } finally {
      coalescer.dispose()
    }
  })

  it('flushes on dispose and leaves no timer behind', async () => {
    // 只统计「本模块武装的定时器」：用 id 追踪，测试/runner 自己创建的 timer 不干扰断言
    const live = new Set<unknown>()
    const realClearTimeout = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      const id = realSetTimeout(fn, ms)
      live.add(id)
      return id
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id: unknown) => {
      live.delete(id)
      return realClearTimeout(id as ReturnType<typeof setTimeout>)
    }) as typeof clearTimeout
    const { frames, send } = collect()
    try {
      const coalescer = createPiEventCoalescer(send, { intervalMs: 40 })
      live.clear()
      coalescer.push(messageUpdateFrame('a', 1))
      assert.equal(live.size, 1, 'pending frame arms exactly one timer')
      const firstTimer = [...live][0]
      coalescer.dispose()
      assert.deepEqual(
        frames.map(item => item.event.type),
        ['message_update'],
        'dispose must not drop the trailing frame',
      )
      assert.equal(live.has(firstTimer), false, 'dispose clears the armed timer')
      assert.equal(live.size, 0, 'no timer left after dispose')

      coalescer.push(messageUpdateFrame('ab', 2))
      await delay(60)
      assert.equal(frames.length, 1, 'pushes after dispose are ignored')

      // 自然到点后同样不能留定时器
      const fired = createPiEventCoalescer(send, { intervalMs: 20 })
      live.clear()
      fired.push(messageUpdateFrame('abc', 3))
      const secondTimer = [...live][0]
      await delay(60)
      assert.equal(frames.length, 2)
      assert.equal(live.has(secondTimer), false, 'timer cleared after it fired')
      assert.equal(live.size, 0, 'nothing armed at rest')
      fired.dispose()
    } finally {
      globalThis.setTimeout = realSetTimeout
      globalThis.clearTimeout = realClearTimeout
    }
  })

  it('treats message_start / message_end as ordered, non-coalesced frames', () => {
    const { frames, send } = collect()
    const coalescer = createPiEventCoalescer(send, { intervalMs: 40 })
    try {
      coalescer.push(frame('message_start', 1))
      coalescer.push(frame('message_start', 2))
      assert.equal(frames.length, 2, 'non message_update frames go out immediately')
    } finally {
      coalescer.dispose()
    }
  })
})

describe('resolveMessageUpdateIntervalMs', () => {
  it('defaults to 80ms and ignores sub-16ms / non-numeric overrides', () => {
    assert.equal(DEFAULT_MESSAGE_UPDATE_INTERVAL_MS, 80)
    assert.equal(resolveMessageUpdateIntervalMs(undefined), 80)
    assert.equal(resolveMessageUpdateIntervalMs(''), 80)
    assert.equal(resolveMessageUpdateIntervalMs('abc'), 80)
    assert.equal(resolveMessageUpdateIntervalMs('15'), 80)
    assert.equal(resolveMessageUpdateIntervalMs('-5'), 80)
    assert.equal(resolveMessageUpdateIntervalMs('16'), 16)
    assert.equal(resolveMessageUpdateIntervalMs(' 50 '), 50)
    assert.equal(resolveMessageUpdateIntervalMs(120), 120)
  })
})
