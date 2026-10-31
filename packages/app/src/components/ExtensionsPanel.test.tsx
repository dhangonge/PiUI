import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ExtensionsPanel } from './ExtensionsPanel'
import { extensionUiStore } from '../pi/extensionUiStore'
import { stripAnsi } from '../utils/ansiUtils'

vi.mock('./ExtensionTuiView', () => ({ ExtensionTuiView: () => null }))
vi.mock('../features/chat/ExtensionUiDialogCard', () => ({ ExtensionUiDialogCard: () => null }))

describe('extension status presentation', () => {
  beforeEach(() => extensionUiStore.reset())

  it('renders themed status and widgets without control sequences or HTML execution', () => {
    extensionUiStore.statePatched('a::same', {
      kind: 'status',
      key: 'mcp',
      text: '\u001b[38;2;10;20;30mConnected\u001b[0m',
    })
    extensionUiStore.statePatched('a::same', {
      kind: 'widget',
      key: 'todo',
      lines: ['\u001b[1mTask\u001b[22m', '<script>literal</script>'],
    })
    const { container } = render(<ExtensionsPanel sessionId="a::same" />)
    expect(screen.getByText(/Connected/)).toBeTruthy()
    expect(container.textContent).toContain('Task')
    expect(container.textContent).not.toContain('\u001b')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>literal</script>')
  })

  it('keeps compatibility diagnostics in the owning server and session', () => {
    extensionUiStore.statePatched('a::same', { kind: 'status', key: 'piui-host:theme-fallback', text: 'A fallback' })
    extensionUiStore.statePatched('b::same', { kind: 'status', key: 'piui-host:theme-fallback', text: 'B fallback' })
    const { rerender } = render(<ExtensionsPanel sessionId="a::same" />)
    expect(screen.getByText(/A fallback/)).toBeTruthy()
    expect(screen.queryByText(/B fallback/)).toBeNull()
    rerender(<ExtensionsPanel sessionId="b::same" />)
    expect(screen.getByText(/B fallback/)).toBeTruthy()
    expect(screen.queryByText(/A fallback/)).toBeNull()
  })

  it('strips OSC commands, cursor controls and C0 bytes while preserving text layout', () => {
    expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u001b\\\u001b[2J\u0000\n\ttext')).toBe(
      'link\n\ttext',
    )
  })
})
