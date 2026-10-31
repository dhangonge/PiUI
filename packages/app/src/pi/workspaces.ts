import { postHostCommand } from './transport/index.js'
import { trackPiWorkspace } from './piSessionIndex'
import { serverStore } from '../store/serverStore'
import { getServerRevision } from '../utils/sessionKey'

/**
 * Host workspace commands (workspaces.*). A workspace is just a directory
 * the server remembers; the canonical path is its identity.
 */
export interface HostWorkspace {
  path: string
  displayName?: string
  createdAt?: string
  lastOpenedAt?: string
}

export async function listHostWorkspaces(signal?: AbortSignal, serverId?: string): Promise<HostWorkspace[]> {
  const data = await postHostCommand<{ workspaces: HostWorkspace[] }>('workspaces.list', undefined, signal, serverId)
  return data.workspaces
}

export async function openHostWorkspace(
  rootPath?: string,
  displayName?: string,
  signal?: AbortSignal,
  serverId?: string,
): Promise<HostWorkspace> {
  const params: { rootPath?: string; displayName?: string } = {}
  if (rootPath) params.rootPath = rootPath
  if (displayName) params.displayName = displayName
  const data = await postHostCommand<{ workspace: HostWorkspace }>('workspaces.open', params, signal, serverId)
  if (!serverId || serverId === serverStore.getActiveServerId()) trackPiWorkspace(data.workspace.path)
  return data.workspace
}

export async function watchHostWorkspace(
  workspacePath: string,
  signal?: AbortSignal,
  serverId?: string,
): Promise<void> {
  await postHostCommand<{ ok: boolean }>('workspaces.watch', { workspacePath }, signal, serverId)
}

const workspaceResolutionPromises = new Map<string, Promise<string | null>>()
const defaultWorkspacePromises = new Map<string, Promise<string | null>>()

function captureWorkspaceRevision(serverId?: string): () => void {
  const revision = () => (serverId ? getServerRevision(serverId) : serverStore.getActiveServerGeneration())
  const initial = revision()
  return () => {
    if (revision() !== initial) throw new DOMException('Workspace server changed', 'AbortError')
  }
}

async function ensureDefaultWorkspacePath(serverId?: string): Promise<string | null> {
  const checkRevision = captureWorkspaceRevision(serverId)
  const key = `${serverId ?? serverStore.getActiveServerId()}:${serverId ? getServerRevision(serverId) : serverStore.getActiveServerGeneration()}`
  let pending = defaultWorkspacePromises.get(key)
  if (!pending) {
    pending = (async () => {
      try {
        // 全局（未选目录）的默认工作区：服务器默认目录（桌面安装目录），
        // 与终端的全局语义保持一致。
        const fallback = await openHostWorkspace(undefined, undefined, undefined, serverId)
        checkRevision()
        await watchHostWorkspace(fallback.path, undefined, serverId)
        checkRevision()
        return fallback.path
      } catch {
        return null
      }
    })()
    defaultWorkspacePromises.set(key, pending)
  }
  try {
    return await pending
  } finally {
    if (defaultWorkspacePromises.get(key) === pending) defaultWorkspacePromises.delete(key)
  }
}

/**
 * Return the workspace path for a directory (opening it on demand), or the
 * server's first known workspace when no directory is selected.
 */
export async function resolveWorkspacePath(directory?: string, serverId?: string): Promise<string | null> {
  const checkRevision = captureWorkspaceRevision(serverId)
  if (directory && (/^[a-zA-Z]:[\\/]/.test(directory) || directory.startsWith('/'))) {
    const normalized = directory.replace(/\\/g, '/').replace(/\/+$/, '')
    const key = `${serverId ?? serverStore.getActiveServerId()}:${serverId ? getServerRevision(serverId) : serverStore.getActiveServerGeneration()}:${normalized}`
    let pending = workspaceResolutionPromises.get(key)
    if (!pending) {
      pending = openHostWorkspace(directory, undefined, undefined, serverId)
        .then(async workspace => {
          checkRevision()
          await watchHostWorkspace(workspace.path, undefined, serverId)
          checkRevision()
          return workspace.path
        })
        .catch(error => {
          workspaceResolutionPromises.delete(key)
          // Saved directory no longer exists on disk — treat as absent
          if (error && typeof error === 'object' && 'code' in error && error.code === 'WORKSPACE_NOT_FOUND') {
            return null
          }
          throw error
        })
      workspaceResolutionPromises.set(key, pending)
    }
    return pending
  }
  return ensureDefaultWorkspacePath(serverId)
}

export function resetWorkspaceResolutionCache(): void {
  workspaceResolutionPromises.clear()
  defaultWorkspacePromises.clear()
}
