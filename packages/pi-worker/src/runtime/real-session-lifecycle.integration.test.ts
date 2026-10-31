import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  nativeRole,
  openOfflineSession,
  loadPiAiFromPinnedSdk,
  emptyResourceLoader,
} from './real-session-test-support.ts'

await loadPiSdk()

// 同 real-session.integration.test.ts：关掉子代理落盘桥（桥由 subagent-sessions.test.ts 覆盖）。

process.env.PIUI_SUBAGENT_SESSIONS = 'off'

describe('RealPiSession session lifecycle with the Pi SDK', () => {
  it('returns and persists a native abandoned-branch summary', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-branch-summary-'))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-branch-summary',
          api: 'piui-faux-branch-summary',
          models: [{ id: 'branch-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 },
          branchSummary: { reserveTokens: 32 },
        },
        api => [
          api.fauxAssistantMessage('first answer'),
          api.fauxAssistantMessage('second answer'),
          api.fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' }),
          api.fauxAssistantMessage('abandoned branch summary'),
        ],
      )
      session = opened.session
      const operationPhases: string[] = []
      const off = session.onPiEvent(() => {
        const operation = (session.getState().compaction as AnyRecord).operation as AnyRecord
        if (operation.type === 'branchSummary' && operationPhases.at(-1) !== operation.phase) {
          operationPhases.push(operation.phase)
        }
      })
      await session.prompt('one')
      await session.prompt('two')
      const target = allEntries(session)
        .filter(entry => entry.type === 'message' && nativeRole(entry) === 'assistant')
        .at(0)
      assert.ok(target)

      const navigation = await session.navigateTree(String(target.id), {
        summarize: true,
        customInstructions: 'Preserve the parser decision',
      })
      off()
      assert.equal(navigation.cancelled, false)
      assert.ok(!navigation.aborted)
      const summaryEntry = navigation.summaryEntry as AnyRecord | null
      assert.equal(summaryEntry?.type, 'branch_summary')
      if (summaryEntry?.type !== 'branch_summary') assert.fail('branch summary was not persisted')
      assert.match(String(summaryEntry.summary), /abandoned branch summary/)
      assert.ok(allEntries(session).some(entry => entry.type === 'branch_summary'))
      assert.ok(operationPhases.includes('retrying'))
      assert.equal(opened.faux.state.callCount, 4)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('returns and persists a manual compaction result with custom instructions', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-compact-'))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-compact',
          api: 'piui-faux-compact',
          models: [{ id: 'compact-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false, reserveTokens: 32, keepRecentTokens: 1 },
          retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
        },
        api => [
          api.fauxAssistantMessage('first answer'),
          api.fauxAssistantMessage('second answer'),
          api.fauxAssistantMessage('history summary'),
          api.fauxAssistantMessage('turn prefix summary'),
        ],
      )
      session = opened.session
      await session.prompt('one')
      await session.prompt('two')
      const lastAssistant = allEntries(session)
        .filter(entry => entry.type === 'message' && nativeRole(entry) === 'assistant')
        .at(-1)
      assert.ok(lastAssistant)

      const compacted = (await session.compact('preserve test checkpoints')) as AnyRecord
      assert.equal(compacted.status, 'completed')
      if (compacted.status !== 'completed') assert.fail('manual compaction was skipped')
      assert.match(compacted.result.summary, /history summary/)
      assert.match(compacted.result.summary, /turn prefix summary/)
      assert.equal(compacted.result.firstKeptEntryId, String(lastAssistant.id))
      assert.ok(compacted.result.tokensBefore > 0)
      assert.ok((compacted.result.estimatedTokensAfter ?? 0) > 0)
      assert.equal(opened.faux.state.callCount, 4)
      assert.equal(opened.faux.getPendingResponseCount(), 0)
      assert.ok(allEntries(session).some(entry => entry.type === 'compaction'))
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('resolves and persists scoped models through the native resolver', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-scoped-'))
    let session: RealPiSession | undefined
    try {
      const opened = await openOfflineSession(
        cwd,
        {
          provider: 'piui-faux-scoped',
          api: 'piui-faux-scoped',
          models: [{ id: 'scoped-1', contextWindow: 4096, maxTokens: 256 }],
        },
        {
          compaction: { enabled: false },
          retry: { enabled: false },
        },
        api => [api.fauxAssistantMessage('scope answer')],
      )
      session = opened.session

      // 精确 pattern 解析为 ScopedModel 并持久化到 session state
      const diagnostics = (await session.setScopedModels(['piui-faux-scoped/scoped-1'])) as AnyRecord[] | undefined
      assert.ok(Array.isArray(diagnostics))
      assert.deepEqual(
        ((session.getState() as AnyRecord).scopedModels as AnyRecord[])?.map(item => item.model?.id),
        ['scoped-1'],
      )

      // glob pattern（provider/*）同样解析
      await session.setScopedModels(['piui-faux-scoped/*'])
      assert.deepEqual(
        ((session.getState() as AnyRecord).scopedModels as AnyRecord[])?.map(item => item.model?.id),
        ['scoped-1'],
      )

      // 无法匹配的 pattern 返回 no-match 诊断，而不是抛错
      const noMatch = (await session.setScopedModels(['piui-faux-scoped/missing'])) as AnyRecord[] | undefined
      assert.ok(Array.isArray(noMatch))
      assert.ok(noMatch?.some((item: AnyRecord) => item.code === 'no-match'))

      // 清空范围
      await session.setScopedModels([])
      assert.deepEqual((session.getState() as AnyRecord).scopedModels, [])
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('exports the native session as HTML and JSONL', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'piui-real-export-'))
    const sessionDir = path.join(cwd, 'sessions')
    mkdirSync(sessionDir)
    let session: RealPiSession | undefined
    try {
      const { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } = await loadPiAiFromPinnedSdk()
      const faux = fauxProvider({
        provider: 'piui-faux-export',
        api: 'piui-faux-export',
        models: [{ id: 'export-1', contextWindow: 4096, maxTokens: 256 }],
      })
      faux.setResponses([fauxAssistantMessage('exported answer')])
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        allowModelNetwork: false,
      })
      modelRuntime.registerNativeProvider(faux.provider)
      await modelRuntime.refresh({ allowNetwork: false })
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
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
      session = await RealPiSession.open(cwd, undefined, {
        agentDir: cwd,
        createRuntime,
        createSessionManager: runtimeCwd => SessionManager.create(runtimeCwd, sessionDir),
      })
      await session.prompt('export me')
      assert.ok(session.getSessionFile())
      // 磁盘 session 导出 JSONL：落盘且含对话
      const jsonlPath = path.join(cwd, 'export.jsonl')
      await session.exportJsonl(jsonlPath)
      assert.equal(existsSync(jsonlPath), true)
      assert.match(readFileSync(jsonlPath, 'utf8'), /exported answer/)
      // 磁盘 session 导出 HTML：返回路径且落盘；SDK 把会话数据 base64 嵌入模板
      const htmlPath = path.join(cwd, 'export.html')
      const htmlResult = (await session.exportHtml(htmlPath)) as AnyRecord | undefined
      assert.equal(htmlResult?.path, htmlPath)
      assert.equal(existsSync(htmlPath), true)
      const html = readFileSync(htmlPath, 'utf8')
      assert.match(html, /<!DOCTYPE html>/)
      const embedded = html.match(/id="session-data"[^>]*>([A-Za-z0-9+/=]+)</)
      assert.ok(embedded, 'html export should embed base64 session data')
      assert.match(Buffer.from(embedded[1], 'base64').toString('utf8'), /exported answer/)
    } finally {
      await session?.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('exercises the native session command surface end to end', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-conformance-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd)
    mkdirSync(agentDir)
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      await session.appendCustomEntry('conformance', { text: 'hello' })

      // state.get：核心状态结构
      const state = session.getState() as AnyRecord
      assert.equal(typeof state.sessionId, 'string')
      assert.equal(typeof state.thinkingLevel, 'string')
      assert.equal(typeof state.messageCount, 'number')

      // state.get：stats/context usage 来自 SDK getSessionStats/getContextUsage
      assert.ok(state.sessionStats && typeof state.sessionStats === 'object' && !Array.isArray(state.sessionStats))
      assert.equal(typeof state.sessionStats.sessionId, 'string')
      assert.equal(typeof state.sessionStats.totalMessages, 'number')
      assert.equal(typeof state.sessionStats.cost, 'number')
      const statsTokens = state.sessionStats.tokens as AnyRecord
      assert.equal(typeof statsTokens.input, 'number')
      assert.equal(typeof statsTokens.output, 'number')
      assert.equal(typeof statsTokens.cacheRead, 'number')
      assert.equal(typeof statsTokens.cacheWrite, 'number')
      assert.equal(typeof statsTokens.total, 'number')
      // 无 provider 时 contextUsage 可为 null 或估算结构，两种都接受
      if (state.contextUsage != null) {
        assert.ok(typeof state.contextUsage === 'object' && !Array.isArray(state.contextUsage))
        assert.equal(typeof state.contextUsage.contextWindow, 'number')
      }

      // registry.get：tools/commands/extensions/handlers 数组
      const registry = session.getRegistry()
      assert.ok(Array.isArray(registry.tools))
      assert.ok(Array.isArray(registry.commands))
      assert.ok(Array.isArray(registry.extensions))
      assert.ok(Array.isArray(registry.eventHandlers))

      // skills.list
      assert.ok(Array.isArray(session.listSkills()))

      // prompts.list：模板结构（name/description/content/filePath）
      const prompts = session.listPrompts() as AnyRecord[]
      assert.ok(Array.isArray(prompts))
      for (const prompt of prompts) {
        assert.equal(typeof prompt.name, 'string')
        assert.equal(typeof prompt.description, 'string')
        assert.equal(typeof prompt.content, 'string')
        assert.equal(typeof prompt.filePath, 'string')
      }

      // agentsFiles.list：AGENTS/CLAUDE 上下文（path/content 结构）
      const agentsFiles = session.listAgentsFiles() as AnyRecord[]
      assert.ok(Array.isArray(agentsFiles))
      for (const file of agentsFiles) {
        assert.equal(typeof file.path, 'string')
        assert.equal(typeof file.content, 'string')
      }

      // entries.get / branch.get / tree.get：分页与树结构
      const entries = session.getEntriesPage(undefined, 100, 1_000_000) as AnyRecord
      assert.ok(Array.isArray(entries.items))
      assert.ok(entries.items.some((item: AnyRecord) => item.type === 'custom'))
      assert.ok(entries.head)
      const branch = session.getBranchPage(undefined, 100, 1_000_000) as AnyRecord
      assert.ok(Array.isArray(branch.items))
      const tree = session.getTree() as AnyRecord[]
      assert.ok(Array.isArray(tree))

      // 状态类命令：name / auto-compaction / auto-retry
      // （thinking level 依赖模型支持，无 provider 时保持 off，不断言）
      await session.setSessionName('conformance-session')
      assert.equal((session.getState() as AnyRecord).sessionName, 'conformance-session')
      await session.setAutoCompaction(false)
      await session.setAutoRetry(false)
      const updated = session.getState() as AnyRecord
      assert.equal(updated.autoCompactionEnabled, false)
      assert.equal(updated.autoRetryEnabled, false)

      // exportJsonl：落盘
      const jsonlPath = path.join(root, 'out.jsonl')
      await session.exportJsonl(jsonlPath)
      assert.equal(existsSync(jsonlPath), true)
      assert.match(readFileSync(jsonlPath, 'utf8'), /conformance/)
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
