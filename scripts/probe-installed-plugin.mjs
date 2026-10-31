// Run only through the isolated bubblewrap harness; never load personal config here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadPiSdk } from '../packages/pi-worker/src/sdk-host.ts'
import { RealPiSession } from '../packages/pi-worker/src/runtime/real-session.ts'

if (process.env.PIUI_PLUGIN_SANDBOX !== '1' || process.env.HOME !== '/fixture') {
  throw new Error('This probe requires the isolated /fixture sandbox')
}
const name = process.argv[2]
const packageDir = path.join('/plugins/node_modules', name ?? '')
const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
const sources = manifest.pi?.extensions?.map(entry => path.resolve(packageDir, entry)) ?? []
if (!sources.length) throw new Error('No declared plugin entry points')
mkdirSync('/fixture/agent', { recursive: true })
mkdirSync('/fixture/workspace', { recursive: true })
writeFileSync(
  '/fixture/agent/settings.json',
  JSON.stringify({ extensions: [...sources, '-builtin:mcp'], packages: [], theme: 'dark' }),
)
await loadPiSdk()
const session = await RealPiSession.open('/fixture/workspace', undefined, { agentDir: '/fixture/agent' })
const started = Date.now()
const report = {
  name,
  version: manifest.version,
  tools: [],
  commands: [],
  diagnostics: [],
  exercise: 'startup only',
  elapsedMs: 0,
}
try {
  await session.initializeExtensions()
  const registry = session.getRegistry()
  // Test-only inspection of the pinned SDK host; sandbox contains no credentials.
  const loadErrors = session.runtime.session.resourceLoader.getExtensions().errors
  if (loadErrors.length) {
    console.error('ISOLATED_LOAD_ERRORS ' + JSON.stringify(loadErrors))
    process.exitCode = 1
  }
  if (!registry.extensions.length) throw new Error('No extension registered')
  report.extensionTools = registry.extensions.flatMap(extension => extension.tools)
  report.tools = registry.tools.map(tool => tool.name)
  report.commands = registry.extensions.flatMap(extension => extension.commands)
  if (name === '@juicesharp/rpiv-todo') {
    let rendered = false
    const stopFrames = session.extensionUi.onEvent(event => {
      if (event.type === 'tuiFrame' && event.data.includes('Sandbox task')) rendered = true
    })
    try {
      const result = await session.invokeTool('todo', {
        action: 'create',
        subject: 'Sandbox task',
        description: 'Isolated test; no personal state',
      })
      // Manual invokeTool intentionally bypasses agent events. Replay the documented
      // post-tool event to exercise the real plugin's lazy widget path as well.
      await session.runtime.session.extensionRunner.emit({
        type: 'tool_execution_end',
        toolCallId: 'sandbox-fixture',
        toolName: 'todo',
        result,
        isError: false,
      })
      const deadline = Date.now() + 3000
      while (!rendered && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      if (!session.extensionUi.listTuiPanels().some(panel => panel.kind === 'widget') || !rendered)
        throw new Error('Todo widget did not render its task')
      if (
        !session.extensionUi
          .getStateMirror()
          .patches.some(patch => patch.kind === 'widget' && patch.lines?.some(line => line.includes('Sandbox task')))
      )
        throw new Error('Todo widget has no mobile snapshot')
    } finally {
      stopFrames()
    }
    report.exercise = 'created one isolated task; verified TUI frame and persistent mobile widget snapshot'
  }
  if (name === '@juicesharp/rpiv-ask-user-question') {
    const unsubscribe = session.extensionUi.onEvent(event => {
      if (event.type !== 'requested') return
      const request = event.request
      session.extensionUi.respond(
        request.requestId,
        request.kind === 'confirm'
          ? { confirmed: false }
          : { value: request.kind === 'select' ? request.options[0] : '1,2' },
      )
    })
    try {
      const result = await session.invokeTool('ask_user_question', {
        questions: [
          {
            question: 'Select fixture items?',
            header: 'Fixture',
            multiSelect: true,
            options: [
              { label: 'One', description: 'First fixture' },
              { label: 'Two', description: 'Second fixture' },
            ],
          },
        ],
      })
      if (!JSON.stringify(result).includes('One') || !JSON.stringify(result).includes('Two'))
        throw new Error('Multiple choices not preserved')
      report.exercise = 'answered an isolated RPC multi-select'
    } finally {
      unsubscribe()
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250))
  report.diagnostics = session.extensionUi
    .getStateMirror()
    .patches.filter(patch => patch.kind === 'status' && patch.key.startsWith('piui-host:'))
    .map(patch => patch.text)
  report.panels = session.extensionUi.listTuiPanels().map(panel => panel.kind)
  report.elapsedMs = Date.now() - started
  if (
    session.extensionUi
      .getStateMirror()
      .patches.some(patch => patch.kind === 'status' && patch.key.startsWith('piui-host:error:'))
  )
    process.exitCode = 1
} catch {
  report.diagnostics = session.extensionUi
    .getStateMirror()
    .patches.filter(patch => patch.kind === 'status' && patch.key.startsWith('piui-host:'))
    .map(patch => patch.text)
  report.exercise = 'probe action failed; inspect isolated logs'
  process.exitCode = 1
} finally {
  await session.dispose()
  console.log('PIUI_PLUGIN_PROBE ' + JSON.stringify(report))
}
