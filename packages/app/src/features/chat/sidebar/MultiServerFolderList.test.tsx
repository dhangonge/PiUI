import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MultiServerFolderList } from './MultiServerFolderList'
import { serverStore, LOCAL_SERVER_ID } from '../../../store/serverStore'
import { multiServerStore } from '../../../store/multiServerStore'
import { addServerWorkspace, readServerWorkspaces } from '../../../utils/serverWorkspaces'
import type { UiSession } from '../../../types/session'

const fixtures = vi.hoisted(() => ({ sessions: new Map<string, UiSession[]>(), setDirectory: vi.fn() }))
vi.mock('../../../hooks/useSessions', () => ({
  useSessions: ({ serverId }: { serverId: string }) => ({
    sessions: fixtures.sessions.get(serverId) ?? [],
    isLoading: false,
    refresh: vi.fn(),
    remove: vi.fn(),
    patchLocalSession: vi.fn(),
    hasMore: false,
  }),
}))
vi.mock('../../../hooks/useRouter', () => ({
  useRouter: () => ({ setDirectory: fixtures.setDirectory, directory: '/same' }),
}))
vi.mock('../../../hooks/useInputCapabilities', () => ({ useInputCapabilities: () => ({ preferTouchUi: true }) }))
vi.mock('../../sessions/SessionList', () => ({
  SessionListItem: ({
    session,
    isSelected,
    onSelect,
  }: {
    session: UiSession
    isSelected: boolean
    onSelect: () => void
  }) => (
    <button aria-pressed={isSelected} onClick={onSelect}>
      {session.title}
    </button>
  ),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

describe('multi-server folder sidebar', () => {
  let a: string, b: string
  const props = {
    selectedSessionId: null as string | null,
    search: '',
    onSelectSession: vi.fn(),
    onAddProject: vi.fn(),
    onNewSession: vi.fn(),
  }
  beforeEach(() => {
    a = serverStore.addServer({ name: 'Alpha', url: 'https://alpha.example.test' }).id
    b = serverStore.addServer({ name: 'Beta', url: 'https://beta.example.test' }).id
    serverStore.setActiveServer(a)
    multiServerStore.setSubscribedServerIds([a, b])
    multiServerStore.setEnabled(true)
    fixtures.sessions.set(a, [{ id: `${a}::same`, directory: '/same', title: 'One', createdAt: 1, updatedAt: 1 }])
    fixtures.sessions.set(b, [{ id: `${b}::same`, directory: '/same', title: 'Two', createdAt: 1, updatedAt: 1 }])
    addServerWorkspace(a, '/same')
    addServerWorkspace(b, '/same')
    addServerWorkspace(b, '/saved-empty')
  })
  afterEach(() => {
    cleanup()
    multiServerStore.setEnabled(false)
    multiServerStore.setSubscribedServerIds([])
    serverStore.setActiveServer(LOCAL_SERVER_ID)
    serverStore.removeServer(a)
    serverStore.removeServer(b)
    fixtures.sessions.clear()
    vi.clearAllMocks()
  })

  it('matches server names, empty saved folders and session titles', () => {
    const { rerender } = render(<MultiServerFolderList {...props} search="beta" />)
    expect(screen.getByText('Two')).toBeInTheDocument()
    expect(screen.queryByText('One')).toBeNull()
    rerender(<MultiServerFolderList {...props} search="saved-empty" />)
    expect(screen.getByText('saved-empty')).toBeInTheDocument()
    expect(screen.queryByText('Two')).toBeNull()
    rerender(<MultiServerFolderList {...props} search="one" />)
    expect(screen.getByText('One')).toBeInTheDocument()
    expect(screen.queryByText('Two')).toBeNull()
  })

  it('uses exact qualified selection and reacts to unsubscribing a server', () => {
    render(<MultiServerFolderList {...props} selectedSessionId={`${b}::same`} />)
    expect(screen.getByRole('button', { name: 'One' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'Two' })).toHaveAttribute('aria-pressed', 'true')
    act(() => multiServerStore.setSubscribed(b, false))
    expect(screen.queryByText('Two')).toBeNull()
    expect(screen.getByText('One')).toBeInTheDocument()
  })

  it('switches owner for identical folders and reorders only that server', () => {
    render(<MultiServerFolderList {...props} />)
    const beta = within(screen.getByRole('region', { name: 'Beta' }))
    fireEvent.click(beta.getByText('same'))
    expect(serverStore.getActiveServerId()).toBe(b)
    expect(fixtures.setDirectory).toHaveBeenCalledWith('/same')
    fireEvent.click(beta.getByRole('button', { name: 'sidebar.moveFolderUp /saved-empty' }))
    expect(readServerWorkspaces(b)).toEqual(['/saved-empty', '/same'])
    expect(readServerWorkspaces(a)).toEqual(['/same'])
  })
})
