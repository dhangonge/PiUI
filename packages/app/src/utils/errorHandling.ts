import { recordClientError, type ClientErrorSource } from '../store/clientErrorLog'
import { logger } from './logger'

// ============================================
// 统一错误处理工具
// ============================================

export type ErrorCategory =
  | 'api' // API 调用错误
  | 'session' // Session 相关错误
  | 'permission' // 权限相关错误
  | 'ui' // UI 交互错误
  | 'parse' // 解析错误
  | 'sse' // SSE 事件流错误
  | 'file' // 文件操作错误
  | 'syntax' // 语法高亮错误
  | 'global' // 全局错误
  | 'revert' // 撤销/重做错误
  | 'clipboard' // 剪贴板错误
  | 'unknown' // 未分类错误

export interface ErrorContext {
  category: ErrorCategory
  operation: string
  silent?: boolean // 静默错误，不显示给用户
  details?: unknown // 额外的错误详情
  /** 错误来源，用于客户端错误日志分类（默认 manual） */
  source?: ClientErrorSource
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  if (error === undefined || error === null) return 'unknown error'
  try {
    return JSON.stringify(error) || String(error)
  } catch {
    return String(error)
  }
}

/**
 * 统一的错误日志函数。
 *
 * 生产构建里也必须留痕：打包后的 app 没有 devtools，`import.meta.env.DEV` 分支
 * 会把所有错误吃掉。这里同时写控制台和客户端错误日志（设置 → 关于 → 诊断可见，
 * 并尽力上报本地 server 的日志文件）。
 *
 * 有意不在这里弹 toast：34 个调用点里大量是「重试成功就无感」的场景，逐个弹
 * 会把界面变成报错墙；需要用户看见的渲染崩溃由 ErrorBoundary 负责。
 */
export function logError(error: unknown, context: ErrorContext): void {
  const { category, operation } = context

  logger.error(`[${category}] ${operation}:`, error)
  recordClientError({
    source: context.source ?? 'manual',
    category,
    operation,
    message: errorMessage(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  })
}

/**
 * 包装异步函数，自动处理错误
 */
export function withErrorHandling<T>(fn: () => Promise<T>, context: ErrorContext): Promise<T | undefined> {
  return fn().catch(error => {
    logError(error, context)
    return undefined
  })
}

/**
 * 创建带上下文的错误处理器
 * 用于同一模块内多次使用
 */
export function createErrorHandler(category: ErrorCategory) {
  return (operation: string, error: unknown, silent = false, details?: unknown) => {
    logError(error, { category, operation, silent, details })
  }
}

// ============================================
// 预定义的错误处理器 - 按模块分类
// ============================================

export const apiErrorHandler = createErrorHandler('api')
export const sessionErrorHandler = createErrorHandler('session')
export const permissionErrorHandler = createErrorHandler('permission')
export const uiErrorHandler = createErrorHandler('ui')
export const parseErrorHandler = createErrorHandler('parse')
export const sseErrorHandler = createErrorHandler('sse')
export const fileErrorHandler = createErrorHandler('file')
export const syntaxErrorHandler = createErrorHandler('syntax')
export const revertErrorHandler = createErrorHandler('revert')
export const clipboardErrorHandler = createErrorHandler('clipboard')

/**
 * 简单的 catch 处理器，用于 .catch(handleError('operation'))
 */
export function handleError(operation: string, category: ErrorCategory = 'unknown') {
  return (error: unknown) => {
    logError(error, { category, operation })
  }
}
