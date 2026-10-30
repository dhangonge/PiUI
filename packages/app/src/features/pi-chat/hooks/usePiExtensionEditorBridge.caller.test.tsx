// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryContext, type DirectoryContextValue } from '../../../contexts/DirectoryContext.shared'
import { SessionContext, type SessionContextValue } from '../../../contexts/SessionContext.shared'
import { serverStore } from '../../../store/serverStore'

/**
 * 调用方接线（不是 hook 内部逻辑）：PiChatPane 真的把 session / server 的
 * 切换传到了桥接层——切换后挂起的输入同步防抖被取消，不会写进旧会话。
 *
 * 用真实 PiChatPane + 真实桥接 hook + 真实 InputBox，只替换传输层入口。
 * harness 成本：三个 context + serverStore 种子；不需要 mock 子组件。
 */

const { setEditorStateMock, invokeMock } = vi.hoisted(() => ({
  setEditorStateMock: vi.fn(),
  invokeMock: vi.fn(),
}))

// 传输层只替换命令入口，其余（getProjectTrust 等）保留真实实现
vi.mock('../../../pi/transport/index.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../pi/transport/index.js')>()
  return { ...actual, invokePiCommand: (...args: unknown[]) => invokeMock(...args) }
})

vi.mock('../../../pi/controllers/index.js', () => {
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    abortPiOperation: noop,
    abortPiCompaction: noop,
    compactPiSession: noop,
    cyclePiModel: noop,
    cyclePiThinkingLevel: noop,
    executePiBash: noop,
    exportPiSession: noop,
    forkPiSession: noop,
    importPiSession: noop,
    loadMorePiBranchEntries: noop,
    loadPiSessionRegistry: noop,
    logoutPiProvider: noop,
    refreshPiBranch: noop,
    refreshPiSessionState: noop,
    loadPiModels: noop,
    loadPiSessionData: noop,
    navigatePiTree: noop,
    newPiSessionFrom: noop,
    openPiSession: noop,
    reloadPiSessionResources: noop,
    renamePiSession: noop,
    sendPiPrompt: noop,
    sendPiUserMessage: noop,
    setPiProjectTrust: noop,
    setPiScopedModels: noop,
    startPiProviderAuth: noop,
    setPiExtensionEditorState: (...args: unknown[]) => setEditorStateMock(...args),
    setPiModel: noop,
    setPiThinkingLevel: noop,
    clearPiQueue: noop,
  }
})

const { PiChatPane } = await import('../PiChatPane')

/** 与 sessionKeyToServerId 一致：`<serverId>::<sessionId>` */
function sessionKey(serverId: string, sessionId: string) {
  return `${serverId}::${sessionId}`
}

const directoryValue: DirectoryContextValue = {
  currentDirectory: '/tmp/work',
  setCurrentDirectory: () => undefined,
  savedDirectories: [],
  addDirectory: () => undefined,
  removeDirectory: () => undefined,
  reorderDirectories: () => undefined,
  sidebarExpanded: false,
  setSidebarExpanded: () => undefined,
  recentProjects: {},
}

const sessionValue: SessionContextValue = {
  sessions: [],
  isLoading: false,
  isLoadingMore: false,
  hasMore: false,
  search: '',
  setSearch: () => undefined,
  refresh: () => Promise.resolve(),
  loadMore: () => Promise.resolve(),
  createSession: () => Promise.reject(new Error('not used')),
  registerSession: () => undefined,
  deleteSession: () => Promise.resolve(),
}

type PaneProps = ComponentProps<typeof PiChatPane>

function Harness({ sessionId }: { sessionId: string | undefined }) {
  return createElement(
    DirectoryContext.Provider,
    { value: directoryValue },
    createElement(
      SessionContext.Provider,
      { value: sessionValue },
      createElement(PiChatPane, { paneId: 'pane-1', sessionId, isFocused: true, paneCount: 1 } as PaneProps),
    ),
  )
}

/** 两台服务器各注册一次，返回 store 分配的真实 id（会话键要按它们拼） */
function seedServers(): { a: string; b: string } {
  const a = serverStore.addServer({ name: 'A', url: 'http://a.test', token: 'ta' })
  const b = serverStore.addServer({ name: 'B', url: 'http://b.test', token: 'tb' })
  return { a: a.id, b: b.id }
}

function composer(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/./) as HTMLTextAreaElement
}

describe('PiChatPane -> editor bridge wiring', () => {
  beforeEach(() => {
    setEditorStateMock.mockReset()
    setEditorStateMock.mockResolvedValue(undefined)
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(null)
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels the pending editor sync when the pane switches session', () => {
    const { a: SERVER_A } = seedServers()
    vi.useFakeTimers()
    const { rerender } = render(createElement(Harness, { sessionId: sessionKey(SERVER_A, 'session-1') }))

    fireEvent.change(composer(), { target: { value: 'draft text' } })
    expect(setEditorStateMock).not.toHaveBeenCalled()

    act(() => {
      rerender(createElement(Harness, { sessionId: sessionKey(SERVER_A, 'session-2') }))
    })
    act(() => vi.advanceTimersByTime(1000))

    // 不变量：旧会话这条挂起的同步必须被取消——它绝不会写到旧会话上。
    // （InputBox 会以新会话重排一次防抖，所以新会话仍会收到当前文本，
    //  这是既有行为，见下一条断言；取消的判定点在 hook 层测试里。）
    expect(setEditorStateMock.mock.calls).not.toContainEqual([sessionKey(SERVER_A, 'session-1'), 'draft text'])
    expect(setEditorStateMock).toHaveBeenCalledTimes(1)
    expect(setEditorStateMock).toHaveBeenCalledWith(sessionKey(SERVER_A, 'session-2'), 'draft text')
  })

  it('keeps the pending editor sync when nothing switches (control case)', () => {
    const { a: SERVER_A } = seedServers()
    vi.useFakeTimers()
    render(createElement(Harness, { sessionId: sessionKey(SERVER_A, 'session-1') }))

    fireEvent.change(composer(), { target: { value: 'draft text' } })
    act(() => vi.advanceTimersByTime(1000))

    // 对照组：同一会话下防抖照常落库（证明上面的取消不是「一直不发」）
    expect(setEditorStateMock).toHaveBeenCalledWith(sessionKey(SERVER_A, 'session-1'), 'draft text')
  })

  it('cancels the pending editor sync when the bound server changes under the same session id', () => {
    const { a: SERVER_A, b: SERVER_B } = seedServers()
    vi.useFakeTimers()
    const { rerender } = render(createElement(Harness, { sessionId: sessionKey(SERVER_A, 'session-1') }))

    fireEvent.change(composer(), { target: { value: 'draft text' } })
    act(() => {
      rerender(createElement(Harness, { sessionId: sessionKey(SERVER_B, 'session-1') }))
    })
    act(() => vi.advanceTimersByTime(1000))

    // 服务器切换：旧服务器的会话绝不能收到这条草稿
    expect(setEditorStateMock.mock.calls).not.toContainEqual([sessionKey(SERVER_A, 'session-1'), 'draft text'])
    expect(setEditorStateMock).toHaveBeenCalledTimes(1)
    expect(setEditorStateMock).toHaveBeenCalledWith(sessionKey(SERVER_B, 'session-1'), 'draft text')
  })
})
