import type { BundledTheme } from 'shiki/themes'
import type { WorkerRequest, WorkerResponse, WorkerToken } from '../workers/shikiWorker'
import type { HighlightTokens } from './highlightTypes'
import {
  DEFAULT_CODE_BLOCK_THEME_DARK,
  DEFAULT_CODE_BLOCK_THEME_LIGHT,
  normalizeCodeBlockTheme,
} from './codeBlockThemes'

type PendingRequest = {
  resolve: (response: WorkerResponse) => void
  reject: (error: unknown) => void
}

let worker: Worker | null = null
let workerReady: Promise<void> | null = null
let workerReadyPromiseResolve: (() => void) | null = null
let workerReadyPromiseReject: ((error: unknown) => void) | null = null
let nextId = 1

const pendingRequests = new Map<number, PendingRequest>()
const latestRequestByKey = new Map<string, number>()

function getWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('../workers/shikiWorker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data
    if (msg.type === 'ready') {
      workerReadyPromiseResolve?.()
      workerReadyPromiseResolve = null
      workerReadyPromiseReject = null
      return
    }

    if (msg.type === 'init-error') {
      workerReadyPromiseReject?.(new Error(msg.message))
      workerReady = null
      workerReadyPromiseResolve = null
      workerReadyPromiseReject = null
      worker?.terminate()
      worker = null
      return
    }

    if (!('id' in msg)) return
    const pending = pendingRequests.get(msg.id)
    if (!pending) return

    pendingRequests.delete(msg.id)
    if (msg.type === 'error') {
      pending.reject(new Error(msg.message))
    } else if (msg.type === 'superseded') {
      pending.reject(new Error('superseded'))
    } else {
      pending.resolve(msg)
    }
  }

  worker.onerror = error => {
    workerReadyPromiseReject?.(error)
    pendingRequests.forEach(pending => pending.reject(error))
    pendingRequests.clear()
    workerReady = null
    workerReadyPromiseResolve = null
    workerReadyPromiseReject = null
    worker = null
  }

  return worker
}

export function ensureShikiWorkerReady(): Promise<void> {
  if (workerReady) return workerReady

  workerReady = new Promise((resolve, reject) => {
    workerReadyPromiseResolve = resolve
    workerReadyPromiseReject = reject
  })
  // 预加载用户当前选择的主题；其他主题在第一次 highlight 时 lazy load。
  // 用 localStorage 直接读避免循环依赖（themeStore 也会反向引用此模块树）。
  const light = normalizeCodeBlockTheme(
    (typeof localStorage !== 'undefined' && localStorage.getItem('piui-code-block-theme-light')) ||
      DEFAULT_CODE_BLOCK_THEME_LIGHT,
    DEFAULT_CODE_BLOCK_THEME_LIGHT,
  )
  const dark = normalizeCodeBlockTheme(
    (typeof localStorage !== 'undefined' && localStorage.getItem('piui-code-block-theme-dark')) ||
      DEFAULT_CODE_BLOCK_THEME_DARK,
    DEFAULT_CODE_BLOCK_THEME_DARK,
  )
  const themes = Array.from(new Set<BundledTheme>([light, dark]))
  getWorker().postMessage({ type: 'init', themes } satisfies WorkerRequest)
  return workerReady
}

function splitTokensIntoLines(tokens: WorkerToken[]): HighlightTokens {
  if (tokens.length === 0) return [[]]

  const lines: HighlightTokens = []
  let currentLine: HighlightTokens[number] = []

  for (const [content, color] of tokens) {
    const token = { content, color }
    const newlineIndex = content.indexOf('\n')
    if (newlineIndex === -1) {
      currentLine.push(token)
      continue
    }

    const segments = content.split('\n')
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      if (segment) currentLine.push(index === 0 && segment === content ? token : { ...token, content: segment })
      if (index < segments.length - 1) {
        lines.push(currentLine)
        currentLine = []
      }
    }
  }

  if (currentLine.length > 0 || lines.length === 0) lines.push(currentLine)
  return lines
}

type HighlightResult = {
  response: Extract<WorkerResponse, { type: 'highlight' }>
  /** 请求结算的这一刻，它是否仍是该 key 的 latest 请求 */
  isLatest: boolean
}

async function workerHighlight(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
  mode: 'tokens' | 'html'
  complete?: boolean
}): Promise<HighlightResult> {
  await ensureShikiWorkerReady()

  const id = nextId++
  const w = getWorker()
  // 一次性请求（完整 token / html）在 worker 侧不留流状态，客户端标记也用完即弃；
  // 流式请求的 key 对应 worker 里的 tokenizer，必须由调用方 dispose 释放。
  const oneShot = params.complete === true || params.mode === 'html'
  latestRequestByKey.set(params.key, id)

  return new Promise<HighlightResult>((resolve, reject) => {
    // 终态清理：只有仍是该 key 的 latest 请求才有权释放标记。
    // 旧请求的完成 / 失败不能抹掉新请求的标记，否则新响应会被误判为 superseded。
    const releaseIfLatest = (): boolean => {
      const isLatest = latestRequestByKey.get(params.key) === id
      if (isLatest && oneShot) latestRequestByKey.delete(params.key)
      return isLatest
    }

    pendingRequests.set(id, {
      resolve: response => {
        resolve({
          response: response as Extract<WorkerResponse, { type: 'highlight' }>,
          isLatest: releaseIfLatest(),
        })
      },
      reject: error => {
        releaseIfLatest()
        reject(error)
      },
    })
    w.postMessage({ type: 'highlight', id, ...params } satisfies WorkerRequest)
  })
}

export async function highlightTokensInWorker(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
  complete?: boolean
}): Promise<{ id: number; code: string; tokens: HighlightTokens }> {
  const { response, isLatest } = await workerHighlight({ ...params, mode: 'tokens' })
  if (!isLatest) throw new Error('superseded')
  return {
    id: response.id,
    code: response.code,
    tokens: splitTokensIntoLines([...response.stable, ...response.unstable]),
  }
}

export async function highlightHtmlInWorker(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
}): Promise<{ id: number; html: string }> {
  const { response, isLatest } = await workerHighlight({ ...params, mode: 'html', complete: true })
  if (!isLatest) throw new Error('superseded')
  return { id: response.id, html: response.html ?? '' }
}

export function disposeShikiWorkerKey(key: string) {
  if (!worker) return

  worker.postMessage({ type: 'dispose', key } satisfies WorkerRequest)
  latestRequestByKey.delete(key)
}
