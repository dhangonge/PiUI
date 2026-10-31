import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon } from '../../components/Icons'
import { CopyButton } from '../../components/ui'
import { useInputCapabilities } from '../../hooks/useInputCapabilities'

/** 队列消息气泡（当前回合 steering / 下一回合 followUp），对齐用户消息的布局与操作行。 */
export const QueuedUserMessageQueue = memo(function QueuedUserMessageQueue({
  kind,
  items,
  maxWidthClass,
  paddingClass,
  onBackToInput,
  onMoveMode,
  onClear,
}: {
  kind: 'current' | 'next'
  items: readonly string[]
  maxWidthClass: string
  paddingClass: string
  /** 修改该条（pi 不支持队列内修改：清除后回填输入框，编辑后重发） */
  onBackToInput?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 切换该条队列模式（steer ↔ followUp） */
  onMoveMode?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
  /** 直接清除该条 */
  onClear?: (queueKind: 'steering' | 'followUp', index: number) => void | Promise<void>
}) {
  const { t } = useTranslation('chat')
  const { preferTouchUi } = useInputCapabilities()
  if (items.length === 0) return null

  const queueKind = kind === 'current' ? 'steering' : 'followUp'
  const moveTitle = t(kind === 'current' ? 'chatArea.moveQueueToNext' : 'chatArea.moveQueueToCurrent')
  const label = t(kind === 'current' ? 'chatArea.currentTurnQueue' : 'chatArea.nextTurnQueue', {
    count: items.length,
  })
  // 对齐用户消息 action bar：PC 悬浮显示、触控恒显示
  const actionBarClass = preferTouchUi
    ? 'flex items-center gap-0.5 transition-opacity'
    : 'flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 group-focus-within/msg:opacity-100 transition-opacity'
  const actionBtnClass = 'p-1.5 rounded-md text-text-400 hover:text-text-200 hover:bg-bg-200/50 transition-colors'
  return (
    <section
      data-message-queue={kind}
      aria-label={label}
      className={`w-full ${maxWidthClass} mx-auto ${paddingClass} pt-3 pb-2`}
    >
      <div className="flex items-center gap-3 pb-3 text-[length:var(--fs-sm)] text-text-500" role="status">
        <span className="h-px flex-1 bg-border-200" aria-hidden="true" />
        <span className="shrink-0">{label}</span>
        <span className="h-px flex-1 bg-border-200" aria-hidden="true" />
      </div>
      <div className="flex flex-col items-end gap-2">
        {items.map((text, index) => (
          <div key={`${index}:${text}`} className="group/msg flex flex-col items-end gap-1 max-w-[85%]">
            {/* 气泡：仅文本（对齐用户消息布局） */}
            <div className="whitespace-pre-wrap break-words rounded-2xl border border-dashed border-border-200 bg-bg-300/60 px-4 py-2.5 text-[length:var(--fs-base)] leading-relaxed text-text-200">
              {text}
            </div>
            {/* 操作行：气泡下方（对齐用户消息 action bar） */}
            {(onBackToInput || onMoveMode || onClear) && (
              <div className={`px-1 ${actionBarClass}`}>
                <CopyButton text={text} position="static" />
                {onClear && (
                  <button
                    type="button"
                    onClick={() => void onClear(queueKind, index)}
                    title={t('chatArea.clearQueueItem')}
                    className={actionBtnClass}
                  >
                    <TrashIcon />
                  </button>
                )}
                {onMoveMode && (
                  <button
                    type="button"
                    onClick={() => void onMoveMode(queueKind, index)}
                    title={moveTitle}
                    className={actionBtnClass}
                  >
                    {kind === 'current' ? <ArrowDownIcon /> : <ArrowUpIcon />}
                  </button>
                )}
                {onBackToInput && (
                  <button
                    type="button"
                    onClick={() => void onBackToInput(queueKind, index)}
                    title={t('chatArea.editQueueItem')}
                    className={actionBtnClass}
                  >
                    <PencilIcon />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
})
