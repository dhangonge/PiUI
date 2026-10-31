/** 获取路径的父目录部分（用于显示项目位置） */
export function getParentPath(fullPath: string): string {
  // 处理 Windows 和 Unix 路径
  const sep = fullPath.includes('\\') ? '\\' : '/'
  const parts = fullPath.split(sep)
  // 移除最后一个部分（文件夹名本身）
  parts.pop()
  if (parts.length === 0) return sep
  // Windows: 保留盘符，Unix: 保留开头的 /
  const parent = parts.join(sep)
  return parent || sep
}

/** 格式化通知时间戳为相对时间 */
export function formatNotificationTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3600_000)}h ago`
}

/** Shift 连选：按锚点与目标的可见顺序取闭区间，任一端不在当前可见列表里就不选 */
export function getSelectionRange(visibleIds: string[], anchorId: string, targetId: string) {
  const startIndex = visibleIds.indexOf(anchorId)
  const endIndex = visibleIds.indexOf(targetId)

  if (startIndex === -1 || endIndex === -1) return null

  const from = Math.min(startIndex, endIndex)
  const to = Math.max(startIndex, endIndex)
  return visibleIds.slice(from, to + 1)
}
