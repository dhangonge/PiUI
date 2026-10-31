import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { RealPiSession } from './real-session.ts'
import { loadPiSdk } from '../sdk-host.ts'
import { PiCatalog } from './catalog.ts'
import { AnyRecord, loadPiAiFromPinnedSdk } from '../../test-support/real-session.ts'

await loadPiSdk()

// 子代理落盘桥会把 SessionManager.inMemory 换成落盘会话；本文件测的是通用
// 会话语义（含真正的内存态会话），所以关掉桥。桥本身由 subagent-sessions.test.ts 覆盖。

process.env.PIUI_SUBAGENT_SESSIONS = 'off'

describe('RealPiSession with the Pi SDK', () => {
  it('reads a session persisted by SDK 0.84.2 without rewriting its history', () => {
    const fixture = new URL('./fixtures/session-sdk-0.84.2.jsonl', import.meta.url)
    const source = readFileSync(fixture, 'utf8')
    const entries = source
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    const root = mkdtempSync(path.join(tmpdir(), 'piui-sdk-upgrade-'))
    try {
      const file = path.join(root, 'legacy.jsonl')
      writeFileSync(file, source)
      const manager = SessionManager.open(file, root)
      assert.deepEqual(manager.getEntries(), entries.slice(1))
      assert.equal(readFileSync(file, 'utf8'), source)
      assert.ok(manager.buildSessionContext().messages.some(message => message.role === 'user'))
      manager.appendCustomEntry('piui.upgrade-check', { sdk: '1.0.3' })
      assert.deepEqual(SessionManager.open(file, root).getEntries().slice(0, -1), entries.slice(1))
      assert.equal(readFileSync(fixture, 'utf8'), source)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loads a configured custom theme and keeps SDK-bound UI references live', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-theme-context-'))
    const agentDir = path.join(root, 'agent')
    mkdirSync(path.join(agentDir, 'themes'), { recursive: true })
    mkdirSync(path.join(agentDir, 'extensions'))
    const theme = JSON.parse(
      readFileSync(
        new URL('./modes/interactive/theme/dark.json', import.meta.resolve('@earendil-works/pi-coding-agent')),
        'utf8',
      ),
    )
    theme.name = 'custom-fixture'
    writeFileSync(path.join(agentDir, 'themes/custom-fixture.json'), JSON.stringify(theme))
    writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ theme: 'custom-fixture' }))
    writeFileSync(
      path.join(agentDir, 'extensions/probe.js'),
      `
export default function (pi) {
  let capturedTheme;
  pi.on("session_start", (_event, ctx) => {
    capturedTheme = ctx.ui.theme;
    ctx.ui.onTerminalInput(() => undefined)();
    ctx.ui.setStatus("initial-theme", capturedTheme.name);
    ctx.ui.setWidget("todo-like", (_tui, factoryTheme) => ({
      render: () => [ctx.ui.theme.fg("accent", factoryTheme.name)], invalidate() {}
    }));
  });
  pi.registerCommand("swap-theme", { handler: async (_args, ctx) => {
    if (!ctx.ui.setTheme("light").success) throw new Error("theme unavailable");
    ctx.ui.setStatus("changed-theme", capturedTheme.name + ":" + ctx.ui.theme.name);
  } });
}
`,
    )
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(root, undefined, { agentDir })
      await session.initializeExtensions()
      await session.invokeCommand('swap-theme')
      const patches = session.extensionUi.getStateMirror().patches
      assert.ok(
        patches.some(
          patch => patch.kind === 'status' && patch.key === 'initial-theme' && patch.text === 'custom-fixture',
        ),
      )
      assert.ok(
        patches.some(patch => patch.kind === 'status' && patch.key === 'changed-theme' && patch.text === 'light:light'),
      )
      assert.ok(session.extensionUi.listTuiPanels().some(panel => panel.key === 'todo-like'))
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports load, setup and action failures safely and rebinds diagnostics on reload', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-extension-errors-'))
    const agentDir = path.join(root, 'agent')
    const extensionsDir = path.join(agentDir, 'extensions')
    mkdirSync(extensionsDir, { recursive: true })
    writeFileSync(
      path.join(extensionsDir, 'broken.js'),
      'throw new Error("private-load-sentinel"); export default function() {}',
    )
    writeFileSync(
      path.join(extensionsDir, 'events.js'),
      `
export default function (pi) {
  pi.on("session_start", () => {
    pi.appendEntry("start-counter", {});
    throw new Error("private-setup-sentinel");
  });
  pi.registerCommand("bad-command", { handler: async () => { throw new Error("private-command-sentinel") } });
  pi.registerCommand("good-command", { handler: async (_args, ctx) => { ctx.ui.setStatus("alive", "yes") } });
  pi.registerTool({ name: "bad_tool", label: "Bad tool", description: "Fault fixture", parameters: { type: "object", properties: {} },
    execute: async () => { throw new Error("private-tool-sentinel") } });
}
`,
    )
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(root, undefined, { agentDir })
      await session.initializeExtensions()
      const initial = JSON.stringify(session.extensionUi.getStateMirror())
      assert.ok(initial.includes('broken.js failed during load'))
      assert.ok(initial.includes('events.js failed during session_start'))
      await assert.rejects(session.invokeCommand('bad-command'), /Extension action failed/)
      await assert.rejects(session.invokeTool('bad_tool'), /Extension action failed/)
      await session.invokeCommand('good-command')
      assert.ok(JSON.stringify(session.extensionUi.getStateMirror()).includes('"text":"yes"'))
      assert.ok(!JSON.stringify(session.extensionUi.getStateMirror()).includes('sentinel'))
      await session.reload()
      const reloaded = JSON.stringify(session.extensionUi.getStateMirror())
      assert.ok(reloaded.includes('events.js failed during session_start'))
      assert.ok(reloaded.includes('broken.js failed during load'))
      assert.equal(
        session.getEntriesPage(undefined, 100, 100_000).items.filter(entry => entry.customType === 'start-counter')
          .length,
        2,
      )
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('supplies tool context and preserves the SDK guard on manual nested calls', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-tool-context-'))
    const agentDir = path.join(root, 'agent')
    const extensions = path.join(agentDir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeFileSync(
      path.join(extensions, 'nested.js'),
      `
export default function (pi) {
  pi.registerTool({ name: "child", description: "fixture", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "nested result" }], details: {} }) })
  pi.registerTool({ name: "parent", description: "fixture", parameters: { type: "object", properties: {} },
    execute: async (_id, _args, _signal, _update, ctx) => {
      if (!ctx.tools.some(tool => tool.name === "child")) throw new Error("missing tool catalog")
      const outcome = await ctx.executeTool("child", {})
      return { ...outcome.result, details: { nestedIsError: outcome.isError } }
    } })
}
`,
    )
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(root, undefined, { agentDir })
      await session.initializeExtensions()
      const result = (await session.invokeTool('parent')) as {
        content: Array<{ text: string }>
        details: { nestedIsError: boolean }
      }
      assert.equal(result.details.nestedIsError, true)
      assert.match(result.content[0]?.text ?? '', /No assistant message issued this call/)
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forwards the subagent-integration child-session announcements from pi.events', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-child-bus-'))
    const agentDir = path.join(root, 'agent')
    const extensions = path.join(agentDir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    // 频道名与 payload 是 subagent-integration 约定，pi-subagents-lite 就是
    // 用这两个值发公告的；这里用最小 fixture 复现同样的调用。
    writeFileSync(
      path.join(extensions, 'announce.js'),
      `
export default function (pi) {
  pi.registerTool({ name: "announce", description: "fixture", parameters: { type: "object", properties: {} },
    execute: async () => {
      for (const channel of ["subagents:child:session-created", "subagents:child:bound", "subagents:child:disposed"]) {
        pi.events.emit(channel, { sessionId: "child-1", parentSessionId: "parent-1" })
      }
      return { content: [{ type: "text", text: "announced" }], details: {} }
    } })
}
`,
    )
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(root, undefined, { agentDir })
      await session.initializeExtensions()
      const events: AnyRecord[] = []
      const off = session.onChildSession(event => events.push(event as AnyRecord))
      await session.invokeTool('announce')
      off()

      assert.deepEqual(
        events.map(event => event.phase),
        ['created', 'bound', 'disposed'],
      )
      assert.equal(events[0]?.sessionId, 'child-1')
      assert.equal(events[0]?.parentSessionId, 'parent-1')
      // owningSessionId 由 worker 自己盖章，用来对账多会话共进程的情况
      assert.equal(events[0]?.owningSessionId, session.getSessionId())
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('drops announcements when the tool emits on a channel nobody listens to', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-child-bus-mute-'))
    const agentDir = path.join(root, 'agent')
    const extensions = path.join(agentDir, 'extensions')
    mkdirSync(extensions, { recursive: true })
    writeFileSync(
      path.join(extensions, 'announce.js'),
      `
export default function (pi) {
  pi.registerTool({ name: "announce", description: "fixture", parameters: { type: "object", properties: {} },
    execute: async () => {
      pi.events.emit("subagents:child:session-created", { parentSessionId: "parent-1" })
      return { content: [{ type: "text", text: "announced" }], details: {} }
    } })
}
`,
    )
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(root, undefined, { agentDir })
      await session.initializeExtensions()
      const events: AnyRecord[] = []
      session.onChildSession(event => events.push(event as AnyRecord))
      await session.invokeTool('announce')

      // 没有 sessionId 就定位不到子会话，不能上报
      assert.deepEqual(events, [])
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the configured sessionDir for creation and discovery', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-session-dir-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    const sessionDir = path.join(root, 'sessions')
    mkdirSync(cwd)
    mkdirSync(agentDir)
    writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ sessionDir }))
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      assert.equal(path.dirname(session.getSessionFile()!), sessionDir)
      const discoverable = SessionManager.create(cwd, sessionDir)
      discoverable.appendMessage({ role: 'user', content: 'persist', timestamp: Date.now() })
      const { fauxAssistantMessage } = await loadPiAiFromPinnedSdk()
      discoverable.appendMessage(fauxAssistantMessage('persisted'))
      assert.equal(existsSync(discoverable.getSessionFile()!), true)
      assert.equal(
        (await SessionManager.list(cwd, sessionDir)).some(item => item.id === discoverable.getSessionId()),
        true,
      )
      const catalog = new PiCatalog(agentDir)
      assert.equal(
        ((await catalog.listSessions(cwd)) as AnyRecord[]).some(item => item.id === discoverable.getSessionId()),
        true,
      )
      assert.equal(SettingsManager.create(process.cwd(), agentDir).getSessionDir(), sessionDir)
      assert.equal(
        ((await catalog.listAllSessions()) as AnyRecord[]).some(item => item.id === discoverable.getSessionId()),
        true,
      )
      await session.dispose()
      session = await RealPiSession.open(cwd, discoverable.getSessionFile(), { agentDir })
      const replacement = await session.newSession()
      assert.equal(path.dirname(replacement.targetSessionFile!), sessionDir)
    } finally {
      await session?.dispose()
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers the Pi session directory environment override', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-session-dir-env-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    const sessionDir = path.join(root, 'environment-sessions')
    mkdirSync(cwd)
    mkdirSync(agentDir)
    writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ sessionDir: path.join(root, 'settings-sessions') }),
    )
    const previous = process.env.PI_CODING_AGENT_SESSION_DIR
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      assert.equal(path.dirname(session.getSessionFile()!), sessionDir)
    } finally {
      await session?.dispose()
      if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
      else process.env.PI_CODING_AGENT_SESSION_DIR = previous
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('validates and persists every extended settings value', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-settings-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    mkdirSync(cwd)
    mkdirSync(agentDir)
    const previousHttpProxy = process.env.HTTP_PROXY
    const previousHttpsProxy = process.env.HTTPS_PROXY
    try {
      const catalog = new PiCatalog(agentDir)
      const result = (await catalog.patchSettings(cwd, {
        defaultThinkingLevel: 'max',
        transport: 'websocket-cached',
        httpIdleTimeoutMs: 1234,
        httpProxy: ' http://127.0.0.1:7890 ',
        shellPath: null,
        packages: ['npm:plain-package', { source: 'git:filtered-package', autoload: false, extensions: ['index.ts'] }],
        warnings: { anthropicExtraUsage: false },
      })) as AnyRecord
      assert.equal(result.effective.defaultThinkingLevel, 'max')
      assert.equal(result.effective.transport, 'websocket-cached')
      assert.equal(result.effective.httpIdleTimeoutMs, 1234)
      assert.equal(result.effective.httpProxy, 'http://127.0.0.1:7890')
      assert.deepEqual(result.effective.packages, [
        'npm:plain-package',
        { source: 'git:filtered-package', autoload: false, extensions: ['index.ts'] },
      ])

      await assert.rejects(
        catalog.patchSettings(cwd, { packages: [{ source: 'x', unknown: true }] }),
        /invalid Pi setting: packages/,
      )
      await assert.rejects(
        catalog.patchSettings(cwd, { warnings: { anthropicExtraUsage: 'yes' as never } }),
        /invalid Pi setting: warnings/,
      )
      await assert.rejects(
        catalog.patchSettings(cwd, { httpIdleTimeoutMs: -1 }),
        /invalid Pi setting: httpIdleTimeoutMs/,
      )
      await assert.rejects(catalog.patchSettings(cwd, { httpProxy: 42 as never }), /invalid Pi setting: httpProxy/)
      const cleared = (await catalog.patchSettings(cwd, { httpProxy: null })) as AnyRecord
      assert.equal(cleared.effective.httpProxy, undefined)
    } finally {
      if (previousHttpProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = previousHttpProxy
      if (previousHttpsProxy === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previousHttpsProxy
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets global extensions decide project trust before project resources load', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-project-trust-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    const projectExtensions = path.join(cwd, '.pi', 'extensions')
    mkdirSync(projectExtensions, { recursive: true })
    mkdirSync(agentDir)
    const trustExtension = path.join(root, 'trust-extension.js')
    writeFileSync(
      trustExtension,
      `
export default function (pi) {
  pi.on("project_trust", () => ({ trusted: "yes", remember: true }))
}
`,
    )
    writeFileSync(
      path.join(projectExtensions, 'trusted-command.js'),
      `
export default function (pi) {
  pi.registerCommand("trusted-project-command", { description: "trusted", handler: async () => {} })
  pi.registerTool({
    name: "trusted-project-tool",
    description: "trusted tool",
    parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  })
}
`,
    )
    writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ extensions: [trustExtension] }))
    let session: RealPiSession | undefined
    try {
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      await session.initializeExtensions()
      assert.equal(
        session.getRegistry().commands.some(command => command.name === 'trusted-project-command'),
        true,
      )
      assert.equal(
        session
          .getRegistry()
          .commands.some(command => command.name === 'reload' && command.sourceInfo?.builtin === true),
        true,
      )
      assert.equal(
        session
          .getRegistry()
          .tools.some(
            tool =>
              tool.name === 'trusted-project-tool' &&
              tool.parameters &&
              typeof tool.parameters === 'object' &&
              !Array.isArray(tool.parameters),
          ),
        true,
      )
      assert.equal(new (await import('@earendil-works/pi-coding-agent')).ProjectTrustStore(agentDir).get(cwd), true)
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('round-trips native extension dialogs through the real SDK', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-real-dialog-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    const projectExtensions = path.join(cwd, '.pi', 'extensions')
    mkdirSync(projectExtensions, { recursive: true })
    mkdirSync(agentDir)
    writeFileSync(
      path.join(projectExtensions, 'dialog-command.js'),
      `
export default function (pi) {
  pi.registerCommand("dialog-e2e", {
    description: "exercise extension dialogs",
    handler: async (args, ctx) => {
      ctx.ui.setStatus("mode", "Planning")
      ctx.ui.setWidget("plan", ["1. Inspect", "2. Fix"], { placement: "aboveEditor" })
      ctx.ui.notify("started", "info")
      const choice = await ctx.ui.select("Pick one", ["alpha", "beta"])
      const ok = await ctx.ui.confirm("Confirm?", "Proceed?")
      const text = await ctx.ui.input("Name", "hint")
      const edited = await ctx.ui.editor("Editor", "prefill")
      ctx.ui.setStatus("mode", "Done")
      ctx.ui.notify("finished", "success")
      const { writeFileSync } = await import("node:fs")
      writeFileSync(${JSON.stringify(path.join(root, 'dialog-result.json'))}, JSON.stringify({ choice, ok, text, edited }))
    },
  })
}
`,
    )
    let session: RealPiSession | undefined
    try {
      // 预置项目信任，让 .pi/extensions 的扩展在 trust pass 后加载
      new (await import('@earendil-works/pi-coding-agent')).ProjectTrustStore(agentDir).set(cwd, true)
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      await session.initializeExtensions()
      assert.equal(
        session.getRegistry().commands.some(command => command.name === 'dialog-e2e'),
        true,
      )

      // 触发 command：handler 依次发起 4 个原生对话框
      const pending: Array<{ requestId: string; kind: string }> = []
      const states: string[] = []
      const notifications: string[] = []
      const off = session.onExtensionUi(event => {
        const uiEvent = event as {
          type?: string
          request?: { requestId?: string; kind?: string }
          patch?: { kind?: string }
          message?: string
        }
        const request = uiEvent.request
        if (request?.requestId) pending.push({ requestId: request.requestId, kind: String(request.kind) })
        if (uiEvent.type === 'state' && uiEvent.patch?.kind === 'status' && typeof uiEvent.patch.text === 'string') {
          states.push(uiEvent.patch.text)
        }
        if (uiEvent.type === 'notify' && typeof uiEvent.message === 'string') notifications.push(uiEvent.message)
      })
      const result = session.invokeCommand('dialog-e2e', undefined)

      // 逐个响应：select -> confirm -> input -> editor
      const kinds: string[] = []
      const deadline = Date.now() + 10_000
      while (kinds.length < 4 && Date.now() < deadline) {
        const next = pending.shift()
        if (!next) {
          await new Promise(resolve => setTimeout(resolve, 25))
          continue
        }
        kinds.push(next.kind)
        // 刷新/重连恢复：dialog 挂起期间 state.get 必须能带回未应答的
        // pending 请求（worker 侧请求仍在，扩展仍在阻塞等应答——数据没有
        // 丢）。已应答的已被 respond() 移除，所以快照只含当前未应答的。
        const pendingState = (session.getState().pendingExtensionUiRequests ?? []) as Array<{
          requestId: string
          kind: string
        }>
        assert.deepEqual(
          pendingState.map(request => request.kind),
          [next.kind],
        )
        assert.equal(pendingState[0]?.requestId, next.requestId)
        // 刷新/重连恢复：增量 UI 状态镜像（setStatus 的 patch）同样可见
        const uiState = session.getState().extensionUiState as {
          patches?: Array<{ kind: string; key?: string; text?: string }>
        }
        const statusPatches = (uiState.patches ?? []).filter(patch => patch.kind === 'status')
        assert.deepEqual(
          statusPatches.map(patch => patch.text),
          ['Planning'],
        )
        const response =
          next.kind === 'select'
            ? { value: 'beta' }
            : next.kind === 'confirm'
              ? { confirmed: true }
              : next.kind === 'input'
                ? { value: 'typed' }
                : { value: 'edited!' }
        assert.equal(await session.respondExtensionUi(next.requestId, response as never), true)
      }
      assert.deepEqual(kinds, ['select', 'confirm', 'input', 'editor'])

      await result
      const values = JSON.parse(readFileSync(path.join(root, 'dialog-result.json'), 'utf8')) as Record<string, unknown>
      assert.deepEqual(values, { choice: 'beta', ok: true, text: 'typed', edited: 'edited!' })
      // 状态事件：setStatus 先后推送 Planning / Done，notify 推送 started / finished
      assert.deepEqual(states, ['Planning', 'Done'])
      assert.deepEqual(notifications, ['started', 'finished'])
      // 全部应答后 pending 清空（settled）
      assert.deepEqual(session.getState().pendingExtensionUiRequests, [])
      // Reconnect restores the latest value; the event stream above retains both transitions.
      const doneState = session.getState().extensionUiState as {
        patches?: Array<{ kind: string; key?: string; text?: string }>
      }
      assert.deepEqual(
        (doneState.patches ?? []).filter(patch => patch.kind === 'status').map(patch => patch.text),
        ['Done'],
      )
      off()
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('hosts extension component widgets and custom() offscreen through the real SDK', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'piui-real-tui-'))
    const cwd = path.join(root, 'workspace')
    const agentDir = path.join(root, 'agent')
    const projectExtensions = path.join(cwd, '.pi', 'extensions')
    mkdirSync(projectExtensions, { recursive: true })
    mkdirSync(agentDir)
    writeFileSync(
      path.join(projectExtensions, 'tui-command.js'),
      `
export default function (pi) {
  pi.registerCommand("tui-e2e", {
    description: "exercise the extension TUI mirror",
    handler: async (args, ctx) => {
      const { Container, Text } = await import("@earendil-works/pi-tui")
      ctx.ui.setWidget("panel", (tui, theme) => {
        const container = new Container()
        container.addChild(new Text(theme.fg("accent", "e2e panel"), 1, 0))
        return container
      }, { placement: "aboveEditor" })
      const result = await ctx.ui.custom((tui, theme, keybindings, done) => {
        const container = new Container()
        container.addChild(new Text("custom e2e", 1, 0))
        setTimeout(() => done("custom-done"), 50)
        return container
      })
      const { writeFileSync } = await import("node:fs")
      writeFileSync(${JSON.stringify(path.join(root, 'tui-result.json'))}, JSON.stringify({ result }))
    },
  })
}
`,
    )
    let session: RealPiSession | undefined
    try {
      // 预置项目信任，让 .pi/extensions 的扩展在 trust pass 后加载
      new (await import('@earendil-works/pi-coding-agent')).ProjectTrustStore(agentDir).set(cwd, true)
      session = await RealPiSession.open(cwd, undefined, { agentDir })
      await session.initializeExtensions()
      assert.equal(
        session.getRegistry().commands.some(command => command.name === 'tui-e2e'),
        true,
      )

      const tuiEvents: Array<{ type: string; key?: string; data?: string }> = []
      const off = session.onExtensionUi(event => {
        const tuiEvent = event as { type?: string; attach?: { key?: string }; key?: string; data?: string }
        if (tuiEvent.type === 'tuiAttach' || tuiEvent.type === 'tuiDetach' || tuiEvent.type === 'tuiFrame') {
          tuiEvents.push({
            type: String(tuiEvent.type),
            key: tuiEvent.attach?.key ?? tuiEvent.key,
            data: tuiEvent.data,
          })
        }
      })

      await session.invokeCommand('tui-e2e', undefined)
      // custom() 的 done 在 50ms 后触发，帧走 setTimeout(0) flush
      await new Promise(resolve => setTimeout(resolve, 300))

      // 组件 widget 与 custom() 都挂载、出帧、custom 关闭后 detach
      assert.ok(tuiEvents.some(event => event.type === 'tuiAttach' && event.key === 'panel'))
      assert.ok(tuiEvents.some(event => event.type === 'tuiAttach' && event.key === 'custom'))
      assert.ok(tuiEvents.some(event => event.type === 'tuiFrame' && event.data?.includes('e2e panel')))
      assert.ok(tuiEvents.some(event => event.type === 'tuiFrame' && event.data?.includes('custom e2e')))
      assert.ok(tuiEvents.some(event => event.type === 'tuiDetach' && event.key === 'custom'))

      const result = JSON.parse(readFileSync(path.join(root, 'tui-result.json'), 'utf8')) as Record<string, unknown>
      assert.deepEqual(result, { result: 'custom-done' })
      off()
    } finally {
      await session?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
