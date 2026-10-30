import { act, render } from '@testing-library/react'
import { useEffect, useRef, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import type { InputBoxHandle } from '../../chat/index.js'
import { EDITOR_SYNC_DEBOUNCE_MS, usePiExtensionEditorBridge } from './usePiExtensionEditorBridge'

/**
 * 调用点接线：PiChatPane 里那段 hook 调用的参数派生（sessionId +
 * server 的 id/token/url → resetKey）与依赖变化 → 取消挂起同步。
 *
 * 说明（诚实边界）：这里是按 PiChatPane 调用点原样复刻的小 harness，
 * **不是**真实 PiChatPane 集成测试——组件树、context、控制器都没有参与。
 * 真实 PiChatPane 的调用点本身仍无自动化覆盖，靠命令行差审查。
 */

const { setEditorStateMock } = vi.hoisted(() => ({ setEditorStateMock: vi.fn() }))

vi.mock('../../../pi/controllers/index.js', () => ({
  setPiExtensionEditorState: (...args: unknown[]) => setEditorStateMock(...args),
}))

interface ServerLike {
  id: string
  url?: string
  token?: string
}

interface CallSiteProps {
  sessionId: string | null
  server: ServerLike | null
  /** 测试用：把 handleTextChange 交出去（等价于 InputBox 的 onTextChange） */
  onReady: (change: (text: string) => void) => void
}

/** 与 PiChatPane 相同形状的调用点（ref 位置、resetKey 派生都照抄） */
function PaneCallSite({ sessionId, server, onReady }: CallSiteProps) {
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  const sessionUnavailableRef = useRef(false)
  const inputBoxRef: RefObject<InputBoxHandle | null> = useRef(null)
  const activeServerKey = `${server?.id ?? ''}|${server?.token ?? ''}|${server?.url ?? ''}`
  const { handleTextChange } = usePiExtensionEditorBridge({
    sessionId,
    inputBoxRef,
    lastEditorTextRef,
    sessionUnavailableRef,
    resetKey: activeServerKey,
  })
  useEffect(() => onReady(handleTextChange), [onReady, handleTextChange])
  return null
}

const SERVER_A: ServerLike = { id: 'server-a', url: 'http://a.test', token: 'ta' }
const SERVER_B: ServerLike = { id: 'server-b', url: 'http://b.test', token: 'tb' }

function mountCallSite(initial: { sessionId: string | null; server: ServerLike | null }) {
  let change: ((text: string) => void) | null = null
  const onReady = (next: (text: string) => void) => {
    change = next
  }
  const rendered = render(<PaneCallSite {...initial} onReady={onReady} />)
  const type = (text: string) =>
    act(() => {
      if (!change) throw new Error('call site not mounted')
      change(text)
    })
  return { ...rendered, type }
}

describe('editor bridge call site (PiChatPane shape)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setEditorStateMock.mockReset()
    setEditorStateMock.mockResolvedValue(undefined)
    extensionUiStore.reset()
  })

  it('syncs the typed text to the current session when nothing switches', () => {
    const { type } = mountCallSite({ sessionId: 'session-1', server: SERVER_A })

    type('draft')
    act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

    expect(setEditorStateMock).toHaveBeenCalledWith('session-1', 'draft')
  })

  it('drops the pending sync when the session changes', () => {
    const { type, rerender } = mountCallSite({ sessionId: 'session-1', server: SERVER_A })

    type('draft')
    rerender(<PaneCallSite sessionId="session-2" server={SERVER_A} onReady={vi.fn()} />)
    act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

    expect(setEditorStateMock.mock.calls).toEqual([])
  })

  it('drops the pending sync when the endpoint (url/token) of the bound server changes', () => {
    const { type, rerender } = mountCallSite({ sessionId: 'session-1', server: SERVER_A })

    type('draft')
    rerender(<PaneCallSite sessionId="session-1" server={SERVER_B} onReady={vi.fn()} />)
    act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

    expect(setEditorStateMock.mock.calls).toEqual([])
  })

  it('drops the pending sync on unmount', () => {
    const { type, unmount } = mountCallSite({ sessionId: 'session-1', server: SERVER_A })

    type('draft')
    unmount()
    act(() => vi.advanceTimersByTime(EDITOR_SYNC_DEBOUNCE_MS))

    expect(setEditorStateMock.mock.calls).toEqual([])
  })
})
