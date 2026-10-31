import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePiQueueControl, type PiQueueSnapshot } from './usePiQueueControl'

const { clearPiQueueMock, sendPiUserMessageMock, setDraftMock, trace } = vi.hoisted(() => ({
  clearPiQueueMock: vi.fn(),
  sendPiUserMessageMock: vi.fn(),
  setDraftMock: vi.fn(),
  trace: [] as string[],
}))

vi.mock('../../../pi/controllers/index.js', () => ({
  clearPiQueue: (...args: unknown[]) => {
    trace.push(`clear:${String(args[0])}`)
    return clearPiQueueMock(...args)
  },
  sendPiUserMessage: (...args: unknown[]) => {
    trace.push(`send:${String(args[1])}:${String(args[3] ?? 'prompt')}`)
    return sendPiUserMessageMock(...args)
  },
}))

vi.mock('../../../pi/sessionEditorDraftStore', () => ({
  setSessionEditorDraft: (...args: unknown[]) => {
    trace.push(`draft:${String(args[0])}:${String(args[1])}`)
    setDraftMock(...args)
  },
}))

function renderQueueControl(sessionId: string | null, queue: PiQueueSnapshot | undefined) {
  return renderHook(
    ({ sid, q }: { sid: string | null; q: PiQueueSnapshot | undefined }) =>
      usePiQueueControl({ sessionId: sid, queue: q }),
    { initialProps: { sid: sessionId, q: queue } },
  )
}

describe('usePiQueueControl', () => {
  beforeEach(() => {
    trace.length = 0
    clearPiQueueMock.mockReset()
    sendPiUserMessageMock.mockReset()
    setDraftMock.mockReset()
    sendPiUserMessageMock.mockResolvedValue(undefined)
  })

  describe('handleQueueBackToInput', () => {
    it('clears first, then backfills the draft and replays the rest in original order', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1', 's2'], followUp: ['f1'] })
      const { result } = renderQueueControl('session-1', { steering: ['s1', 's2'], followUp: ['f1'] })

      await act(async () => {
        await result.current.handleQueueBackToInput('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1', 'draft:session-1:s1', 'send:s2:steer', 'send:f1:followUp'])
      expect(clearPiQueueMock).toHaveBeenCalledWith('session-1')
      // 回填的是被撤销的那条，且不再重放
      expect(sendPiUserMessageMock.mock.calls.map(call => call[1])).toEqual(['s2', 'f1'])
    })

    it('splices the followUp entry at its own index', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1'], followUp: ['f1', 'f2'] })
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: ['f1', 'f2'] })

      await act(async () => {
        await result.current.handleQueueBackToInput('followUp', 1)
      })

      expect(trace).toEqual(['clear:session-1', 'draft:session-1:f2', 'send:s1:steer', 'send:f1:followUp'])
    })

    it('stops without side effects when clearPiQueue fails', async () => {
      clearPiQueueMock.mockRejectedValue(new Error('boom'))
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueBackToInput('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1'])
      expect(setDraftMock).not.toHaveBeenCalled()
      expect(sendPiUserMessageMock).not.toHaveBeenCalled()
    })

    it('does nothing when the queue has no entry at that index', async () => {
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueBackToInput('steering', 3)
      })

      expect(trace).toEqual([])
    })

    it('does nothing without a session', async () => {
      const { result } = renderQueueControl(null, { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueBackToInput('steering', 0)
      })

      expect(trace).toEqual([])
    })

    it('swallows replay failures', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1', 's2'], followUp: [] })
      sendPiUserMessageMock.mockRejectedValue(new Error('replay failed'))
      const { result } = renderQueueControl('session-1', { steering: ['s1', 's2'], followUp: [] })

      await act(async () => {
        await expect(result.current.handleQueueBackToInput('steering', 0)).resolves.toBeUndefined()
      })

      expect(trace).toContain('send:s2:steer')
    })
  })

  describe('handleQueueMoveMode', () => {
    it('replays the moved entry with the flipped delivery before the rest', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1', 's2'], followUp: ['f1'] })
      const { result } = renderQueueControl('session-1', { steering: ['s1', 's2'], followUp: ['f1'] })

      await act(async () => {
        await result.current.handleQueueMoveMode('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1', 'send:s1:followUp', 'send:s2:steer', 'send:f1:followUp'])
      expect(setDraftMock).not.toHaveBeenCalled()
    })

    it('flips followUp to steer and excludes the moved text from both lists', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['dup'], followUp: ['dup'] })
      const { result } = renderQueueControl('session-1', { steering: ['dup'], followUp: ['dup'] })

      await act(async () => {
        await result.current.handleQueueMoveMode('followUp', 0)
      })

      // 排除按文本比较（沿用既有语义）：同文本条目不会被重复入队
      expect(trace).toEqual(['clear:session-1', 'send:dup:steer'])
    })

    it('stops without side effects when clearPiQueue fails', async () => {
      clearPiQueueMock.mockRejectedValue(new Error('boom'))
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueMoveMode('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1'])
    })

    it('does nothing without a session', async () => {
      const { result } = renderQueueControl(null, { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueMoveMode('steering', 0)
      })

      expect(trace).toEqual([])
    })
  })

  describe('handleQueueClear', () => {
    it('replays the remaining entries without touching the draft', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1', 's2'], followUp: ['f1'] })
      const { result } = renderQueueControl('session-1', { steering: ['s1', 's2'], followUp: ['f1'] })

      await act(async () => {
        await result.current.handleQueueClear('steering', 1)
      })

      expect(trace).toEqual(['clear:session-1', 'send:s1:steer', 'send:f1:followUp'])
      expect(setDraftMock).not.toHaveBeenCalled()
    })

    it('splices followUp entries at their own index', async () => {
      clearPiQueueMock.mockResolvedValue({ steering: ['s1'], followUp: ['f1', 'f2'] })
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: ['f1', 'f2'] })

      await act(async () => {
        await result.current.handleQueueClear('followUp', 0)
      })

      expect(trace).toEqual(['clear:session-1', 'send:s1:steer', 'send:f2:followUp'])
    })

    it('stops without side effects when clearPiQueue fails', async () => {
      clearPiQueueMock.mockRejectedValue(new Error('boom'))
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueClear('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1'])
      expect(sendPiUserMessageMock).not.toHaveBeenCalled()
    })

    it('clears an empty queue snapshot without replaying', async () => {
      clearPiQueueMock.mockResolvedValue({})
      const { result } = renderQueueControl('session-1', { steering: ['s1'], followUp: [] })

      await act(async () => {
        await result.current.handleQueueClear('steering', 0)
      })

      expect(trace).toEqual(['clear:session-1'])
    })
  })
})
