import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { TodoWidget } from './TodoWidget'
import { extensionUiStore } from '../pi/extensionUiStore'

// Mirrors how the rpiv-todo widget renders: tree prefix, status glyph, ANSI colors,
// strikethrough on completed rows, and a trailing spacer line.
const widgetLines = [
  '\u001b[32m●\u001b[0m \u001b[32mTodos (1/3)\u001b[0m',
  '\u001b[2m├─\u001b[0m \u001b[32m✓\u001b[0m \u001b[2m#1\u001b[0m \u001b[9mRead config\u001b[0m',
  '\u001b[2m├─\u001b[0m \u001b[33m◐\u001b[0m \u001b[2m#2\u001b[0m \u001b[36mShip fix\u001b[0m \u001b[2m(shipping)\u001b[0m',
  '\u001b[2m└─\u001b[0m \u001b[2m○\u001b[0m Write notes',
  '',
]

beforeEach(() => extensionUiStore.reset())

it('renders only todo widget rows in the shared list presentation', () => {
  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'rpiv-todos', lines: widgetLines, placement: 'aboveEditor' })
  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'input-status', lines: ['Model: opus'], placement: 'aboveEditor' })
  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'context-progress', lines: ['Context 12%'], placement: 'belowEditor' })
  render(<TodoWidget sessionId="a::same" />)

  expect(screen.getByText('Tasks')).toBeTruthy()
  expect(screen.getByText('1/3')).toBeTruthy()
  expect(screen.getByText('Read config').className).toContain('line-through')
  expect(screen.getByText('Ship fix (shipping)')).toBeTruthy()
  expect(screen.getByText('Write notes')).toBeTruthy()
  // Non-todo widget mirrors must not reach the composer.
  expect(screen.queryByText(/Model: opus|Context 12%/)).toBeNull()
})

it('ignores other sessions, non-todo keys and empty widgets', () => {
  extensionUiStore.statePatched('b::same', { kind: 'widget', key: 'rpiv-todos', lines: widgetLines })
  const { rerender } = render(<TodoWidget sessionId="a::same" />)
  expect(screen.queryByText('Tasks')).toBeNull()

  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'rpiv-todos', lines: [] })
  rerender(<TodoWidget sessionId="a::same" />)
  expect(screen.queryByText('Tasks')).toBeNull()

  rerender(<TodoWidget sessionId={null} />)
  expect(screen.queryByText('Tasks')).toBeNull()
})

it('follows the owner session and clears when the extension removes the widget', () => {
  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'rpiv-todos', lines: widgetLines })
  extensionUiStore.statePatched('b::same', { kind: 'widget', key: 'rpiv-todos', lines: ['\u001b[2m└─\u001b[0m \u001b[2m○\u001b[0m Beta only'] })
  const { rerender } = render(<TodoWidget sessionId="a::same" />)
  expect(screen.getByText('Write notes')).toBeTruthy()
  rerender(<TodoWidget sessionId="b::same" />)
  expect(screen.queryByText('Write notes')).toBeNull()
  expect(screen.getByText('Beta only')).toBeTruthy()
  act(() => extensionUiStore.statePatched('b::same', { kind: 'widget', key: 'rpiv-todos' }))
  expect(screen.queryByText('Beta only')).toBeNull()
})
