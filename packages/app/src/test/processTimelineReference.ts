/**
 * 冻结的旧行为参考实现（H 独立验证用）。
 *
 * 来源：`940844c5a2d50fc516f218b1bf43ac92259c84bf`
 *      `packages/app/src/features/chat/processTimeline.ts`（318 行，逐字拷贝行为）
 *
 * 规则：
 * - 只拷贝算 expected 所必需的私有 helpers（itemRenderKey / assistantHasLiveWork /
 *   resolveTurnDurationMs）与两个导出函数，不 import 生产模块，避免「用新实现验证新实现」。
 * - 类型从 pi 域类型只读导入：类型是冻结的共享契约，行为才是本文件冻结的对象。
 * - 生产实现变动后不要同步本文件；差分失败说明行为变了，由测试暴露而不是抹平。
 * - 本文件只在测试内使用（vitest coverage 已排除 src/test/**）。
 *
 * 与旧文件的唯一差异是函数名加 `reference` 前缀，便于差分断言时区分。
 */
import type { PiAssistantMessageItem, PiTimelineItem } from '../pi/domain/index.js'

export const REFERENCE_SOURCE_COMMIT = '940844c5a2d50fc516f218b1bf43ac92259c84bf'

/** 旧实现的过程折叠行（拷贝自 940844c5 的 ProcessTimelineItem）。 */
export type ReferenceProcessTimelineItem =
  | {
      kind: 'message'
      key: string
      item: PiTimelineItem
      processContentScope?: 'process' | 'final' | 'inline'
    }
  | {
      kind: 'process-shell'
      key: string
      userMessageId: string | null
      startedAt?: number
      durationMs?: number
      isActive: boolean
      children: Array<{
        item: PiTimelineItem
        processContentScope: 'process' | 'inline'
      }>
      finalItem?: PiTimelineItem
    }

function itemRenderKey(item: PiTimelineItem): string {
  return item.renderKey ?? item.entryId
}

export function referenceSameProcessTimelineItem(
  a: ReferenceProcessTimelineItem,
  b: ReferenceProcessTimelineItem,
): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.key !== b.key) return false

  if (a.kind === 'message' && b.kind === 'message') {
    return a.item === b.item && a.processContentScope === b.processContentScope
  }

  if (a.kind === 'process-shell' && b.kind === 'process-shell') {
    if (
      a.userMessageId !== b.userMessageId ||
      a.startedAt !== b.startedAt ||
      a.durationMs !== b.durationMs ||
      a.isActive !== b.isActive ||
      a.finalItem !== b.finalItem ||
      a.children.length !== b.children.length
    ) {
      return false
    }
    for (let i = 0; i < a.children.length; i++) {
      const left = a.children[i]
      const right = b.children[i]
      if (left.item !== right.item || left.processContentScope !== right.processContentScope) {
        return false
      }
    }
    return true
  }

  return false
}

export function referenceReuseProcessTimelineItems(
  previous: ReferenceProcessTimelineItem[] | undefined,
  next: ReferenceProcessTimelineItem[],
): ReferenceProcessTimelineItem[] {
  if (!previous || previous.length === 0) return next
  if (previous === next) return previous

  const prevByKey = new Map(previous.map(item => [item.key, item]))
  let allSame = previous.length === next.length
  const result = new Array<ReferenceProcessTimelineItem>(next.length)

  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    const prev = prevByKey.get(item.key)
    if (prev && referenceSameProcessTimelineItem(prev, item)) {
      result[i] = prev
      if (previous[i] !== prev) allSame = false
    } else {
      result[i] = item
      allSame = false
    }
  }

  return allSame ? previous : result
}

function assistantHasLiveWork(item: PiTimelineItem): boolean {
  if (item.kind !== 'assistant_message') return false
  return Boolean(item.isStreaming)
}

function resolveTurnDurationMs(
  assistants: PiAssistantMessageItem[],
  userStart: number | undefined,
  turnDurationMap: Map<string, number>,
): number | undefined {
  if (userStart == null) return undefined
  for (const m of [...assistants].reverse()) {
    const mapped = turnDurationMap.get(m.entryId)
    if (mapped != null && mapped > 0) return mapped
  }
  let latestEnd: number | undefined
  for (const m of assistants) {
    const completed = m.isStreaming ? null : m.message.timestamp || null
    if (completed != null && (latestEnd == null || completed > latestEnd)) latestEnd = completed
    for (const p of m.blocks) {
      if (p.type !== 'toolCall') continue
      const toolEnd = m.toolResults[p.id]?.timestamp
      if (toolEnd != null && (latestEnd == null || toolEnd > latestEnd)) latestEnd = toolEnd
    }
  }
  if (latestEnd != null && latestEnd > userStart) return latestEnd - userStart
  return undefined
}

/** 冻结的 buildProcessTimeline（940844c5），签名与旧实现一致。 */
export function referenceBuildProcessTimeline(
  visibleItems: PiTimelineItem[],
  options: {
    turnDurationMap: Map<string, number>
    sessionIsStreaming: boolean
    messageHasProcess: (item: PiAssistantMessageItem) => boolean
    messageHasFinal: (item: PiAssistantMessageItem) => boolean
    isUserEntryReady?: (userMessageId: string) => boolean
  },
): ReferenceProcessTimelineItem[] {
  const {
    turnDurationMap,
    sessionIsStreaming,
    messageHasProcess,
    messageHasFinal,
    isUserEntryReady = () => true,
  } = options
  const items: ReferenceProcessTimelineItem[] = []

  type TurnBag = {
    user: PiTimelineItem
    assistants: PiAssistantMessageItem[]
  }

  const slots: Array<{ kind: 'flat'; item: PiTimelineItem } | { kind: 'turn'; turn: TurnBag }> = []
  const turns: TurnBag[] = []
  let current: TurnBag | null = null

  for (const item of visibleItems) {
    if (item.kind === 'user_message') {
      current = { user: item, assistants: [] }
      turns.push(current)
      slots.push({ kind: 'turn', turn: current })
      continue
    }
    if (item.kind !== 'assistant_message') {
      slots.push({ kind: 'flat', item })
      continue
    }
    if (!current) {
      slots.push({ kind: 'flat', item })
      continue
    }
    current.assistants.push(item)
  }

  const laterHasAssistant = (fromIndex: number) => {
    for (let j = fromIndex + 1; j < turns.length; j++) {
      if (turns[j].assistants.length > 0) return true
    }
    return false
  }

  const laterHasLive = (fromIndex: number) => {
    for (let j = fromIndex + 1; j < turns.length; j++) {
      if (turns[j].assistants.some(assistantHasLiveWork)) return true
    }
    return false
  }

  const isTurnSettled = (turn: TurnBag, index: number): boolean => {
    const assistants = turn.assistants
    if (laterHasLive(index)) return true
    if (assistants.some(assistantHasLiveWork)) return false
    if (assistants.length === 0) {
      return !sessionIsStreaming || laterHasAssistant(index)
    }
    if (sessionIsStreaming && index === turns.length - 1) return false
    return assistants.every(m => !m.isStreaming)
  }

  const isTurnPending = (turn: TurnBag, index: number): boolean => {
    if (isTurnSettled(turn, index)) return false
    if (turn.assistants.length > 0) return true
    return sessionIsStreaming && isUserEntryReady(turn.user.entryId)
  }

  let activeUserId: string | null = null
  for (let i = 0; i < turns.length; i++) {
    if (isTurnPending(turns[i], i)) {
      activeUserId = turns[i].user.renderKey ?? turns[i].user.entryId
      break
    }
  }

  for (const slot of slots) {
    if (slot.kind === 'flat') {
      items.push({ kind: 'message', key: itemRenderKey(slot.item), item: slot.item })
      continue
    }

    const turn = slot.turn
    const assistants = turn.assistants

    items.push({ kind: 'message', key: itemRenderKey(turn.user), item: turn.user })

    const userId = turn.user.renderKey ?? turn.user.entryId
    const turnIsActive = activeUserId != null && userId === activeUserId

    const finalAssistant = assistants.length > 0 ? assistants[assistants.length - 1] : null
    const finalId = finalAssistant?.entryId ?? null
    const startedAt = turn.user.timestamp
    const durationMs = turnIsActive ? undefined : resolveTurnDurationMs(assistants, startedAt, turnDurationMap)

    const children: Array<{ item: PiTimelineItem; processContentScope: 'process' | 'inline' }> = []
    if (turnIsActive) {
      for (const m of assistants) {
        children.push({
          item: m,
          processContentScope: m.entryId === finalId ? 'process' : 'inline',
        })
      }
    } else {
      for (const m of assistants) {
        if (m.entryId === finalId) {
          if (messageHasProcess(m)) {
            children.push({ item: m, processContentScope: 'process' })
          }
        } else {
          children.push({ item: m, processContentScope: 'inline' })
        }
      }
    }

    const finalOutside = !turnIsActive && finalAssistant && messageHasFinal(finalAssistant) ? finalAssistant : undefined

    if (children.length > 0 || turnIsActive) {
      items.push({
        kind: 'process-shell',
        key: `process-shell:${itemRenderKey(turn.user)}`,
        userMessageId: userId,
        startedAt,
        durationMs,
        isActive: turnIsActive,
        children,
        finalItem: finalOutside,
      })
    } else if (finalOutside) {
      items.push({
        kind: 'message',
        key: `process-shell:${itemRenderKey(turn.user)}`,
        item: finalOutside,
      })
    } else {
      for (const m of assistants) {
        items.push({ kind: 'message', key: itemRenderKey(m), item: m })
      }
    }
  }

  return items
}
