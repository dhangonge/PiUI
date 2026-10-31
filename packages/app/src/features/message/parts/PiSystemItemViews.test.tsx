import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { PiCustomMessageItem } from '../../../pi/domain/index.js'
import { PiSystemItemView, subagentResultToExecution } from './PiSystemItemViews'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

// ContentBlock（结果/错误卡片）需要全屏上下文；展开态在单元测试里直接钉成展开。
vi.mock('../../../contexts', () => ({
  useFullscreen: () => ({
    activeId: null,
    openFullscreen: vi.fn(),
    updateFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
  }),
  useFullscreenLayer: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}))

vi.mock('../../../contexts/SessionNavigationContext', () => ({
  useSessionNavigation: () => ({
    navigateToSession: vi.fn(),
    currentSessionId: 'parent-session',
    currentDirectory: '/work',
  }),
}))

vi.mock('../../../utils/uiDisclosureState', () => ({
  useUiDisclosureState: () => [true, vi.fn()] as const,
}))

vi.mock('../../../pi/controllers/index.js', () => ({
  abortPiOperation: vi.fn(async () => undefined),
  stopPiAgent: vi.fn(async () => undefined),
}))

vi.mock('../../../components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}))

function customMessage(options: {
  customType?: string
  content?: string
  display?: boolean
  details?: unknown
}): PiCustomMessageItem {
  return {
    kind: 'custom_message',
    entryId: 'entry-1',
    timestamp: 0,
    rawEntry: {} as PiCustomMessageItem['rawEntry'],
    customType: options.customType ?? 'subagent-result',
    content: options.content ?? '',
    display: options.display ?? true,
    details: options.details,
  }
}

describe('PiSystemItemView custom messages', () => {
  it('renders an ordinary custom message as markdown', () => {
    render(<PiSystemItemView item={customMessage({ customType: 'plannotator-framing', content: 'hello' })} />)

    expect(screen.getByTestId('markdown')).toHaveTextContent('hello')
  })

  it('drops a custom message that is not displayed', () => {
    const { container } = render(
      <PiSystemItemView
        item={customMessage({ customType: 'plannotator-framing', content: 'hidden', display: false })}
      />,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders a subagent-result as an agent card, not raw markdown', () => {
    render(
      <PiSystemItemView
        item={customMessage({
          content: '[Subagent "Explore" ab12cd34 completed]\n\nThe answer is 42.',
          details: { type: 'Explore', description: 'Inspect the renderer', status: 'completed' },
        })}
      />,
    )

    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
    expect(screen.getByText('Explore')).toBeInTheDocument()
    expect(screen.getByText('Inspect the renderer')).toBeInTheDocument()
    // 状态由卡片头部表达，正文走结果内容块
    expect(screen.queryByText(/\[Subagent "Explore"/)).not.toBeInTheDocument()
    expect(screen.getByText('task.result')).toBeInTheDocument()
  })

  it('strips the plugin header line and keeps the result body', () => {
    const execution = subagentResultToExecution(
      customMessage({
        content: '[Subagent "Explore" ab12cd34 completed]\n\nThe answer is 42.',
        details: { type: 'Explore', description: 'Inspect', status: 'completed' },
      }),
    )

    expect(execution?.call.name).toBe('Agent')
    expect(execution?.call.arguments.agent).toBe('Explore')
    expect(execution?.result?.content).toEqual([{ type: 'text', text: 'The answer is 42.' }])
    expect(execution?.result?.isError).toBe(false)
  })

  it('marks an errored subagent-result as a tool error', () => {
    const execution = subagentResultToExecution(
      customMessage({ content: '[Subagent "X" y error]\n\nError: boom', details: { status: 'error' } }),
    )

    expect(execution?.result?.isError).toBe(true)
  })

  it('keeps the plugin stats chips from the message details', () => {
    render(
      <PiSystemItemView
        item={customMessage({
          content: '[Subagent "Explore" ab12cd34 completed]\n\ndone',
          details: { type: 'Explore', description: 'Inspect', status: 'completed', turnCount: 4, toolUses: 9 },
        })}
      />,
    )

    expect(screen.getByText('task.stats.turns 4')).toBeInTheDocument()
    expect(screen.getByText('task.stats.tools 9')).toBeInTheDocument()
  })

  it('renders an errored subagent-result with the error card', () => {
    render(
      <PiSystemItemView
        item={customMessage({
          content: '[Subagent "Explore" ab12cd34 error]\n\nError: boom',
          details: { type: 'Explore', description: 'Inspect', status: 'error' },
        })}
      />,
    )

    expect(screen.getByText('task.error')).toBeInTheDocument()
  })

  it('falls back to markdown when a subagent-result carries no details', () => {
    render(<PiSystemItemView item={customMessage({ content: '[Subagent "X" y completed]\n\ntext' })} />)

    expect(screen.getByTestId('markdown')).toHaveTextContent('text')
  })
})
