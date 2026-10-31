import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent'
import { RealPiSession } from './real-session.ts'
import { loadPiSdk } from '../sdk-host.ts'
import {
  AnyRecord,
  allEntries,
  activeBranchEntries,
  sessionTree,
  findTreeLabel,
  findTreeNode,
  nativeRole,
  nativeMessage,
  nativeMessageText,
  nativeContentText,
  openOfflineSession,
  loadPiAiFromPinnedSdk,
  emptyResourceLoader,
} from '../../test-support/real-session.ts'

await loadPiSdk()

// 同 real-session.integration.test.ts：关掉子代理落盘桥（桥由 subagent-sessions.test.ts 覆盖）。

process.env.PIUI_SUBAGENT_SESSIONS = 'off'

describe('RealPiSession streaming with the Pi SDK', () => {
  it('streams raw events and persists an offline faux-provider turn', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-sdk-'))
    const { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } = await loadPiAiFromPinnedSdk()
    const faux = fauxProvider({ provider: 'piui-faux', api: 'piui-faux' })
    faux.setResponses([
      fauxAssistantMessage('offline answer'),
      fauxAssistantMessage('idle reply'),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'offline failure' }),
    ])
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    })
    modelRuntime.registerNativeProvider(faux.provider)
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    const resourceLoader = emptyResourceLoader()
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const services: AgentSessionServices = {
        cwd,
        agentDir: cwd,
        modelRuntime,
        settingsManager,
        resourceLoader,
        diagnostics: [],
      }
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: faux.getModel(),
          thinkingLevel: 'off',
          noTools: 'all',
        })),
        services,
        diagnostics: [],
      }
    }

    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, {
        agentDir: cwd,
        createRuntime,
        createSessionManager: runtimeCwd => SessionManager.inMemory(runtimeCwd),
      })
      const skippedCompaction = await session.compact()
      assert.equal(skippedCompaction.status, 'skipped')
      const nativeEvents: Array<Record<string, unknown>> = []
      const unsubscribeNative = session.onPiEvent(event => nativeEvents.push(event as Record<string, unknown>))
      const image = {
        type: 'image' as const,
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      }
      await session.prompt('ping', [image])
      unsubscribeNative()

      // The authenticated client receives Pi's complete JSON event structure.
      assert.ok(nativeEvents.length > 0)
      for (const event of nativeEvents) {
        assert.equal(typeof event.type, 'string')
      }
      assert.ok(
        nativeEvents.some(event => {
          const message = event.message
          return (
            event.type === 'message_start' &&
            message &&
            typeof message === 'object' &&
            !Array.isArray(message) &&
            (message as { role?: unknown }).role === 'user'
          )
        }),
      )

      assert.equal(faux.state.callCount, 1)
      assert.equal(session.getSessionFile(), undefined)
      assert.equal((session.getState().model as AnyRecord)?.provider, 'piui-faux')
      const nativeEntries = allEntries(session)
      const userEntry = nativeEntries.find(entry => entry.type === 'message' && nativeRole(entry) === 'user')
      const assistantEntry = nativeEntries.find(entry => entry.type === 'message' && nativeRole(entry) === 'assistant')
      assert.ok(userEntry)
      assert.ok(assistantEntry)
      assert.deepEqual(session.getBranchPage(undefined, 100, 32 * 1024 * 1024).items, activeBranchEntries(session))
      const userMessage = userEntry.message
      assert.ok(userMessage && typeof userMessage === 'object' && !Array.isArray(userMessage))
      assert.deepEqual(userMessage.content, [{ type: 'text', text: 'ping' }, image])
      await session.setLabel(String(assistantEntry.id), 'offline checkpoint')
      await session.setSessionName('Offline R3')
      assert.equal(session.getState().sessionName, 'Offline R3')
      assert.equal(findTreeLabel(sessionTree(session), String(assistantEntry.id)), 'offline checkpoint')
      assert.deepEqual(findTreeNode(sessionTree(session), String(assistantEntry.id))?.entry, assistantEntry)
      await assert.rejects(
        session.setActiveTools(['piui-tool-that-does-not-exist']),
        error => (error as { code?: string }).code === 'INVALID_REQUEST',
      )

      const navigation = await session.navigateTree(String(userEntry.id))
      assert.equal(navigation.editorText, 'ping')
      const sourceSessionId = session.getSessionId()
      const replacement = await session.fork(assistantEntry.id, 'at')
      assert.equal(replacement.sourceSessionId, sourceSessionId)
      assert.notEqual(replacement.targetSessionId, sourceSessionId)
      assert.equal(replacement.cancelled, false)

      const uiState = session.getState()
      assert.equal(uiState.isBashRunning, false)
      assert.equal(uiState.hasPendingBashMessages, false)
      assert.equal(uiState.isRetrying, false)
      assert.equal(uiState.retryAttempt, 0)
      assert.equal(uiState.pendingMessageCount, 0)
      await assert.rejects(
        session.cycleThinkingLevel(),
        error => (error as { code?: string }).code === 'CAPABILITY_DISABLED',
      )

      await session.sendUserMessage('sent while idle')
      assert.equal(faux.state.callCount, 2)
      assert.ok(
        allEntries(session).some(
          entry =>
            entry.type === 'message' && nativeRole(entry) === 'user' && nativeMessageText(entry) === 'sent while idle',
        ),
      )

      await session.prompt('fail offline')
      const failed = allEntries(session)
        .filter(entry => entry.type === 'message' && nativeRole(entry) === 'assistant')
        .at(-1)
      assert.equal(faux.state.callCount, 3)
      assert.equal(nativeMessage(failed).stopReason, 'error')
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stages imports under a unique filename before Pi can overwrite an existing session', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-import-'))
    const { fauxAssistantMessage } = await loadPiAiFromPinnedSdk()
    const sessionDir = path.join(cwd, 'sessions')
    const inputDir = path.join(cwd, 'inputs')
    mkdirSync(inputDir)
    const currentManager = SessionManager.create(cwd, sessionDir)
    currentManager.appendMessage({ role: 'user', content: 'source content', timestamp: Date.now() } as never)
    currentManager.appendMessage(fauxAssistantMessage('source answer') as never)
    const importedManager = SessionManager.create(cwd, inputDir)
    importedManager.appendMessage({ role: 'user', content: 'imported content', timestamp: Date.now() } as never)
    importedManager.appendMessage(fauxAssistantMessage('imported answer') as never)
    const sourceFile = currentManager.getSessionFile()!
    const importedFile = importedManager.getSessionFile()!
    const collidingInput = path.join(inputDir, path.basename(sourceFile))
    copyFileSync(importedFile, collidingInput)
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
    })
    const settingsManager = SettingsManager.inMemory()
    const resourceLoader = emptyResourceLoader()
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
      const services: AgentSessionServices = {
        cwd,
        agentDir: cwd,
        modelRuntime,
        settingsManager,
        resourceLoader,
        diagnostics: [],
      }
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          noTools: 'all',
        })),
        services,
        diagnostics: [],
      }
    }

    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, sourceFile, {
        agentDir: cwd,
        createRuntime,
        createSessionManager: () => currentManager,
      })
      const sourceBefore = readFileSync(sourceFile, 'utf8')
      const sourceSessionId = session.getSessionId()
      await assert.rejects(session.importSession(path.join(inputDir, 'missing.jsonl'), cwd), { code: 'NOT_FOUND' })
      assert.equal(session.getSessionId(), sourceSessionId)
      assert.equal(readFileSync(sourceFile, 'utf8'), sourceBefore)

      const replacement = await session.importSession(collidingInput, cwd)
      assert.equal(replacement.cancelled, false)
      assert.notEqual(path.resolve(replacement.targetSessionFile!), path.resolve(sourceFile))
      assert.equal(readFileSync(sourceFile, 'utf8'), sourceBefore)
      assert.match(path.basename(replacement.targetSessionFile!), /^piui-import-.*\.jsonl$/)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps a live checkpoint while an extension settles message_end', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-live-settlement-'))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-live-settlement',
          api: 'piui-faux-live-settlement',
          models: [{ id: 'live-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false },
          retry: { enabled: false },
        },
        api => [api.fauxAssistantMessage('settled answer')],
      )
      session = opened.session
      await session.initializeExtensions()

      const runner = (
        session as unknown as {
          runtime: { session: { _extensionRunner?: { emitMessageEnd: (event: unknown) => Promise<unknown> } } }
        }
      ).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmitMessageEnd = runner.emitMessageEnd.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => {
        markBlocked = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      runner.emitMessageEnd = async event => {
        const message =
          event && typeof event === 'object' && 'message' in event
            ? (event as { message?: { role?: unknown } }).message
            : undefined
        if (message?.role === 'user') {
          markBlocked()
          await gate
        }
        return originalEmitMessageEnd(event)
      }

      const prompt = session.prompt('hold user settlement')
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      assert.equal(
        during.items.some(entry => nativeRole(entry) === 'user'),
        false,
      )
      assert.equal(during.checkpoint?.liveMessage?.phase, 'streaming')
      const live = during.checkpoint?.liveMessage?.message
      assert.ok(live && typeof live === 'object' && !Array.isArray(live))
      assert.equal(live.role, 'user')

      release()
      await prompt
      const settled = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      assert.equal(settled.checkpoint?.liveMessage, undefined)
      assert.ok(settled.items.some(entry => nativeRole(entry) === 'user'))
      assert.ok(settled.items.some(entry => nativeRole(entry) === 'assistant'))
      const latest = session.getBranchPage(undefined, 1, 32 * 1024 * 1024)
      assert.ok(latest.beforeCursor)
      assert.ok(latest.checkpoint)
      const older = session.getBranchPage(latest.beforeCursor, 1, 32 * 1024 * 1024)
      assert.equal(older.checkpoint, undefined)
      await session.sendCustomMessage('fixture.custom', [{ type: 'text', text: 'custom' }], { display: true })
      assert.equal(session.getBranchPage(undefined, 100, 32 * 1024 * 1024).checkpoint?.liveMessage, undefined)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('samples the native streaming message while a message_start extension is blocked', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-live-start-'))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-live-start',
          api: 'piui-faux-live-start',
          models: [{ id: 'live-start-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false },
          retry: { enabled: false },
        },
        api => [api.fauxAssistantMessage('answer')],
      )
      session = opened.session
      await session.initializeExtensions()
      const runner = (
        session as unknown as {
          runtime: { session: { _extensionRunner?: { emit: (event: { type?: string }) => Promise<unknown> } } }
        }
      ).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmit = runner.emit.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => {
        markBlocked = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      let held = false
      runner.emit = async event => {
        if (
          !held &&
          event.type === 'message_start' &&
          (event as { message?: { role?: string } }).message?.role === 'user'
        ) {
          held = true
          markBlocked()
          await gate
        }
        return originalEmit(event)
      }
      const eventLiveIds: string[] = []
      const off = session.onPiEvent((event, meta) => {
        if (
          event &&
          typeof event === 'object' &&
          !Array.isArray(event) &&
          event.type === 'message_start' &&
          (event.message as { role?: string } | undefined)?.role === 'user' &&
          meta.liveMessage
        ) {
          eventLiveIds.push(meta.liveMessage.id)
        }
      })

      const prompt = session.prompt('blocked start')
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const provisionalId = during.checkpoint?.liveMessage?.id
      assert.ok(provisionalId)
      const provisional = during.checkpoint?.liveMessage?.message
      assert.ok(provisional && typeof provisional === 'object' && !Array.isArray(provisional))
      assert.equal(provisional.role, 'user')

      release()
      await prompt
      off()
      assert.equal(eventLiveIds[0], provisionalId)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps the live id while a message_update extension is blocked', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-live-update-'))
    let session: RealPiSession | undefined
    let release!: () => void
    try {
      const answer = 'streaming answer '.repeat(20)
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-live-update',
          api: 'piui-faux-live-update',
          models: [{ id: 'live-update-1', contextWindow: 4096, maxTokens: 256 }],
          tokensPerSecond: 200,
          tokenSize: { min: 1, max: 1 },
        },
        {
          compaction: { enabled: false },
          retry: { enabled: false },
        },
        api => [api.fauxAssistantMessage(answer)],
      )
      session = opened.session
      await session.initializeExtensions()
      const runner = (
        session as unknown as {
          runtime: { session: { _extensionRunner?: { emit: (event: { type?: string }) => Promise<unknown> } } }
        }
      ).runtime.session._extensionRunner
      assert.ok(runner)
      const originalEmit = runner.emit.bind(runner)
      let markBlocked!: () => void
      const blocked = new Promise<void>(resolve => {
        markBlocked = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      let held = false
      runner.emit = async event => {
        if (!held && event.type === 'message_update') {
          held = true
          markBlocked()
          await gate
        }
        return originalEmit(event)
      }
      let assistantStartId: string | undefined
      let assistantUpdateId: string | undefined
      const off = session.onPiEvent((event, meta) => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return
        const message = event.message
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.role !== 'assistant') return
        if (event.type === 'message_start') assistantStartId = meta.liveMessage?.id
        if (event.type === 'message_update') assistantUpdateId = meta.liveMessage?.id
      })

      const prompt = session.prompt('blocked update')
      await blocked
      const during = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const provisionalId = during.checkpoint?.liveMessage?.id
      assert.ok(assistantStartId)
      assert.equal(provisionalId, assistantStartId)
      assert.ok((during.checkpoint?.liveMessage?.revision ?? 0) > 1)

      release()
      await prompt
      off()
      assert.equal(assistantUpdateId, assistantStartId)
    } finally {
      release?.()
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('keeps steer and follow-up in independent native queues during a streamed turn', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-control-'))
    const slowText = 'streaming content '.repeat(12)
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-control',
          api: 'piui-faux-control',
          models: [{ id: 'control-1', contextWindow: 4096, maxTokens: 256 }],
          tokensPerSecond: 200,
          tokenSize: { min: 1, max: 1 },
        },
        {
          compaction: { enabled: false },
          retry: { enabled: false },
          steeringMode: 'all',
          followUpMode: 'all',
        },
        api => [
          api.fauxAssistantMessage(slowText),
          api.fauxAssistantMessage('steering handled'),
          api.fauxAssistantMessage('follow-up handled'),
        ],
      )
      session = opened.session
      const nativeEvents: Array<Record<string, unknown>> = []
      let resolvePartial!: () => void
      const partialStarted = new Promise<void>(resolve => {
        resolvePartial = resolve
      })
      const offNative = session.onPiEvent(event => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return
        nativeEvents.push(event)
        if (event.type !== 'message_update') return
        const message = event.message
        if (!message || typeof message !== 'object' || Array.isArray(message)) return
        const text = nativeContentText(message.content)
        return text.length > 0 && text.length < slowText.length ? resolvePartial() : undefined
      })

      const prompt = session.prompt('initial')
      await partialStarted
      const livePage = session.getBranchPage(undefined, 100, 32 * 1024 * 1024)
      const liveMessage = livePage.checkpoint?.liveMessage?.message
      assert.ok(liveMessage && typeof liveMessage === 'object' && !Array.isArray(liveMessage))
      assert.equal(liveMessage.role, 'assistant')
      assert.ok(nativeContentText(liveMessage.content).length > 0)
      assert.ok(nativeContentText(liveMessage.content).length < slowText.length)
      await session.steer('steer now')
      await session.followUp('follow up later')
      assert.deepEqual((session.getState().queue as AnyRecord).steering, ['steer now'])
      assert.deepEqual((session.getState().queue as AnyRecord).followUp, ['follow up later'])

      await prompt
      offNative()
      assert.equal(opened.faux.state.callCount, 3)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
      assert.deepEqual((session.getState().queue as AnyRecord).steering, [])
      assert.deepEqual((session.getState().queue as AnyRecord).followUp, [])
      const answers = allEntries(session)
        .filter(entry => entry.type === 'message' && nativeRole(entry) === 'assistant')
        .map(nativeMessageText)
      assert.deepEqual(answers, [slowText, 'steering handled', 'follow-up handled'])
      assert.ok(nativeEvents.some(event => event.type === 'message_update' && 'message' in event))
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reports native auto-retry phases and the final result', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-retry-'))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-retry',
          api: 'piui-faux-retry',
          models: [{ id: 'retry-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
        },
        api => [
          api.fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' }),
          api.fauxAssistantMessage('retry recovered'),
        ],
      )
      session = opened.session
      const phases: string[] = []
      const off = session.onPiEvent(() => {
        const phase = String((session.getState().retry as AnyRecord).phase)
        if (phases.at(-1) !== phase) phases.push(phase)
      })
      await session.prompt('retry this')
      off()

      const waiting = phases.indexOf('waiting')
      const running = phases.indexOf('running')
      const finished = phases.indexOf('finished')
      assert.ok(waiting >= 0)
      assert.ok(running > waiting)
      assert.ok(finished > running)
      const retry = session.getState().retry as AnyRecord
      assert.equal(retry.phase, 'finished')
      if (retry.phase !== 'finished') assert.fail('retry did not finish')
      assert.equal(retry.success, true)
      assert.equal(retry.attempt, 1)
      assert.equal(opened.faux.state.callCount, 2)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
