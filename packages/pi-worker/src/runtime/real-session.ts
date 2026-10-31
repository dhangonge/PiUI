import { constants, copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  EventBus,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import type { ImageInput, JsonObject, JsonValue, RegistrySnapshot, SessionActivityStatus } from '@piui/protocol'
import { isJsonObject, requireJsonValue } from '@piui/protocol'
import { getLoadedSdk } from '../sdk-host.js'
import {
  describeSubagentSession,
  forgetSubagentSession,
  installSubagentSessionPersistence,
  setSubagentParentAnchor,
} from './subagent-sessions.js'
import { configuredSessionDir, normalizeCwd, resolveUserPath } from './catalog.js'
import { forwardChildSessionEvents } from './child-session-events.js'
import { createDefaultRuntime } from './default-runtime.js'
import { extensionActionError } from './extension-diagnostics.js'
import { extensionBindings, type ExtensionHostActions } from './extension-host.js'
import { ExtensionUiBridge } from './extension-ui-bridge.js'
import {
  nextLiveMessageCheckpoint,
  provisionalLiveMessageCheckpoint,
  shouldClearPersistedLiveMessage,
  type LiveMessageCheckpoint,
} from './live-message.js'
import { assertSessionFileInside, pathKey, stripDuplicatePartial, toJson, toJsonObject } from './native-json.js'
import {
  entriesPageFromEntries,
  imageAttachmentFromEntry,
  sessionHeadFromParts,
  type BranchCheckpoint,
  type EntriesPage,
  type SessionHead,
} from './pagination.js'
import { verifySdkSessionContract } from './sdk-contract.js'
import {
  activityStatus,
  initialSessionShadow,
  resetSessionShadow,
  trackSessionShadow,
  withBranchSummaryFinished,
  withBranchSummaryRunning,
  type SessionShadow,
} from './session-shadow.js'
import type { PiEventMeta, SessionRuntime, Unsubscribe } from '../runtime.js'

// 契约门禁、子代理公告、JSON 归一与扩展宿主动作下沉到独立模块，
// 这里保持原有公开出口不变（其余包按这些名字引用）。
export { verifySdkSessionContract } from './sdk-contract.js'
export { forwardChildSessionEvents, toChildSessionEvent, type ChildSessionPhase } from './child-session-events.js'
export { stripDuplicatePartial } from './native-json.js'
export type { ExtensionHostActions } from './extension-host.js'

export interface RealPiSessionOpenOptions {
  agentDir?: string
  createRuntime?: CreateAgentSessionRuntimeFactory
  createSessionManager?: (cwd: string, sessionFile?: string) => unknown
  hostActions?: ExtensionHostActions
  /** 进程级共享 ModelRuntime：多个会话 runtime 共享同一个模型/认证实例 */
  modelRuntime?: ModelRuntime
}

export class RealPiSession implements SessionRuntime {
  private runtime: AgentSessionRuntime
  private readonly extensionUi: ExtensionUiBridge
  private extensionsInitialized = false
  private sessionUnsub: (() => void) | null = null
  private extensionErrorUnsub?: () => void
  private readonly piEventListeners = new Set<(event: JsonObject, meta: PiEventMeta) => void>()
  private readonly activityListeners = new Set<(status: SessionActivityStatus | null) => void>()
  private readonly headListeners = new Set<(head: SessionHead) => void>()
  private readonly resourceListeners = new Set<() => void>()
  private readonly childSessionListeners = new Set<(event: JsonObject) => void>()
  private childSessionBusUnsubs: Array<() => void> = []
  private nativeRevision = 1
  private nativeFingerprint = ''
  private eventEpoch = randomUUID()
  private eventSequence = 0
  private liveMessage?: LiveMessageCheckpoint
  private shadow: SessionShadow = initialSessionShadow()

  private constructor(
    runtime: AgentSessionRuntime,
    private readonly hostActions?: ExtensionHostActions,
  ) {
    this.runtime = runtime
    this.extensionUi = new ExtensionUiBridge(
      () => this.runtime.session.sessionManager.getSessionId(),
      () => undefined,
      {
        getThemes: () => this.runtime.session.resourceLoader.getThemes().themes,
        getPreferredTheme: () => this.runtime.session.settingsManager.getTheme(),
      },
    )
    this.nativeFingerprint = this.getNativeFingerprint()
    this.bindSessionEvents()
  }

  static async open(cwd: string, sessionFile?: string, options: RealPiSessionOpenOptions = {}): Promise<RealPiSession> {
    const { SessionManager, createAgentSessionRuntime, getAgentDir } = getLoadedSdk().sdk
    cwd = normalizeCwd(cwd)
    if (sessionFile && !existsSync(sessionFile)) {
      throw Object.assign(new Error('Pi session file no longer exists'), { code: 'SESSION_NOT_FOUND' })
    }
    const agentDir = options.agentDir ?? getAgentDir()
    const sessionDir = configuredSessionDir(cwd, agentDir)
    if (sessionFile && !options.createSessionManager) await assertSessionFileInside(sessionDir, sessionFile)
    const sessionManager = (options.createSessionManager?.(cwd, sessionFile) ??
      (sessionFile
        ? sessionDir
          ? SessionManager.open(sessionFile, sessionDir)
          : SessionManager.open(sessionFile)
        : SessionManager.create(cwd, sessionDir))) as SessionManager
    if (sessionFile && pathKey(sessionManager.getCwd()) !== pathKey(cwd)) {
      throw Object.assign(new Error('Pi session workspace does not match the selected workspace'), {
        code: 'SESSION_IDENTITY_MISMATCH',
      })
    }
    // 子代理公告总线：插件从 pi.events 发 `subagents:child:*`，不传自有总线
    // 时每个 resource loader 各建一条，worker 就收不到。外部注入的
    // createRuntime（集成测试）自行负责总线，这里就不再订阅。
    const childSessionBus = options.createRuntime ? undefined : getLoadedSdk().sdk.createEventBus()
    const runtime = await createAgentSessionRuntime(
      options.createRuntime ?? createDefaultRuntime(options.modelRuntime, childSessionBus),
      {
        cwd: sessionManager.getCwd(),
        agentDir,
        sessionManager,
      },
    )
    verifySdkSessionContract(runtime)

    const result = new RealPiSession(runtime, options.hostActions)
    // 子代理会话落盘桥：把插件的 `SessionManager.inMemory` 换成落盘会话，
    // 让子代理转录成为真会话（左侧会话管理可见、点开可读）。安装失败时
    // 插件行为与打补丁前一致。anchor 必须在 spawn 之前指向父会话。
    installSubagentSessionPersistence()
    result.anchorSubagentParent()
    result.bindChildSessionBus(childSessionBus)
    runtime.setBeforeSessionInvalidate(() => result.detachSessionSubscriptions())
    runtime.setRebindSession(async session => {
      result.extensionUi.cancelAll('session_replaced')
      result.resetSessionShadowState()
      result.nativeRevision += 1
      result.nativeFingerprint = result.getNativeFingerprint()
      if (result.extensionsInitialized) {
        result.bindExtensionErrors()
        await session.bindExtensions(
          extensionBindings(
            result.extensionUi,
            result.runtime,
            result.navigateTree.bind(result),
            result.reload.bind(result),
            result.hostActions,
          ),
        )
        result.reportExtensionLoadErrors()
      }
      result.bindSessionEvents()
    })
    return result
  }

  async initializeExtensions(): Promise<void> {
    if (this.extensionsInitialized) return
    this.bindExtensionErrors()
    await this.runtime.session.bindExtensions(
      extensionBindings(
        this.extensionUi,
        this.runtime,
        this.navigateTree.bind(this),
        this.reload.bind(this),
        this.hostActions,
      ),
    )
    this.extensionsInitialized = true
    this.reportExtensionLoadErrors()
  }

  private bindExtensionErrors(): void {
    this.extensionErrorUnsub?.()
    const reportFailure = this.extensionUi.captureFailureReporter()
    this.extensionErrorUnsub = this.runtime.session.extensionRunner?.onError(error => {
      reportFailure(error.extensionPath, error.event)
    })
  }

  private reportExtensionLoadErrors(): void {
    for (const error of this.runtime.session.resourceLoader.getExtensions().errors) {
      this.extensionUi.reportFailure(error.path, 'load')
    }
  }

  private bindSessionEvents(): void {
    this.sessionUnsub?.()
    this.sessionUnsub = this.runtime.session.subscribe(event => {
      const nativeEvent = toJsonObject(event)
      stripDuplicatePartial(nativeEvent)
      this.trackShadowState(event)
      const meta = this.captureEvent(event, nativeEvent)
      for (const listener of this.piEventListeners) listener(nativeEvent, meta)
      this.emitHeadIfChanged()
      this.emitActivityIfChanged()
      if (event.type === 'message_end' || event.type === 'agent_settled' || event.type === 'entry_appended') {
        queueMicrotask(() => {
          // dispose() nulls sessionUnsub before tearing down the runtime; skip
          // the deferred bookkeeping if we were disposed in between.
          if (this.sessionUnsub === null) return
          this.clearPersistedLiveMessage()
          this.emitHeadIfChanged()
          this.emitActivityIfChanged()
        })
      }
    })
  }

  /**
   * Derive activity status from the SDK's synchronous state (isStreaming /
   * isRetrying) — the same source state.get exposes. Reported on change so
   * the host can aggregate a global view without inferring from event types.
   */
  private emitActivityIfChanged(): void {
    const session = this.runtime.session
    const flags = {
      streaming: Boolean(session.isStreaming),
      retrying: Boolean(session.isRetrying),
      compacting: Boolean(session.isCompacting) || this.shadow.isCompacting,
    }
    if (
      flags.streaming === this.lastActivity.streaming &&
      flags.retrying === this.lastActivity.retrying &&
      flags.compacting === this.lastActivity.compacting
    )
      return
    this.lastActivity = flags

    const status = activityStatus(flags, this.shadow, session.retryAttempt)
    for (const listener of this.activityListeners) listener(status)
  }

  private lastActivity = { streaming: false, retrying: false, compacting: false }

  /** 每帧把原生事件累积进影子状态（自动压缩/重试/压缩操作的可读视图） */
  private trackShadowState(event: { type: string; [key: string]: unknown }): void {
    const session = this.runtime.session
    this.shadow = trackSessionShadow(this.shadow, event, {
      autoCompactionEnabled: session.autoCompactionEnabled,
      autoRetryEnabled: session.autoRetryEnabled,
    })
  }

  private captureEvent(event: { type: string; message?: unknown }, nativeEvent: JsonObject): PiEventMeta {
    const position = { epoch: this.eventEpoch, sequence: ++this.eventSequence }
    this.liveMessage = nextLiveMessageCheckpoint(
      this.liveMessage,
      event,
      nativeEvent,
      this.runtime.session.sessionManager.getEntries().length,
    )
    return {
      ...position,
      liveMessage: this.liveMessage
        ? { id: this.liveMessage.value.id, revision: this.liveMessage.value.revision }
        : undefined,
    }
  }

  /** 采样会话同步状态里的 streamingMessage（扩展拦下 message_start 时的兜底） */
  private syncLiveMessageFromAgentState(): void {
    this.liveMessage = provisionalLiveMessageCheckpoint(
      this.liveMessage,
      this.runtime.session.agent.state.streamingMessage,
      this.runtime.session.sessionManager.getEntries().length,
    )
  }

  private clearPersistedLiveMessage(): void {
    const checkpoint = this.liveMessage
    if (!checkpoint) return
    if (!shouldClearPersistedLiveMessage(checkpoint, this.runtime.session.sessionManager.getEntries())) return
    if (this.liveMessage?.value.id === checkpoint.value.id) this.liveMessage = undefined
  }

  private detachSessionSubscriptions(): void {
    this.extensionErrorUnsub?.()
    this.extensionErrorUnsub = undefined
    this.sessionUnsub?.()
    this.sessionUnsub = null
  }

  private resetSessionShadowState(): void {
    this.shadow = resetSessionShadow({
      autoCompactionEnabled: this.runtime.session.autoCompactionEnabled,
      autoRetryEnabled: this.runtime.session.autoRetryEnabled,
    })
    this.eventEpoch = randomUUID()
    this.eventSequence = 0
    this.liveMessage = undefined
  }

  getSessionId(): string {
    return this.runtime.session.sessionId
  }

  getSessionFile(): string | undefined {
    return this.runtime.session.sessionFile
  }

  getCwd(): string {
    return this.runtime.session.sessionManager.getCwd()
  }

  getModelRuntime() {
    return this.runtime.session.modelRuntime
  }

  onPiEvent(listener: (event: JsonObject, meta: PiEventMeta) => void): Unsubscribe {
    this.piEventListeners.add(listener)
    return () => this.piEventListeners.delete(listener)
  }

  onHead(listener: (head: SessionHead) => void): Unsubscribe {
    this.headListeners.add(listener)
    return () => this.headListeners.delete(listener)
  }

  onActivity(listener: (status: SessionActivityStatus | null) => void): Unsubscribe {
    this.activityListeners.add(listener)
    // Push current status immediately so late subscribers get the truth
    this.lastActivity = { streaming: false, retrying: false, compacting: false }
    this.emitActivityIfChanged()
    return () => this.activityListeners.delete(listener)
  }

  onExtensionUi(listener: (event: JsonObject) => void): Unsubscribe {
    return this.extensionUi.onEvent(listener as never)
  }

  onChildSession(listener: (event: JsonObject) => void): Unsubscribe {
    this.childSessionListeners.add(listener)
    return () => this.childSessionListeners.delete(listener)
  }

  /**
   * 订阅插件的子代理会话公告。
   *
   * 约定频道名由 @gotgenes/pi-permission-system 的 subagent-integration 文档
   * 定义，不可改名、不可加字段：payload 只有 { sessionId, parentSessionId }。
   * 子代理会话是 SessionManager.inMemory，转录不落盘也不在本进程可读，
   * 所以这里只转发「有/没有」这件事，不假装能拿到消息。
   */
  private bindChildSessionBus(bus: EventBus | undefined): void {
    for (const unsub of this.childSessionBusUnsubs) unsub()
    this.childSessionBusUnsubs = []
    if (!bus) return
    this.childSessionBusUnsubs = forwardChildSessionEvents(bus, event => {
      // parentSessionId 由插件从父会话管理器取；对账时以 worker 自己的
      // 会话 id 为准，避免多会话共用一个进程时串号。
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : ''
      const persisted = sessionId ? describeSubagentSession(sessionId) : undefined
      const enriched: JsonObject = {
        ...event,
        owningSessionId: this.runtime.session.sessionManager.getSessionId(),
        ...(persisted ? { sessionFile: persisted.sessionFile } : {}),
        ...(persisted?.sessionName ? { sessionName: persisted.sessionName } : {}),
      }
      if (event.phase === 'disposed' && sessionId) forgetSubagentSession(sessionId)
      for (const listener of this.childSessionListeners) listener(enriched)
    })
  }

  /**
   * 把子代理落盘桥的父锚点指向当前会话：插件 spawn 子代理时 worker 拿不到
   * 调用栈，只能按「当前正在推进的会话」认父。
   */
  anchorSubagentParent(): void {
    const manager = this.runtime.session.sessionManager
    try {
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) {
        setSubagentParentAnchor(undefined)
        return
      }
      setSubagentParentAnchor({ cwd: manager.getCwd(), sessionFile, sessionDir: manager.getSessionDir() })
    } catch {
      setSubagentParentAnchor(undefined)
    }
  }

  onResourcesChanged(listener: () => void): Unsubscribe {
    this.resourceListeners.add(listener)
    return () => this.resourceListeners.delete(listener)
  }

  respondExtensionUi(requestId: string, response: JsonObject): Promise<boolean> {
    return Promise.resolve(this.extensionUi.respond(requestId, response as never))
  }

  async setExtensionEditorState(text: string): Promise<void> {
    this.extensionUi.setEditorState(text)
  }

  extensionTuiInput(data: string): void {
    this.extensionUi.tuiInput(data)
  }

  extensionTuiResize(cols: number, rows: number): void {
    this.extensionUi.tuiResize(cols, rows)
  }

  extensionTuiRedraw(): void {
    this.extensionUi.tuiRedraw()
  }

  getHead(): SessionHead {
    const manager = this.runtime.session.sessionManager
    const header = toJson(manager.getHeader()) ?? null
    const version = isJsonObject(header) && typeof header.version === 'number' ? header.version : undefined
    return sessionHeadFromParts(
      {
        sdkVersion: getLoadedSdk().version,
        revision: this.nativeRevision,
        sessionFormatVersion: version,
        header: isJsonObject(header) ? header : null,
        leafId: manager.getLeafId(),
        entryCount: manager.getEntries().length,
      },
      manager.getSessionId(),
    )
  }

  getEntriesPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    const manager = this.runtime.session.sessionManager
    return entriesPageFromEntries(this.getHead(), manager.getEntries(), { cursor, limit, maxBytes }, toJsonObject)
  }

  getBranchPage(cursor: string | undefined, limit: number, maxBytes: number): EntriesPage {
    const manager = this.runtime.session.sessionManager
    this.syncLiveMessageFromAgentState()
    this.clearPersistedLiveMessage()
    const checkpoint: BranchCheckpoint | undefined = cursor
      ? undefined
      : {
          position: { epoch: this.eventEpoch, sequence: this.eventSequence },
          liveMessage: this.liveMessage?.value,
        }
    return entriesPageFromEntries(
      this.getHead(),
      manager.getBranch(),
      { cursor, limit, maxBytes, checkpoint },
      toJsonObject,
    )
  }

  getTree(): JsonValue {
    const tree = toJson(this.runtime.session.sessionManager.getTree())
    if (!Array.isArray(tree) || tree.some(node => !isJsonObject(node))) {
      throw Object.assign(new Error('Pi session tree nodes are not JSON objects'), { code: 'NATIVE_DATA_NOT_JSON' })
    }
    return tree
  }

  getAttachment(entryId: string, blockIndex: number): JsonObject {
    const entry = this.runtime.session.sessionManager.getEntry(entryId)
    if (!entry) throw Object.assign(new Error('entry not found'), { code: 'NOT_FOUND' })
    return imageAttachmentFromEntry(toJsonObject(entry), blockIndex)
  }

  getState(): JsonObject {
    const session = this.runtime.session
    const contextUsage = session.getContextUsage()
    const stats = session.getSessionStats()
    return requireJsonValue({
      sessionId: session.sessionId,
      sessionFile: session.sessionFile ?? null,
      sessionName: session.sessionManager.getSessionName() ?? null,
      cwd: session.sessionManager.getCwd(),
      model: toJson(session.model) ?? null,
      thinkingLevel: String(session.thinkingLevel ?? 'off'),
      isStreaming: Boolean(session.isStreaming),
      isCompacting: this.shadow.isCompacting || Boolean(session.isCompacting),
      steeringMode: String(session.steeringMode),
      followUpMode: String(session.followUpMode),
      autoCompactionEnabled: Boolean(session.autoCompactionEnabled),
      autoRetryEnabled: Boolean(session.autoRetryEnabled),
      messageCount: session.sessionManager.getEntries().length,
      pendingMessageCount: Number(session.pendingMessageCount ?? 0),
      availableThinkingLevels: this.getAvailableThinkingLevels(),
      isIdle: Boolean(session.isIdle ?? !session.isStreaming),
      isBashRunning: Boolean(session.isBashRunning),
      hasPendingBashMessages: Boolean(session.hasPendingBashMessages),
      isRetrying: Boolean(session.isRetrying),
      retryAttempt: Number(session.retryAttempt ?? 0),
      queue: {
        steering: [...(session.getSteeringMessages?.() ?? [])].map(String),
        followUp: [...(session.getFollowUpMessages?.() ?? [])].map(String),
        steeringMode: String(session.steeringMode),
        followUpMode: String(session.followUpMode),
      },
      // 刷新/重连恢复：未应答的扩展 dialog 请求快照（请求仍挂起，扩展在
      // 阻塞等应答），前端据此重新渲染弹窗，避免无人应答卡死会话。
      pendingExtensionUiRequests: this.extensionUi.listPending(),
      // 刷新/重连恢复：扩展增量 UI 状态（status/widget/working 指示等）的
      // 镜像，前端重放 patch 重建显示。
      extensionUiState: this.extensionUi.getStateMirror(),
      // 刷新/重连恢复：offscreen 扩展 TUI 面板清单（组件在 worker 侧仍
      // 挂着），前端重新 attach 后由视图挂载时请求一次全量重绘。
      extensionTuiPanels: this.extensionUi.listTuiPanels(),
      supportsThinking: Boolean(session.supportsThinking?.() ?? true),
      activeTools: session.getActiveToolNames?.() ?? [],
      scopedModels: toJson(session.scopedModels) ?? [],
      contextUsage: toJson(contextUsage) ?? null,
      sessionStats: toJson(stats) ?? null,
      retry: this.shadow.retry,
      compaction: this.shadow.compaction,
      head: this.getHead(),
    }) as JsonObject
  }

  listSkills(): JsonValue {
    return toJson(this.runtime.session.resourceLoader.getSkills().skills) ?? []
  }

  listPrompts(): JsonValue {
    return toJson(this.runtime.session.resourceLoader.getPrompts().prompts) ?? []
  }

  listAgentsFiles(): JsonValue {
    return toJson(this.runtime.session.resourceLoader.getAgentsFiles().agentsFiles) ?? []
  }

  getRegistry(): RegistrySnapshot {
    const session = this.runtime.session
    const loader = session.resourceLoader
    const extensions = loader.getExtensions()
    const eventHandlers = new Set<string>()
    const extensionDescriptors = extensions.extensions.map(extension => {
      for (const key of extension.handlers.keys()) eventHandlers.add(key)
      return {
        path: extension.path,
        hidden: extension.hidden,
        sourceInfo: toJson(extension.sourceInfo),
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()],
        handlers: [...extension.handlers.keys()],
      }
    })
    return {
      sdkVersion: getLoadedSdk().version,
      tools: requireJsonValue(session.getAllTools()) as RegistrySnapshot['tools'],
      activeTools: session.getActiveToolNames?.() ?? [],
      commands: requireJsonValue([
        ...getLoadedSdk().builtinSlashCommands.map(command => ({
          name: command.name,
          description: command.description,
          argumentHint: command.argumentHint,
          sourceInfo: { source: 'pi-sdk', builtin: true },
        })),
        ...extensions.extensions.flatMap(extension =>
          [...extension.commands.values()].map(command => ({
            name: command.name,
            description: command.description,
            sourceInfo: toJson(command.sourceInfo),
          })),
        ),
      ]) as RegistrySnapshot['commands'],
      extensions: extensionDescriptors,
      eventHandlers: [...eventHandlers],
    }
  }

  async invokeTool(name: string, args?: JsonObject): Promise<JsonValue | undefined> {
    const runner = this.runtime.session.extensionRunner
    if (!runner) throw Object.assign(new Error('extensions are not initialized'), { code: 'CAPABILITY_DISABLED' })
    const registered = runner.getAllRegisteredTools().find(tool => tool.definition.name === name)
    if (!registered) throw Object.assign(new Error(`tool not found: ${name}`), { code: 'NOT_FOUND' })
    if (typeof runner.createToolContext !== 'function') {
      throw Object.assign(new Error('Pi SDK does not expose extension tool execution contexts'), {
        code: 'PI_SDK_INCOMPATIBLE',
      })
    }
    const toolCallId = randomUUID()
    const reportFailure = this.extensionUi.captureFailureReporter()
    try {
      const result = await registered.definition.execute(
        toolCallId,
        args ?? {},
        undefined,
        undefined,
        runner.createToolContext(toolCallId, undefined),
      )
      this.emitHeadIfChanged()
      return toJson(result)
    } catch (error) {
      reportFailure(registered.sourceInfo.path, 'tool')
      throw extensionActionError(error)
    }
  }

  async invokeCommand(name: string, args?: string): Promise<JsonValue | undefined> {
    const runner = this.runtime.session.extensionRunner
    if (!runner) throw Object.assign(new Error('extensions are not initialized'), { code: 'CAPABILITY_DISABLED' })
    const command = runner.getCommand(name)
    if (!command) throw Object.assign(new Error(`command not found: ${name}`), { code: 'NOT_FOUND' })
    const reportFailure = this.extensionUi.captureFailureReporter()
    try {
      await command.handler(args ?? '', runner.createCommandContext())
      this.emitHeadIfChanged()
      return undefined
    } catch (error) {
      reportFailure(command.sourceInfo.path, 'command')
      throw extensionActionError(error)
    }
  }

  /**
   * Resolve argument completions for a registered extension command — pi TUI
   * `getArgumentCompletions(prefix)` parity. Returns [{ value, label, description? }]
   * or undefined when the command exposes no completions.
   */
  async getCommandCompletions(name: string, prefix: string): Promise<JsonValue | undefined> {
    const runner = this.runtime.session.extensionRunner
    if (!runner) throw Object.assign(new Error('extensions are not initialized'), { code: 'CAPABILITY_DISABLED' })
    const command = runner.getCommand(name)
    if (!command?.getArgumentCompletions) return undefined
    const items = await command.getArgumentCompletions(prefix)
    return toJson(items) ?? undefined
  }

  private getNativeFingerprint(): string {
    const manager = this.runtime.session.sessionManager
    const entries = manager.getEntries()
    const last = entries.at(-1)
    return `${entries.length}:${manager.getLeafId() ?? ''}:${last?.id ?? ''}:${last?.timestamp ?? ''}`
  }

  private emitHeadIfChanged(): void {
    const fingerprint = this.getNativeFingerprint()
    if (fingerprint === this.nativeFingerprint) return
    this.nativeFingerprint = fingerprint
    this.nativeRevision += 1
    const head = this.getHead()
    for (const listener of this.headListeners) listener(head)
  }

  private getAvailableThinkingLevels(): string[] {
    try {
      const levels = this.runtime.session.getAvailableThinkingLevels?.() ?? []
      return levels.map(String)
    } catch {
      return ['off', 'minimal', 'low', 'medium', 'high']
    }
  }

  private assertImageSupport(images: ImageInput[] | undefined): void {
    if (!images?.length) return
    const model = this.runtime.session.model as { input?: string[] } | undefined
    if (!model?.input?.includes('image')) {
      throw Object.assign(new Error('The selected Pi model does not support image input'), {
        code: 'CAPABILITY_DISABLED',
      })
    }
  }

  async prompt(
    text: string,
    images?: ImageInput[],
    options: { expandPromptTemplates?: boolean; streamingBehavior?: 'steer' | 'followUp' } = {},
  ): Promise<void> {
    try {
      this.assertImageSupport(images)
      this.anchorSubagentParent()
      await this.runtime.session.prompt(text, {
        images: images?.length ? images : undefined,
        expandPromptTemplates: options.expandPromptTemplates,
        streamingBehavior: options.streamingBehavior,
        source: 'rpc',
      })
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async steer(text: string, images?: ImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error('Cannot steer an idle Pi session'), { code: 'SESSION_CONFLICT' })
    }
    this.assertImageSupport(images)
    this.anchorSubagentParent()
    await this.runtime.session.steer(text, images)
  }

  async followUp(text: string, images?: ImageInput[]): Promise<void> {
    if (!this.runtime.session.isStreaming) {
      throw Object.assign(new Error('Cannot queue a follow-up on an idle Pi session'), { code: 'SESSION_CONFLICT' })
    }
    this.assertImageSupport(images)
    this.anchorSubagentParent()
    await this.runtime.session.followUp(text, images)
  }

  async sendUserMessage(text: string, images?: ImageInput[], deliverAs?: 'steer' | 'followUp'): Promise<void> {
    this.assertImageSupport(images)
    const content = images?.length ? [{ type: 'text' as const, text }, ...images] : text
    try {
      await this.runtime.session.sendUserMessage(content, deliverAs ? { deliverAs } : undefined)
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async abort(): Promise<JsonValue | undefined> {
    const cleared = this.runtime.session.clearQueue()
    await this.runtime.session.abort()
    return toJson(cleared)
  }

  async newSession(parentSession?: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.newSession({ parentSession })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: 'new',
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      cancelled: Boolean(result.cancelled),
    }
  }

  async switchSession(sessionPath: string, cwdOverride?: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const targetPath = resolveUserPath(sessionPath)
    await assertSessionFileInside(this.runtime.session.sessionManager.getSessionDir(), targetPath)
    const result = await this.runtime.switchSession(targetPath, { cwdOverride })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: 'switch',
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      cancelled: Boolean(result.cancelled),
    }
  }

  async fork(entryId: string, position: 'before' | 'at'): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const result = await this.runtime.fork(entryId, { position })
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      operation: 'fork',
      sourceSessionId,
      targetSessionId: this.getSessionId(),
      targetSessionFile: this.getSessionFile() ?? null,
      targetCwd: this.getCwd(),
      selectedText: toJson(result.selectedText) ?? null,
      cancelled: Boolean(result.cancelled),
    }
  }

  async importSession(inputPath: string, cwdOverride?: string): Promise<JsonObject> {
    const sourceSessionId = this.getSessionId()
    const sourcePath = resolveUserPath(inputPath)
    if (!existsSync(sourcePath)) {
      throw Object.assign(new Error(`Import file not found: ${sourcePath}`), { code: 'NOT_FOUND' })
    }
    const sessionDir = this.runtime.session.sessionManager.getSessionDir()
    mkdirSync(sessionDir, { recursive: true })
    const stagedPath = path.join(sessionDir, `piui-import-${randomUUID()}.jsonl`)
    copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL)
    let keepStagedFile = false
    try {
      const result = await this.runtime.importFromJsonl(stagedPath, cwdOverride)
      keepStagedFile = !result.cancelled
      if (!result.cancelled) this.emitHeadIfChanged()
      return {
        operation: 'import',
        sourceSessionId,
        targetSessionId: this.getSessionId(),
        targetSessionFile: this.getSessionFile() ?? null,
        targetCwd: this.getCwd(),
        cancelled: Boolean(result.cancelled),
      }
    } finally {
      if (!keepStagedFile) {
        try {
          unlinkSync(stagedPath)
        } catch {
          /* best effort cleanup for a cancelled or failed import */
        }
      }
    }
  }

  async setSessionName(name: string): Promise<void> {
    this.runtime.session.setSessionName(name)
    this.emitHeadIfChanged()
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const session = this.runtime.session
    const model = session.modelRuntime?.getModel?.(provider, modelId)
    if (!model)
      throw Object.assign(new Error(`model not found: ${provider}/${modelId}`), { code: 'MODEL_NOT_AVAILABLE' })
    await session.setModel(model)
  }

  async cycleModel(direction: 'forward' | 'backward' = 'forward'): Promise<void> {
    const result = await this.runtime.session.cycleModel(direction)
    if (!result)
      throw Object.assign(new Error('no authenticated model is available to cycle to'), {
        code: 'MODEL_NOT_AVAILABLE',
      })
  }

  async setScopedModels(patterns: string[]): Promise<JsonValue | undefined> {
    const { resolveModelScopeWithDiagnostics } = getLoadedSdk().sdk
    const normalized = patterns.map(pattern => pattern.trim()).filter(Boolean)
    const result = await resolveModelScopeWithDiagnostics(normalized, this.runtime.session.modelRuntime)
    this.runtime.session.setScopedModels(result.scopedModels)
    return toJson(result.diagnostics)
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.runtime.session.setThinkingLevel(level as never)
  }

  async cycleThinkingLevel(): Promise<JsonValue | undefined> {
    const level = this.runtime.session.cycleThinkingLevel()
    if (level === undefined) {
      throw Object.assign(new Error('the selected Pi model does not support thinking levels'), {
        code: 'CAPABILITY_DISABLED',
      })
    }
    return String(level)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    this.runtime.session.setSteeringMode(mode)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    this.runtime.session.setFollowUpMode(mode)
  }

  async clearQueue(): Promise<JsonValue | undefined> {
    return toJson(this.runtime.session.clearQueue())
  }

  async compact(customInstructions?: string): Promise<JsonValue | undefined> {
    try {
      const result = await this.runtime.session.compact(customInstructions)
      this.emitHeadIfChanged()
      return toJson({ status: 'completed', result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/nothing to compact/i.test(message)) {
        return { status: 'skipped', reason: 'session_too_small', message }
      }
      if (/already compacted/i.test(message)) {
        return { status: 'skipped', reason: 'already_compacted', message }
      }
      if (/compaction cancelled/i.test(message)) return { status: 'aborted' }
      throw error
    }
  }

  async abortCompaction(): Promise<void> {
    this.runtime.session.abortCompaction?.()
  }

  async abortBranchSummary(): Promise<void> {
    this.runtime.session.abortBranchSummary()
  }

  async abortRetry(): Promise<void> {
    this.runtime.session.abortRetry()
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    this.runtime.session.setAutoCompactionEnabled(enabled)
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    this.runtime.session.setAutoRetryEnabled(enabled)
  }

  async bash(command: string, excludeFromContext = false, clientId?: string): Promise<JsonValue | undefined> {
    const normalized = command.trim()
    if (!normalized) throw Object.assign(new Error('empty bash command'), { code: 'INVALID_REQUEST' })
    try {
      const eventResult = await this.runtime.session.extensionRunner?.emitUserBash({
        type: 'user_bash',
        command: normalized,
        excludeFromContext,
        cwd: this.getCwd(),
      })
      if (eventResult?.result) {
        this.runtime.session.recordBashResult(normalized, eventResult.result, { excludeFromContext })
        return toJson(eventResult.result)
      }
      // clientId 透传为 bash_execution_update 事件的 id：前端用它关联乐观
      // 条目的实时输出（pi TUI 的 onChunk 对应物，经事件流转发）。
      return toJson(
        await this.runtime.session.executeBash(normalized, undefined, {
          excludeFromContext,
          operations: eventResult?.operations,
          id: clientId,
        }),
      )
    } finally {
      this.emitHeadIfChanged()
    }
  }

  async abortBash(): Promise<void> {
    this.runtime.session.abortBash()
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    const available = new Set(this.runtime.session.getAllTools().map(tool => tool.name))
    const normalized = [...new Set(toolNames)]
    const unknown = normalized.filter(name => !available.has(name))
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown Pi tools: ${unknown.join(', ')}`), { code: 'INVALID_REQUEST' })
    }
    this.runtime.session.setActiveToolsByName(normalized)
  }

  async navigateTree(
    entryId: string,
    options: {
      summarize?: boolean
      customInstructions?: string
      replaceInstructions?: boolean
      label?: string
    } = {},
  ): Promise<JsonObject> {
    if (options.summarize) this.shadow = withBranchSummaryRunning(this.shadow, entryId)
    let result: Awaited<ReturnType<AgentSessionRuntime['session']['navigateTree']>>
    try {
      result = await this.runtime.session.navigateTree(entryId, options)
    } finally {
      if (options.summarize) this.shadow = withBranchSummaryFinished(this.shadow)
    }
    if (!result.cancelled) this.emitHeadIfChanged()
    return {
      editorText: toJson(result.editorText) ?? null,
      cancelled: Boolean(result.cancelled),
      aborted: Boolean(result.aborted),
      summaryEntry: result.summaryEntry ? toJsonObject(result.summaryEntry) : null,
    }
  }

  async setLabel(entryId: string, label?: string): Promise<void> {
    this.runtime.session.sessionManager.appendLabelChange(entryId, label)
    this.emitHeadIfChanged()
  }

  async sendCustomMessage(
    customType: string,
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
    options: {
      display: boolean
      details?: JsonValue
      triggerTurn?: boolean
      deliverAs?: 'steer' | 'followUp' | 'nextTurn'
    },
  ): Promise<void> {
    if (!customType.trim()) throw Object.assign(new Error('custom message type required'), { code: 'INVALID_REQUEST' })
    await this.runtime.session.sendCustomMessage(
      {
        customType: customType.trim(),
        content,
        display: options.display,
        details: options.details,
      },
      {
        triggerTurn: options.triggerTurn,
        deliverAs: options.deliverAs,
      },
    )
    this.emitHeadIfChanged()
  }

  async appendCustomEntry(customType: string, data?: JsonValue): Promise<void> {
    const normalized = customType.trim()
    if (!normalized) throw Object.assign(new Error('custom entry type required'), { code: 'INVALID_REQUEST' })
    this.runtime.session.sessionManager.appendCustomEntry(normalized, data)
    this.emitHeadIfChanged()
  }

  async exportHtml(outputPath: string): Promise<JsonValue | undefined> {
    return toJson({ path: await this.runtime.session.exportToHtml(outputPath) })
  }

  async exportJsonl(outputPath: string): Promise<JsonValue | undefined> {
    return toJson({ path: this.runtime.session.exportToJsonl(outputPath) })
  }

  async waitForIdle(): Promise<void> {
    await this.runtime.session.waitForIdle()
  }

  async reload(): Promise<void> {
    this.extensionUi.cancelAll('runtime_reloaded')
    await this.runtime.session.reload({ beforeSessionStart: async () => this.bindExtensionErrors() })
    this.reportExtensionLoadErrors()
    this.nativeFingerprint = ''
    this.emitHeadIfChanged()
    for (const listener of this.resourceListeners) listener()
  }

  async dispose(): Promise<void> {
    this.extensionUi.cancelAll('runtime_disposed')
    this.detachSessionSubscriptions()
    for (const unsub of this.childSessionBusUnsubs) unsub()
    this.childSessionBusUnsubs = []
    this.childSessionListeners.clear()
    this.piEventListeners.clear()
    this.headListeners.clear()
    this.resourceListeners.clear()
    await this.runtime.dispose()
  }
}
