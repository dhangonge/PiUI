import type { GitWorkspaceMeta } from '../../../hooks'
import { isSameDirectory, normalizeToForwardSlash } from '../../../utils'

export function isWorkspaceRootDirectory(directory: string, meta: GitWorkspaceMeta | undefined) {
  if (!meta?.isGit) return false
  return meta.workspaces.some(workspace => isSameDirectory(workspace, directory))
}

export function getProjectGroupIdentity(directory: string, meta: GitWorkspaceMeta | undefined) {
  const normalizedDirectory = normalizeToForwardSlash(directory)

  if (isWorkspaceRootDirectory(normalizedDirectory, meta) && meta) {
    return {
      projectId: meta.rootDirectory,
      workspaceDirectories: meta.workspaces,
    }
  }

  return {
    projectId: normalizedDirectory,
    workspaceDirectories: undefined,
  }
}

/** 侧栏里作为一个可折叠项目呈现的分组（项目 / workspace / 目录成员） */
export interface ProjectItem {
  id: string
  path: string
  name: string
  canReorder?: boolean
  memberDirectories?: string[]
  reorderPath?: string
  workspaceDirectories?: string[]
  sectionKind?: 'project' | 'workspace'
}

/** 按目录找命中的项目分组：项目 id / 路径 / workspace / 成员目录任一相等即命中 */
export function findProjectGroupForDirectory(projects: ProjectItem[], directory: string) {
  return projects.find(project => {
    if (isSameDirectory(project.id, directory) || isSameDirectory(project.path, directory)) {
      return true
    }

    if (project.workspaceDirectories?.some(workspace => isSameDirectory(workspace, directory))) {
      return true
    }

    if (project.memberDirectories?.some(memberDirectory => isSameDirectory(memberDirectory, directory))) {
      return true
    }

    return false
  })
}
