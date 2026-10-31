import { useCallback } from 'react'
import { clearPiQueue, sendPiUserMessage } from '../../../pi/controllers/index.js'
import { setSessionEditorDraft } from '../../../pi/sessionEditorDraftStore'

export type PiQueueKind = 'steering' | 'followUp'

/** Runtime-state queue shape (`state.queue`), both lists optional. */
export interface PiQueueSnapshot {
  steering?: string[]
  followUp?: string[]
}

interface ClearPiQueueSnapshot {
  steering?: string[]
  followUp?: string[]
}

export interface PiQueueControl {
  /** 撤销回输入框：清空队列 → 回填草稿 → 其余条目按原模式重放 */
  handleQueueBackToInput: (kind: PiQueueKind, index: number) => Promise<void>
  /** 切换 steer↔followUp：清空队列 → 该条以目标模式重放 → 其余按原模式重放 */
  handleQueueMoveMode: (kind: PiQueueKind, index: number) => Promise<void>
  /** 直接清除一条（不回输入框，也不切换模式） */
  handleQueueClear: (kind: PiQueueKind, index: number) => Promise<void>
}

/**
 * 队列条目没有单条移除的 SDK 命令：统一用 `clearPiQueue`（返回清空前的
 * 快照）后按目标集合重放其余条目实现。所有路径都保持「先 clear，再按
 * steering → followUp 原顺序重放」，被操作的那条由调用方决定是否保留。
 */
function replayQueue(sessionId: string, steering: readonly string[], followUp: readonly string[]) {
  for (const text of steering) {
    void sendPiUserMessage(sessionId, text, undefined, 'steer').catch(() => undefined)
  }
  for (const text of followUp) {
    void sendPiUserMessage(sessionId, text, undefined, 'followUp').catch(() => undefined)
  }
}

async function clearQueueSnapshot(sessionId: string): Promise<ClearPiQueueSnapshot | null> {
  return (await clearPiQueue(sessionId).catch(() => null)) as ClearPiQueueSnapshot | null
}

/**
 * 队列条目操作（编辑回填 / 模式切换 / 删除）。从 PiChatPane 抽出，
 * 命令副作用顺序与原实现一致：clearQueue 成功后才回填或重放，失败静默。
 */
export function usePiQueueControl({
  sessionId,
  queue,
}: {
  sessionId: string | null
  queue: PiQueueSnapshot | undefined
}): PiQueueControl {
  const handleQueueBackToInput = useCallback(
    async (kind: PiQueueKind, index: number) => {
      if (!sessionId) return
      const source = (kind === 'steering' ? queue?.steering : queue?.followUp) ?? []
      const text = source[index]
      if (!text) return
      const cleared = await clearQueueSnapshot(sessionId)
      if (!cleared) return
      // 回填输入框
      setSessionEditorDraft(sessionId, text)
      // 其余按原模式重放（保持顺序），被撤销的那条不再入队
      const restSteering = [...(cleared.steering ?? [])]
      if (kind === 'steering') restSteering.splice(index, 1)
      const restFollowUp = [...(cleared.followUp ?? [])]
      if (kind === 'followUp') restFollowUp.splice(index, 1)
      replayQueue(sessionId, restSteering, restFollowUp)
    },
    [sessionId, queue],
  )

  const handleQueueMoveMode = useCallback(
    async (kind: PiQueueKind, index: number) => {
      if (!sessionId) return
      const source = (kind === 'steering' ? queue?.steering : queue?.followUp) ?? []
      const text = source[index]
      if (!text) return
      const cleared = await clearQueueSnapshot(sessionId)
      if (!cleared) return
      // 该条以目标模式重放；其余保持原模式（排除该条）
      void sendPiUserMessage(sessionId, text, undefined, kind === 'steering' ? 'followUp' : 'steer').catch(
        () => undefined,
      )
      const restSteering = [...(cleared.steering ?? [])].filter(t => t !== text)
      const restFollowUp = [...(cleared.followUp ?? [])].filter(t => t !== text)
      replayQueue(sessionId, restSteering, restFollowUp)
    },
    [sessionId, queue],
  )

  const handleQueueClear = useCallback(
    async (kind: PiQueueKind, index: number) => {
      if (!sessionId) return
      const cleared = await clearQueueSnapshot(sessionId)
      if (!cleared) return
      const restSteering = [...(cleared.steering ?? [])]
      if (kind === 'steering') restSteering.splice(index, 1)
      const restFollowUp = [...(cleared.followUp ?? [])]
      if (kind === 'followUp') restFollowUp.splice(index, 1)
      replayQueue(sessionId, restSteering, restFollowUp)
    },
    [sessionId],
  )

  return { handleQueueBackToInput, handleQueueMoveMode, handleQueueClear }
}
