import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getInternalDragSnapshot,
  startInternalDrag,
  subscribeInternalDrop,
  type InternalSessionPayload,
} from './internalDragCore'

afterEach(() => {
  window.dispatchEvent(new Event('blur'))
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  cleanup()
})

describe('internal session drag', () => {
  it.each([undefined, 'server-b'])('preserves the source server (%s) through the drop', serverId => {
    const payload: InternalSessionPayload = { kind: 'session', sessionId: 'same-id', serverId, directory: '/work' }
    const onDrop = vi.fn()
    const unsubscribe = subscribeInternalDrop(onDrop)
    const { getByRole } = render(<button onPointerDown={event => startInternalDrag(event, payload)}>Session</button>)
    try {
      fireEvent.pointerDown(getByRole('button'), {
        button: 0,
        pointerId: 1,
        isPrimary: true,
        pointerType: 'mouse',
        clientX: 10,
        clientY: 10,
      })
      fireEvent.pointerMove(document, { pointerId: 1, clientX: 30, clientY: 40 })
      expect(getInternalDragSnapshot().active?.payload).toEqual(payload)
      fireEvent.pointerUp(document, { pointerId: 1, clientX: 30, clientY: 40 })
      expect(onDrop).toHaveBeenCalledExactlyOnceWith({ payload, point: { x: 30, y: 40 } })
      expect(getInternalDragSnapshot().active).toBeNull()
    } finally {
      unsubscribe()
    }
  })
})
