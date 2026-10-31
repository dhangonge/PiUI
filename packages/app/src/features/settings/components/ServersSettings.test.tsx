import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServersSettings } from './ServersSettings'
import { multiServerStore } from '../../../store/multiServerStore'

const { useServerStoreMock, navigateHomeMock, clearSessionMock } = vi.hoisted(() => ({
  useServerStoreMock: vi.fn(),
  navigateHomeMock: vi.fn(),
  clearSessionMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      typeof values?.latency === 'number' ? `${key} ${values.latency}` : key,
  }),
}))

vi.mock('../../../hooks', () => ({
  useServerStore: useServerStoreMock,
  useRouter: () => ({ setDirectory: navigateHomeMock, sessionId: 'session-1' }),
}))

vi.mock('../../../utils/sessionLifecycle', () => ({
  clearSessionRuntimeState: clearSessionMock,
}))

const localServer = { id: 'local', name: 'Local', url: 'http://127.0.0.1:4096', isDefault: true }
const remoteServer = { id: 'remote', name: 'Remote', url: 'http://remote.test' }

describe('ServersSettings', () => {
  const checkHealthMock = vi.fn()
  const setActiveServerMock = vi.fn()
  const setDefaultServerMock = vi.fn()

  beforeEach(() => {
    multiServerStore.setEnabled(false)
    multiServerStore.setSubscribedServerIds([])
    checkHealthMock.mockReset()
    setActiveServerMock.mockReset()
    setDefaultServerMock.mockReset()
    navigateHomeMock.mockReset()
    clearSessionMock.mockReset()
    useServerStoreMock.mockReturnValue({
      servers: [localServer, remoteServer],
      activeServer: localServer,
      defaultServerId: null,
      setDefaultServer: setDefaultServerMock,
      addServer: vi.fn(),
      removeServer: vi.fn(),
      updateServer: vi.fn(),
      setActiveServer: setActiveServerMock,
      checkHealth: checkHealthMock,
      checkAllHealth: vi.fn(),
      getHealth: vi.fn(() => null),
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    multiServerStore.setEnabled(false)
    multiServerStore.setSubscribedServerIds([])
  })

  it('uses the shared settings switch and preserves subscriptions when toggled', () => {
    render(<ServersSettings />)

    const toggle = screen.getByRole('switch', { name: 'servers.multiServerMode' })
    expect(toggle.closest('[data-setting-label]')).toHaveAttribute('data-setting-label', 'servers.multiServerMode')
    expect(toggle).toHaveStyle({ width: '36px', height: '20px' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(multiServerStore.isEnabled()).toBe(true)
    expect(multiServerStore.getSubscribedServerIds()).toEqual(['local'])

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(multiServerStore.isEnabled()).toBe(false)
    expect(multiServerStore.getSubscribedServerIds()).toEqual(['local'])
    expect(setActiveServerMock).not.toHaveBeenCalled()
    expect(navigateHomeMock).not.toHaveBeenCalled()
  })

  it('toggles once per click on the row text or switch', () => {
    const setEnabled = vi.spyOn(multiServerStore, 'setEnabled')
    render(<ServersSettings />)

    fireEvent.click(screen.getByText('servers.multiServerMode'))
    fireEvent.click(screen.getByText('servers.multiServerModeDesc'))
    fireEvent.click(screen.getByRole('switch', { name: 'servers.multiServerMode' }))

    expect(setEnabled.mock.calls).toEqual([[true], [false], [true]])
    expect(screen.getByRole('switch', { name: 'servers.multiServerMode' })).toHaveAttribute('aria-checked', 'true')
    expect(setActiveServerMock).not.toHaveBeenCalled()
  })

  it('sets the startup preference without changing the active connection', () => {
    render(<ServersSettings />)
    fireEvent.click(screen.getAllByRole('button', { name: 'servers.setDefaultServer' })[1])
    expect(setDefaultServerMock).toHaveBeenCalledWith('remote')
    expect(setActiveServerMock).not.toHaveBeenCalled()
  })

  it('switches servers even when health verification fails', async () => {
    checkHealthMock.mockResolvedValueOnce({ status: 'error', error: 'Not an PiUI server' })

    render(<ServersSettings />)

    fireEvent.click(screen.getByRole('button', { name: /Remote/ }))

    await waitFor(() => {
      expect(checkHealthMock).toHaveBeenCalledWith('remote')
    })
    expect(setActiveServerMock).toHaveBeenCalledWith('remote')
    expect(navigateHomeMock).toHaveBeenCalled()
    expect(navigateHomeMock).toHaveBeenCalledWith(undefined)
    expect(clearSessionMock).not.toHaveBeenCalled()
  })
})
