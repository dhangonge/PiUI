// ============================================
// DirectoryContext - 管理当前工作目录
// ============================================

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { serverStore } from '../store/serverStore'
import { getStorageVersion, subscribePerServerStorageVersion } from '../utils/perServerStorage'
import i18n from '../i18n'
import { useRouter } from '../hooks/useRouter'
import { normalizeToForwardSlash, getDirectoryName, isSameDirectory, serverStorage } from '../utils'
import { layoutStore, useLayoutStore } from '../store/layoutStore'
import { isTauri, isTauriMobile } from '../utils/tauri'
import { DirectoryContext, type DirectoryContextValue, type SavedDirectory } from './DirectoryContext.shared'
import { hasUnsavedFileChanges } from '../store/unsavedFileStore'

const STORAGE_KEY_SAVED = 'piui-saved-directories'
const STORAGE_KEY_RECENT = 'piui-recent-projects'

// 最近使用记录: { [path]: lastUsedAt }
type RecentProjects = Record<string, number>

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readSavedDirectories(serverId: string): SavedDirectory[] {
  const saved = serverStorage.getJSONFor<unknown>(STORAGE_KEY_SAVED, serverId)
  if (!Array.isArray(saved)) return []

  return saved.flatMap(item => {
    if (!isRecord(item) || typeof item.path !== 'string') return []
    const path = item.path
    return [
      {
        path,
        name: typeof item.name === 'string' && item.name.trim() ? item.name : getDirectoryName(path) || path,
        addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
      },
    ]
  })
}

function readRecentProjects(serverId: string): RecentProjects {
  const recent = serverStorage.getJSONFor<unknown>(STORAGE_KEY_RECENT, serverId)
  if (!isRecord(recent)) return {}

  return Object.fromEntries(
    Object.entries(recent).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
  )
}

export function DirectoryProvider({ children }: { children: ReactNode }) {
  // 从 URL 获取 directory（替代 localStorage）
  const { directory: urlDirectory, setDirectory: setUrlDirectory } = useRouter()

  // 从 layoutStore 获取 sidebarExpanded
  const { sidebarExpanded } = useLayoutStore()

  const serverId = useSyncExternalStore(listener => serverStore.subscribe(listener), () => serverStore.getActiveServerId())
  const storageVersion = useSyncExternalStore(subscribePerServerStorageVersion, getStorageVersion)
  const savedDirectories = useMemo(() => { void storageVersion; return readSavedDirectories(serverId) }, [serverId, storageVersion])
  const recentProjects = useMemo(() => { void storageVersion; return readRecentProjects(serverId) }, [serverId, storageVersion])
  const setSavedDirectories = useCallback((update: (previous: SavedDirectory[]) => SavedDirectory[]) => {
    serverStorage.setJSONFor(STORAGE_KEY_SAVED, update(readSavedDirectories(serverId)), serverId)
  }, [serverId])
  const setRecentProjects = useCallback((update: (previous: RecentProjects) => RecentProjects) => {
    serverStorage.setJSONFor(STORAGE_KEY_RECENT, update(readRecentProjects(serverId)), serverId)
  }, [serverId])

  // 设置当前目录（更新 URL + 记录最近使用）
  const setCurrentDirectory = useCallback(
    (directory: string | undefined) => {
      if (serverStore.getActiveServerId() !== serverId) return
      if (directory !== urlDirectory && hasUnsavedFileChanges() && !window.confirm(i18n.t('components:fileExplorer.discardUnsaved'))) return
      setUrlDirectory(directory)
      if (directory) {
        setRecentProjects(prev => ({ ...prev, [directory]: Date.now() }))
      }
    },
    [setUrlDirectory, urlDirectory, setRecentProjects, serverId],
  )

  // 添加目录
  const addDirectory = useCallback(
    (path: string) => {
      let normalized = normalizeToForwardSlash(path)

      // normalizeToForwardSlash 会去掉尾斜杠，导致根路径 "/" → "" 和 "C:/" → "C:"
      // 需要修正：如果原始路径是根路径，恢复正确的值
      const trimmed = path.replace(/\\/g, '/').replace(/\/+$/, '/')
      if (!normalized && (trimmed === '/' || /^[a-zA-Z]:\/$/.test(trimmed))) {
        normalized = trimmed.slice(0, -1) || '/'
      }

      // 验证路径非空（只阻止空字符串和 "."）
      if (!normalized || normalized === '.') return

      // 使用 isSameDirectory 检查是否已存在（处理大小写和斜杠差异）
      if (savedDirectories.some(d => isSameDirectory(d.path, normalized))) {
        setCurrentDirectory(normalized)
        return
      }

      const newDir: SavedDirectory = {
        path: normalized,
        name: getDirectoryName(normalized) || normalized,
        addedAt: Date.now(),
      }

      setSavedDirectories(prev => [...prev, newDir])
      setCurrentDirectory(normalized)
    },
    [savedDirectories, setCurrentDirectory, setSavedDirectories],
  )

  // 移除目录
  const removeDirectory = useCallback(
    (path: string) => {
      const normalized = normalizeToForwardSlash(path)
      setSavedDirectories(prev => prev.filter(d => !isSameDirectory(d.path, normalized)))
      if (isSameDirectory(urlDirectory, normalized)) {
        setCurrentDirectory(undefined)
      }
    },
    [urlDirectory, setCurrentDirectory, setSavedDirectories],
  )

  const reorderDirectories = useCallback((draggedPath: string, targetPath: string) => {
    const normalizedDragged = normalizeToForwardSlash(draggedPath)
    const normalizedTarget = normalizeToForwardSlash(targetPath)

    if (!normalizedDragged || !normalizedTarget || isSameDirectory(normalizedDragged, normalizedTarget)) {
      return
    }

    setSavedDirectories(prev => {
      const next = [...prev]
      const draggedIndex = next.findIndex(directory => isSameDirectory(directory.path, normalizedDragged))
      const targetIndex = next.findIndex(directory => isSameDirectory(directory.path, normalizedTarget))

      if (draggedIndex === -1 || targetIndex === -1 || draggedIndex === targetIndex) {
        return prev
      }

      const [draggedDirectory] = next.splice(draggedIndex, 1)
      next.splice(targetIndex, 0, draggedDirectory)
      return next
    })
  }, [setSavedDirectories])

  // Tauri: 启动时获取 CLI 传入的目录 + 监听后续 open-directory 事件
  // 用 ref 持有最新的 addDirectory 避免 stale closure
  const addDirectoryRef = useRef(addDirectory)
  useEffect(() => {
    addDirectoryRef.current = addDirectory
  }, [addDirectory])

  useEffect(() => {
    // 桌面专属：CLI 启动参数目录 + single-instance / macOS open 事件；
    // 安卓端既无命令行参数也无二次实例，直接跳过。
    if (!isTauri() || isTauriMobile()) return

    let unlisten: (() => void) | undefined

    // 拉取启动时的 CLI 目录（一次性）
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<string | null>('get_cli_directory')
        .then(dir => {
          if (dir) addDirectoryRef.current(dir)
        })
        .catch(() => {})
    })

    // 监听后续的 open-directory 事件（single-instance / macOS RunEvent::Opened）
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('open-directory', event => {
        addDirectoryRef.current(event.payload)
      }).then(fn => {
        unlisten = fn
      })
    })

    return () => {
      unlisten?.()
    }
  }, [])

  // 设置侧边栏展开 - 委托给 layoutStore
  const setSidebarExpanded = useCallback((expanded: boolean) => {
    layoutStore.setSidebarExpanded(expanded)
  }, [])

  // 稳定化 Provider value，避免每次渲染创建新对象导致子组件不必要重渲染
  const value = useMemo<DirectoryContextValue>(
    () => ({
      currentDirectory: urlDirectory,
      setCurrentDirectory,
      savedDirectories,
      addDirectory,
      removeDirectory,
      reorderDirectories,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects,
    }),
    [
      urlDirectory,
      setCurrentDirectory,
      savedDirectories,
      addDirectory,
      removeDirectory,
      reorderDirectories,
      sidebarExpanded,
      setSidebarExpanded,
      recentProjects,
    ],
  )

  return <DirectoryContext.Provider value={value}>{children}</DirectoryContext.Provider>
}
