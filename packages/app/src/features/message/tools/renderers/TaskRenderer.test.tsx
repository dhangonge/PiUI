import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionNavigationContext } from '../../../../contexts/SessionNavigationContext'
import { childAgentStore } from '../../../../pi/childAgentStore'
import { piSessionInfoStore } from '../../../../pi/piSessionInfoStore'
import type { PiToolExecution } from '../../../../pi/domain/index.js'
import { TaskHeader, TaskRenderer } from './TaskRenderer'

const { stopPiAgentMock, abortPiOperationMock } = vi.hoisted(() => ({
  stopPiAgentMock: vi.fn<(sessionId: string, agentId: string) => Promise<void>>(async () => undefined),
  abortPiOperationMock: vi.fn<(sessionId: string) => Promise<void>>(async () => undefined),
}))

vi.mock('../../../../pi/controllers/index.js', () => ({
  stopPiAgent: stopPiAgentMock,
  abortPiOperation: abortPiOperationMock,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}))

// ContentBlock 需要全屏上下文；卡片本身的展开状态在单元测试里直接钉成展开，
// 否则被测节点全在 MessageExpandPanel 的折叠壳里取不到。
vi.mock('../../../../contexts', () => ({
  useFullscreen: () => ({
    activeId: null,
    openFullscreen: vi.fn(),
    updateFullscreen: vi.fn(),
    closeFullscreen: vi.fn(),
  }),
  useFullscreenLayer: () => ({ isOpen: false, open: vi.fn(), close: vi.fn() }),
}))

vi.mock('../../../../utils/uiDisclosureState', () => ({
  useUiDisclosureState: () => [true, vi.fn()] as const,
}))

function renderHeader(options: { sessionId?: string; parentId?: string } = { sessionId: 'child-session' }) {
  const sessionId = options.sessionId
  const navigateToSession = vi.fn()
  const onToggle = vi.fn()

  render(
    <SessionNavigationContext.Provider
      value={{
        navigateToSession,
        currentSessionId: options.parentId ?? 'parent-session',
        currentDirectory: 'E:\\workspace',
      }}
    >
      <TaskHeader
        agentType="explore"
        description="Inspect the renderer"
        status="completed"
        expanded={false}
        onToggle={onToggle}
        sessionId={sessionId}
      />
    </SessionNavigationContext.Provider>,
  )

  return { navigateToSession, onToggle }
}

describe('TaskHeader', () => {
  it('opens the child session from the jump button', () => {
    const { navigateToSession, onToggle } = renderHeader()

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('also opens the child session from the agent badge', () => {
    const { navigateToSession, onToggle } = renderHeader()

    const badge = screen.getByRole('button', { name: 'explore' })
    // 移动端 32px 最小点击区域会把这枚内联徽标撑高，data-compact 是 index.css 的逃生口
    expect(badge).toHaveAttribute('data-compact')

    fireEvent.click(badge)

    expect(navigateToSession).toHaveBeenCalledWith('child-session', 'E:\\workspace')
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('uses the title and its remaining row space to toggle details', () => {
    const { navigateToSession, onToggle } = renderHeader()
    const titleButton = screen.getByRole('button', { name: /Inspect the renderer/ })

    expect(titleButton).toHaveClass('flex-1')
    fireEvent.click(titleButton)

    expect(onToggle).toHaveBeenCalledOnce()
    expect(navigateToSession).not.toHaveBeenCalled()
  })

  it('routes raw child IDs to the parent server rather than the focused server', () => {
    const { navigateToSession } = renderHeader({ sessionId: 'child', parentId: 'owner::parent' })
    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))
    expect(navigateToSession).toHaveBeenCalledWith('owner::child', 'E:\\workspace')
  })

  it('hides the jump button until a child session exists', () => {
    const { onToggle } = renderHeader({ sessionId: undefined })

    expect(screen.queryByRole('button', { name: 'task.openSession' })).not.toBeInTheDocument()
    expect(screen.getByText('explore').tagName).toBe('SPAN')
    expect(onToggle).not.toHaveBeenCalled()
  })
})

// ============================================
// pi-subagents-lite Agent 族卡片
//
// 与 OpenCode `task` 的差别全在 details 的形状上：前台带统计和 outputFile，
// 后台只有 agentId，但两者在工具返回时都已经有 result —— 状态只能看
// details.status，不能看 result 是否存在。
// ============================================

function agentExecution(options: {
  input?: Record<string, unknown>
  details?: Record<string, unknown>
  hasResult?: boolean
  isError?: boolean
  text?: string
}): PiToolExecution {
  const hasResult = options.hasResult ?? true
  return {
    call: {
      type: 'toolCall',
      id: 'call-agent',
      name: 'Agent',
      arguments: { prompt: 'Inspect the renderer', description: 'Inspect', ...options.input },
    },
    result: hasResult
      ? {
          role: 'toolResult',
          toolCallId: 'call-agent',
          toolName: 'Agent',
          content: [{ type: 'text', text: options.text ?? 'done' }],
          isError: options.isError ?? false,
          timestamp: 0,
          details: options.details as never,
        }
      : undefined,
  }
}

function renderAgent(execution: PiToolExecution) {
  return render(
    <SessionNavigationContext.Provider
      value={{ navigateToSession: vi.fn(), currentSessionId: 'parent-session', currentDirectory: '/work' }}
    >
      <TaskRenderer execution={execution} partKey="p-agent" data={{}} />
    </SessionNavigationContext.Provider>,
  )
}

function renderAgentWithNav(execution: PiToolExecution, currentSessionId: string) {
  const navigateToSession = vi.fn()
  render(
    <SessionNavigationContext.Provider value={{ navigateToSession, currentSessionId, currentDirectory: '/work' }}>
      <TaskRenderer execution={execution} partKey="p-agent" data={{}} />
    </SessionNavigationContext.Provider>,
  )
  return navigateToSession
}

describe('TaskRenderer (pi Agent tool)', () => {
  beforeEach(() => {
    stopPiAgentMock.mockClear()
    abortPiOperationMock.mockClear()
    childAgentStore.clearAll()
    piSessionInfoStore.clear()
  })

  it('opens the live subagent transcript matched by the child session name', () => {
    const agentId = 'a1b2c3d4-1111-2222-3333-444455556666'
    childAgentStore.receive(
      { phase: 'created', sessionId: 'child-1', sessionName: 'Explore#a1b2c3d4' },
      'owner::parent-session',
    )
    const navigateToSession = renderAgentWithNav(
      agentExecution({ input: { run_in_background: true }, details: { status: 'running', agentId } }),
      'owner::parent-session',
    )

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(navigateToSession).toHaveBeenCalledWith('owner::child-1', '/work')
  })

  it('opens a persisted subagent session after the agent is gone', () => {
    const agentId = 'deadbeef-1111-2222-3333-444455556666'
    piSessionInfoStore.replaceForServer('owner', [
      {
        id: 'owner::child-2',
        path: '/work/.pi/sessions/child-2.jsonl',
        cwd: '/work',
        name: 'Explore#deadbeef',
        created: new Date(0),
        modified: new Date(0),
        messageCount: 1,
        firstMessage: '',
        allMessagesText: '',
      } as never,
    ])
    const navigateToSession = renderAgentWithNav(
      agentExecution({ input: { run_in_background: true }, details: { status: 'completed', agentId } }),
      'owner::parent-session',
    )

    fireEvent.click(screen.getByRole('button', { name: 'task.openSession' }))

    expect(navigateToSession).toHaveBeenCalledWith('owner::child-2', '/work')
  })

  it('hides the jump button when the subagent session was never persisted', () => {
    renderAgent(
      agentExecution({ input: { run_in_background: true }, details: { status: 'running', agentId: 'ffffffff' } }),
    )

    expect(screen.queryByRole('button', { name: 'task.openSession' })).not.toBeInTheDocument()
  })

  it('defaults the agent badge to general-purpose', () => {
    renderAgent(agentExecution({ details: { status: 'completed' } }))
    expect(screen.getByText('general-purpose')).toBeInTheDocument()
  })

  it('renders the requested agent name instead of the default', () => {
    renderAgent(agentExecution({ input: { agent: 'oracle' }, details: { status: 'completed' } }))
    expect(screen.getByText('oracle')).toBeInTheDocument()
    expect(screen.queryByText('general-purpose')).not.toBeInTheDocument()
  })

  it('shows no status text for a completed agent', () => {
    renderAgent(agentExecution({ details: { status: 'completed' } }))
    expect(screen.queryByText('task.status.completed')).not.toBeInTheDocument()
  })

  it('shows the queued label and no stop button is missing when queued', () => {
    renderAgent(agentExecution({ input: { run_in_background: true }, details: { status: 'queued', agentId: 'a1' } }))
    expect(screen.getByText('task.status.queued')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'task.stop' })).toBeInTheDocument()
  })

  it('keeps a background agent running even though its result already exists', () => {
    renderAgent(
      agentExecution({
        input: { run_in_background: true },
        details: { status: 'running', agentId: 'agent-1' },
      }),
    )
    // details 里只有后台字段：没有统计、没有 outputFile
    expect(screen.getByRole('button', { name: 'task.stop' })).toBeInTheDocument()
    expect(screen.getByText('task.backgroundHint')).toBeInTheDocument()
    // 结果区不能出现：后台 agent 还没结束
    expect(screen.queryByText('task.result')).not.toBeInTheDocument()
  })

  it('reports how many child agent sessions are alive under the parent', () => {
    childAgentStore.receive(
      { phase: 'created', sessionId: 'child-1', parentSessionId: 'parent-session' },
      'parent-session',
    )
    childAgentStore.receive(
      { phase: 'created', sessionId: 'child-2', parentSessionId: 'parent-session' },
      'parent-session',
    )

    renderAgent(agentExecution({ input: { run_in_background: true }, details: { status: 'running', agentId: 'a1' } }))

    // i18n mock 把参数拼在 key 后面，所以匹配前缀
    expect(screen.getByText(/^task\.childSessionsRunning/)).toHaveTextContent('"count":2')
    childAgentStore.clearAll()
  })

  it('shows a live child session instead of the waiting placeholder', () => {
    childAgentStore.receive(
      { phase: 'bound', sessionId: 'child-session-xyz', parentSessionId: 'parent-session' },
      'parent-session',
    )

    renderAgent(agentExecution({ details: { status: 'running', sessionId: 'parent-session::child-session-xyz' } }))

    expect(screen.getByText(/^task\.childSessionLive/)).toBeInTheDocument()
    expect(screen.queryByText('task.waitingForResponse')).not.toBeInTheDocument()
    childAgentStore.clearAll()
  })

  it('stops a background agent through StopAgent with its agent id', async () => {
    renderAgent(
      agentExecution({
        input: { run_in_background: true },
        details: { status: 'running', agentId: 'agent-1' },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'task.stop' }))
    await waitFor(() => expect(stopPiAgentMock).toHaveBeenCalledWith('parent-session', 'agent-1'))
    expect(abortPiOperationMock).not.toHaveBeenCalled()
  })

  it('stops a foreground agent by aborting the turn', async () => {
    renderAgent(agentExecution({ details: { status: 'running' } }))
    fireEvent.click(screen.getByRole('button', { name: 'task.stop' }))
    await waitFor(() => expect(abortPiOperationMock).toHaveBeenCalledWith('parent-session'))
    expect(stopPiAgentMock).not.toHaveBeenCalled()
  })

  it('surfaces a failed stop instead of swallowing it', async () => {
    stopPiAgentMock.mockRejectedValueOnce(new Error('agent is gone'))
    renderAgent(
      agentExecution({
        input: { run_in_background: true },
        details: { status: 'running', agentId: 'agent-1' },
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'task.stop' }))
    expect(await screen.findByText(/task\.stopFailed/)).toBeInTheDocument()
    expect(screen.getByText(/agent is gone/)).toBeInTheDocument()
  })

  it('renders foreground stats', async () => {
    renderAgent(
      agentExecution({
        details: {
          status: 'completed',
          turnCount: 3,
          maxTurns: 10,
          toolUses: 7,
          durationMs: 1500,
          cost: 0.004,
          modelName: 'deepseek-v4.1-flash',
          thinkingLevel: 'high',
        },
      }),
    )
    expect(await screen.findByText('task.stats.turns 3/10')).toBeInTheDocument()
    expect(screen.getByText('task.stats.tools 7')).toBeInTheDocument()
    expect(screen.getByText('1.5s')).toBeInTheDocument()
    expect(screen.getByText('deepseek-v4.1-flash · high')).toBeInTheDocument()
  })

  it('renders a background agent without stats and without crashing', () => {
    renderAgent(
      agentExecution({
        input: { run_in_background: true },
        details: { status: 'running', agentId: 'agent-1' },
      }),
    )
    expect(screen.queryByText(/^task\.stats\./)).not.toBeInTheDocument()
    expect(screen.getByText('Inspect')).toBeInTheDocument()
  })

  it('shows the log path when the plugin reports outputFile', () => {
    renderAgent(
      agentExecution({
        details: { status: 'completed', outputFile: '/tmp/pi-agent-outputs/abc.log' },
      }),
    )
    expect(screen.getByText('/tmp/pi-agent-outputs/abc.log')).toBeInTheDocument()
  })

  it('renders the error card when details.status is error', () => {
    renderAgent(
      agentExecution({
        details: { status: 'error', stopReason: 'error' },
        text: 'Agent failed: boom',
      }),
    )
    expect(screen.getByText('task.error')).toBeInTheDocument()
    expect(screen.queryByText('task.result')).not.toBeInTheDocument()
  })

  it('renders the error card when only result.isError is set', () => {
    renderAgent(agentExecution({ details: {}, isError: true, text: 'boom' }))
    expect(screen.getByText('task.error')).toBeInTheDocument()
  })
})
