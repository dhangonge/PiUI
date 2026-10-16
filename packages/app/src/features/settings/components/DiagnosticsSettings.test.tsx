import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticsCard } from './DiagnosticsSettings'
import { clearClientErrors, recordClientError } from '../../../store/clientErrorLog'

describe('DiagnosticsCard', () => {
  beforeEach(() => {
    clearClientErrors()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  afterEach(() => {
    clearClientErrors()
    vi.restoreAllMocks()
  })

  it('shows the empty state when nothing was recorded', () => {
    render(<DiagnosticsCard />)
    expect(screen.getByText(/No errors recorded/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy all/i })).toBeNull()
  })

  it('lists recent errors, newest first, with repeat counts', () => {
    recordClientError({ category: 'api', operation: 'load skills', message: 'older failure' })
    recordClientError({ category: 'ui', operation: 'render', message: 'newer failure' })

    render(<DiagnosticsCard />)

    const messages = screen.getAllByText(/failure/).map(node => node.textContent)
    expect(messages).toEqual(['newer failure', 'older failure'])
    expect(screen.getByText(/2 error\(s\) recorded/i)).toBeInTheDocument()
  })

  it('copies the full report and clears the log', async () => {
    recordClientError({ category: 'api', operation: 'load skills', message: 'older failure' })
    render(<DiagnosticsCard />)

    fireEvent.click(screen.getByRole('button', { name: /copy all/i }))
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1))
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? ''
    expect(copied).toContain('older failure')
    expect(copied).toContain('client error(s)')

    fireEvent.click(screen.getByRole('button', { name: /clear/i }))
    await waitFor(() => expect(screen.getByText(/No errors recorded/i)).toBeInTheDocument())
  })
})
