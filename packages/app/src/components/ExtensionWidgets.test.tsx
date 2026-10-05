import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { ExtensionWidgets } from './ExtensionWidgets'
import { extensionUiStore } from '../pi/extensionUiStore'

beforeEach(() => extensionUiStore.reset())

it('shows restored widgets inline, scopes their owner, and keeps manual collapse on updates', () => {
  extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'todo', lines: ['\u001b[32mA task\u001b[0m'] })
  extensionUiStore.statePatched('b::same', { kind: 'widget', key: 'todo', lines: ['B task'] })
  const { rerender } = render(<ExtensionWidgets sessionId="a::same" placement="aboveEditor" />)
  expect(screen.getByText('A task')).toBeTruthy()
  expect(screen.queryByText('B task')).toBeNull()
  fireEvent.click(screen.getByRole('button'))
  act(() => extensionUiStore.statePatched('a::same', { kind: 'widget', key: 'todo', lines: ['Updated task'] }))
  expect(screen.queryByText('Updated task')).toBeNull()
  fireEvent.click(screen.getByRole('button'))
  expect(screen.getByText('Updated task')).toBeTruthy()
  rerender(<ExtensionWidgets sessionId="b::same" placement="aboveEditor" />)
  expect(screen.getByText('B task')).toBeTruthy()
  expect(screen.queryByText('Updated task')).toBeNull()
})

it('respects placement and removes widgets when the extension clears them', () => {
  extensionUiStore.statePatched('a', { kind: 'widget', key: 'progress', lines: ['Progress'], placement: 'belowEditor' })
  const { rerender } = render(<ExtensionWidgets sessionId="a" placement="aboveEditor" />)
  expect(screen.queryByText('Progress')).toBeNull()
  rerender(<ExtensionWidgets sessionId="a" placement="belowEditor" />)
  expect(screen.getByText('Progress')).toBeTruthy()
  act(() => extensionUiStore.statePatched('a', { kind: 'widget', key: 'progress' }))
  expect(screen.queryByRole('button')).toBeNull()
})
