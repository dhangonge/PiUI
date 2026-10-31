import { randomUUID } from 'node:crypto'
import type { AgentSessionRuntime } from '@earendil-works/pi-coding-agent'
import type { JsonObject } from '@piui/protocol'
import { resolveUserPath } from './catalog.js'
import type { ExtensionUiBridge } from './extension-ui-bridge.js'
import { assertSessionFileInside } from './native-json.js'
import type { RealPiSession } from './real-session.js'

export interface ExtensionHostActions {
  reserveReplacement(request: {
    reservationId: string
    sourceSessionId: string
    operation: 'new' | 'fork' | 'switch'
    targetSessionFile?: string
  }): Promise<void>
  commitReplacement(reservationId: string, replacement: JsonObject): Promise<void>
  abortReplacement(reservationId: string): Promise<void>
  requestShutdown(sessionId: string): void
}

export function unsupportedExtensionHostAction(action: string): never {
  throw Object.assign(new Error(`Extension command context ${action} requires a coordinated PiUI host`), {
    code: 'CAPABILITY_DISABLED',
  })
}

export function extensionBindings(
  bridge: ExtensionUiBridge,
  runtime: AgentSessionRuntime,
  navigateTree: RealPiSession['navigateTree'],
  reload: RealPiSession['reload'],
  hostActions?: ExtensionHostActions,
) {
  const reportFailure = bridge.captureFailureReporter()
  return {
    mode: 'rpc' as const,
    uiContext: bridge.context,
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: (options?: Parameters<AgentSessionRuntime['newSession']>[0]) =>
        runExtensionReplacement(runtime, hostActions, 'new', undefined, () => runtime.newSession(options)),
      fork: (entryId: string, options?: Parameters<AgentSessionRuntime['fork']>[1]) =>
        runExtensionReplacement(runtime, hostActions, 'fork', undefined, () => runtime.fork(entryId, options)),
      navigateTree: async (
        entryId: string,
        options?: {
          summarize?: boolean
          customInstructions?: string
          replaceInstructions?: boolean
          label?: string
        },
      ) => {
        const result = await navigateTree(entryId, options)
        return { cancelled: result.cancelled === true }
      },
      switchSession: (sessionPath: string, options?: Parameters<AgentSessionRuntime['switchSession']>[1]) =>
        runExtensionReplacement(runtime, hostActions, 'switch', sessionPath, () =>
          runtime.switchSession(sessionPath, options),
        ),
      reload,
    },
    abortHandler: () => {
      void runtime.session.abort().catch(() => reportFailure('runtime', 'abort'))
    },
    shutdownHandler: () =>
      hostActions
        ? hostActions.requestShutdown(runtime.session.sessionManager.getSessionId())
        : unsupportedExtensionHostAction('shutdown'),
  }
}

/**
 * 扩展发起的 new/fork/switch 走宿主预约→替换→提交/回滚：
 * 宿主（worker）据此先清空会话镜像，再落地新会话，避免半替换状态。
 * 替换取消或抛错都必须回滚预约，否则宿主会一直等这个 reservation。
 */
export async function runExtensionReplacement(
  runtime: AgentSessionRuntime,
  hostActions: ExtensionHostActions | undefined,
  operation: 'new' | 'fork' | 'switch',
  targetSessionFile: string | undefined,
  replace: () => Promise<{ cancelled: boolean }>,
): Promise<{ cancelled: boolean }> {
  if (!hostActions) return unsupportedExtensionHostAction(operation)
  const sourceSessionId = runtime.session.sessionManager.getSessionId()
  if (operation === 'switch' && targetSessionFile) {
    await assertSessionFileInside(runtime.session.sessionManager.getSessionDir(), resolveUserPath(targetSessionFile))
  }
  const reservationId = randomUUID()
  await hostActions.reserveReplacement({ reservationId, sourceSessionId, operation, targetSessionFile })
  try {
    const result = await replace()
    if (result.cancelled) {
      await hostActions.abortReplacement(reservationId)
      return result
    }
    const replacement: JsonObject = {
      operation,
      sourceSessionId,
      targetSessionId: runtime.session.sessionManager.getSessionId(),
      targetSessionFile: runtime.session.sessionManager.getSessionFile() ?? null,
      targetCwd: runtime.session.sessionManager.getCwd(),
      cancelled: false,
    }
    await hostActions.commitReplacement(reservationId, replacement)
    return result
  } catch (error) {
    await hostActions.abortReplacement(reservationId).catch(() => undefined)
    throw error
  }
}
