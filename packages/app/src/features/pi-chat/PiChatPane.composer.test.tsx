// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEntry } from '@earendil-works/pi-coding-agent'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { PiBranchPage } from '../../pi/domain/index.js'
import type { InputBoxProps } from '../chat/InputBox'
import { PiChatPane } from './PiChatPane'
import { extensionUiStore } from '../../pi/extensionUiStore'
import { redoPlanStore } from '../../pi/redoPlanStore'
import { clearSessionEditorDraft, setSessionEditorDraft } from '../../pi/sessionEditorDraftStore'
import i18n from '../../i18n'

/**
 * PiChatPane → InputBox 的 prop 边界。
 *
 * InputBox 是 memo 组件：任何一项 prop 引用变化都会整块重渲染。这里用真实的
 * PiChatPane 接线（store 订阅、effect、Task/队列/编辑桥接 hook 全是真代码），
 * 只把三样东西换成测试替身：
 * - `InputBox` → memo spy（记录每次渲染收到的完整 props，用真实 InputBoxProps 类型）
 * - `ChatArea` → memo spy（记录 props，让测试能推动滚动 / onAtBottomChange）
 * - 数据出口（pi/hooks、controllers、eventStream、contexts）→ 可控的假实现
 *
 * 断言方式：比较「边界上每个 prop 的 Object.is」+ memo spy 的渲染计数，而不是
 * 只断言某一个 useMemo。渲染计数只代表合成环境里的组件提交次数，不是真机
 * 输入延迟或 P95。
 */

const rt = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const store = {
    models: [] as unknown,
    modelsLoading: false,
    branch: null as unknown,
    branchError: null as unknown,
    sessionState: null as unknown,
    sessionInfos: [] as unknown,
    activeEntry: undefined as unknown,
    activeServer: null as unknown,
    servers: [] as unknown,
    currentDirectory: '/work' as string | undefined,
    sessions: [] as unknown,
  }
  return {
    store,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit() {
      for (const listener of [...listeners]) listener()
    },
    reset() {
      for (const listener of [...listeners]) listener()
      listeners.clear()
      Object.assign(store, {
        models: [],
        modelsLoading: false,
        branch: null,
        branchError: null,
        sessionState: null,
        sessionInfos: [],
        activeEntry: undefined,
        activeServer: null,
        servers: [],
        currentDirectory: '/work',
        sessions: [],
      })
    },
  }
})

/** InputBox / ChatArea 的每次渲染都记进这里（按渲染顺序） */
const spy = vi.hoisted(() => ({
  inputBoxProps: [] as Array<Record<string, unknown>>,
  chatAreaProps: [] as Array<Record<string, unknown>>,
  scrollToBottomCalls: 0,
  openMenuCalls: 0,
  /** PiChatPane 的提交次数探针（Header 在 mock 里不 memo，每次父渲染都会被调用） */
  paneRenders: 0,
  /** usePiModels 收到的 server id 序列（服务切换接线） */
  modelServerIds: [] as Array<string | null | undefined>,
}))

const ctl = vi.hoisted(() => {
  const asyncStub = () => vi.fn(async () => undefined)
  return {
    abortPiCompaction: asyncStub(),
    abortPiOperation: asyncStub(),
    cyclePiModel: asyncStub(),
    cyclePiThinkingLevel: asyncStub(),
    refreshPiSessionState: asyncStub(),
    refreshPiBranch: asyncStub(),
    loadPiModels: asyncStub(),
    loadPiSessionData: asyncStub(),
    loadMorePiBranchEntries: asyncStub(),
    loadPiSessionRegistry: vi.fn(async () => ({ commands: [] })),
    sendPiUserMessage: asyncStub(),
    sendPiPrompt: asyncStub(),
    clearPiQueue: asyncStub(),
    setPiExtensionEditorState: asyncStub(),
    setPiModel: asyncStub(),
    setPiThinkingLevel: asyncStub(),
    forkPiSession: vi.fn(async () => ({ cancelled: false })),
    navigatePiTree: vi.fn(async () => ({ cancelled: false })),
    openPiSession: vi.fn(async () => ({ sessionId: null })),
    newPiSessionFrom: vi.fn(async () => ({})),
    importPiSession: vi.fn(async () => ({})),
    exportPiSession: asyncStub(),
    compactPiSession: asyncStub(),
    executePiBash: asyncStub(),
    logoutPiProvider: asyncStub(),
    renamePiSession: asyncStub(),
    reloadPiSessionResources: asyncStub(),
    setPiProjectTrust: asyncStub(),
    setPiScopedModels: asyncStub(),
    startPiProviderAuth: asyncStub(),
  }
})

const copyTextToClipboard = vi.hoisted(() => vi.fn(async (_text: string) => true))

vi.mock('../chat/index.js', async () => {
  const React = await import('react')
  const InputBoxSpy = React.memo(
    React.forwardRef(function InputBoxSpy(props: Record<string, unknown>, ref: React.Ref<unknown>) {
      spy.inputBoxProps.push(props)
      React.useImperativeHandle(ref, () => ({ setEditorText: () => {} }), [])
      return React.createElement('div', { 'data-testid': 'inputbox-spy' })
    }),
  )
  const ChatAreaSpy = React.memo(
    React.forwardRef(function ChatAreaSpy(props: Record<string, unknown>, ref: React.Ref<unknown>) {
      spy.chatAreaProps.push(props)
      React.useImperativeHandle(ref, () => ({ scrollToBottom: () => spy.scrollToBottomCalls++ }), [])
      return React.createElement('div', { 'data-testid': 'chatarea-spy' })
    }),
  )
  // PiChatPane 把 modelSelectorRef 交给 Header（Header 内部挂 ModelSelector）：
  // 这里照真实接线挂一个假句柄，用来验证 onOpenModelSelector 的去向。
  const HeaderSpy = function HeaderSpy(props: Record<string, unknown>) {
    spy.paneRenders++
    const selectorRef = props.modelSelectorRef as React.RefObject<{ openMenu: () => void } | null>
    React.useEffect(() => {
      selectorRef.current = { openMenu: () => spy.openMenuCalls++ }
      return () => {
        selectorRef.current = null
      }
    }, [selectorRef])
    return null
  }
  return {
    InputBox: InputBoxSpy,
    ChatArea: ChatAreaSpy,
    Header: HeaderSpy,
  }
})

vi.mock('../chat/ExtensionUiDialogHost.js', async () => {
  const React = await import('react')
  return {
    ExtensionUiDialogHost: ({
      collapsed,
      onCollapsedChange,
    }: {
      collapsed: boolean
      onCollapsedChange: (collapsed: boolean) => void
    }) =>
      React.createElement('button', {
        'data-testid': 'toggle-dialog-collapse',
        onClick: () => onCollapsedChange(!collapsed),
      }),
  }
})

vi.mock('../../pi/hooks/index.js', async () => {
  const React = await import('react')
  const useStoreSnapshot = <T,>(pick: () => T): T => React.useSyncExternalStore(rt.subscribe, pick, pick)
  return {
    useFocusedSessionId: () => null,
    useFocusedSessionHasEntries: () => false,
    usePiSessionTodos: () => [],
    usePiSessionInfos: () => useStoreSnapshot(() => rt.store.sessionInfos),
    usePiBranchData: () => useStoreSnapshot(() => rt.store.branch),
    usePiBranchLoading: () => false,
    usePiBranchError: () => useStoreSnapshot(() => rt.store.branchError),
    usePiSessionRuntimeState: () => useStoreSnapshot(() => rt.store.sessionState),
    usePiModels: (serverId?: string | null) => {
      spy.modelServerIds.push(serverId)
      return {
        models: useStoreSnapshot(() => rt.store.models),
        isLoading: useStoreSnapshot(() => rt.store.modelsLoading),
      }
    },
    usePiSessionTitle: () => null,
  }
})

vi.mock('../../store/activeSessionStore', async () => {
  const React = await import('react')
  return {
    useSessionActiveEntry: () =>
      React.useSyncExternalStore(
        rt.subscribe,
        () => rt.store.activeEntry,
        () => undefined,
      ),
  }
})

vi.mock('../../hooks/useServerStore', async () => {
  const React = await import('react')
  return {
    useServerStore: () => ({
      activeServer: React.useSyncExternalStore(
        rt.subscribe,
        () => rt.store.activeServer,
        () => null,
      ),
      servers: React.useSyncExternalStore(
        rt.subscribe,
        () => rt.store.servers,
        () => [],
      ),
    }),
  }
})

vi.mock('../../contexts/useDirectory', () => ({
  useDirectory: () => ({
    currentDirectory: rt.store.currentDirectory,
    addDirectory: async () => undefined,
  }),
}))

vi.mock('../../contexts/useSessionContext', async () => {
  const React = await import('react')
  return {
    useSessionContext: () => ({
      sessions: React.useSyncExternalStore(
        rt.subscribe,
        () => rt.store.sessions,
        () => [],
      ),
      registerSession: () => undefined,
    }),
  }
})

vi.mock('../../pi/eventStream.js', () => ({
  piEventStream: { connect: vi.fn(), disconnect: vi.fn() },
}))

vi.mock('../../utils/clipboard', () => ({ copyTextToClipboard }))

vi.mock('./ProjectTrustPrompt', () => ({ ProjectTrustPrompt: () => null }))

vi.mock('../../pi/controllers/index.js', () => ctl)

// ============================================
// fixtures
// ============================================

const SESSION = 'session-1'
const SERVER = { id: 'server-a', url: 'http://a.test', token: 'ta', name: 'A' }

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...overrides,
  }
}

function assistantEntry(id: string, text: string): SessionEntry {
  return {
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as SessionEntry
}

function page(entries: SessionEntry[], leafId: string | null = null): PiBranchPage {
  return {
    head: {
      sdkVersion: '0.84.0',
      revision: entries.length,
      header: null,
      leafId: leafId ?? entries[entries.length - 1]?.id ?? null,
      entryCount: entries.length,
      epoch: 'epoch-1',
    },
    items: entries,
    beforeCursor: undefined,
    hasMore: false,
  }
}

interface RuntimeState {
  isStreaming: boolean
  model: { provider: string; id: string } | null
  thinkingLevel: string
  head: { epoch: string; leafId: string | null }
  contextUsage?: { contextWindow: number }
  queue?: { steering?: string[]; followUp?: string[] }
}

function runningState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    isStreaming: false,
    model: { provider: 'openai', id: 'fast' },
    thinkingLevel: 'off',
    head: { epoch: 'epoch-1', leafId: 'a1' },
    ...overrides,
  }
}

/** 一次 runtime store 推送（等价于一条事件 / 一个 token） */
function push(patch: Record<string, unknown>): void {
  act(() => {
    Object.assign(rt.store, patch)
    rt.emit()
  })
}

function seedSession(overrides: { state?: RuntimeState; branch?: PiBranchPage } = {}): void {
  rt.store.models = [model('fast'), model('vision', { input: ['text', 'image'], reasoning: true })]
  rt.store.sessionInfos = [{ id: SESSION, name: 'Session', cwd: '/work' }]
  rt.store.sessions = [{ id: SESSION, directory: '/work', title: 'Session' }]
  rt.store.servers = [SERVER]
  rt.store.activeServer = SERVER
  rt.store.branch = overrides.branch ?? page([assistantEntry('a1', 'first answer')])
  rt.store.sessionState = overrides.state ?? runningState()
  rt.store.activeEntry = undefined
  rt.store.modelsLoading = false
  rt.store.currentDirectory = '/work'
}

function renderPane(props: { sessionId?: string | null; isFocused?: boolean; paneCount?: number } = {}) {
  const element = (next: { sessionId?: string | null; isFocused?: boolean; paneCount?: number }) => (
    <PiChatPane
      paneId="pane-1"
      sessionId={next.sessionId === undefined ? SESSION : next.sessionId}
      isFocused={next.isFocused ?? false}
      paneCount={next.paneCount ?? 1}
    />
  )
  const initial = {
    sessionId: props.sessionId === undefined ? SESSION : props.sessionId,
    isFocused: props.isFocused,
    paneCount: props.paneCount,
  }
  const rendered = render(element(initial))
  return {
    ...rendered,
    rerenderPane: (next: { sessionId?: string | null; isFocused?: boolean; paneCount?: number }) =>
      rendered.rerender(element(next)),
  }
}

function lastProps(): InputBoxProps {
  const props = spy.inputBoxProps[spy.inputBoxProps.length - 1]
  if (!props) throw new Error('InputBox spy has not rendered')
  return props as unknown as InputBoxProps
}

function renderCount(): number {
  return spy.inputBoxProps.length
}

function changedProps(before: InputBoxProps, after: InputBoxProps): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed: string[] = []
  for (const key of keys) {
    const a = (before as unknown as Record<string, unknown>)[key]
    const b = (after as unknown as Record<string, unknown>)[key]
    if (!Object.is(a, b)) changed.push(key)
  }
  return changed
}

beforeEach(() => {
  rt.reset()
  seedSession()
  spy.inputBoxProps.length = 0
  spy.chatAreaProps.length = 0
  spy.scrollToBottomCalls = 0
  spy.openMenuCalls = 0
  spy.paneRenders = 0
  spy.modelServerIds.length = 0
  copyTextToClipboard.mockClear()
  for (const stub of Object.values(ctl)) stub.mockClear()
  extensionUiStore.reset()
  redoPlanStore.setPlan(SESSION, null)
  clearSessionEditorDraft(SESSION)
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  await i18n.changeLanguage('en')
})

// ============================================
// 父级无关更新：整个 prop 边界保持稳定
// ============================================

describe('PiChatPane composer boundary: unrelated updates', () => {
  it('keeps every InputBox prop referentially stable across a parent re-render', () => {
    const { rerenderPane } = renderPane()
    expect(renderCount()).toBe(1)
    const before = lastProps()

    // 父层换了一个与输入区无关的 prop（分栏高亮），并再渲染一次
    rerenderPane({ isFocused: true })
    rerenderPane({ isFocused: false })

    expect(renderCount()).toBe(1)
    expect(changedProps(before, lastProps())).toEqual([])
  })

  it('does not re-render InputBox when a streaming token replaces the timeline', () => {
    renderPane()
    const before = lastProps()
    const chatAreaRendersBefore = spy.chatAreaProps.length

    // 一条 assistant 条目落定 + 新的 branch page：PiChatPane 自己必须重渲染
    push({ branch: page([assistantEntry('a1', 'first answer'), assistantEntry('a2', 'second answer')]) })

    expect(spy.chatAreaProps.length).toBeGreaterThan(chatAreaRendersBefore)
    expect(spy.chatAreaProps[spy.chatAreaProps.length - 1]?.items).toHaveLength(2)
    expect(renderCount()).toBe(1)
    expect(changedProps(before, lastProps())).toEqual([])
  })

  it('rebuilds the model catalog from the catalog store only (shallow copy, no deep comparator)', () => {
    renderPane()
    const before = lastProps()

    // 时间线 / 会话登记信息更新与模型目录无关：引用必须保持不变
    push({ branch: page([assistantEntry('a1', 'first answer'), assistantEntry('a2', 'second answer')]) })
    push({ sessionInfos: [{ id: SESSION, name: 'Renamed', cwd: '/work' }] })
    push({ sessions: [{ id: SESSION, directory: '/work', title: 'Renamed' }] })
    expect(renderCount()).toBe(1)
    expect(lastProps().models).toBe(before.models)

    // 模型目录本身刷新（新数组、内容相同）：props.models 换引用是设计选择——
    // 只做浅拷贝，不做内容级比较器；会带来一次输入区重渲染，但不改变选择态。
    push({ models: [model('fast'), model('vision', { input: ['text', 'image'], reasoning: true })] })
    expect(renderCount()).toBe(2)
    expect(lastProps().models?.map(item => item.id)).toEqual(['fast', 'vision'])
    expect(lastProps().selectedModelKey).toBe(before.selectedModelKey)
  })
})

// ============================================
// 每一项有意义的变化：必须越过 memo
// ============================================

describe('PiChatPane composer boundary: meaningful updates', () => {
  it('updates on session switch without disturbing the model catalog reference', () => {
    const { rerenderPane } = renderPane()
    const before = lastProps()

    rerenderPane({ sessionId: null })

    expect(renderCount()).toBe(2)
    const after = lastProps()
    expect(after.sessionId).toBeNull()
    expect(after.aboveComposer).not.toBe(before.aboveComposer)
    // 模型目录与输入区无关：引用保持不变
    expect(after.models).toBe(before.models)
    expect(after.fileCapabilities).toBe(before.fileCapabilities)
  })

  it('swallows controller failures from model / thinking cycling (no unhandled rejection)', async () => {
    renderPane()
    ctl.cyclePiModel.mockRejectedValueOnce(new Error('boom'))
    ctl.cyclePiThinkingLevel.mockRejectedValueOnce(new Error('boom'))

    await act(async () => {
      lastProps().onCycleModel?.('forward')
      lastProps().onCycleThinkingLevel?.()
      await Promise.resolve()
    })

    expect(ctl.cyclePiModel).toHaveBeenCalledWith(SESSION, 'forward')
    expect(ctl.cyclePiThinkingLevel).toHaveBeenCalledWith(SESSION)
    // 失败后不再刷新会话状态，且输入区仍然可用
    expect(ctl.refreshPiSessionState).not.toHaveBeenCalled()
    expect(lastProps().onCycleModel).toBeTypeOf('function')
  })

  it('updates streaming / compacting flags from runtime state', () => {
    renderPane()
    expect(lastProps().isStreaming).toBe(false)

    push({ sessionState: runningState({ isStreaming: true }) })
    expect(renderCount()).toBe(2)
    expect(lastProps().isStreaming).toBe(true)

    push({ activeEntry: { sessionId: SESSION, status: { type: 'compacting' } } })
    expect(renderCount()).toBe(3)
    expect(lastProps().isCompacting).toBe(true)
  })

  it('updates the model catalog props when the catalog really changes', () => {
    renderPane()
    const before = lastProps()
    expect(before.models?.map(item => item.id)).toEqual(['fast', 'vision'])

    push({
      models: [model('fast'), model('vision', { input: ['text', 'image'], reasoning: true }), model('slow')],
      modelsLoading: true,
    })

    const after = lastProps()
    expect(after.models).not.toBe(before.models)
    expect(after.models?.map(item => item.id)).toEqual(['fast', 'vision', 'slow'])
    expect(after.modelsLoading).toBe(true)
    // 已选中 fast（纯文本）时，图片能力只跟随当前模型而不是目录 → 引用不变
    expect(after.selectedModelKey).toBe('openai:fast')
    expect(after.fileCapabilities).toBe(before.fileCapabilities)
    expect(after.fileCapabilities?.image).toBe(false)
  })

  it('updates thinking variants, the selected model and image capability from runtime state', () => {
    renderPane()
    const before = lastProps()
    expect(before.selectedVariant).toBe('off')
    expect(before.fileCapabilities?.image).toBe(false)

    push({ sessionState: runningState({ model: { provider: 'openai', id: 'vision' }, thinkingLevel: 'high' }) })

    const after = lastProps()
    expect(after.selectedModelKey).toBe('openai:vision')
    expect(after.selectedVariant).toBe('high')
    expect(after.variants).toContain('high')
    // 选中的模型支持图片 → 能力对象必须换（否则发送前的附件判断会读旧值）
    expect(after.fileCapabilities).not.toBe(before.fileCapabilities)
    expect(after.fileCapabilities?.image).toBe(true)
  })

  it('surfaces redo state and keeps the redo callbacks stable across it', async () => {
    renderPane()
    const before = lastProps()
    expect(before.canRedo).toBe(false)

    act(() => {
      redoPlanStore.setPlan(SESSION, { epoch: 'epoch-1', undoLeafId: 'a1', checkpoints: ['a2', 'a3'], restored: 0 })
    })

    const after = lastProps()
    expect(after.canRedo).toBe(true)
    expect(after.revertSteps).toBe(2)
    expect(after.onRedo).not.toBe(before.onRedo)

    // 返回 undefined（不是 Promise）：沿用旧内联箭头 `() => void handleRedoStep()` 的边界
    let redoResult: unknown
    await act(async () => {
      redoResult = after.onRedo?.()
    })
    expect(redoResult).toBeUndefined()
    expect(ctl.navigatePiTree).toHaveBeenCalledWith(SESSION, { entryId: 'a2' })

    let redoAllResult: unknown
    await act(async () => {
      redoAllResult = after.onRedoAll?.()
    })
    expect(redoAllResult).toBeUndefined()
    expect(ctl.navigatePiTree).toHaveBeenLastCalledWith(SESSION, { entryId: 'a3' })
  })

  it('updates the undo text when a redo draft arrives', () => {
    renderPane()
    expect(lastProps().revertedText).toBeUndefined()

    act(() => {
      setSessionEditorDraft(SESSION, 'draft from undo', { sync: false })
    })

    expect(lastProps().revertedText).toBe('draft from undo')
  })

  it('updates scroll affordances from ChatArea at-bottom changes', () => {
    renderPane()
    expect(lastProps().isAtBottom).toBe(true)
    expect(lastProps().showScrollToBottom).toBe(false)

    act(() => {
      const onAtBottomChange = spy.chatAreaProps[spy.chatAreaProps.length - 1]?.onAtBottomChange as
        ((atBottom: boolean) => void) | undefined
      onAtBottomChange?.(false)
    })

    expect(lastProps().isAtBottom).toBe(false)
    expect(lastProps().showScrollToBottom).toBe(true)
  })
})

// ============================================
// 折叠胶囊 / 命令 / 中止：语义依赖
// ============================================

describe('PiChatPane composer boundary: collapsed dialogs', () => {
  it('builds the collapsed capsule from real pending dialogs and clears it on expand', () => {
    renderPane()
    expect(lastProps().collapsedPermission).toBeUndefined()

    act(() => {
      extensionUiStore.requestOpened({
        kind: 'confirm',
        requestId: 'r1',
        sessionId: SESSION,
        title: 'Allow bash?',
        createdAt: '2026-01-01T00:00:00.000Z',
        message: 'run rm',
      })
    })
    // 未折叠时仍然不生成胶囊
    expect(lastProps().collapsedPermission).toBeUndefined()

    fireEvent.click(document.querySelector('[data-testid="toggle-dialog-collapse"]') as HTMLElement)
    const capsule = lastProps().collapsedPermission
    expect(capsule).toMatchObject({ label: 'Allow bash?', queueLength: 1 })

    act(() => {
      capsule?.onExpand()
    })
    expect(lastProps().collapsedPermission).toBeUndefined()
  })

  it('updates the capsule when the queue length really changes', () => {
    renderPane()
    act(() => {
      extensionUiStore.requestOpened({
        kind: 'confirm',
        requestId: 'r1',
        sessionId: SESSION,
        title: 'Allow bash?',
        createdAt: '2026-01-01T00:00:00.000Z',
        message: 'run rm',
      })
    })
    fireEvent.click(document.querySelector('[data-testid="toggle-dialog-collapse"]') as HTMLElement)
    const before = lastProps().collapsedPermission
    expect(before?.queueLength).toBe(1)

    act(() => {
      extensionUiStore.requestOpened({
        kind: 'input',
        requestId: 'r2',
        sessionId: SESSION,
        title: 'Name?',
        createdAt: '2026-01-01T00:00:01.000Z',
      })
    })

    const after = lastProps().collapsedPermission
    expect(after).not.toBe(before)
    expect(after?.queueLength).toBe(2)
    expect(after?.label).toBe('Allow bash?')
  })
})

describe('PiChatPane composer boundary: callbacks keep real semantics', () => {
  it('routes abort to compaction while compacting and to the turn abort otherwise', () => {
    renderPane()
    lastProps().onAbort?.()
    expect(ctl.abortPiOperation).toHaveBeenCalledWith(SESSION)
    expect(ctl.abortPiCompaction).not.toHaveBeenCalled()

    push({ activeEntry: { sessionId: SESSION, status: { type: 'compacting' } } })
    const abort = lastProps().onAbort
    expect(abort).toBeTypeOf('function')
    abort?.()
    expect(ctl.abortPiCompaction).toHaveBeenCalledWith(SESSION)
  })

  it('routes scroll-to-bottom and model-selector intents to the pane handles', () => {
    renderPane()
    const props = lastProps()

    props.onScrollToBottom?.()
    props.onOpenModelSelector?.()

    expect(spy.scrollToBottomCalls).toBe(1)
    expect(spy.openMenuCalls).toBe(1)

    // 两个回调只依赖 ref，不随会话状态/时间线变化
    push({ branch: page([assistantEntry('a1', 'first answer'), assistantEntry('a2', 'second')]) })
    expect(lastProps().onScrollToBottom).toBe(props.onScrollToBottom)
    expect(lastProps().onOpenModelSelector).toBe(props.onOpenModelSelector)
  })

  it('cycles model and thinking level through the session-bound handlers', async () => {
    renderPane()
    const onCycleModel = lastProps().onCycleModel
    const onCycleThinkingLevel = lastProps().onCycleThinkingLevel

    await act(async () => {
      onCycleModel?.('forward')
      onCycleThinkingLevel?.()
    })

    expect(ctl.cyclePiModel).toHaveBeenCalledWith(SESSION, 'forward')
    expect(ctl.cyclePiThinkingLevel).toHaveBeenCalledWith(SESSION)
    expect(ctl.refreshPiSessionState).toHaveBeenCalledWith(SESSION)

    // 切到 home 后这些回调必须换引用并停止作用在旧会话上
    const { rerenderPane } = renderPane()
    rerenderPane({ sessionId: null })
    expect(lastProps().onCycleModel).not.toBe(onCycleModel)
    lastProps().onCycleModel?.('backward')
    expect(ctl.cyclePiModel).toHaveBeenCalledTimes(1)
  })

  it('dispatches slash commands to the latest handler without re-rendering InputBox', async () => {
    renderPane()
    const onCommand = lastProps().onCommand
    expect(onCommand).toBeTypeOf('function')

    // 新的 assistant 文本到达：InputBox 不重渲染，但 onCommand 必须看到它
    push({ branch: page([assistantEntry('a1', 'first answer'), assistantEntry('a2', 'latest answer')]) })
    expect(renderCount()).toBe(1)

    await act(async () => {
      await onCommand?.('/copy')
    })

    expect(copyTextToClipboard).toHaveBeenCalledTimes(1)
    expect(copyTextToClipboard.mock.calls[0]?.[0]).toContain('latest answer')
  })

  it('keeps the todo slot mounted with the same key while the session is unchanged', () => {
    renderPane()
    const slot = lastProps().aboveComposer
    push({ sessionState: runningState({ isStreaming: true }) })
    expect(lastProps().aboveComposer).toBe(slot)
    expect((slot as { key?: string }).key).toBe(`${SESSION}:todo`)
  })
})

// ============================================
// home / 空状态
// ============================================

describe('PiChatPane composer boundary: home', () => {
  it('follows the active server: new catalog in, memo boundary only changes with it', () => {
    rt.store.branch = null
    rt.store.sessionState = null
    rt.store.activeEntry = undefined
    renderPane({ sessionId: null })
    expect(renderCount()).toBe(1)
    expect(spy.modelServerIds).toContain('server-a')
    expect(lastProps().models?.map(item => item.id)).toEqual(['fast', 'vision'])

    // 切到另一台服务：模型目录跟着变，输入区必须看到新目录
    const serverB = { id: 'server-b', url: 'http://b.test', token: 'tb', name: 'B' }
    act(() => {
      rt.store.servers = [SERVER, serverB]
      rt.store.activeServer = serverB
      rt.store.models = [model('slow', { provider: 'anthropic' })]
      rt.emit()
    })

    expect(spy.modelServerIds).toContain('server-b')
    const props = lastProps()
    expect(props.models?.map(item => item.id)).toEqual(['slow'])
    expect(props.fileCapabilities?.image).toBe(false)
  })

  it('renders the composer on home with an empty, stable boundary', () => {
    rt.store.branch = null
    rt.store.sessionState = null
    rt.store.activeEntry = undefined
    const { rerenderPane } = renderPane({ sessionId: null })
    expect(renderCount()).toBe(1)
    const before = lastProps()
    expect(before.sessionId).toBeNull()
    expect(before.models?.map(item => item.id)).toEqual(['fast', 'vision'])

    rerenderPane({ sessionId: null })
    expect(renderCount()).toBe(1)
    expect(changedProps(before, lastProps())).toEqual([])
  })

  it('keeps the composer boundary stable across an app language change', async () => {
    renderPane()
    const before = lastProps()
    const paneRendersBefore = spy.paneRenders

    // 真的切语言：react-i18next 会重渲染所有 useTranslation 订阅方（PiChatPane 自己）
    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(i18n.language).toBe('zh-CN')
    expect(spy.paneRenders).toBeGreaterThan(paneRendersBefore)
    // InputBox 内部自己订阅语言，不需要父层换 prop 来重渲染
    expect(renderCount()).toBe(1)
    expect(changedProps(before, lastProps())).toEqual([])
  })

  it('no-ops session-scoped callbacks on home instead of calling controllers with a null session', async () => {
    rt.store.branch = null
    rt.store.sessionState = null
    rt.store.activeEntry = undefined
    renderPane({ sessionId: null })
    const props = lastProps()

    await act(async () => {
      props.onCycleModel?.('forward')
      props.onCycleThinkingLevel?.()
      props.onAbort?.()
    })

    expect(ctl.cyclePiModel).not.toHaveBeenCalled()
    expect(ctl.cyclePiThinkingLevel).not.toHaveBeenCalled()
    expect(ctl.abortPiOperation).not.toHaveBeenCalled()
    expect(ctl.abortPiCompaction).not.toHaveBeenCalled()
  })
})
