import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'
import { Button } from './ui/Button'
import { copyTextToClipboard } from '../utils/clipboard'
import { recordClientError } from '../store/clientErrorLog'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 翻译取不到时退回英文原文——这个组件本身处在「有东西坏了」的路径上，
 * 不能依赖任何可能一起坏掉的东西。
 */
function t(key: string, fallback: string): string {
  try {
    return i18n.t(key, { ns: 'common', defaultValue: fallback })
  } catch {
    return fallback
  }
}

function errorText(error: Error): string {
  return `${error.name}: ${error.message}\n\n${error.stack ?? ''}`.trim()
}

function CopyDetailsButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (): void => {
    void copyTextToClipboard(text)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  return (
    <Button size="sm" variant="ghost" onClick={handleCopy}>
      {copied ? t('errorBoundary.copied', 'Copied') : t('errorBoundary.copyDetails', 'Copy details')}
    </Button>
  )
}

interface ErrorFallbackProps {
  error: Error
  onRetry: () => void
}

function ErrorFallback({ error, onRetry }: ErrorFallbackProps) {
  // 内联样式：外层样式表/主题变量不一定还有效，这里优先保证能读能点。
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: 'calc(24px + env(safe-area-inset-top)) 20px 24px',
        overflowY: 'auto',
        background: 'var(--color-bg-100, #14161a)',
        color: 'var(--color-text-100, #f2f3f5)',
        fontFamily: 'inherit',
      }}
      role="alert"
    >
      <div style={{ fontSize: 18, fontWeight: 600 }}>{t('errorBoundary.title', 'Something went wrong')}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--color-text-300, #a7abb3)' }}>
        {t(
          'errorBoundary.description',
          'The interface hit an unexpected error. Your session data on the server is untouched — retry, or reload the page. The error has been recorded in Settings → About → Diagnostics.',
        )}
      </div>

      <pre
        style={{
          margin: 0,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--color-bg-200, #1c1f24)',
          border: '1px solid var(--color-danger-100, #e5484d)',
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {errorText(error)}
      </pre>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('errorBoundary.retry', 'Retry')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          {t('errorBoundary.reload', 'Reload')}
        </Button>
        <CopyDetailsButton text={errorText(error)} />
      </div>
    </div>
  )
}

/**
 * 渲染期错误的兜底。
 *
 * 之前 app 根本没有挂载 ErrorBoundary：一次渲染期 throw 就是白屏，Android WebView
 * 没有 devtools，用户和开发者都拿不到任何信息。这里至少给出可读的错误、可重试的
 * 出口，并把它记进客户端错误日志。
 *
 * 注意范围：只覆盖 render / 生命周期 / 构造阶段的错误。事件回调和 Promise 里的
 * 异常 React 不会交给它，那些走 logError。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    recordClientError({
      source: 'react',
      category: 'ui',
      operation: 'render',
      message: error.message || error.name,
      stack: [error.stack, info.componentStack].filter(Boolean).join('\nComponent stack:'),
    })
  }

  private handleRetry = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return <ErrorFallback error={error} onRetry={this.handleRetry} />
  }
}
