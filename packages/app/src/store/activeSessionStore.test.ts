import { beforeEach, describe, expect, it } from 'vitest'
import { activeSessionStore } from './activeSessionStore'

describe('activeSessionStore scoped refresh handling', () => {
  beforeEach(() => {
    activeSessionStore.reset()
  })

  it('preserves existing busy child sessions when merging scoped status refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root', 'child'])
  })

  it('drops missing sessions on full status replacement refreshes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
      child: { type: 'busy' },
    })

    activeSessionStore.initialize({
      root: { type: 'busy' },
    })

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['root'])
  })

  it('keeps existing pending child requests during scoped pending refresh merges', () => {
    activeSessionStore.addPendingRequest('req-child', 'child', 'question', 'Need approval')

    activeSessionStore.mergePendingRequests([], [])

    expect(activeSessionStore.getBusySessions().map(entry => entry.sessionId)).toEqual(['child'])
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'Need approval',
    })
  })

  it('reuses the busySessions array reference when content is unchanged', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    activeSessionStore.setSessionMeta('root', 'Root', '/repo')

    const first = activeSessionStore.getBusySessionsSnapshot()
    activeSessionStore.mergeStatusRefresh({
      root: { type: 'busy' },
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).toBe(first)
    expect(second).toEqual([
      {
        sessionId: 'root',
        status: { type: 'busy' },
        title: 'Root',
        directory: '/repo',
        pendingAction: undefined,
      },
    ])
  })

  it('replaces the busySessions array reference when status content changes', () => {
    activeSessionStore.initialize({
      root: { type: 'busy' },
    })
    const first = activeSessionStore.getBusySessionsSnapshot()

    activeSessionStore.updateStatus('root', {
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
    const second = activeSessionStore.getBusySessionsSnapshot()

    expect(second).not.toBe(first)
    expect(second[0]?.status).toEqual({
      type: 'retry',
      attempt: 1,
      message: 'retrying',
      next: 1000,
    })
  })

  it('drops a replayed pending request after it has been replied', () => {
    // 症状：本地乐观回复清掉了 store，但 worker 侧回放的 pending / 迟到事件没清；
    // 下一次重放就把已回复的请求补回来，侧边栏徽标卡住不消失。
    activeSessionStore.addPendingRequest('req-1', 'local::root', 'permission', 'bash: rm -rf')
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'permission',
      description: 'bash: rm -rf',
    })

    activeSessionStore.resolvePendingRequest('req-1')

    activeSessionStore.addPendingRequest('req-1', 'local::root', 'permission', 'bash: rm -rf')

    expect(activeSessionStore.getBusySessions()).toEqual([])
  })

  it('still accepts a fresh request id after another one settled', () => {
    activeSessionStore.addPendingRequest('req-1', 'local::root', 'question', 'first')
    activeSessionStore.resolvePendingRequest('req-1')
    activeSessionStore.addPendingRequest('req-2', 'local::root', 'question', 'second')

    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'second',
    })
  })

  it('lets a pending snapshot revive a request the local side had settled', () => {
    // 快照是权威：它说还 pending 就要显示（本地乐观回复可能没真正生效），
    // 所以 settled 只拦 addPendingRequest，不拦 applyPendingSnapshot。
    activeSessionStore.addPendingRequest('req-1', 'local::root', 'permission', 'x')
    activeSessionStore.resolvePendingRequest('req-1')

    activeSessionStore.initializePendingRequests([{ id: 'req-1', sessionID: 'local::root', permission: 'bash' }], [])

    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'permission',
      description: 'bash',
    })
  })

  it('keeps the settled record bounded so old ids can come back', () => {
    for (let i = 0; i < 600; i++) {
      activeSessionStore.addPendingRequest(`req-${i}`, 'local::root', 'question', `q${i}`)
      activeSessionStore.resolvePendingRequest(`req-${i}`)
    }

    // 早期 id 已被 FIFO 挤掉，重放时按新请求处理
    activeSessionStore.addPendingRequest('req-0', 'local::root', 'question', 'again')
    expect(activeSessionStore.getBusySessions()[0]?.pendingAction).toEqual({
      type: 'question',
      description: 'again',
    })
  })
})
