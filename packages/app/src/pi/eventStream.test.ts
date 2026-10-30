/**
 * handleSessionsUpdated 的替换语义测试：
 * - fork/new/import 等真实替换：清源 session 的 keyed store + 派发
 *   piui:session-replaced（pane 跟随新 session）。
 * - runtime-reuse（server 复用同目录空闲 runtime 的静默身份切换）：
 *   源 session 的磁盘数据与 pane 绑定都不变——不清 store、不派发
 *   session-replaced，只刷新会话列表。否则 paneLayoutStore.remapSession
 *   会把所有绑定源 session 的 pane 切走（分屏串扰）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { piEventStream } from './eventStream'
import { piBranchStore, piSessionStateStore, piCommandStore } from './state/index.js'
import type { PiBranchPage } from './domain/index.js'

/** piui:sessions-changed 的合并窗口是 250ms，这里推进稍多保证落地 */
const PAST_THROTTLE_MS = 300

// 触达私有方法做白盒测试（事件驱动路径需要 WS，单测直接调 handler）
type Handler = (payload: unknown) => void
const handle = (payload: unknown) =>
  (piEventStream as unknown as { handleSessionsUpdated: Handler }).handleSessionsUpdated(payload)

function fakeBranchPage(sessionId: string): PiBranchPage {
  return {
    head: {
      sdkVersion: 'test',
      revision: 1,
      header: null,
      leafId: null,
      entryCount: 0,
      epoch: `test:${sessionId}`,
    },
    items: [],
    hasMore: false,
  } as PiBranchPage
}

describe('handleSessionsUpdated replacement semantics', () => {
  let replacedEvents: unknown[] = []
  let changedCount = 0
  const onReplaced = (event: Event) => replacedEvents.push((event as CustomEvent).detail)
  const onChanged = () => {
    changedCount += 1
  }

  beforeEach(() => {
    vi.useFakeTimers()
    replacedEvents = []
    changedCount = 0
    window.addEventListener('piui:session-replaced', onReplaced)
    window.addEventListener('piui:sessions-changed', onChanged)
  })

  afterEach(() => {
    window.removeEventListener('piui:session-replaced', onReplaced)
    window.removeEventListener('piui:sessions-changed', onChanged)
    // 先摘监听再拆流：避免上一个用例的挂起 dispatch 计数到下一个用例
    piEventStream.disconnectAll()
    vi.clearAllTimers()
    piBranchStore.clear('session-a')
    piSessionStateStore.clear('session-a')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('runtime-reuse: keeps source keyed stores and does not emit session-replaced', () => {
    piBranchStore.setData('session-a', fakeBranchPage('session-a'))
    piSessionStateStore.setState('session-a', { isStreaming: false })
    const branchClear = vi.spyOn(piBranchStore, 'clear')
    const stateClear = vi.spyOn(piSessionStateStore, 'clear')
    const commandClear = vi.spyOn(piCommandStore, 'clearSession')

    handle({
      replaced: true,
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetCwd: '/tmp',
      reason: 'runtime-reuse',
    })

    // 源 session 的缓存数据保留：pane 继续显示磁盘预览，无闪烁
    expect(branchClear).not.toHaveBeenCalled()
    expect(stateClear).not.toHaveBeenCalled()
    expect(commandClear).not.toHaveBeenCalled()
    expect(piBranchStore.getData('session-a')).not.toBeNull()
    // pane 不跟随：不派发 session-replaced（App 的 remapSession 不会触发）
    expect(replacedEvents).toHaveLength(0)
    // 列表仍刷新（但要等合并窗口结束）
    vi.advanceTimersByTime(PAST_THROTTLE_MS)
    expect(changedCount).toBe(1)
  })

  it('user replacement (fork/new/import): clears source stores and emits session-replaced', () => {
    piBranchStore.setData('session-a', fakeBranchPage('session-a'))
    const branchClear = vi.spyOn(piBranchStore, 'clear')

    handle({
      replaced: true,
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetCwd: '/tmp',
    })

    expect(branchClear).toHaveBeenCalledWith('session-a')
    // pane 切换必须立即发生，不受列表刷新节流影响
    expect(replacedEvents).toHaveLength(1)
    expect(changedCount).toBe(0)
    expect(replacedEvents[0]).toMatchObject({
      sourceSessionId: 'session-a',
      targetSessionId: 'session-b',
    })
    vi.advanceTimersByTime(PAST_THROTTLE_MS)
    expect(changedCount).toBe(1)
  })

  it('coalesces a burst of sessions.updated into a single trailing refresh', () => {
    for (let i = 0; i < 5; i += 1) handle({ updated: true })
    expect(changedCount).toBe(0)
    vi.advanceTimersByTime(PAST_THROTTLE_MS)
    expect(changedCount).toBe(1)
  })

  it('always dispatches the last request, even one arriving late in the window', () => {
    handle({ updated: true })
    vi.advanceTimersByTime(200) // 窗口内还没到尾部
    handle({ updated: true })
    expect(changedCount).toBe(0)
    vi.advanceTimersByTime(PAST_THROTTLE_MS)
    expect(changedCount).toBe(1)

    // 下一波在新窗口里照常派发
    handle({ updated: true })
    vi.advanceTimersByTime(PAST_THROTTLE_MS)
    expect(changedCount).toBe(2)
  })

  it('flushes a pending refresh on teardown instead of dropping it', () => {
    handle({ updated: true })
    expect(changedCount).toBe(0)
    piEventStream.disconnectAll()
    expect(changedCount).toBe(1)
  })
})
