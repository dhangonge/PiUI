import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import { getLoadedSdk } from '../sdk-host.js'

/** PiUI 直接调用的会话方法（缺任一 → 开会话就报错，而不是运行时才炸） */
const SESSION_METHODS = [
  'subscribe',
  'bindExtensions',
  'waitForIdle',
  'prompt',
  'steer',
  'followUp',
  'sendUserMessage',
  'clearQueue',
  'abort',
  'setSessionName',
  'cycleModel',
  'setScopedModels',
  'setThinkingLevel',
  'cycleThinkingLevel',
  'setSteeringMode',
  'setFollowUpMode',
  'compact',
  'abortBranchSummary',
  'abortRetry',
  'setAutoCompactionEnabled',
  'setAutoRetryEnabled',
  'recordBashResult',
  'executeBash',
  'abortBash',
  'getAllTools',
  'setActiveToolsByName',
  'navigateTree',
  'sendCustomMessage',
  'exportToHtml',
  'exportToJsonl',
  'reload',
] as const

/** 运行时（跨会话替换）方法 */
const RUNTIME_METHODS = [
  'newSession',
  'switchSession',
  'fork',
  'importFromJsonl',
  'dispose',
  'setBeforeSessionInvalidate',
  'setRebindSession',
] as const

/** SessionManager 方法：落盘、树、标签、自定义条目 */
const SESSION_MANAGER_METHODS = [
  'getSessionId',
  'getSessionFile',
  'getCwd',
  'getEntries',
  'getTree',
  'getEntry',
  'getSessionName',
  'getSessionDir',
  'appendLabelChange',
  'appendCustomEntry',
  'getLeafId',
] as const

/** 资源加载器方法：主题与扩展列表 */
const RESOURCE_LOADER_METHODS = ['getThemes', 'getSkills', 'getExtensions'] as const

/**
 * 会话实例契约门禁：PiUI 委托到的 Pi SDK 会话/运行时方法必须存在。
 * 按 SDK 版本缓存（同版本只验一次）；缺方法 → PI_SDK_INCOMPATIBLE 响亮失败，
 * 在开会话时暴露详情，而不是等用户发消息才在运行时炸。
 */
let verifiedSessionContractSdkVersion: string | undefined

export function verifySdkSessionContract(runtime: AgentSessionRuntime, version = getLoadedSdk().version): void {
  if (verifiedSessionContractSdkVersion === version) return
  const missing: string[] = []
  const session = runtime.session as unknown as Record<string, unknown>
  for (const method of SESSION_METHODS) {
    if (typeof session[method] !== 'function') missing.push(`session.${method}`)
  }
  for (const method of RUNTIME_METHODS) {
    if (typeof (runtime as unknown as Record<string, unknown>)[method] !== 'function') missing.push(`runtime.${method}`)
  }
  const manager = runtime.session.sessionManager as unknown as Record<string, unknown> | undefined
  for (const method of SESSION_MANAGER_METHODS) {
    if (!manager || typeof manager[method] !== 'function') missing.push(`sessionManager.${method}`)
  }
  const loader = runtime.session.resourceLoader as unknown as Record<string, unknown> | undefined
  for (const method of RESOURCE_LOADER_METHODS) {
    if (!loader || typeof loader[method] !== 'function') missing.push(`resourceLoader.${method}`)
  }
  if (missing.length > 0) {
    throw Object.assign(new Error(`Pi SDK ${version} session contract is incompatible:\n- ${missing.join('\n- ')}`), {
      code: 'PI_SDK_INCOMPATIBLE',
    })
  }
  verifiedSessionContractSdkVersion = version
}
