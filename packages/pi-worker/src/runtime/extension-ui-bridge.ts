import { randomUUID } from 'node:crypto'
import type {
  ExtensionTuiAttach,
  ExtensionUiDialogRequest,
  ExtensionUiDialogResponse,
  ExtensionUiEditorCommand,
  ExtensionUiStatePatch,
  ExtensionUiSettlementReason,
} from '@piui/protocol'
import type { ExtensionUIContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type { Component, TUI, OverlayHandle, OverlayOptions } from '@earendil-works/pi-tui'
import { ExtensionTuiHost } from './extension-tui.js'
import { ExtensionThemeService, type ExtensionThemeOptions } from './extension-theme.js'
import { extensionDiagnostic } from './extension-diagnostics.js'
import { GuardedComponent } from './guarded-component.js'

const MAX_TEXT_LENGTH = 256 * 1024
const MAX_TITLE_LENGTH = 4 * 1024
const MAX_OPTIONS = 200
const MAX_WIDGET_LINES = 500

/** 状态镜像的 patch 上限：超出丢最老（覆盖式 patch，重放子序列仍一致）。 */
const MAX_STATE_MIRROR_PATCHES = 512

export type PiExtensionUiEvent =
  | { type: 'requested'; request: ExtensionUiDialogRequest }
  | { type: 'settled'; requestId: string; sessionId: string; reason: ExtensionUiSettlementReason }
  | { type: 'state'; sessionId: string; patch: ExtensionUiStatePatch }
  | { type: 'notify'; sessionId: string; message: string; notifyType?: 'info' | 'warning' | 'error' }
  | { type: 'editor'; sessionId: string; command: ExtensionUiEditorCommand }
  | { type: 'tuiAttach'; sessionId: string; attach: ExtensionTuiAttach }
  | { type: 'tuiDetach'; sessionId: string; key: string }
  | { type: 'tuiFrame'; sessionId: string; data: string }

interface PendingDialog {
  request: ExtensionUiDialogRequest
  resolve: (response: ExtensionUiDialogResponse) => void
  timer?: NodeJS.Timeout
  removeAbort?: () => void
}

export class ExtensionUiBridge {
  private readonly pending = new Map<string, PendingDialog>()
  private readonly listeners = new Set<(event: PiExtensionUiEvent) => void>()
  private editorText = ''
  private toolsExpanded = false
  /** 当前挂载的 offscreen TUI 面板（key → attach），刷新/重连恢复用。 */
  private readonly tuiPanels = new Map<string, ExtensionTuiAttach>()
  /**
   * 状态镜像：状态 patch 的追加式记录，供客户端刷新/重连后重建 status /
   * widget / working 指示等增量状态（这些值原本只存在前端内存里）。
   * cancelAll 时清空——会话替换/重载后新会话从零开始。
   */
  private stateMirror: ExtensionUiStatePatch[] = []
  private readonly compatibilityWarnings = new Set<string>()
  private readonly themes: ExtensionThemeService
  private activeCustom?: { cancel(): void }
  private diagnosticGeneration = 0

  constructor(
    private readonly getSessionId: () => string,
    private readonly getWorkerGeneration: () => string | undefined,
    themeOptions: ExtensionThemeOptions = {},
  ) {
    this.tuiHost = new ExtensionTuiHost(
      event => {
        const sessionId = this.getSessionId()
        if (event.type === 'attach') {
          this.tuiPanels.set(event.attach.key, event.attach)
          this.emit({ type: 'tuiAttach', sessionId, attach: event.attach })
        } else if (event.type === 'widget') {
          this.state({ kind: 'widget', key: event.key, lines: event.lines, placement: event.placement })
        } else if (event.type === 'detach') {
          if (this.tuiPanels.get(event.key)?.kind === 'widget') this.state({ kind: 'widget', key: event.key })
          this.tuiPanels.delete(event.key)
          this.emit({ type: 'tuiDetach', sessionId, key: event.key })
        } else if (event.type === 'error') {
          this.reportFailure(event.key, event.phase)
        } else {
          this.emit({ type: 'tuiFrame', sessionId, data: event.data })
        }
      },
      () => this.themes.current,
    )
    this.themes = new ExtensionThemeService(
      themeOptions,
      () => this.tuiHost.getFallbackTheme(),
      (key, message) => this.reportCompatibility(key, message),
    )
  }

  readonly context = this.createContext()
  private readonly tuiHost: ExtensionTuiHost

  onEvent(listener: (event: PiExtensionUiEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  respond(requestId: string, response: ExtensionUiDialogResponse): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    if (!('cancelled' in response)) {
      if (pending.request.kind === 'confirm' && !('confirmed' in response)) return false
      if (pending.request.kind !== 'confirm' && !('value' in response)) return false
      if (pending.request.kind === 'select' && 'value' in response && !pending.request.options.includes(response.value))
        return false
    }
    this.pending.delete(requestId)
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.emit({
      type: 'settled',
      requestId,
      sessionId: pending.request.sessionId,
      reason: 'cancelled' in response ? 'user_cancelled' : 'submitted',
    })
    pending.resolve(response)
    return true
  }

  setEditorState(text: string): void {
    this.editorText = text
  }

  /** Forward raw key input from the app into the offscreen extension TUI. */
  tuiInput(data: string): void {
    this.tuiHost.input(data)
  }

  /** Resize the offscreen extension TUI. */
  tuiResize(cols: number, rows: number): void {
    this.tuiHost.resize(cols, rows)
  }

  /** Ask the offscreen extension TUI for a full redraw frame. */
  tuiRedraw(): void {
    this.tuiHost.redraw()
  }

  /** Tear down all offscreen extension TUI panels (session replaced/reloaded). */
  resetTui(): void {
    this.activeCustom?.cancel()
    this.tuiHost.reset()
  }

  cancelAll(reason: ExtensionUiSettlementReason): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.resolve({ cancelled: true })
      this.emit({ type: 'settled', requestId, sessionId: pending.request.sessionId, reason })
    }
    this.pending.clear()
    this.resetTui()
    this.diagnosticGeneration++
    this.stateMirror = []
    this.compatibilityWarnings.clear()
    this.themes.reset()
  }

  /**
   * 未应答 dialog 请求快照。客户端刷新/重连后通过 state.get 带回重新
   * 渲染（请求仍挂在这里，扩展还在阻塞，数据没有丢）。
   */
  listPending(): ExtensionUiDialogRequest[] {
    return [...this.pending.values()].map(pending => pending.request)
  }

  /**
   * 状态镜像快照（patch 序列 + 编辑器文本 + 折叠状态）。客户端刷新后
   * 重放 patch 即可重建 status/widget/working 指示等增量 UI 状态。
   */
  getStateMirror(): { patches: ExtensionUiStatePatch[]; editorText: string; toolsExpanded: boolean } {
    return {
      patches: [...this.stateMirror],
      editorText: this.editorText,
      toolsExpanded: this.toolsExpanded,
    }
  }

  /**
   * 当前挂载的 offscreen TUI 面板清单。客户端刷新后重新 attach（组件在
   * worker 侧仍挂着），面板视图挂载时自会请求一次全量重绘取回画面。
   */
  listTuiPanels(): ExtensionTuiAttach[] {
    return [...this.tuiPanels.values()]
  }

  private createContext(): ExtensionUIContext {
    // Pi 以裸函数形式调用这些回调，这里必须捕获 bridge 实例。
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const bridge = this
    return {
      select(title, options, opts) {
        return bridge
          .dialog('select', { title, options }, opts)
          .then(response => ('value' in response && options.includes(response.value) ? response.value : undefined))
      },
      confirm(title, message, opts) {
        return bridge
          .dialog('confirm', { title, message }, opts)
          .then(response => ('confirmed' in response ? response.confirmed : false))
      },
      input(title, placeholder, opts) {
        return bridge
          .dialog('input', { title, placeholder }, opts)
          .then(response => ('value' in response ? response.value : undefined))
      },
      editor(title, prefill) {
        return bridge
          .dialog('editor', { title, prefill })
          .then(response => ('value' in response ? response.value : undefined))
      },
      notify(message, notifyType) {
        assertText('notification', message)
        bridge.emit({ type: 'notify', sessionId: bridge.getSessionId(), message, notifyType })
      },
      onTerminalInput() {
        bridge.reportCompatibility(
          'onTerminalInput',
          "Terminal key listeners are inactive in RPC mode; use the app's touch controls.",
        )
        return () => undefined
      },
      setStatus(key, text) {
        assertText('status key', key, MAX_TITLE_LENGTH)
        if (text !== undefined) assertText('status', text)
        bridge.state({ kind: 'status', key, text })
      },
      setWorkingMessage(message) {
        if (message !== undefined) assertText('working message', message)
        bridge.state({ kind: 'workingMessage', message })
      },
      setWorkingVisible(visible) {
        bridge.state({ kind: 'workingVisible', visible })
      },
      setWorkingIndicator(options) {
        if (options?.frames) assertStringArray('working indicator frames', options.frames, MAX_WIDGET_LINES)
        bridge.state({ kind: 'workingIndicator', frames: options?.frames, intervalMs: options?.intervalMs })
      },
      setHiddenThinkingLabel(label) {
        if (label !== undefined) assertText('thinking label', label, MAX_TITLE_LENGTH)
        bridge.state({ kind: 'hiddenThinkingLabel', label })
      },
      setWidget(key, content, options) {
        assertText('widget key', key, MAX_TITLE_LENGTH)
        if (typeof content === 'function') {
          bridge.tuiHost.unmount(key)
          try {
            const component = content(bridge.tuiHost.getTui(), bridge.tuiHost.getTheme())
            bridge.tuiHost.mount('widget', key, component, options?.placement)
          } catch {
            bridge.reportFailure(key, 'factory')
          }
          return
        }
        if (content !== undefined && !Array.isArray(content)) throw unsupported('component widgets')
        bridge.tuiHost.unmount(key)
        if (content) assertStringArray('widget lines', content, MAX_WIDGET_LINES)
        bridge.state({
          kind: 'widget',
          key,
          lines: content as string[] | undefined,
          placement: options?.placement,
        })
      },
      setFooter(factory) {
        if (factory === undefined) {
          bridge.tuiHost.unmount('footer')
          return
        }
        bridge.tuiHost.unmount('footer')
        bridge.reportCompatibility(
          'footerData',
          "Mirrored footers do not provide git branch or provider-count data; use the app's native panels.",
        )
        try {
          const component = factory(bridge.tuiHost.getTui(), bridge.tuiHost.getTheme(), footerDataProviderStub)
          bridge.tuiHost.mount('footer', 'footer', component)
        } catch {
          bridge.reportFailure('footer', 'factory')
        }
      },
      setHeader(factory) {
        if (factory === undefined) {
          bridge.tuiHost.unmount('header')
          return
        }
        bridge.tuiHost.unmount('header')
        try {
          const component = factory(bridge.tuiHost.getTui(), bridge.tuiHost.getTheme())
          bridge.tuiHost.mount('header', 'header', component)
        } catch {
          bridge.reportFailure('header', 'factory')
        }
      },
      setTitle(title) {
        assertText('title', title, MAX_TITLE_LENGTH)
        bridge.state({ kind: 'title', title })
      },
      custom<T>(
        factory: (
          tui: TUI,
          theme: Theme,
          keybindings: KeybindingsManager,
          done: (result: T) => void,
        ) => (Component & { dispose?: () => void }) | Promise<Component & { dispose?: () => void }>,
        options?: {
          overlay?: boolean
          overlayOptions?: OverlayOptions | (() => OverlayOptions)
          onHandle?: (handle: OverlayHandle) => void
        },
      ): Promise<T> {
        bridge.activeCustom?.cancel()
        const generation = bridge.diagnosticGeneration
        return new Promise<T>((resolve, reject) => {
          let closed = false
          let mounted: OverlayHandle | undefined
          let disposePending: (() => void) | undefined
          const cleanup = () => {
            if (bridge.activeCustom === pending) bridge.activeCustom = undefined
            mounted?.hide()
            disposePending?.()
            disposePending = undefined
          }
          const close = (result: T) => {
            if (closed) return
            closed = true
            cleanup()
            resolve(result)
          }
          const fail = (phase?: string) => {
            if (closed) return
            closed = true
            cleanup()
            if (phase) bridge.reportFailure('custom', phase)
            reject(
              Object.assign(new Error('Extension custom UI failed; see the extension diagnostics'), {
                code: 'INTERNAL_ERROR',
              }),
            )
          }
          const pending = { cancel: () => close(undefined as T) }
          bridge.activeCustom = pending
          try {
            const created = factory(
              bridge.tuiHost.getTui(),
              bridge.tuiHost.getTheme(),
              bridge.tuiHost.getKeybindings(),
              close,
            )
            Promise.resolve(created)
              .then(component => {
                const detached = new GuardedComponent(component, phase => {
                  if (bridge.diagnosticGeneration === generation) bridge.reportFailure('custom', phase)
                })
                disposePending = () => detached.dispose()
                if (closed) {
                  disposePending()
                  disposePending = undefined
                  return
                }
                if (typeof options?.overlayOptions === 'function') {
                  bridge.reportCompatibility(
                    'overlayLayout',
                    'Dynamic overlay options are evaluated on mount; responsive callback updates are not supported.',
                  )
                }
                const layout =
                  typeof options?.overlayOptions === 'function' ? options.overlayOptions() : options?.overlayOptions
                if (closed) return
                mounted = bridge.tuiHost.mountCustom(component, layout, () => fail())
                disposePending = undefined
                options?.onHandle?.({ ...mounted, hide: pending.cancel })
              })
              .catch(() => fail('factory'))
          } catch {
            fail('factory')
          }
        })
      },
      pasteToEditor(text) {
        assertText('editor text', text)
        if (bridge.editorText.length + text.length > MAX_TEXT_LENGTH) {
          throw Object.assign(new Error('editor text exceeds the PiUI RPC limit'), { code: 'EXTENSION_UI_LIMIT' })
        }
        bridge.editorText += text
        bridge.emit({ type: 'editor', sessionId: bridge.getSessionId(), command: { kind: 'paste', text } })
      },
      setEditorText(text) {
        assertText('editor text', text)
        bridge.editorText = text
        bridge.emit({ type: 'editor', sessionId: bridge.getSessionId(), command: { kind: 'set', text } })
      },
      getEditorText() {
        return bridge.editorText
      },
      addAutocompleteProvider() {
        bridge.reportCompatibility(
          'addAutocompleteProvider',
          'TUI autocomplete providers are not connected to the app composer.',
        )
      },
      setEditorComponent() {
        bridge.reportCompatibility('setEditorComponent', 'TUI editor components cannot replace the app composer.')
      },
      getEditorComponent() {
        bridge.reportCompatibility('getEditorComponent', 'The app composer is not a TUI editor component.')
        return undefined
      },
      get theme(): Theme {
        return bridge.tuiHost.getTheme()
      },
      getAllThemes() {
        return bridge.themes.list()
      },
      getTheme(name) {
        return bridge.themes.get(name)
      },
      setTheme(value) {
        const result = bridge.themes.set(value)
        if (result.success) {
          bridge.state({ kind: 'theme', name: bridge.themes.current.name ?? 'custom' })
          bridge.tuiHost.invalidateTheme()
        }
        return result
      },
      getToolsExpanded() {
        return bridge.toolsExpanded
      },
      setToolsExpanded(expanded) {
        bridge.toolsExpanded = expanded
        bridge.state({ kind: 'toolsExpanded', expanded })
      },
    }
  }

  captureFailureReporter(): (source: string, phase: string) => void {
    const generation = this.diagnosticGeneration
    return (source, phase) => {
      if (generation === this.diagnosticGeneration) this.reportFailure(source, phase)
    }
  }

  reportFailure(source: string, phase: string): void {
    const diagnostic = extensionDiagnostic(source, phase)
    const key = `error:${diagnostic.key}`
    if (this.compatibilityWarnings.has(key)) return
    this.compatibilityWarnings.add(key)
    this.state({ kind: 'status', key: `piui-host:${key}`, text: diagnostic.message })
    this.emit({ type: 'notify', sessionId: this.getSessionId(), message: diagnostic.message, notifyType: 'error' })
    console.error(`[piui-worker] ${diagnostic.key}: ${diagnostic.message}`)
  }

  private reportCompatibility(key: string, message: string): void {
    if (this.compatibilityWarnings.has(key)) return
    this.compatibilityWarnings.add(key)
    this.state({ kind: 'status', key: `piui-host:${key}`, text: message })
    this.emit({ type: 'notify', sessionId: this.getSessionId(), message, notifyType: 'warning' })
  }

  private dialog(
    kind: ExtensionUiDialogRequest['kind'],
    fields: {
      title: string
      options?: string[]
      message?: string
      placeholder?: string
      prefill?: string
    },
    opts?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ExtensionUiDialogResponse> {
    if (opts?.signal?.aborted) return Promise.resolve({ cancelled: true })
    assertText('dialog title', fields.title, MAX_TITLE_LENGTH)
    if (fields.message !== undefined) assertText('dialog message', fields.message)
    if (fields.placeholder !== undefined) assertText('dialog placeholder', fields.placeholder, MAX_TITLE_LENGTH)
    if (fields.prefill !== undefined) assertText('dialog prefill', fields.prefill)
    if (fields.options !== undefined) assertStringArray('dialog options', fields.options, MAX_OPTIONS)
    if (this.pending.size >= 32) {
      return Promise.reject(
        Object.assign(new Error('Too many pending extension UI dialogs'), {
          code: 'EXTENSION_UI_LIMIT',
        }),
      )
    }
    const requestId = randomUUID()
    const createdAt = new Date()
    const base = {
      requestId,
      sessionId: this.getSessionId(),
      workerGeneration: this.getWorkerGeneration(),
      title: fields.title,
      createdAt: createdAt.toISOString(),
      expiresAt: opts?.timeout ? new Date(createdAt.getTime() + opts.timeout).toISOString() : undefined,
    }
    const request: ExtensionUiDialogRequest =
      kind === 'select'
        ? { ...base, kind, options: fields.options ?? [] }
        : kind === 'confirm'
          ? { ...base, kind, message: fields.message ?? '' }
          : kind === 'input'
            ? { ...base, kind, placeholder: fields.placeholder }
            : { ...base, kind, prefill: fields.prefill }
    return new Promise(resolve => {
      const pending: PendingDialog = { request, resolve }
      const cancel = (reason: string) => {
        if (!this.pending.delete(requestId)) return
        if (pending.timer) clearTimeout(pending.timer)
        pending.removeAbort?.()
        resolve({ cancelled: true })
        this.emit({
          type: 'settled',
          requestId,
          sessionId: request.sessionId,
          reason: reason as ExtensionUiSettlementReason,
        })
      }
      if (opts?.timeout) pending.timer = setTimeout(() => cancel('timeout'), opts.timeout)
      if (opts?.signal) {
        const onAbort = () => cancel('aborted')
        opts.signal.addEventListener('abort', onAbort, { once: true })
        pending.removeAbort = () => opts.signal?.removeEventListener('abort', onAbort)
      }
      this.pending.set(requestId, pending)
      if (!this.emit({ type: 'requested', request })) cancel('host_unavailable')
    })
  }

  private state(patch: ExtensionUiStatePatch): void {
    const index = this.stateMirror.findIndex(
      previous =>
        previous.kind === patch.kind && (!('key' in previous) || ('key' in patch && previous.key === patch.key)),
    )
    if (index >= 0) this.stateMirror[index] = patch
    else this.stateMirror.push(patch)
    if (this.stateMirror.length > MAX_STATE_MIRROR_PATCHES) {
      this.stateMirror.splice(0, this.stateMirror.length - MAX_STATE_MIRROR_PATCHES)
    }
    this.emit({ type: 'state', sessionId: this.getSessionId(), patch })
  }

  private emit(event: PiExtensionUiEvent): boolean {
    let delivered = false
    for (const listener of this.listeners) {
      try {
        listener(event)
        delivered = true
      } catch {
        /* one failed transport must not prevent another listener from receiving the event */
      }
    }
    return delivered
  }
}

function unsupported(feature: string): Error {
  return Object.assign(new Error(`${feature} are unavailable in the PiUI RPC host`), {
    code: 'EXTENSION_UI_TUI_ONLY',
  })
}

/** Stub passed to `setFooter` factories — PiUI has no git/status footer. */
const footerDataProviderStub = {
  getGitBranch: (): string | null => null,
  getExtensionStatuses: (): ReadonlyMap<string, string> => new Map(),
  getAvailableProviderCount: (): number => 0,
  onBranchChange: (): (() => void) => () => undefined,
  setCwd: (): void => undefined,
  dispose: (): void => undefined,
}

function assertText(name: string, value: unknown, maxLength = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw Object.assign(new Error(`${name} must be a string no longer than ${maxLength} characters`), {
      code: 'EXTENSION_UI_LIMIT',
    })
  }
}

function assertStringArray(name: string, value: unknown, maxItems: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string')) {
    throw Object.assign(new Error(`${name} must contain at most ${maxItems} strings`), {
      code: 'EXTENSION_UI_LIMIT',
    })
  }
  for (const item of value) assertText(name, item)
}
