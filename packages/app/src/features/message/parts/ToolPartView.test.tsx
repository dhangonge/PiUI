import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolPartView } from './ToolPartView'
import type { PiToolExecution } from '../../../pi/domain/index.js'

let processCollapseEnabled = false

const { getActiveCalibratedNowMock } = vi.hoisted(() => ({
  getActiveCalibratedNowMock: vi.fn<() => number | undefined>(() => undefined),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'toolPart.running') return 'Running'
      if (key === 'toolPart.failed') return 'Failed'
      return key
    },
  }),
}))

vi.mock('../../../hooks', () => ({
  useDelayedRender: (show: boolean) => show,
  useDisclosureScrollLock: () => ({
    rootRef: () => undefined,
    headerRef: () => undefined,
    withScrollLock: (action: () => void) => action(),
  }),
  useCompositorExpand: (open: boolean) => ({
    contentRef: { current: null },
    layoutOpen: open,
    keepMounted: open,
    panelClassName: 'transition-[grid-template-rows] duration-300 ease-in-out',
  }),
}))

vi.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({
    immersiveMode: false,
    processCollapseEnabled,
  }),
}))

vi.mock('../../../store/serverStore', () => ({
  serverStore: {
    getActiveCalibratedNow: getActiveCalibratedNowMock,
  },
}))

vi.mock('../tools', () => ({
  getToolIcon: () => <span data-testid="tool-icon">icon</span>,
  extractToolData: () => ({}),
  getToolConfig: () => undefined,
  DefaultRenderer: () => <div>Tool output</div>,
  TodoRenderer: () => null,
  TaskRenderer: () => null,
  hasTodos: () => false,
}))

function createRunningExecution(): PiToolExecution {
  return {
    call: {
      type: 'toolCall',
      id: 'call-1',
      name: 'bash',
      arguments: { command: 'npm run build' },
    },
  }
}

describe('ToolPartView running duration', () => {
  beforeEach(() => {
    processCollapseEnabled = false
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    getActiveCalibratedNowMock.mockReset()
    getActiveCalibratedNowMock.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not auto-expand active tools in process-collapse mode', () => {
    processCollapseEnabled = true
    render(<ToolPartView execution={createRunningExecution()} partKey="collapsed-active" />)
    expect(screen.queryByText('Tool output')).toBeNull()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.queryByText('Tool output')).toBeNull()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('Tool output')).toBeTruthy()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText('Tool output')).toBeTruthy()
  })

  it('still opens explicitly user-started commands', () => {
    processCollapseEnabled = true
    render(<ToolPartView execution={createRunningExecution()} partKey="user-command" defaultExpanded />)
    expect(screen.getByText('Tool output')).toBeTruthy()
  })

  it('falls back to local wall clock when calibration is unavailable', () => {
    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" startedAt={7_500} />)

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('2.5s')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByText('3.0s')).toBeInTheDocument()
  })

  it('uses calibrated server time for running tools when available', () => {
    getActiveCalibratedNowMock.mockReturnValue(11_000)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" startedAt={7_500} />)

    expect(screen.getByText('3.5s')).toBeInTheDocument()
  })

  it('clamps running duration to zero when calibrated time is earlier than start', () => {
    getActiveCalibratedNowMock.mockReturnValue(7_000)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" startedAt={7_500} />)

    expect(screen.getByText('0ms')).toBeInTheDocument()
  })

  it('rounds calibrated sub-second durations before rendering', () => {
    getActiveCalibratedNowMock.mockReturnValue(7_623.456)

    render(<ToolPartView execution={createRunningExecution()} partKey="tool-1" startedAt={7_500} />)

    expect(screen.getByText('123ms')).toBeInTheDocument()
  })

  it('uses shared item spacing on compact and descriptive roots', () => {
    const execution = createRunningExecution()
    const { container, rerender } = render(<ToolPartView execution={execution} partKey="tool-1" compact />)
    expect(container.firstElementChild?.className).toContain('pt-1')

    rerender(<ToolPartView execution={execution} partKey="tool-1" descriptive />)
    expect(container.firstElementChild?.className).toContain('pt-1')
  })
})
