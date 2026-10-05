// Run with node --import tsx scripts/probe-pi-sdk.mjs <SDK package directory>.
// Uses only synthetic messages, an in-memory credential store and temporary files.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifySdkModuleContract } from '../packages/pi-worker/src/sdk-host.ts'
import { verifySdkSessionContract } from '../packages/pi-worker/src/runtime/real-session.ts'

const sdkDir = resolve(process.argv[2] ?? 'node_modules/@earendil-works/pi-coding-agent')
const entry = pathToFileURL(join(sdkDir, 'dist/index.js'))
let aiEntry
for (let directory = sdkDir; directory !== dirname(directory); directory = dirname(directory)) {
  const candidate = join(directory, 'node_modules/@earendil-works/pi-ai/dist/index.js')
  if (existsSync(candidate)) { aiEntry = candidate; break }
}
assert.ok(aiEntry, 'Pi AI must resolve from the selected SDK dependency family')
const root = mkdtempSync(join(tmpdir(), 'piui-sdk-contract-'))
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = root
let runtime
let modelRuntime
try {
  const sdk = await import(entry.href)
  const ai = await import(pathToFileURL(aiEntry).href)
  assert.deepEqual(verifySdkModuleContract(sdk), [])
  const faux = ai.fauxProvider({ provider: 'piui-probe', api: 'piui-probe' })
  faux.setResponses([ai.fauxAssistantMessage('offline contract answer')])
  modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.refresh({ allowNetwork: false })
  const cwd = join(root, 'workspace')
  mkdirSync(cwd)
  const sessionDir = join(root, 'sessions')
  const manager = sdk.SessionManager.create(cwd, sessionDir)
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } })
  const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
    const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }
    const resourceLoader = {
      getExtensions: () => extensions,
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => '', getAppendSystemPrompt: () => [],
      extendResources() {}, async reload() {},
    }
    const services = { cwd, agentDir: root, modelRuntime, settingsManager, resourceLoader, diagnostics: [] }
    return {
      ...await sdk.createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent, model: faux.getModel(), thinkingLevel: 'off', noTools: 'all',
      }),
      services, diagnostics: [],
    }
  }
  runtime = await sdk.createAgentSessionRuntime(createRuntime, { cwd, agentDir: root, sessionManager: manager })
  verifySdkSessionContract(runtime, sdk.VERSION)
  let bindings = 0
  const bind = async session => {
    await session.bindExtensions({ mode: 'rpc' })
    bindings++
  }
  runtime.setRebindSession(bind)
  await bind(runtime.session)
  const events = []
  const off = runtime.session.subscribe(event => events.push(event.type))
  await runtime.session.prompt('offline contract prompt')
  await runtime.session.waitForIdle()
  await runtime.session.abort()
  off()
  assert.equal(faux.state.callCount, 1)
  assert.ok(events.includes('agent_settled'))
  const sourceFile = manager.getSessionFile()
  const sourceEntries = JSON.parse(JSON.stringify(manager.getEntries()))
  const sourceText = readFileSync(sourceFile, 'utf8')
  const userEntry = sourceEntries.find(entry => entry.type === 'message' && entry.message.role === 'user')
  assert.ok(userEntry)
  await runtime.newSession()
  await runtime.switchSession(sourceFile)
  assert.deepEqual(runtime.session.sessionManager.getEntries(), sourceEntries)
  await runtime.fork(userEntry.id)
  assert.notEqual(runtime.session.sessionManager.getSessionId(), manager.getSessionId())
  assert.equal(readFileSync(sourceFile, 'utf8'), sourceText)
  assert.equal(bindings, 4)
  await runtime.session.reload()
  if (process.env.PIUI_PROBE_FIXTURE) {
    // Never overwrite a fixture: the caller must choose a new destination.
    writeFileSync(process.env.PIUI_PROBE_FIXTURE, sourceText, { flag: 'wx' })
  }
  console.log(`PASS SDK ${sdk.VERSION}: module/session contracts, offline prompt, cancel, rebind, new/switch/fork/reload, persisted history`)
} finally {
  await runtime?.dispose()
  await modelRuntime?.dispose?.()
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  rmSync(root, { recursive: true, force: true })
}
