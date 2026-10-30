import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import {
  EDITOR_SYNC_DEBOUNCE_MS,
  usePiExtensionEditorBridge,
  type PiExtensionEditorBridgeOptions,
} from './usePiExtensionEditorBridge'

const { setEditorStateMock } = vi.hoisted(() => ({ setEditorStateMock: vi.fn() }))

vi.mock('../../../pi/controllers/index.js', () => ({
  setPiExtensionEditorState: (...args: unknown[]) => setEditorStateMock(...args),
}))

type BridgeProps = Pick<PiExtensionEditorBridgeOptions, 'sessionId' | 'resetKey'>

function renderBridge(
  initial: BridgeProps & { unavailable?: boolean; lastEditorText?: string } = { sessionId: 'session-1' },
) {
  const setEditorText = vi.fn()
  const inputBoxRef = { current: { setEditorText } }
  // PiChatPane 的持有方式：ref 在父层声明（更早的位置），hook 按引用读写
  const lastEditorTextRef = { current: initial.lastEditorText }
  const sessionUnavailableRef = { current: initial.unavailable ?? false }
  const rendered = renderHook(
    (props: BridgeProps) =>
      usePiExtensionEditorBridge({ ...props, inputBoxRef, lastEditorTextRef, sessionUnavailableRef }),
    {
      initialProps: { sessionId: initial.sessionId, resetKey: initial.resetKey } as BridgeProps,
    },
  )
  return { ...rendered, setEditorText, lastEditorTextRef, sessionUnavailableRef }
}

/** worker 侧的 state 刷新：标记来源为 'mirror' */
function restoreEditorText(sessionId: string, editorText: string) {
  act(() => {
    extensionUiStore.restore(sessionId, { patches: [], editorText, toolsExpanded: false })
  })
}

/** 扩展真实发出的 editor set/paste：标记来源为 'extension' */
function extensionSetEditorText(sessionId: string, text: string) {
  act(() => {
    extensionUiStore.editorCommand(sessionId, { kind: 'set', text })
  })
}

describe('usePiExtensionEditorBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setEditorStateMock.mockReset()
    setEditorStateMock.mockResolvedValue(undefined)
    extensionUiStore.reset()
  })

  afterEach(() => {
    extensionUiStore.reset()
    vi.useRealTimers()
  })

  describe('composer -> worker debounce', () => {
    it('ignores the mount echo and only syncs real input after the debounce window', () => {
      const { result } = renderBridge()

      act(() => result.current.handleTextChange(''))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).not.toHaveBeenCalled()

      act(() => result.current.handleTextChange('hi'))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS - 1))
      expect(setEditorStateMock).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(1))
      expect(setEditorStateMock).toHaveBeenCalledTimes(1)
      expect(setEditorStateMock).toHaveBeenCalledWith('session-1', 'hi')
    })

    it('coalesces rapid edits into one trailing sync', () => {
      const { result } = renderBridge()

      act(() => result.current.handleTextChange('a'))
      act(() => vi.advanceTimersByTime(100))
      act(() => result.current.handleTextChange('ab'))
      act(() => vi.advanceTimersByTime(100))
      act(() => result.current.handleTextChange('abc'))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

      expect(setEditorStateMock).toHaveBeenCalledTimes(1)
      expect(setEditorStateMock).toHaveBeenCalledWith('session-1', 'abc')
    })

    it('does not sync while the session is unavailable', () => {
      const { result, sessionUnavailableRef } = renderBridge({ sessionId: 'session-1' })
      sessionUnavailableRef.current = true

      act(() => result.current.handleTextChange('typed'))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

      expect(setEditorStateMock).not.toHaveBeenCalled()
    })

    it('does not sync on home (no session)', () => {
      const { result } = renderBridge({ sessionId: null })

      act(() => result.current.handleTextChange('typed'))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

      expect(setEditorStateMock).not.toHaveBeenCalled()
    })

    it('cancels the pending sync when the session changes', () => {
      const { result, rerender } = renderBridge({ sessionId: 'session-1' })

      act(() => result.current.handleTextChange('draft for session-1'))
      rerender({ sessionId: 'session-2' })

      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).not.toHaveBeenCalled()
      // 新会话的输入照常同步
      act(() => result.current.handleTextChange('draft for session-2'))
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).toHaveBeenCalledWith('session-2', 'draft for session-2')
    })

    it('cancels the pending sync when the server changes (url/token under same session id)', () => {
      const { result, rerender } = renderBridge({ sessionId: 'session-1', resetKey: 'server-a|tok|url' })

      act(() => result.current.handleTextChange('draft on server-a'))
      rerender({ sessionId: 'session-1', resetKey: 'server-b|tok|url' })

      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).not.toHaveBeenCalled()
    })

    it('keeps the pending sync when the server key is unchanged', () => {
      const { result, rerender } = renderBridge({ sessionId: 'session-1', resetKey: 'server-a|tok|url' })

      act(() => result.current.handleTextChange('draft'))
      rerender({ sessionId: 'session-1', resetKey: 'server-a|tok|url' })
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

      expect(setEditorStateMock).toHaveBeenCalledWith('session-1', 'draft')
    })

    it('cancels the pending sync on unmount', () => {
      const { result, unmount } = renderBridge()

      act(() => result.current.handleTextChange('typed'))
      unmount()
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

      expect(setEditorStateMock).not.toHaveBeenCalled()
    })
  })

  describe('pre-send cleanup', () => {
    it('cancels the debounce before clearing the worker state, so the old text is never written back', () => {
      const { result } = renderBridge()

      act(() => result.current.handleTextChange('draft text'))
      act(() => result.current.clearExtensionEditorState('session-1'))

      // 顺序：先取消定时器，再立刻清空 worker 状态
      expect(setEditorStateMock).toHaveBeenCalledTimes(1)
      expect(setEditorStateMock).toHaveBeenNthCalledWith(1, 'session-1', '')

      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).toHaveBeenCalledTimes(1)
    })

    it('clears the session that actually receives the message (home first send)', () => {
      const { result } = renderBridge({ sessionId: null })

      act(() => result.current.clearExtensionEditorState('created-session'))

      expect(setEditorStateMock).toHaveBeenCalledWith('created-session', '')
    })
  })

  describe('mirror -> composer', () => {
    it('fills the composer from a mirror restore when the user has not typed', () => {
      const { setEditorText } = renderBridge()

      restoreEditorText('session-1', 'recovered text')

      expect(setEditorText).toHaveBeenCalledTimes(1)
      expect(setEditorText).toHaveBeenCalledWith('recovered text')
    })

    it('does not let a lagging mirror overwrite local input', () => {
      const { result, setEditorText } = renderBridge()

      act(() => result.current.handleTextChange('local edit'))
      // 本地输入还没同步到 worker（500ms 防抖窗口内），镜像仍是旧值
      restoreEditorText('session-1', 'stale')

      expect(setEditorText).not.toHaveBeenCalled()

      // 防抖窗口结束：写回 worker 的是本地文本，不是镜像
      act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))
      expect(setEditorStateMock).toHaveBeenCalledWith('session-1', 'local edit')
    })

    it('applies the mirror when it matches what the user typed', () => {
      const { result, setEditorText } = renderBridge()

      act(() => result.current.handleTextChange('same'))
      restoreEditorText('session-1', 'same')

      expect(setEditorText).toHaveBeenCalledWith('same')
    })

    it('lets real extension set/paste bypass the local-input guard', () => {
      const { result, setEditorText } = renderBridge()

      act(() => result.current.handleTextChange('local edit'))
      extensionSetEditorText('session-1', 'from extension')

      expect(setEditorText).toHaveBeenCalledTimes(1)
      expect(setEditorText).toHaveBeenCalledWith('from extension')
    })

    it('skips a mirror restore whose text is already known', () => {
      const { setEditorText } = renderBridge()

      extensionSetEditorText('session-1', 'known')
      expect(setEditorText).toHaveBeenCalledTimes(1)

      restoreEditorText('session-1', 'known')
      expect(setEditorText).toHaveBeenCalledTimes(1)
    })

    it('treats text already registered by the caller (fork seed) as applied', () => {
      const { setEditorText } = renderBridge({ sessionId: 'session-1', lastEditorText: 'seed text' })

      restoreEditorText('session-1', 'seed text')

      expect(setEditorText).not.toHaveBeenCalled()
    })

    it('ignores state of other sessions', () => {
      const { setEditorText } = renderBridge({ sessionId: 'session-1' })

      restoreEditorText('session-2', 'other session text')

      expect(setEditorText).not.toHaveBeenCalled()
    })
  })
})
