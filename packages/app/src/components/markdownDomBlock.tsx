import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import morphdom from 'morphdom'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from './CodeBlock'
import { EyeIcon } from './Icons'
import { renderMarkdownToHtml } from './markdownHtmlRenderer'
import { inferImageDimensions } from './imageDimensions'
import { HtmlPreviewSurface } from './markdownHtmlArtifact'
import { LOCAL_FILE_LINK_PREFIX, decodeLocalFileHref, openLocalFilePath } from './markdownInline'

const htmlCache = new Map<string, string>()
const HTML_CACHE_MAX = 64
export const MARKDOWN_BLOCK_CONTENT_CLASS = 'space-y-4 whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0'
const MARKDOWN_USER_STATE_ATTRIBUTE = 'data-markdown-user-state'

function getCachedHtml(src: string, isReasoning: boolean, renderHtml: boolean): string {
  const key = `${isReasoning ? 'r' : 'd'}:${renderHtml ? 'h' : 'x'}:${src}`
  const cached = htmlCache.get(key)
  if (cached !== undefined) return cached
  const html = renderMarkdownToHtml(src, isReasoning, renderHtml)
  if (htmlCache.size >= HTML_CACHE_MAX) {
    const firstKey = htmlCache.keys().next().value
    if (firstKey !== undefined) htmlCache.delete(firstKey)
  }
  htmlCache.set(key, html)
  return html
}

/**
 * live 尾段是否可以只追加到最后一个文本节点。
 * 保守：后缀一旦含 markdown 结构/强调/代码/链接等字符，回退全量 parse+morph。
 */
function canAppendLiveMarkdownSuffix(suffix: string): boolean {
  if (!suffix) return false
  // 排除会改 markdown 结构、math/code，或可能形成 autolink 的字符
  // （含 :/@/ 时回退全量 parse，避免流式中链接一直是纯文本）
  return /^[^\n`*_[\]()#>|!~\\<$:/@]+$/.test(suffix)
}

/** 最后一个 Text 是否安全承接追加（不能在 strong/em/a/code 等行内节点里） */
function canAppendIntoTextNode(textNode: Text): boolean {
  const parent = textNode.parentElement
  if (!parent) return false
  // 父节点后面还有兄弟时，追加会插在中间，结构不对
  if (parent.lastChild !== textNode) return false
  // 只允许块级/列表等容器的直接文本；行内格式内追加会把后续字错误包进强调/链接
  return /^(P|LI|TD|TH|H[1-6]|BLOCKQUOTE|DIV)$/.test(parent.tagName)
}

/** 把纯文本后缀接到 root 内最后一个 Text 节点；失败返回 false */
function tryAppendLiveText(root: HTMLElement, suffix: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  let node = walker.nextNode()
  while (node) {
    last = node as Text
    node = walker.nextNode()
  }
  if (!last || !canAppendIntoTextNode(last)) return false
  last.textContent = `${last.textContent ?? ''}${suffix}`
  return true
}

function applyMarkdownHtml(root: HTMLElement, html: string) {
  if (!root.hasChildNodes()) {
    root.innerHTML = html
    decorateMarkdownDom(root)
    return
  }
  const next = document.createElement('div')
  next.innerHTML = html
  decorateMarkdownDom(next)
  const dirtySelectValues = Array.from(
    root.querySelectorAll<HTMLSelectElement>(`select[${MARKDOWN_USER_STATE_ATTRIBUTE}]`),
    select => new Set(Array.from(select.selectedOptions, option => option.value)),
  )
  morphdom(root, next, {
    childrenOnly: true,
    onBeforeElUpdated: (fromEl, toEl) => {
      if (fromEl instanceof HTMLElement && toEl instanceof HTMLElement) {
        preserveMarkdownControlState(fromEl, toEl)
      }
      if (fromEl.isEqualNode(toEl)) return false
      return true
    },
  })
  root.querySelectorAll<HTMLSelectElement>(`select[${MARKDOWN_USER_STATE_ATTRIBUTE}]`).forEach((select, index) => {
    const selectedValues = dirtySelectValues[index]
    if (!selectedValues) return
    Array.from(select.options).forEach(option => {
      option.selected = selectedValues.has(option.value)
    })
  })
}

function getOrderedListPadding(start: number, itemCount: number): string {
  const endNumber = Math.max(start + itemCount - 1, start)
  const markerChars = String(Math.abs(endNumber)).length + (endNumber < 0 ? 1 : 0)
  return `${Math.max(3, markerChars + 2)}ch`
}

// ─── DOM decoration and native control state ────────────────────

function decorateMarkdownDom(root: HTMLElement) {
  root.querySelectorAll('img').forEach(image => {
    const dimensions = inferImageDimensions(image.currentSrc || image.src)
    if (dimensions && !image.hasAttribute('width') && !image.hasAttribute('height')) {
      image.width = dimensions.width
      image.height = dimensions.height
    }
    image.loading = 'eager'
    image.decoding = 'async'
  })

  root.querySelectorAll('ol').forEach(list => {
    const startAttr = list.getAttribute('start')
    const start = startAttr ? parseInt(startAttr, 10) : 1
    const itemCount = Math.max(list.children.length, 1)
    list.style.paddingInlineStart = getOrderedListPadding(start, itemCount)
  })

  root.querySelectorAll('input[type="checkbox"][disabled]').forEach(input => {
    if (!(input instanceof HTMLInputElement)) return
    input.readOnly = true
    input.className = 'mr-2 align-middle'
  })
}

function preserveMarkdownControlState(fromElement: HTMLElement, toElement: HTMLElement) {
  if (!fromElement.hasAttribute(MARKDOWN_USER_STATE_ATTRIBUTE)) return
  toElement.setAttribute(MARKDOWN_USER_STATE_ATTRIBUTE, '')

  if (fromElement instanceof HTMLDetailsElement && toElement instanceof HTMLDetailsElement) {
    toElement.open = fromElement.open
    return
  }
  if (fromElement instanceof HTMLInputElement && toElement instanceof HTMLInputElement) {
    toElement.value = fromElement.value
    toElement.setAttribute('value', fromElement.value)
    if (fromElement.type === 'checkbox' || fromElement.type === 'radio') {
      toElement.checked = fromElement.checked
      toElement.toggleAttribute('checked', fromElement.checked)
    }
    return
  }
  if (fromElement instanceof HTMLTextAreaElement && toElement instanceof HTMLTextAreaElement) {
    toElement.value = fromElement.value
    toElement.textContent = fromElement.value
    return
  }
  if (fromElement instanceof HTMLSelectElement && toElement instanceof HTMLSelectElement) {
    const selectedValues = new Set(Array.from(fromElement.selectedOptions, option => option.value))
    Array.from(toElement.options).forEach(option => {
      const selected = selectedValues.has(option.value)
      option.selected = selected
      option.toggleAttribute('selected', selected)
    })
  }
}

// ─── DOM Island Block ───────────────────────────────────────────

export const MarkdownDomBlock = memo(function MarkdownDomBlock({
  src,
  isReasoning,
  isLive,
  renderHtml,
}: {
  src: string
  isReasoning: boolean
  isLive?: boolean
  renderHtml: boolean
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const appliedHtmlRef = useRef<string | null>(null)
  const appliedSrcRef = useRef<string | null>(null)
  // 流式直接渲染最新 src，不叠 useDeferredValue：
  // 双重延迟会让 React 18 concurrent 每帧跑两轮协调（紧急+deferred），流式帧时长翻倍。
  const renderSrc = src

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const markUserState = (event: Event) => {
      if (event.target instanceof HTMLElement) event.target.setAttribute(MARKDOWN_USER_STATE_ATTRIBUTE, '')
    }
    root.addEventListener('input', markUserState)
    root.addEventListener('change', markUserState)
    root.addEventListener('toggle', markUserState, true)
    return () => {
      root.removeEventListener('input', markUserState)
      root.removeEventListener('change', markUserState)
      root.removeEventListener('toggle', markUserState, true)
    }
  }, [])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return

    // live 纯文本追加：跳过 parse + morphdom，只改最后一个 Text 节点
    const prevSrc = appliedSrcRef.current
    if (isLive && prevSrc != null && root.hasChildNodes() && renderSrc.startsWith(prevSrc)) {
      const suffix = renderSrc.slice(prevSrc.length)
      if (canAppendLiveMarkdownSuffix(suffix) && tryAppendLiveText(root, suffix)) {
        appliedSrcRef.current = renderSrc
        // 文本已偏离开 html 快照，强制后续全量路径重算
        appliedHtmlRef.current = null
        return
      }
    }

    // live 中间态不进 htmlCache（避免 64 槽被流式碎片挤爆）；稳定块才缓存
    const html = isLive
      ? renderMarkdownToHtml(renderSrc, isReasoning, renderHtml)
      : getCachedHtml(renderSrc, isReasoning, renderHtml)
    if (appliedHtmlRef.current === html) {
      appliedSrcRef.current = renderSrc
      return
    }
    appliedHtmlRef.current = html
    appliedSrcRef.current = renderSrc
    applyMarkdownHtml(root, html)
  }, [renderSrc, isReasoning, isLive, renderHtml])

  const handleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return
    const target = event.target instanceof Element ? event.target : null

    if (target?.closest('summary')) {
      target.closest('details')?.setAttribute(MARKDOWN_USER_STATE_ATTRIBUTE, '')
    }

    // Local file link
    const anchor = target?.closest<HTMLAnchorElement>(`a[href^="${LOCAL_FILE_LINK_PREFIX}"]`)
    const localPath = decodeLocalFileHref(anchor?.getAttribute('href') ?? undefined)
    if (anchor && localPath) {
      event.preventDefault()
      openLocalFilePath(localPath)
    }
  }, [])

  const handleSubmit = useCallback((event: React.FormEvent<HTMLDivElement>) => {
    event.preventDefault()
  }, [])

  return <div ref={rootRef} className={MARKDOWN_BLOCK_CONTENT_CLASS} onClick={handleClick} onSubmit={handleSubmit} />
})

export function MarkdownHtmlIsland({
  src,
  isReasoning,
  isLive,
}: {
  src: string
  isReasoning: boolean
  isLive: boolean
}) {
  const { t } = useTranslation('components')
  const [showSource, setShowSource] = useState(false)
  if (showSource) {
    return (
      <CodeBlock
        code={src}
        language="html"
        variant={isReasoning ? 'reasoning' : 'default'}
        wordwrap={isReasoning}
        className="my-4 first:mt-0 last:mb-0"
        headerActions={
          <button
            type="button"
            onClick={() => setShowSource(false)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md p-2 text-text-400 transition-colors hover:bg-bg-300/60 hover:text-text-200"
            title={t('markdown.renderHtml')}
            aria-label={t('markdown.renderHtml')}
          >
            <EyeIcon />
          </button>
        }
      />
    )
  }

  return (
    <HtmlPreviewSurface onViewSource={() => setShowSource(true)}>
      <MarkdownDomBlock src={src} isReasoning={isReasoning} isLive={isLive} renderHtml />
    </HtmlPreviewSurface>
  )
}
