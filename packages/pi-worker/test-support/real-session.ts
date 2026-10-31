import {
  createAgentSessionFromServices,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent'
import { RealPiSession } from '../src/runtime/real-session.js'

// 集成测试共用夹具：原生条目/树读取、离线 faux provider 会话。
// 只导出纯函数与工厂，不持有模块级可变状态——每个用例自己开会话，
// 夹具之间不共享会话或临时目录。
export type AnyRecord = Record<string, any>

export function allEntries(session: RealPiSession): AnyRecord[] {
  return session.getEntriesPage(undefined, 100_000, 256 * 1024 * 1024).items as AnyRecord[]
}

export function activeBranchEntries(session: RealPiSession): AnyRecord[] {
  return session.getBranchPage(undefined, 100_000, 256 * 1024 * 1024).items as AnyRecord[]
}

export function sessionTree(session: RealPiSession): AnyRecord[] {
  return session.getTree() as AnyRecord[]
}

export function findTreeLabel(roots: AnyRecord[], entryId: string): string | undefined {
  const node = findTreeNode(roots, entryId)
  return typeof node?.label === 'string' ? node.label : undefined
}

export function findTreeNode(roots: AnyRecord[], entryId: string): AnyRecord | undefined {
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()!
    const entry = node.entry
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === entryId) {
      return node
    }
    if (Array.isArray(node.children)) {
      stack.push(
        ...node.children.filter(
          (child): child is typeof node => Boolean(child) && typeof child === 'object' && !Array.isArray(child),
        ),
      )
    }
  }
  return undefined
}

export function nativeRole(entry: AnyRecord): unknown {
  const message = entry.message
  return message && typeof message === 'object' && !Array.isArray(message) ? message.role : undefined
}

export function nativeMessage(entry: AnyRecord | undefined): Record<string, unknown> {
  const message = entry?.message
  return message && typeof message === 'object' && !Array.isArray(message) ? message : {}
}

export function nativeMessageText(entry: AnyRecord): string {
  return nativeContentText(nativeMessage(entry).content)
}

export function nativeContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap(block =>
      block &&
      typeof block === 'object' &&
      !Array.isArray(block) &&
      block.type === 'text' &&
      typeof block.text === 'string'
        ? [block.text]
        : [],
    )
    .join('')
}

export type ModelRuntimeOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>
export type NativeProvider = Parameters<ModelRuntime['registerNativeProvider']>[0]

export interface PiAiTestApi {
  InMemoryCredentialStore: new () => NonNullable<ModelRuntimeOptions['credentials']>
  fauxAssistantMessage(text: string, options?: { stopReason?: string; errorMessage?: string }): unknown
  fauxProvider(options: {
    provider: string
    api: string
    models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }>
    tokensPerSecond?: number
    tokenSize?: { min?: number; max?: number }
  }): {
    provider: NativeProvider
    state: { callCount: number }
    setResponses(responses: unknown[]): void
    getModel(): ReturnType<ModelRuntime['getModel']> & object
    getPendingResponseCount(): number
  }
}

export async function openOfflineSession(
  cwd: string,
  fauxOptions: Parameters<PiAiTestApi['fauxProvider']>[0],
  settings: Parameters<typeof SettingsManager.inMemory>[0],
  responses: (api: PiAiTestApi) => unknown[],
): Promise<{
  session: RealPiSession
  faux: ReturnType<PiAiTestApi['fauxProvider']>
}> {
  const api = await loadPiAiFromPinnedSdk()
  const faux = api.fauxProvider(fauxOptions)
  faux.setResponses(responses(api))
  const modelRuntime = await ModelRuntime.create({
    credentials: new api.InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  await modelRuntime.refresh({ allowNetwork: false })
  const settingsManager = SettingsManager.inMemory(settings)
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
  return {
    session: await RealPiSession.open(cwd, undefined, {
      agentDir: cwd,
      createRuntime,
      createSessionManager: runtimeCwd => SessionManager.inMemory(runtimeCwd),
    }),
    faux,
  }
}

export async function loadPiAiFromPinnedSdk(): Promise<PiAiTestApi> {
  let piAiEntry: string
  try {
    piAiEntry = import.meta.resolve('@earendil-works/pi-ai')
  } catch {
    const codingAgentEntry = import.meta.resolve('@earendil-works/pi-coding-agent')
    piAiEntry = new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', codingAgentEntry).href
  }
  return (await import(piAiEntry)) as unknown as PiAiTestApi
}

export function emptyResourceLoader(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() }
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '',
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  }
}
