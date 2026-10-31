import { memo, useEffect, useId, useMemo, useSyncExternalStore } from 'react'
import { CodeBlock } from './CodeBlock'
import { detectLanguage } from '../utils/languageUtils'
import { perfMark } from '../utils/perf'
import {
  isMarkupPreviewLanguage,
  projectMarkdownStream,
  stripLeadingHtmlComments,
  type MarkdownStreamProjection,
} from './markdownStream'
import { themeStore } from '../store/themeStore'
import { MarkdownMermaid } from './markdownMermaid'
import { MarkdownHtmlArtifact } from './markdownHtmlArtifact'
import { MARKDOWN_BLOCK_CONTENT_CLASS, MarkdownDomBlock, MarkdownHtmlIsland } from './markdownDomBlock'
import { renderTableFromSrc } from './markdownTable'

/** 只订阅 renderHtmlContent 布尔值（useTheme 全量订阅会让每条消息的 markdown 跟着任何设置变动重渲染） */
function useRenderHtmlContent(): boolean {
  return useSyncExternalStore(themeStore.subscribe, () => themeStore.renderHtmlContent)
}

interface MarkdownRendererProps {
  content: string
  className?: string
  isStreaming?: boolean
  variant?: 'default' | 'reasoning'
}

const markdownProjectionCache = new Map<string, MarkdownStreamProjection>()

const BLOCK_HTML_SOURCE_PATTERN =
  /^\s*<(?:address|article|aside|blockquote|center|details|dialog|div|dl|fieldset|figure|footer|form|header|html|main|nav|ol|section|svg|table|ul)\b/i
const PREFIXED_BLOCK_HTML_SOURCE_PATTERN =
  /^\s*<(?:style|script)\b[\s\S]*<(?:address|article|aside|blockquote|center|details|dialog|div|dl|fieldset|figure|footer|form|header|html|main|nav|ol|section|svg|table|ul)\b/i
const ARTIFACT_HTML_SOURCE_PATTERN =
  /(?:<!doctype\s+html\b|<html\b|<style\b|<script\b|<canvas\b|\son[a-z]+\s*=|(?:href|src)\s*=\s*["']?\s*javascript:)/i

// ─── Stream Block ───────────────────────────────────────────────

const MarkdownStreamBlock = memo(function MarkdownStreamBlock({
  src,
  mode,
  language,
  complete,
  isReasoning,
  isStreaming,
  renderHtml,
}: {
  src: string
  mode: 'full' | 'live' | 'code' | 'table'
  language?: string
  complete?: boolean
  isReasoning: boolean
  isStreaming: boolean
  renderHtml: boolean
}) {
  // 流式高亮/未完成态只对「未闭合 code」或 live 有意义；稳定 full 块 isStreaming 恒 false 以冻 memo
  const streamActive = isStreaming && (mode === 'live' || (mode === 'code' && !complete))

  if (mode === 'table') {
    return (
      <div className="markdown-stream-block">
        <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>{renderTableFromSrc(src, isReasoning)}</div>
      </div>
    )
  }

  if (mode === 'code') {
    if (language?.toLowerCase() === 'mermaid') {
      return (
        <div className="markdown-stream-block">
          <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>
            <MarkdownMermaid code={src} isIncomplete={streamActive} />
          </div>
        </div>
      )
    }
    if (renderHtml && isMarkupPreviewLanguage(language) && !isReasoning) {
      return (
        <div className="markdown-stream-block">
          <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>
            <MarkdownHtmlArtifact
              code={src}
              language={language}
              isReasoning={isReasoning}
              isIncomplete={streamActive}
            />
          </div>
        </div>
      )
    }
    return (
      <div className="markdown-stream-block">
        <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>
          <div className={isReasoning ? 'my-2 first:mt-0 last:mb-0 w-full' : 'my-4 first:mt-0 last:mb-0 w-full'}>
            <CodeBlock
              code={src}
              language={language}
              variant={isReasoning ? 'reasoning' : 'default'}
              wordwrap={isReasoning}
              forceHighlight={streamActive}
              streamingHighlight={streamActive}
            />
          </div>
        </div>
      </div>
    )
  }

  const htmlSourceStart = stripLeadingHtmlComments(src)
  const isHtmlDocument = /^(?:<!doctype\s+html\b|<html\b)/i.test(htmlSourceStart)
  const isHtmlArtifact =
    ARTIFACT_HTML_SOURCE_PATTERN.test(src) &&
    (BLOCK_HTML_SOURCE_PATTERN.test(htmlSourceStart) || PREFIXED_BLOCK_HTML_SOURCE_PATTERN.test(htmlSourceStart))
  if (renderHtml && !isReasoning && (isHtmlDocument || isHtmlArtifact)) {
    return (
      <div className="markdown-stream-block">
        <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>
          <MarkdownHtmlArtifact code={src} isReasoning={false} isIncomplete={streamActive && mode === 'live'} />
        </div>
      </div>
    )
  }

  if (renderHtml && !isReasoning && BLOCK_HTML_SOURCE_PATTERN.test(htmlSourceStart)) {
    return (
      <div className="markdown-stream-block">
        <MarkdownHtmlIsland src={src} isReasoning={false} isLive={mode === 'live'} />
      </div>
    )
  }

  // 关闭 HTML 渲染：HTML 文档/artifact/island 一律按源码代码块展示
  if (
    !renderHtml &&
    !isReasoning &&
    (isHtmlDocument || isHtmlArtifact || BLOCK_HTML_SOURCE_PATTERN.test(htmlSourceStart))
  ) {
    return (
      <div className="markdown-stream-block">
        <div className={MARKDOWN_BLOCK_CONTENT_CLASS}>
          <div className="my-4 first:mt-0 last:mb-0 w-full">
            <CodeBlock code={src} language="html" wordwrap />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="markdown-stream-block">
      <MarkdownDomBlock src={src} isReasoning={isReasoning} isLive={mode === 'live'} renderHtml={renderHtml} />
    </div>
  )
})

// ─── Main Renderer ──────────────────────────────────────────────

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className = '',
  isStreaming = false,
  variant = 'default',
}: MarkdownRendererProps) {
  const isReasoning = variant === 'reasoning'
  const projectionKey = useId()
  // 「渲染 HTML 内容」开关（默认开）；关闭时 HTML 文档/artifact/island 一律按源码展示
  const renderHtml = useRenderHtmlContent()
  // 流式直接渲染最新 content，不做 rAF 节流：旧实现会把一帧内的多次
  // token 更新合并成一次跳变，导致内容「突然蹦出来」而非逐 token 平滑
  // 流出（对齐 reference：直接渲染 + 增量解析保证性能，浏览器按帧自然显示）。
  const renderedContent = content
  const streamBlocks = useMemo(() => {
    perfMark('piui:render-markdown')
    const projection = projectMarkdownStream(markdownProjectionCache.get(projectionKey), renderedContent, isStreaming)
    markdownProjectionCache.set(projectionKey, projection)
    perfMark('piui:render-markdown:end')
    return projection.blocks
  }, [projectionKey, renderedContent, isStreaming])

  useEffect(() => {
    return () => {
      markdownProjectionCache.delete(projectionKey)
    }
  }, [projectionKey])

  return (
    <div
      className={`markdown-content ${isReasoning ? 'text-[length:var(--fs-sm)] leading-5 text-text-400' : 'text-[length:var(--fs-base)] leading-relaxed text-text-100'} break-words min-w-0 overflow-hidden ${className}`}
    >
      {streamBlocks.map(block => (
        <MarkdownStreamBlock
          key={block.key}
          src={block.src}
          mode={block.mode}
          language={block.language}
          complete={block.complete}
          isReasoning={isReasoning}
          renderHtml={renderHtml}
          isStreaming={isStreaming && (block.mode === 'live' || (block.mode === 'code' && !block.complete))}
        />
      ))}
    </div>
  )
})

// ─── Standalone Code Highlighter ────────────────────────────────

export const HighlightedCode = memo(function HighlightedCode({
  code,
  filePath,
  language,
  maxHeight,
  className = '',
}: {
  code: string
  filePath?: string
  language?: string
  maxHeight?: number
  className?: string
}) {
  const lang = useMemo(() => {
    return language || detectLanguage(filePath)
  }, [filePath, language])

  return (
    <div className={`overflow-auto ${className}`} style={maxHeight ? { maxHeight } : undefined}>
      <CodeBlock code={code} language={lang} />
    </div>
  )
})

export default MarkdownRenderer
