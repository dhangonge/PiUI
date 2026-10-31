// ============================================
// 文件下载工具函数
// 支持文本文件和二进制文件（base64）的下载
// 浏览器环境使用 <a download>，Tauri 环境使用原生保存对话框
// ============================================

import type { FileReadResponse } from '@piui/protocol'
import { isBinaryContent } from './mimeUtils'
import { getHttpFetch, isTauri } from './tauri'
import { getApiBase, getPiAuthToken } from '../pi/httpClient'

/**
 * 将 base64 字符串转为 Uint8Array
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * 触发浏览器下载（仅浏览器环境）
 */
function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  // 延迟清理，确保下载已启动
  setTimeout(() => {
    URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }, 100)
}

/**
 * Tauri 原生保存文件
 * 弹出系统保存对话框，用户选择路径后写入文件
 */
async function tauriSaveFile(data: Uint8Array, fileName: string): Promise<void> {
  const [{ save }, { writeFile }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ])

  // 从文件名提取扩展名，用于对话框过滤
  const ext = fileName.split('.').pop()?.toLowerCase()
  const filters = ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : []

  const filePath = await save({
    defaultPath: fileName,
    filters,
  })

  if (!filePath) return // 用户取消

  await writeFile(filePath, data)
}

/**
 * 从 FileReadResponse 下载文件
 * - 二进制文件：从 base64 解码后下载
 * - 文本文件：直接以 UTF-8 编码下载
 * - Tauri 环境：弹出原生保存对话框
 * - 浏览器环境：使用 <a download> 触发下载
 */
export function downloadFileContent(content: FileReadResponse, fileName: string): void {
  // 统一转为 Uint8Array
  const data = isBinaryContent(content.encoding)
    ? base64ToBytes(content.content)
    : new TextEncoder().encode(content.content)

  const mimeType = isBinaryContent(content.encoding)
    ? content.mimeType || 'application/octet-stream'
    : `${content.mimeType || 'text/plain'};charset=utf-8`

  saveData(data, fileName, mimeType)
}

/**
 * 通用保存：接受原始数据 + 文件名 + MIME 类型
 * - Tauri 环境：弹出原生保存对话框 + fs 写入
 * - 浏览器环境：Blob + <a download>
 */
export function saveData(data: Uint8Array, fileName: string, mimeType = 'application/octet-stream'): void {
  if (isTauri()) {
    tauriSaveFile(data, fileName).catch(err => {
      console.warn('[downloadUtils] Tauri save failed:', err)
    })
  } else {
    const blob = new Blob([data.buffer as ArrayBuffer], { type: mimeType })
    triggerBrowserDownload(blob, fileName)
  }
}

// ============================================
// 服务端流式下载（绕过 files.read 的 2MB/8MB 限制）
// ============================================

export interface WorkspaceFileDownloadOptions {
  /** 工作区根目录（绝对路径） */
  workspacePath: string
  /** 相对工作区的文件路径 */
  path: string
  /** 保存时的默认文件名 */
  fileName: string
  /** 指定服务器（默认当前活动服务器） */
  serverId?: string
}

/**
 * 构造 /api/v1/host/files/download 的下载 URL。
 * 浏览器端只能靠 query token 认证（<a download> 无法带 header），
 * Tauri 端走 authorization header，不把 token 暴露在 URL 里。
 */
export function buildWorkspaceDownloadUrl(options: WorkspaceFileDownloadOptions, includeToken = true): string {
  const params = [
    `workspacePath=${encodeURIComponent(options.workspacePath)}`,
    `path=${encodeURIComponent(options.path)}`,
  ]
  if (includeToken) {
    const token = getPiAuthToken(options.serverId)
    if (token) params.push(`token=${encodeURIComponent(token)}`)
  }
  return `${getApiBase(options.serverId)}/api/v1/host/files/download?${params.join('&')}`
}

/** 浏览器环境：交给下载管理器，不占 JS 内存 */
function triggerBrowserHrefDownload(url: string, fileName: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    document.body.removeChild(a)
  }, 100)
}

async function requestDownload(url: string, token?: string): Promise<Response> {
  const fetchImpl = await getHttpFetch()
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  })
  if (!response.ok) {
    // 服务端错误是 JSON problem，取出 code/message 交给 UI
    const body = await response.text().catch(() => '')
    let detail = body
    try {
      const problem = JSON.parse(body) as { code?: string; message?: string }
      detail = [problem.code, problem.message].filter(Boolean).join(': ') || body
    } catch {
      // 非 JSON 错误体，保留原始文本
    }
    throw new Error(`Download failed (${response.status})${detail ? ` ${detail}` : ''}`)
  }
  return response
}

/**
 * 把响应体分块写入本地文件。
 * SAF / content:// 路径上 open+write 可能不可用（权限或插件限制），
 * 此时回退为整体 writeFile —— 需要重新请求一次，避免把已读了一半的流拼成坏文件。
 */
async function writeResponseToPath(
  path: string,
  url: string,
  token: string | undefined,
  response: Response,
): Promise<void> {
  const fs = await import('@tauri-apps/plugin-fs')
  const reader = response.body?.getReader?.()
  if (reader) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(path, { write: true, create: true, truncate: true })
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.byteLength > 0) await handle.write(value)
      }
      await handle.close()
      return
    } catch (error) {
      console.warn('[downloadUtils] streaming write failed, falling back to whole-file write:', error)
      await handle?.close().catch(() => undefined)
      await reader.cancel().catch(() => undefined)
    }
  }
  if (!reader) {
    // 拿不到流式 body：直接整体读取（小文件场景）
    await fs.writeFile(path, new Uint8Array(await response.arrayBuffer()))
    return
  }
  // 兜底：流已被消费一半，重新请求一份完整响应后整体写盘（大文件占内存，仅作降级路径）
  const retry = await requestDownload(url, token)
  await fs.writeFile(path, new Uint8Array(await retry.arrayBuffer()))
}

/**
 * 从服务端流式下载工作区文件。
 * - Tauri（含 Android）：save() 选路径 → fetch → 分块写盘
 * - 浏览器：<a href download> 交给浏览器下载管理器
 */
export async function downloadWorkspaceFile(options: WorkspaceFileDownloadOptions): Promise<void> {
  const { fileName, serverId } = options

  if (!isTauri()) {
    triggerBrowserHrefDownload(buildWorkspaceDownloadUrl(options, true), fileName)
    return
  }

  const { save } = await import('@tauri-apps/plugin-dialog')
  const ext = fileName.split('.').pop()?.toLowerCase()
  const target = await save({
    defaultPath: fileName,
    filters: ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : [],
  })
  if (!target) return // 用户取消

  const url = buildWorkspaceDownloadUrl(options, false)
  const token = getPiAuthToken(serverId)
  const response = await requestDownload(url, token)
  await writeResponseToPath(target, url, token, response)
}
