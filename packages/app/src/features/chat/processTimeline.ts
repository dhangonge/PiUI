/**
 * 过程折叠时间线（Working 壳 / Worked 折叠行）。
 *
 * 从 chatPageModel 拆出的内聚模块：只依赖 pi 域类型，不反向依赖 chatPageModel，
 * 因此不会形成循环依赖。chatPageModel 负责 re-export 以保持既有导入路径。
 */
import type { PiAssistantMessageItem, PiTimelineItem } from '../../pi/domain/index.js'

function itemRenderKey(item: PiTimelineItem): string {
  return item.renderKey ?? item.entryId
}

/** 过程折叠：虚拟时间线上的一行 */
export type ProcessTimelineItem =
  | {
      kind: 'message'
      key: string
      item: PiTimelineItem
      /** 过程壳内消息的内容范围 */
      processContentScope?: 'process' | 'final' | 'inline'
    }
  | {
      kind: 'process-shell'
      key: string
      userMessageId: string | null
      startedAt?: number
      durationMs?: number
      isActive: boolean
      /** 壳内消息（不含壳外 final） */
      children: Array<{
        item: PiTimelineItem
        processContentScope: 'process' | 'inline'
      }>
      /** 壳外最终回答（结束后才有） */
      finalItem?: PiTimelineItem
    }

/** 两行是否可共享同一对象（VirtualRow 靠 item 引用短路） */
export function sameProcessTimelineItem(a: ProcessTimelineItem, b: ProcessTimelineItem): boolean {
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

/**
 * 流式时只脏最后一行：按 key 复用未变 timeline item，让 VirtualRow memo 命中历史行。
 * 数组本身若完全未变则复用 previous 数组引用。
 */
export function reuseProcessTimelineItems(
  previous: ProcessTimelineItem[] | undefined,
  next: ProcessTimelineItem[],
): ProcessTimelineItem[] {
  if (!previous || previous.length === 0) return next
  if (previous === next) return previous

  const prevByKey = new Map(previous.map(item => [item.key, item]))
  let allSame = previous.length === next.length
  const result = new Array<ProcessTimelineItem>(next.length)

  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    const prev = prevByKey.get(item.key)
    if (prev && sameProcessTimelineItem(prev, item)) {
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
  // Only the streaming item counts as live. A persisted assistant whose
  // toolCall lacks a result is NOT live work — the result either landed in
  // a later entry (paired already) or lives in an older unloaded page.
  // Treating it as live would mark historical turns as still-working.
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

/**
 * 过程折叠时间线：按用户消息分组。
 *
 * 异步多发：
 * - 同一时刻只一个 Working，挂在最早仍 pending 的 user 回合
 * - 更晚空回合先只显示 user
 * - 后面回合 SSE live 一到，前面一律 Worked（不必等 completed / idle）
 * - 本轮 assistant 全 completed 但会话仍 busy（多步 agent 的下一步还没到，Pi 的 isStreaming 也盖住子代理回合）→ 不收壳
 *   （否则发送瞬间 streaming 先到、新 user 未入列，会把已 Worked 闪回 Working；
 *    busy 摘掉或下一轮 user 接手后才收）
 *
 * isUserEntryReady：空壳等用户入场生长完成后再挂。
 */
export function buildProcessTimeline(
  visibleItems: PiTimelineItem[],
  options: {
    turnDurationMap: Map<string, number>
    sessionIsStreaming: boolean
    messageHasProcess: (item: PiAssistantMessageItem) => boolean
    messageHasFinal: (item: PiAssistantMessageItem) => boolean
    /** 用户消息入场生长是否完成；缺省视为已完成（历史消息 / 测试） */
    isUserEntryReady?: (userMessageId: string) => boolean
  },
): ProcessTimelineItem[] {
  const {
    turnDurationMap,
    sessionIsStreaming,
    messageHasProcess,
    messageHasFinal,
    isUserEntryReady = () => true,
  } = options
  const items: ProcessTimelineItem[] = []

  type TurnBag = {
    user: PiTimelineItem
    assistants: PiAssistantMessageItem[]
  }

  // 单趟收集：输出顺序必须与输入一致。系统条目与页首孤立助手只能就地平铺；
  // 一旦推到第二趟再输出，它们会跑到所有用户消息之前（顺序错乱、助手脱离壳）。
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
    // 系统条目（bash/compaction/summary/custom/label/unknown）就地平铺，不进壳。
    // 不清空 current：紧跟其后的助手仍属于同一用户回合，否则会被踢出壳。
    if (item.kind !== 'assistant_message') {
      slots.push({ kind: 'flat', item })
      continue
    }
    if (!current) {
      // 历史续段 / 页首无 user：直接平铺，不挂壳
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

  /** 更晚回合是否已有 live 助手——SSE 挂 Working 的绝对条件 */
  const laterHasLive = (fromIndex: number) => {
    for (let j = fromIndex + 1; j < turns.length; j++) {
      if (turns[j].assistants.some(assistantHasLiveWork)) return true
    }
    return false
  }

  const isTurnSettled = (turn: TurnBag, index: number): boolean => {
    const assistants = turn.assistants
    // 后面 SSE live → 前面 Worked（须最先判断；前轮 completed 常晚到）
    if (laterHasLive(index)) return true
    if (assistants.some(assistantHasLiveWork)) return false
    if (assistants.length === 0) {
      // 空回合：idle 结束；或后面已有 assistant（被跳过）
      return !sessionIsStreaming || laterHasAssistant(index)
    }
    // 全 completed 且无 live，但会话还 busy 且这是最后一个用户回合：
    // 只是同一回合「上一步已收尾、下一步还没到」的间隙（多步 agent 的常态），
    // 不能判成 Worked —— 否则壳会先收成「已处理」，等下一步内容到了再展开一次。
    // 等 idle 把 busy 摘掉，或下一轮 user 接手（index 不再是最后一个）才收。
    if (sessionIsStreaming && index === turns.length - 1) return false
    return assistants.every(m => !m.isStreaming)
  }

  const isTurnPending = (turn: TurnBag, index: number): boolean => {
    if (isTurnSettled(turn, index)) return false
    if (turn.assistants.length > 0) return true
    return sessionIsStreaming && isUserEntryReady(turn.user.entryId)
  }

  // 唯一 Working：最早 pending 的用户回合
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

    // 进行中：全部进壳；结束：中间全进 + 末尾仅 process
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

    // 进行中或有过程内容 → 挂壳
    // 更晚的空 pending 回合：turnIsActive=false 且无 children → 不挂壳（只显示 user）
    // 纯 final 正文、无过程 → 直接平铺
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
        // Keep the row identity when a pure text response settles. During
        // streaming this turn is represented by the process-shell row.
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
