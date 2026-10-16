import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'
import { recordClientError } from '../store/clientErrorLog'

vi.mock('../store/clientErrorLog', () => ({
  recordClientError: vi.fn(),
}))

vi.mock('../utils/clipboard', () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}))

let shouldThrow = false

function Bomb() {
  if (shouldThrow) throw new Error('render exploded')
  return <div>healthy ui</div>
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    shouldThrow = false
    vi.mocked(recordClientError).mockClear()
    // React 会把捕获到的错误再打到 console.error，测试输出里不需要。
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByText('healthy ui')).toBeInTheDocument()
    expect(recordClientError).not.toHaveBeenCalled()
  })

  it('shows a recoverable fallback and records the error', () => {
    shouldThrow = true
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/render exploded/)).toBeInTheDocument()
    expect(recordClientError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordClientError).mock.calls[0]?.[0]).toMatchObject({
      source: 'react',
      category: 'ui',
      operation: 'render',
      message: 'render exploded',
    })
  })

  it('retries the subtree instead of reloading the app', () => {
    shouldThrow = true
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    // 重试只重置 boundary 状态，不强制刷新页面（用户可能正在看长会话），
    // 一次性故障或状况已变化的故障因此能直接恢复。
    shouldThrow = false
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(screen.getByText('healthy ui')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
