import { Fragment } from 'react'
import { renderKatexHtml } from './markdownHtmlRenderer'
import { getFootnoteId, scanTextSegments } from './markdownSegments'
import type { MarkdownSegment } from './markdownSegments'
import { inferImageDimensions } from './imageDimensions'
import { isTauri } from '../utils/tauri'

export const LOCAL_FILE_LINK_PREFIX = '#piui-local-file:'

export function decodeLocalFileHref(href?: string): string | null {
  if (!href?.startsWith(LOCAL_FILE_LINK_PREFIX)) return null
  try {
    return decodeURIComponent(href.slice(LOCAL_FILE_LINK_PREFIX.length))
  } catch {
    return null
  }
}

export function openLocalFilePath(filePath: string) {
  if (!isTauri()) return
  import('@tauri-apps/plugin-opener').then(mod => mod.openPath(filePath)).catch(() => {})
}

export function renderInlineTokensToReact(tokens: unknown[], _isReasoning: boolean): React.ReactNode {
  return tokens.map((token, index) => {
    const item = token as Record<string, unknown>
    if (item.type === 'text') {
      const nested = item.tokens as unknown[] | undefined
      if (nested?.length) return <Fragment key={index}>{renderInlineTokensToReact(nested, _isReasoning)}</Fragment>
      return renderSegmentsToReact(scanTextSegments(String(item.text ?? '')), `text-${index}`, _isReasoning)
    }
    if (item.type === 'strong')
      return (
        <strong key={index} className={_isReasoning ? 'font-semibold text-text-300' : 'font-semibold text-text-100'}>
          {renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)}
        </strong>
      )
    if (item.type === 'em')
      return (
        <em key={index} className={_isReasoning ? 'italic text-text-300' : 'italic text-text-200'}>
          {renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)}
        </em>
      )
    // 删除线只来自 ~~...~~（tokenizer 已限制单 ~ 不产生 del）
    if (item.type === 'del') {
      return (
        <del
          key={index}
          className={
            _isReasoning
              ? 'text-text-500 line-through decoration-text-500/50'
              : 'text-text-400 line-through decoration-text-400/50'
          }
        >
          {renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)}
        </del>
      )
    }
    if (item.type === 'codespan')
      return (
        <code
          key={index}
          className={
            _isReasoning
              ? 'font-mono text-accent-main-100 text-[0.9em] align-baseline break-words'
              : 'text-accent-main-100 text-[0.9em] font-mono align-baseline break-words'
          }
        >
          {String(item.text ?? '')}
        </code>
      )
    if (item.type === 'link') {
      const href = typeof item.href === 'string' ? item.href : undefined
      if (isUnsafeHrefInline(href))
        return (
          <span key={index}>{renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)} [blocked]</span>
        )
      const localPath = decodeLocalFileHref(href) ?? getWindowsAbsolutePathInline(href)
      const className = _isReasoning
        ? 'text-[length:var(--fs-sm)] font-medium text-accent-main-200/80 hover:text-accent-main-200 underline underline-offset-2 transition-colors'
        : 'font-medium text-accent-main-100 hover:text-accent-main-200 underline underline-offset-2 transition-colors'
      if (localPath) {
        return (
          <a
            key={index}
            href={encodeLocalFileHref(localPath)}
            title={localPath}
            className={className}
            onClick={e => {
              e.preventDefault()
              openLocalFilePath(localPath)
            }}
          >
            {renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)}
          </a>
        )
      }
      return (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer" className={className}>
          {renderInlineTokensToReact((item.tokens as unknown[]) ?? [], _isReasoning)}
        </a>
      )
    }
    if (item.type === 'image') {
      const src = typeof item.href === 'string' ? item.href : undefined
      if (!src || isUnsafeImageSrcInline(src))
        return <span key={index}>[Image blocked: {String(item.text ?? '')}]</span>
      const dimensions = inferImageDimensions(src)
      return (
        <img
          key={index}
          src={src}
          alt={String(item.text ?? '')}
          width={dimensions?.width}
          height={dimensions?.height}
          loading="eager"
          decoding="async"
          className="block max-w-full rounded-md"
        />
      )
    }
    if (item.type === 'br') return <br key={index} />
    if (item.type === 'math') {
      const text = String(item.text ?? '')
      const display = item.display === true
      const fallback = display ? `\\[${text}\\]` : `\\(${text}\\)`
      return <span key={index} dangerouslySetInnerHTML={{ __html: renderKatexHtml(text, display, fallback) }} />
    }
    return <span key={index}>{String(item.text ?? item.raw ?? '')}</span>
  })
}

/** 把统一扫描出的 segments 渲染成 React 节点（表格单元格路径）。 */
function renderSegmentsToReact(segments: MarkdownSegment[], keyPrefix: string, isReasoning: boolean): React.ReactNode {
  return segments.map((segment, index) => {
    const key = `${keyPrefix}-${index}`
    switch (segment.type) {
      case 'text':
        return <Fragment key={key}>{segment.text}</Fragment>
      case 'math':
        return <span key={key} dangerouslySetInnerHTML={{ __html: renderKatexHtml(segment.latex, segment.display) }} />
      case 'mark': {
        const className = isReasoning
          ? 'rounded-sm bg-bg-300/70 px-0.5 text-text-300'
          : 'rounded-sm bg-accent-main-100/15 px-0.5 text-text-100'
        return (
          <mark key={key} className={className}>
            {renderSegmentsToReact(segment.children, key, isReasoning)}
          </mark>
        )
      }
      case 'sup':
        return <sup key={key}>{renderSegmentsToReact(segment.children, key, isReasoning)}</sup>
      case 'sub':
        return <sub key={key}>{renderSegmentsToReact(segment.children, key, isReasoning)}</sub>
      case 'footnoteRef': {
        const id = getFootnoteId(segment.label)
        const className = isReasoning
          ? 'align-super text-[0.75em] text-accent-main-200/80'
          : 'align-super text-[0.75em] text-accent-main-100'
        return (
          <sup key={key} id={`fnref-${id}`} className={className}>
            <a href={`#fn-${id}`} className="font-medium underline underline-offset-2">
              {segment.label}
            </a>
          </sup>
        )
      }
    }
  })
}

function isUnsafeHrefInline(href?: string): boolean {
  if (!href) return false
  const normalized = Array.from(href.trim())
    .filter(char => {
      const code = char.charCodeAt(0)
      return code > 0x1f && code !== 0x7f && !/\s/.test(char)
    })
    .join('')
    .toLowerCase()
  return normalized.startsWith('javascript:') || normalized.startsWith('vbscript:') || normalized.startsWith('data:')
}

function isUnsafeImageSrcInline(src?: string): boolean {
  if (!src) return false
  if (/^data:/i.test(src.trim())) return true
  return isUnsafeHrefInline(src)
}

function getWindowsAbsolutePathInline(value: string | undefined): string | null {
  if (!value) return null
  try {
    const decoded = decodeURIComponent(value)
    return /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : null
  } catch {
    return value
  }
}

function encodeLocalFileHref(filePath: string): string {
  return `${LOCAL_FILE_LINK_PREFIX}${encodeURIComponent(filePath)}`
}
