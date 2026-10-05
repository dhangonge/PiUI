// ============================================
// Directory Path Utilities
// 统一的目录路径处理工具
// ============================================
//
// 设计原则：
// 1. 前端内部存储：统一使用正斜杠 (URL友好，跨平台)
// 2. 后端 API 请求：根据 pathMode 决定用正斜杠还是反斜杠
// 3. 路径比较：统一规范化后比较（正斜杠 + 小写 + 无末尾斜杠）
//

import { serverStorage } from './perServerStorage'
import { serverStore } from '../store/serverStore'

// ============================================
// Path Mode Configuration
// ============================================

/**
 * 路径模式
 * - auto: 自动检测（根据后端响应判断）
 * - unix: 强制使用正斜杠 /
 * - windows: 强制使用反斜杠 \
 */
export type PathMode = 'auto' | 'unix' | 'windows'

/**
 * 检测到的实际路径风格
 */
export type DetectedPathStyle = 'unix' | 'windows'

const STORAGE_KEY_PATH_MODE = 'piui-path-mode'
const STORAGE_KEY_DETECTED_STYLE = 'piui-detected-path-style'

const pathModes = new Map<string, PathMode>()
const detectedStyles = new Map<string, DetectedPathStyle>()

/**
 * 重置路径模式缓存（服务器切换时调用）
 * 下次 getPathMode / getDetectedPathStyle 会从 serverStorage 重新读取
 */
export function resetPathModeCache(): void {
  pathModes.clear()
  detectedStyles.clear()
}

// Path mode change listeners
type PathModeListener = (mode: PathMode, effectiveStyle: DetectedPathStyle) => void
const _listeners: Set<PathModeListener> = new Set()

/**
 * 订阅路径模式变化
 */
export function subscribePathMode(listener: PathModeListener): () => void {
  _listeners.add(listener)
  return () => _listeners.delete(listener)
}

/**
 * 通知所有监听器
 */
function notifyListeners(serverId = serverStore.getActiveServerId()): void {
  if (serverId !== serverStore.getActiveServerId()) return
  const mode = getPathMode()
  const style = getEffectivePathStyle()
  _listeners.forEach(listener => listener(mode, style))
}

/**
 * 获取当前路径模式设置
 */
export function getPathMode(serverId = serverStore.getActiveServerId()): PathMode {
  let mode = pathModes.get(serverId)
  if (!mode) {
    const saved = serverStorage.getFor(STORAGE_KEY_PATH_MODE, serverId)
    mode = saved === 'unix' || saved === 'windows' ? saved : 'auto'
    pathModes.set(serverId, mode)
  }
  return mode
}

/**
 * 设置路径模式
 */
export function setPathMode(mode: PathMode, serverId = serverStore.getActiveServerId()): void {
  pathModes.set(serverId, mode)
  serverStorage.setFor(STORAGE_KEY_PATH_MODE, mode, serverId)
  notifyListeners(serverId)
}

/**
 * 获取检测到的路径风格
 */
export function getDetectedPathStyle(serverId = serverStore.getActiveServerId()): DetectedPathStyle {
  let style = detectedStyles.get(serverId)
  if (!style) {
    const saved = serverStorage.getFor(STORAGE_KEY_DETECTED_STYLE, serverId)
    style = saved === 'windows' ? 'windows' : 'unix'
    detectedStyles.set(serverId, style)
  }
  return style
}

/**
 * 设置检测到的路径风格（由自动检测逻辑调用）
 */
export function setDetectedPathStyle(style: DetectedPathStyle, serverId = serverStore.getActiveServerId()): void {
  const previousStyle = detectedStyles.get(serverId)
  detectedStyles.set(serverId, style)
  serverStorage.setFor(STORAGE_KEY_DETECTED_STYLE, style, serverId)
  if (getPathMode(serverId) === 'auto' && previousStyle !== style) notifyListeners(serverId)
}

/**
 * 获取实际生效的路径风格
 * - 如果是 auto 模式，返回检测到的风格
 * - 否则返回用户设置的模式
 */
export function getEffectivePathStyle(serverId?: string): DetectedPathStyle {
  const mode = getPathMode(serverId)
  if (mode === 'auto') {
    return getDetectedPathStyle(serverId)
  }
  return mode
}

/**
 * 是否为 Windows 路径模式（实际生效的）
 */
export function isWindowsPathMode(serverId?: string): boolean {
  return getEffectivePathStyle(serverId) === 'windows'
}

/**
 * 根据当前模式格式化路径用于 API 请求
 * - unix 模式: 转正斜杠
 * - windows 模式: 转反斜杠
 */
export function formatPathForApi(dir: string | undefined | null, serverId?: string): string | undefined {
  if (!dir) return undefined

  let trimmed = dir.replace(/[/\\]+$/, '') // 移除末尾斜杠

  // 根路径保护：/ → ""，C:/ → "C:"，需要恢复斜杠
  if (!trimmed) {
    trimmed = '/'
  } else if (/^[a-zA-Z]:$/.test(trimmed)) {
    trimmed = trimmed + '/'
  }

  if (isWindowsPathMode(serverId)) {
    return trimmed.replace(/\//g, '\\')
  } else {
    return trimmed.replace(/\\/g, '/')
  }
}

/**
 * 从后端响应中检测路径风格
 * 分析路径字符串，判断后端使用的是哪种斜杠风格
 */
export function detectPathStyleFromResponse(path: string | undefined | null): DetectedPathStyle | null {
  if (!path) return null

  const backslashCount = (path.match(/\\/g) || []).length
  const forwardSlashCount = (path.match(/\//g) || []).length

  // 如果有反斜杠且多于正斜杠，判定为 Windows 风格
  if (backslashCount > 0 && backslashCount >= forwardSlashCount) {
    return 'windows'
  }
  // 如果有正斜杠，判定为 Unix 风格
  if (forwardSlashCount > 0) {
    return 'unix'
  }

  return null
}

/**
 * 自动检测并更新路径风格
 * 调用此函数时传入后端返回的路径，会自动更新检测结果
 */
export function autoDetectPathStyle(path: string | undefined | null, serverId?: string): void {
  const detected = detectPathStyleFromResponse(path)
  if (detected) {
    setDetectedPathStyle(detected, serverId)
  }
}

// ============================================
// Path Normalization (Internal Use)
// ============================================

/**
 * 规范化目录路径为正斜杠格式
 * 用于前端内部存储和 URL
 *
 * @example
 * normalizeToForwardSlash('E:\\dev\\project') // 'E:/dev/project'
 * normalizeToForwardSlash('E:/dev/project/') // 'E:/dev/project'
 */
export function normalizeToForwardSlash(dir: string | undefined | null): string {
  if (!dir) return ''
  const forward = dir.replace(/\\/g, '/')
  if (/^\/+$/u.test(forward)) return '/'
  if (/^[a-zA-Z]:\/+$/u.test(forward)) return forward.slice(0, 3)
  return forward.replace(/\/+$/, '')
}

/**
 * 规范化目录路径用于比较
 * - 统一使用正斜杠
 * - 移除末尾斜杠
 * - Windows 盘符和 UNC 路径转小写，POSIX 路径保留大小写
 *
 * @example
 * normalizeForComparison('E:\\Dev\\Project') // 'e:/dev/project'
 */
export function normalizeForComparison(dir: string | undefined | null): string {
  if (!dir) return ''
  const slashed = dir.replace(/\\/g, '/') // 反斜杠 → 正斜杠
  const normalized = slashed === '/' ? '/' : slashed.replace(/\/+$/, '') // 保留 POSIX 根目录
  return /^[a-zA-Z]:(?:\/|$)/.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

/**
 * 比较两个目录路径是否相同
 * 处理斜杠、大小写差异
 *
 * @example
 * isSameDirectory('E:\\dev\\project', 'E:/dev/project') // true
 * isSameDirectory('E:/Dev/Project', 'e:/dev/project') // true
 */
export function isSameDirectory(dir1: string | undefined | null, dir2: string | undefined | null): boolean {
  return normalizeForComparison(dir1) === normalizeForComparison(dir2)
}

/**
 * 从路径中提取目录名（最后一个部分）
 *
 * @example
 * getDirectoryName('E:/dev/my-project') // 'my-project'
 * getDirectoryName('E:\\dev\\my-project\\') // 'my-project'
 */
export function getDirectoryName(dir: string | undefined | null): string {
  if (!dir) return ''
  const normalized = normalizeToForwardSlash(dir)
  const parts = normalized.split('/').filter(Boolean)
  const name = parts[parts.length - 1] || normalized
  // 解码 URL 编码的中文等字符
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * 检查路径是否是 Windows 绝对路径
 *
 * @example
 * isWindowsAbsolutePath('E:/dev') // true
 * isWindowsAbsolutePath('/home/user') // false
 */
export function isWindowsAbsolutePath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path)
}

/**
 * 检查路径是否是绝对路径（Windows 或 Unix）
 */
export function isAbsolutePath(path: string): boolean {
  return isWindowsAbsolutePath(path) || path.startsWith('/')
}

// ============================================
// Re-export from stringUtils for compatibility
// ============================================

// 保持向后兼容，逐步废弃 stringUtils 中的目录函数
export { normalizeForComparison as normalizeDirectoryPath }
