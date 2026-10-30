import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBackClose } from './useBackClose'

/**
 * 行为契约测试（对 48344fd3 的原实现成立，不是新实现的设计目标）。
 *
 * jsdom 的 history 遍历是异步任务（`back()` 内部 `setTimeout(…, 0)`），
 * 且 `pushState` 会清空待执行的 traversal 任务。因此每个断言前都要把
 * 任务队列跑干，不能假设 popstate 同步到达。
 */

const BACK_CLOSE_KEY = '__piuiBackClose'

type HookHandle = RenderHookResult<unknown, { open: boolean }>

let handles: HookHandle[] = []

function mountBackClose(open: boolean, onClose: () => void): HookHandle {
  const handle = renderHook(({ open: isOpen }: { open: boolean }) => useBackClose(isOpen, onClose), {
    initialProps: { open },
  }) as HookHandle
  handles.push(handle)
  return handle
}

async function flushHistoryTasks(ticks = 6) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    }
  })
}

function dispatchPopState(state: unknown) {
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate', { state }))
  })
}

/**
 * 把 hook 的模块级状态（栈、historyEntryActive、ignoreNextPopState）恢复到
 * 「无叠加层、当前 history 状态不是 back-close」。
 *
 * 只 unmount 并清 history.state 不够：一次被 pushState 取消掉的 traversal 会
 * 让 ignoreNextPopState 保持 true，泄漏到下一个测试并吞掉它第一次 popstate。
 * 显式派发一个非 back-close 的 popstate 会把两个开关都归零（此时栈为空，
 * closeTopEntry 是空操作）。
 */
async function resetBackCloseState() {
  for (const handle of handles) handle.unmount()
  handles = []
  await flushHistoryTasks()
  window.history.replaceState(null, '')
  dispatchPopState(null)
  await flushHistoryTasks()
  window.history.replaceState(null, '')
}

describe('useBackClose', () => {
  beforeEach(async () => {
    await resetBackCloseState()
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await resetBackCloseState()
  })

  it('pushes one back-close history entry when opened and reuses it across re-renders', async () => {
    const pushState = vi.spyOn(History.prototype, 'pushState')
    const onClose = vi.fn()

    mountBackClose(true, onClose)
    await flushHistoryTasks()

    expect(pushState).toHaveBeenCalledTimes(1)
    expect(window.history.state).toMatchObject({ [BACK_CLOSE_KEY]: true })

    // onClose 变化会触发 effect 重跑，但已经压入的 history 条目不能被重复压栈。
    for (let i = 0; i < 3; i++) {
      const handle = handles[0]
      act(() => handle.rerender({ open: true }))
    }
    await flushHistoryTasks()

    expect(pushState).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not close when the history entry it pushed itself is traversed', async () => {
    const onClose = vi.fn()
    mountBackClose(true, onClose)
    await flushHistoryTasks()

    // back-close 状态的 popstate 只用来确认条目仍在，不应关闭任何东西。
    dispatchPopState({ [BACK_CLOSE_KEY]: true })
    await flushHistoryTasks()

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the overlay and returns to the previous history state on user back', async () => {
    const onClose = vi.fn()
    mountBackClose(true, onClose)
    await flushHistoryTasks()

    act(() => window.history.back())
    await flushHistoryTasks()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(window.history.state).toBeNull()
  })

  it('closes only the top overlay and re-arms the entry for the next back', async () => {
    const bottomClose = vi.fn()
    const topClose = vi.fn()
    mountBackClose(true, bottomClose)
    mountBackClose(true, topClose)
    await flushHistoryTasks()

    act(() => window.history.back())
    await flushHistoryTasks()

    // 后压栈的才是顶层：一次返回只关一层。
    expect(topClose).toHaveBeenCalledTimes(1)
    expect(bottomClose).not.toHaveBeenCalled()

    // 关掉顶层后必须重新压入 back-close 条目，否则第二次返回会直接退出页面。
    expect(window.history.state).toMatchObject({ [BACK_CLOSE_KEY]: true })
    expect(handles[1]).toBeTruthy()

    act(() => handles[1].unmount())
    await flushHistoryTasks()

    act(() => window.history.back())
    await flushHistoryTasks()

    expect(bottomClose).toHaveBeenCalledTimes(1)
    expect(topClose).toHaveBeenCalledTimes(1)
    expect(window.history.state).toBeNull()
  })

  it('does not call onClose when the overlay is closed programmatically', async () => {
    const onClose = vi.fn()
    const back = vi.spyOn(History.prototype, 'back')

    const handle = mountBackClose(true, onClose)
    await flushHistoryTasks()

    act(() => handle.rerender({ open: false }))
    await flushHistoryTasks()

    expect(onClose).not.toHaveBeenCalled()
    // 自己压入的条目必须自己回退，否则历史里会留下一个死条目。
    expect(back).toHaveBeenCalledTimes(1)
    expect(window.history.state).toBeNull()
  })

  it('swallows exactly one late popstate after a programmatic close', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const back = vi.spyOn(History.prototype, 'back')

    const handle = mountBackClose(true, onClose)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    act(() => handle.rerender({ open: false }))
    // 只推进清理定时器：back() 的 traversal 任务被后续 pushState 取消，
    // 于是 ignoreNextPopState 保持 armed（见文件头注释）。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(back).toHaveBeenCalledTimes(1)

    const reopened = vi.fn()
    mountBackClose(true, reopened)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(window.history.state).toMatchObject({ [BACK_CLOSE_KEY]: true })

    // 迟到的合成 popstate 落在新开的叠加层上，但属于上一次回退，必须被忽略。
    dispatchPopState(null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reopened).not.toHaveBeenCalled()

    // 只吞一次：用户真正的下一次返回仍然要能关闭。
    dispatchPopState(null)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(reopened).toHaveBeenCalledTimes(1)
  })

  it('cleans up on unmount without closing and rewinds its own history entry', async () => {
    const onClose = vi.fn()
    const back = vi.spyOn(History.prototype, 'back')

    const handle = mountBackClose(true, onClose)
    await flushHistoryTasks()

    act(() => handle.unmount())
    handles = handles.filter(item => item !== handle)
    await flushHistoryTasks()

    expect(onClose).not.toHaveBeenCalled()
    expect(back).toHaveBeenCalledTimes(1)
    // artifact 卸载后，任何残留 popstate 都不能再回调到已卸载的 onClose。
    dispatchPopState(null)
    await flushHistoryTasks()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('survives rapid open/close toggles without extra history entries or stray closes', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const pushState = vi.spyOn(History.prototype, 'pushState')
    const back = vi.spyOn(History.prototype, 'back')

    const handle = mountBackClose(true, onClose)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(pushState).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i++) {
      act(() => handle.rerender({ open: false }))
      act(() => handle.rerender({ open: true }))
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // 快速开关期间既不该多压栈，也不该触发回退：清理定时器被重开取消。
    expect(pushState).toHaveBeenCalledTimes(1)
    expect(back).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    act(() => handle.unmount())
    handles = handles.filter(item => item !== handle)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(back).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('invokes the latest onClose callback after a re-render', async () => {
    const first = vi.fn()
    const second = vi.fn()

    const handle = mountBackClose(true, first)
    await flushHistoryTasks()

    act(() => handle.rerender({ open: true }))
    // onClose 通过 ref 转发：替换回调后应调用新的那个。
    const replacement = mountBackClose(true, second)
    await flushHistoryTasks()

    act(() => window.history.back())
    await flushHistoryTasks()
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    act(() => replacement.unmount())
    handles = handles.filter(item => item !== replacement)
    await flushHistoryTasks()
  })

  it('does not call a stale onClose after teardown', async () => {
    const onClose = vi.fn()
    const handle = mountBackClose(true, onClose)
    await flushHistoryTasks()

    act(() => handle.unmount())
    handles = handles.filter(item => item !== handle)
    await flushHistoryTasks()

    dispatchPopState(null)
    dispatchPopState({ [BACK_CLOSE_KEY]: true })
    await flushHistoryTasks()

    expect(onClose).not.toHaveBeenCalled()
  })
})
