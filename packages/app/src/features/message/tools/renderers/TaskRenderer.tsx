import { memo, useState, useCallback, useEffect, type RefCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useChildAgentSessions } from '../../../../pi/childAgentStore'
import { useSubagentSessionId } from '../../../../pi/subagentSessions'
import { ContentBlock } from '../../../../components'
import { ChevronRightIcon, ExternalLinkIcon, StopIcon } from '../../../../components/Icons'
import { useDisclosureScrollLock } from '../../../../hooks'
import { useSessionNavigation } from '../../../../contexts/SessionNavigationContext'
import { abortPiOperation, stopPiAgent } from '../../../../pi/controllers/index.js'
import {
  isScopedSessionKey,
  makeSessionKey,
  sessionKeyToServerId,
  sessionKeyToSessionId,
} from '../../../../utils/sessionKey'
import { useUiDisclosureState } from '../../../../utils/uiDisclosureState'
import { formatCost, formatDuration } from '../../../../utils/formatUtils'
import type { ToolRendererProps } from '../types'
import { MessageExpandPanel, useMessageExpandRender } from '../../messageExpand'

// ============================================
// Task / Agent Tool Renderer (子 agent)
//
// 设计原则：
// 1. 渐进式展开 - 默认显示摘要，点击展开详情
// 2. 视觉层次 - 左侧缩进线区分嵌套层级
// 3. 状态优先 - 运行中/完成/错误状态一目了然
// 4. 按需交互 - 输入框只在需要时显示
//
// 两种后端形态：
// - OpenCode 的 `task` 工具：details.sessionId 指向可浏览的子会话
//   （Pi 侧不存在，SubSessionView 保留占位）
// - Pi 的 `Agent` 工具（pi-subagents-lite）：details 里前台带统计+日志路径、
//   后台只有 agentId，见 buildAgentDetails
//
// 状态判定不能只看 result：后台 Agent 在工具返回时就已经有 result，
// 但子代理仍在跑，真正的状态在 details.status 上。
// ============================================

type AgentUiStatus = 'queued' | 'running' | 'completed' | 'turn_limited' | 'aborted' | 'stopped' | 'error'

const ACTIVE_STATUSES: readonly AgentUiStatus[] = ['queued', 'running']

/** 终态里用中性色显示的几种（不是失败，也不是正常完成）。 */
const NEUTRAL_STATUSES: readonly AgentUiStatus[] = ['queued', 'turn_limited', 'aborted', 'stopped']

const STATUS_LABEL_KEYS: Record<AgentUiStatus, string> = {
  queued: 'task.status.queued',
  running: 'task.status.running',
  completed: 'task.status.completed',
  turn_limited: 'task.status.turnLimited',
  aborted: 'task.status.aborted',
  stopped: 'task.status.stopped',
  error: 'task.status.error',
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function readString(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function readNumber(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 归一化状态。
 *
 * details.status 是插件给的真状态（AgentStatus 枚举 7 值）；拿不到时才退回
 * 「有 result 即完成、isError 即失败」的旧判定（OpenCode `task` 走这条）。
 */
function resolveStatus(
  details: Record<string, unknown> | undefined,
  hasResult: boolean,
  isResultError: boolean,
): AgentUiStatus {
  const raw = readString(details, 'status')
  if (raw && raw in STATUS_LABEL_KEYS) return raw as AgentUiStatus
  if (isResultError) return 'error'
  return hasResult ? 'completed' : 'running'
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

function scopeChildSession(sessionId: string | undefined, parentId: string | null | undefined): string | undefined {
  if (!sessionId || !parentId || !isScopedSessionKey(parentId)) return sessionId
  return makeSessionKey(sessionKeyToServerId(parentId), sessionKeyToSessionId(sessionId))
}

export const TaskRenderer = memo(function TaskRenderer({ execution, partKey, onFullscreenChange }: ToolRendererProps) {
  const { t } = useTranslation('message')
  const input = asRecord(execution.call.arguments)
  const details = asRecord(execution.result?.details)
  const hasResult = Boolean(execution.result)
  const resultIsError = Boolean(execution.result?.isError)

  const status = resolveStatus(details, hasResult, resultIsError)
  const isRunning = ACTIVE_STATUSES.includes(status)
  const isError = status === 'error'
  const isCompleted = !isRunning && !isError

  const [expanded, setExpanded] = useUiDisclosureState(`message:${partKey}:task-body`, isRunning)
  const [isContentFullscreen, setIsContentFullscreen] = useState(false)
  const [stopError, setStopError] = useState<string | undefined>(undefined)
  const { rootRef, headerRef, withScrollLock } = useDisclosureScrollLock()
  const effectiveExpanded = expanded || isContentFullscreen
  const shouldRenderBody = useMessageExpandRender(effectiveExpanded)

  // 任务信息：Pi 的 Agent 工具用 `agent`，OpenCode 的 task 用 `subagent_type`
  const description = readString(input, 'description') ?? t('task.subtask')
  const prompt = readString(input, 'prompt') ?? ''
  const agentType = readString(input, 'agent') ?? readString(input, 'subagent_type') ?? 'general-purpose'
  const worktreePath = readString(input, 'worktree_path')
  const runInBackground = details?.runInBackground === true || input?.run_in_background === true

  // 子 session ID —— 优先 metadata.sessionId（后端为 tool call 精确设置，OCUI
  // 的 task 走这条）；Pi 的 Agent 不提供，用 agentId 短 id 反查子会话
  // （插件把子会话命名为 `<类型>#<短 id>`）。
  const { currentSessionId } = useSessionNavigation()
  const agentId = readString(details, 'agentId')
  const childSessionId = useSubagentSessionId(agentId)
  const targetSessionId = scopeChildSession(readString(details, 'sessionId') ?? childSessionId, currentSessionId)
  // 子代理公告不带 agentId；只按父会话报总数，让后台 agent 跑着的时候
  // 界面上有活着的证据。
  const liveChildCount = useChildAgentSessions().length
  const parentSessionId = currentSessionId ? sessionKeyToSessionId(currentSessionId) || currentSessionId : undefined

  const resultOutput = execution.result
    ? ((execution.result.content ?? []) as Array<{ type: string; text?: string }>)
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text as string)
        .join('\n')
    : undefined

  const handleContentFullscreenChange = useCallback(
    (isFullscreen: boolean) => {
      setIsContentFullscreen(isFullscreen)
      onFullscreenChange?.(isFullscreen)
    },
    [onFullscreenChange],
  )

  // Stop handler：前台 Agent 中断所在回合，后台 Agent 调插件的 StopAgent
  const handleStop = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setStopError(undefined)
      const onError = (error: unknown) => {
        setStopError(error instanceof Error ? error.message : String(error))
      }
      if (agentId) {
        if (!parentSessionId) return onError(new Error('No active session'))
        void stopPiAgent(parentSessionId, agentId).catch(onError)
        return
      }
      const abortTarget = targetSessionId ?? currentSessionId
      if (!abortTarget) return onError(new Error('No active session'))
      void abortPiOperation(abortTarget).catch(onError)
    },
    [agentId, parentSessionId, targetSessionId, currentSessionId],
  )

  // 运行时自动展开
  useEffect(() => {
    let frameId: number | null = null

    if (isRunning) {
      frameId = requestAnimationFrame(() => {
        setExpanded(true, { touched: false, respectUser: true })
      })
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [isRunning, setExpanded])

  const canStop = isRunning && (Boolean(agentId) || Boolean(targetSessionId) || Boolean(currentSessionId))

  return (
    <div ref={rootRef} className="min-w-0">
      <div>
        {/* Header */}
        <TaskHeader
          agentType={agentType}
          description={description}
          status={status}
          expanded={expanded}
          headerRef={headerRef}
          onToggle={() => withScrollLock(() => setExpanded(!expanded))}
          sessionId={targetSessionId}
          onStop={canStop ? handleStop : undefined}
        />

        {/* Body */}
        <MessageExpandPanel open={effectiveExpanded} innerClassName="overflow-hidden">
          {shouldRenderBody && (
            <div className="pt-2 space-y-3">
              {/* Prompt */}
              {prompt && (
                <div className="text-[length:var(--fs-xs)] text-text-500 leading-relaxed whitespace-nowrap overflow-hidden text-ellipsis">
                  {prompt}
                </div>
              )}

              {/* 前台 Agent 的统计（后台调用没有这些字段） */}
              <AgentStats details={details} />

              {/* 工作树 / 日志路径 —— OCUI 无对应信息，判据 3 */}
              {worktreePath && (
                <div className="flex gap-2 text-[length:var(--fs-xs)] text-text-500">
                  <span className="shrink-0 text-text-400">{t('task.worktree')}</span>
                  <span className="min-w-0 truncate" title={worktreePath}>
                    {worktreePath}
                  </span>
                </div>
              )}
              {readString(details, 'outputFile') && (
                <div className="flex gap-2 text-[length:var(--fs-xs)] text-text-500">
                  <span className="shrink-0 text-text-400">{t('task.outputFile')}</span>
                  <span className="min-w-0 truncate" title={readString(details, 'outputFile')}>
                    {readString(details, 'outputFile')}
                  </span>
                </div>
              )}

              {runInBackground && (
                <div className="text-[length:var(--fs-xs)] text-text-400">{t('task.backgroundHint')}</div>
              )}

              {liveChildCount > 0 && (
                <div className="text-[length:var(--fs-xs)] text-text-500">
                  {t('task.childSessionsRunning', { count: liveChildCount })}
                </div>
              )}

              {stopError && (
                <div className="text-[length:var(--fs-xs)] text-danger-100 break-words">
                  {t('task.stopFailed', { message: stopError })}
                </div>
              )}

              {/* 子会话内容 */}
              {targetSessionId && (
                <>
                  {prompt && <hr className="border-border-200/30" />}
                  <SubSessionView sessionId={targetSessionId} isParentRunning={isRunning} />
                </>
              )}

              {/* 完成时的输出 */}
              {isCompleted && resultOutput !== undefined && resultOutput !== '' && (
                <ContentBlock
                  label={t('task.result')}
                  stateKey={`message:${partKey}:task-result`}
                  content={resultOutput}
                  defaultCollapsed={true}
                  onFullscreenChange={handleContentFullscreenChange}
                  fullscreenId={`task:${partKey}:result`}
                />
              )}

              {/* 错误信息：result.isError 或 details.status === 'error' 都要显示 */}
              {isError && (
                <ContentBlock
                  label={t('task.error')}
                  stateKey={`message:${partKey}:task-error`}
                  content={resultOutput || t('task.taskFailed')}
                  variant="error"
                  onFullscreenChange={handleContentFullscreenChange}
                  fullscreenId={`task:${partKey}:error`}
                />
              )}
            </div>
          )}
        </MessageExpandPanel>
      </div>
    </div>
  )
})

// ============================================
// Task Header
// ============================================

interface TaskHeaderProps {
  agentType: string
  description: string
  status: string
  expanded: boolean
  onToggle: () => void
  headerRef?: RefCallback<HTMLElement>
  sessionId?: string
  onStop?: (e: React.MouseEvent) => void
}

export const TaskHeader = memo(function TaskHeader({
  agentType,
  description,
  status,
  expanded,
  onToggle,
  headerRef,
  sessionId,
  onStop,
}: TaskHeaderProps) {
  const { t } = useTranslation('message')
  const { navigateToSession, currentDirectory, currentSessionId } = useSessionNavigation()
  const targetSessionId = scopeChildSession(sessionId, currentSessionId)
  const handleOpenSession = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!targetSessionId) return
      navigateToSession(targetSessionId, currentDirectory || undefined)
    },
    [targetSessionId, navigateToSession, currentDirectory],
  )

  const isRunning = status === 'running' || status === 'pending'
  const isError = status === 'error'
  const isCompleted = status === 'completed'
  const isNeutral = NEUTRAL_STATUSES.includes(status as AgentUiStatus)
  const showStatusLabel = isNeutral || status === 'turn_limited'

  const agentBadgeClass = `shrink-0 px-1.5 py-0.5 text-[length:var(--fs-xxs)] font-medium rounded-xs ${
    isRunning
      ? 'bg-accent-main-100/20 text-accent-main-100'
      : isError
        ? 'bg-danger-100/20 text-danger-100'
        : isCompleted
          ? 'bg-accent-secondary-100/20 text-accent-secondary-100'
          : 'bg-bg-300 text-text-300'
  }`

  return (
    <div ref={headerRef} className="flex items-center gap-2 py-1 group">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded ? t('showLess') : t('showMore')}
        title={expanded ? t('showLess') : t('showMore')}
        className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm text-text-400 transition-colors hover:bg-bg-200/70 hover:text-text-100 bg-transparent border-none p-0"
      >
        {/* Expand icon */}
        <span className={`text-text-400 transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <ChevronRightIcon size={12} />
        </span>
      </button>

      {sessionId ? (
        <button
          type="button"
          data-compact=""
          onClick={handleOpenSession}
          className={`${agentBadgeClass} border-none transition-opacity hover:opacity-80`}
          title={t('task.openSession')}
        >
          {agentType}
        </button>
      ) : (
        <span className={agentBadgeClass}>{agentType}</span>
      )}

      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group/title flex min-w-0 flex-1 self-stretch items-center text-left bg-transparent border-none p-0"
        title={expanded ? t('showLess') : t('showMore')}
      >
        <span className="min-w-0 truncate text-[length:var(--fs-sm)] text-text-300 group-hover/title:text-text-100">
          {description}
        </span>
      </button>

      {/* 非完成态的状态文字（排队 / 轮次上限 / 已中止 / 已停止） */}
      {showStatusLabel && (
        <span className="shrink-0 text-[length:var(--fs-xxs)] text-text-400">
          {t(STATUS_LABEL_KEYS[status as AgentUiStatus] ?? 'task.status.completed')}
        </span>
      )}

      {/* Stop button (running) */}
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          aria-label={t('task.stop')}
          className="flex-shrink-0 w-[18px] h-[18px] p-0 flex items-center justify-center text-text-400 hover:text-danger-100 hover:bg-danger-100/10 rounded-sm transition-colors active:scale-90 bg-transparent border-none"
          title={t('task.stop')}
        >
          <StopIcon size={10} />
        </button>
      )}

      {/* Open session */}
      {sessionId && (
        <button
          type="button"
          onClick={handleOpenSession}
          aria-label={t('task.openSession')}
          className="flex-shrink-0 p-1 text-text-500 hover:text-accent-main-100 transition-all bg-transparent border-none"
          title={t('task.openSession')}
        >
          <ExternalLinkIcon size={12} />
        </button>
      )}
    </div>
  )
})

// ============================================
// Agent Stats（判据 3：OCUI 的 task 结果没有统计字段）
// ============================================

const AgentStats = memo(function AgentStats({ details }: { details: Record<string, unknown> | undefined }) {
  const { t } = useTranslation('message')
  const chips: string[] = []

  const turns = readNumber(details, 'turnCount')
  const maxTurns = readNumber(details, 'maxTurns')
  if (turns !== undefined) {
    chips.push(`${t('task.stats.turns')} ${maxTurns ? `${turns}/${maxTurns}` : turns}`)
  }

  const toolUses = readNumber(details, 'toolUses')
  if (toolUses !== undefined) chips.push(`${t('task.stats.tools')} ${toolUses}`)

  const input = readNumber(details, 'input')
  const output = readNumber(details, 'output')
  if (input !== undefined || output !== undefined) {
    chips.push(`${t('task.stats.tokens')} ${formatTokens(input ?? 0)}↑ ${formatTokens(output ?? 0)}↓`)
  }

  const durationMs = readNumber(details, 'durationMs')
  if (durationMs !== undefined) chips.push(formatDuration(durationMs))

  const cost = readNumber(details, 'cost')
  if (cost !== undefined && cost > 0) chips.push(formatCost(cost))

  const contextPercent = readNumber(details, 'contextPercent')
  if (contextPercent !== undefined) chips.push(`${t('task.stats.context')} ${Math.round(contextPercent)}%`)

  const compactions = readNumber(details, 'compactions')
  if (compactions) chips.push(`${t('task.stats.compactions')} ${compactions}`)

  const model = readString(details, 'modelName') ?? readString(details, 'modelId')
  const thinking = readString(details, 'thinkingLevel')
  if (model) chips.push(thinking ? `${model} · ${thinking}` : model)

  if (chips.length === 0) return null

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--fs-xxs)] text-text-500">
      {chips.map(chip => (
        <span key={chip} className="shrink-0">
          {chip}
        </span>
      ))}
    </div>
  )
})

// ============================================
// Sub Session View
// ============================================

interface SubSessionViewProps {
  sessionId: string
  isParentRunning: boolean
}

const SubSessionView = memo(function SubSessionView({ sessionId, isParentRunning }: SubSessionViewProps) {
  const { t } = useTranslation('message')
  // Pi 的子代理会话是内存态（SessionManager.inMemory）：转录既不落盘也不在
  // 宿主可读范围内，只有 pi.events 的 subagents:child:* 公告能证明它存在。
  // 所以这里只能报存活，不能渲染内容。
  const bareId = sessionKeyToSessionId(sessionId)
  const live = useChildAgentSessions().some(session => session.sessionId === bareId)
  if (live) {
    return (
      <div className="text-[length:var(--fs-sm)] text-text-500 py-2">
        {t('task.childSessionLive', { id: bareId.slice(0, 8) })}
      </div>
    )
  }
  // 跑完的 agent 没有子会话也不该再挂着「等待中」——内容在结果块里。
  if (!isParentRunning) return null
  return <div className="text-[length:var(--fs-sm)] text-text-500 italic py-2">{t('task.waitingForResponse')}</div>
})
