import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UiSession } from '../../../types/session'
import { SessionRowWithChildren } from './SessionRowWithChildren'
import { sessionChildrenExpansionStore } from '../../../store/sessionChildrenExpansionStore'

const { markSessionNotificationsReadMock } = vi.hoisted(() => ({
  markSessionNotificationsReadMock: vi.fn(),
}))

vi.mock('../../../store/activeSessionStore', () => ({
  useSessionActiveEntry: () => null,
}))

vi.mock('../../../store/notificationStore', () => ({
  notificationStore: { markSessionNotificationsRead: markSessionNotificationsReadMock },
  useHasUnreadCompletedNotification: () => false,
}))

vi.mock('../../../hooks/useInputCapabilities', () => ({
  useInputCapabilities: () => ({ preferTouchUi: false }),
}))

vi.mock('../../../components/ui/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}))

vi.mock('../../sessions', async () => ({
  ...(await vi.importActual<typeof import('../../sessions')>('../../sessions')),
}))

const parentSession: UiSession = {
  id: 'parent-1',
  title: 'Parent chat',
  directory: '/workspace/demo',
  createdAt: 1,
  updatedAt: 1,
  isNamed: true,
}

const childSession: UiSession = {
  id: 'child-1',
  title: 'Explore#deadbeef',
  directory: '/workspace/demo',
  createdAt: 2,
  updatedAt: 2,
  isNamed: true,
  parentSessionPath: '/workspace/demo/parent.jsonl',
  forkParentId: 'parent-1',
}

describe('SessionRowWithChildren', () => {
  beforeEach(() => {
    sessionChildrenExpansionStore.clear()
  })

  it('keeps subagents hidden until the parent row is expanded', () => {
    render(
      <SessionRowWithChildren
        session={parentSession}
        isSelected={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        preferTouchUi={false}
        density="minimal"
        childrenByParentId={new Map([['parent-1', [childSession]]])}
        selectedSessionId={null}
        onSelectChildSession={vi.fn()}
      />,
    )

    expect(screen.getByText('Parent chat')).toBeInTheDocument()
    expect(screen.queryByText('Explore#deadbeef')).not.toBeInTheDocument()
    expect(screen.getByTitle('1 subagents')).toBeInTheDocument()
  })

  it('shows the child row after toggling and hides it again', () => {
    const onSelectChildSession = vi.fn()
    render(
      <SessionRowWithChildren
        session={parentSession}
        isSelected={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        preferTouchUi={false}
        density="minimal"
        childrenByParentId={new Map([['parent-1', [childSession]]])}
        selectedSessionId={null}
        onSelectChildSession={onSelectChildSession}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show subagents' }))
    expect(screen.getByText('Explore#deadbeef')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Hide subagents' }))
    expect(screen.queryByText('Explore#deadbeef')).not.toBeInTheDocument()
  })

  it('renders no toggle for sessions without subagents', () => {
    render(
      <SessionRowWithChildren
        session={parentSession}
        isSelected={false}
        onSelect={vi.fn()}
        onDelete={vi.fn()}
        onRename={vi.fn()}
        preferTouchUi={false}
        density="minimal"
        childrenByParentId={new Map()}
        selectedSessionId={null}
        onSelectChildSession={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Show subagents' })).not.toBeInTheDocument()
  })
})
