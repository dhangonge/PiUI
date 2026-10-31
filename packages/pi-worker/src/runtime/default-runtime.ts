import type {
  CreateAgentSessionRuntimeFactory,
  EventBus,
  LoadExtensionsResult,
  ModelRuntime,
  ProjectTrustContext,
} from '@earendil-works/pi-coding-agent'
import { getLoadedSdk } from '../sdk-host.js'

/**
 * 默认运行时工厂：一个会话一套 settings/services，模型实例（ModelRuntime）
 * 与事件总线由 worker 传入共享——同一进程内所有会话复用同一个模型/认证实例，
 * 插件广播也落在同一条总线上。
 */
export const createDefaultRuntime =
  (modelRuntime?: ModelRuntime, eventBus?: EventBus): CreateAgentSessionRuntimeFactory =>
  async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const { SettingsManager, createAgentSessionServices, createAgentSessionFromServices } = getLoadedSdk().sdk
    const globalSettings = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false })
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      // 共享 ModelRuntime：同一进程内所有会话复用同一个模型/认证实例
      // （SDK 原生支持，见 createAgentSessionServices 的 modelRuntime 参数）。
      modelRuntime,
      // 插件通过 pi.events 广播（子代理公告走这条总线）。显式传入可以让
      // worker 自己也订阅，否则每个 resource loader 会各建一条私有总线。
      ...(eventBus ? { resourceLoaderOptions: { eventBus } } : {}),
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async ({ extensionsResult }) =>
          resolveProjectTrustFromExtensions(cwd, agentDir, extensionsResult, globalSettings.getDefaultProjectTrust()),
      },
    })
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })),
      services,
      diagnostics: services.diagnostics,
    }
  }

/** 无 UI 的 RPC 信任上下文：扩展只能拿到"没人可问"，据此自行决断 */
export function projectTrustContextForRpc(cwd: string): ProjectTrustContext {
  return {
    cwd,
    mode: 'rpc',
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => {},
    },
  }
}

/**
 * 项目信任决策：扩展声明 project_trust 处理器时由它决定（可记住），
 * 否则用 store 里的历史选择，最后退回全局默认。
 */
export async function resolveProjectTrustFromExtensions(
  cwd: string,
  agentDir: string,
  extensionsResult: LoadExtensionsResult,
  defaultDecision: 'always' | 'never' | 'ask',
): Promise<boolean> {
  const { ProjectTrustStore, hasTrustRequiringProjectResources } = getLoadedSdk().sdk
  if (!hasTrustRequiringProjectResources(cwd)) return true

  const trustStore = new ProjectTrustStore(agentDir)
  const context = projectTrustContextForRpc(cwd)
  for (const extension of extensionsResult.extensions) {
    const handlers = extension.handlers.get('project_trust') ?? []
    for (const handler of handlers) {
      const result = (await handler({ type: 'project_trust', cwd }, context)) as {
        trusted: 'yes' | 'no' | 'undecided'
        remember?: boolean
      }
      if (result.trusted === 'undecided') continue
      const trusted = result.trusted === 'yes'
      if (result.remember === true) trustStore.set(cwd, trusted)
      return trusted
    }
  }

  const stored = trustStore.get(cwd)
  if (stored !== null) return stored
  return defaultDecision === 'always'
}
