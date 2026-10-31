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
    // Worker 实例整个丢弃，worker 侧的流状态随它一起消失；留下的 key 标记都是死引用
    // （ref 拿到的 dispose 会因 worker 为 null 而空转），在这里一并清掉。
    latestRequestByKey.clear()
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

type HighlightResponse = Extract<WorkerResponse, { type: 'highlight' }>

/**
 * 一次性请求（完整 token / html）在 worker 侧不留流状态，客户端 key 标记也应随请求结算释放；
 * 流式请求的 key 对应 worker 里的 tokenizer，必须由调用方 dispose 释放。
 */
function isOneShot(params: { mode: 'tokens' | 'html'; complete?: boolean }): boolean {
  return params.complete === true || params.mode === 'html'
}

/** 只有仍是该 key 的 latest 请求才有权释放标记，旧请求不得抹掉新请求的标记。 */
function releaseLatestKey(key: string, id: number): boolean {
  if (latestRequestByKey.get(key) !== id) return false
  latestRequestByKey.delete(key)
  return true
}

async function workerHighlight(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
  mode: 'tokens' | 'html'
  complete?: boolean
}): Promise<HighlightResponse> {
  await ensureShikiWorkerReady()

  const id = nextId++
  const w = getWorker()
  const oneShot = isOneShot(params)
  latestRequestByKey.set(params.key, id)

  return new Promise<HighlightResponse>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: resolve as (response: WorkerResponse) => void,
      // 失败没有消费方可以做判定，只能在这里按 requestId 守卫释放。
      reject: error => {
        if (oneShot) releaseLatestKey(params.key, id)
        reject(error)
      },
    })
    try {
      w.postMessage({ type: 'highlight', id, ...params } satisfies WorkerRequest)
    } catch (error) {
      // postMessage 同步抛错（如结构化克隆失败）时 Promise 会直接 reject，绕过上面的守卫；
      // 请求从未进入 worker，所以 worker 侧没有该 key 的 tokenizer，pending 条目与 key 标记都该在这里清。
      pendingRequests.delete(id)
      releaseLatestKey(params.key, id)
      reject(error)
    }
  })
}

export async function highlightTokensInWorker(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
  complete?: boolean
}): Promise<{ id: number; code: string; tokens: HighlightTokens }> {
  const oneShot = params.complete === true
  const result = await workerHighlight({ ...params, mode: 'tokens' })
  try {
    // latest 判定留在消费时点（await 之后），与重构前一致：响应到达后、
    // 消费前的 dispose 或新请求都算 superseded。
    if (result.id !== latestRequestByKey.get(params.key)) throw new Error('superseded')
    return {
      id: result.id,
      code: result.code,
      tokens: splitTokensIntoLines([...result.stable, ...result.unstable]),
    }
  } finally {
    // 一次性请求的标记在判定通过后才释放；superseded 时 Map 已指向别的请求，释放会自守卫为空操作。
    if (oneShot) releaseLatestKey(params.key, result.id)
  }
}

export async function highlightHtmlInWorker(params: {
  key: string
  text: string
  language: string
  theme: BundledTheme
}): Promise<{ id: number; html: string }> {
  const result = await workerHighlight({ ...params, mode: 'html', complete: true })
  try {
    if (result.id !== latestRequestByKey.get(params.key)) throw new Error('superseded')
    return { id: result.id, html: result.html ?? '' }
  } finally {
    releaseLatestKey(params.key, result.id)
  }
}

export function disposeShikiWorkerKey(key: string) {
  if (!worker) return

  worker.postMessage({ type: 'dispose', key } satisfies WorkerRequest)
  latestRequestByKey.delete(key)
}
