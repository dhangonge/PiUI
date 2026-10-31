import type { UiSession } from '../../../types/session'
import { SessionListItem, type SessionListItemProps } from '../../sessions/SessionList'
import { SessionChildrenSlot } from './SessionChildrenSlot'
import { sessionChildrenExpansionStore, useSessionChildrenExpanded } from '../../../store/sessionChildrenExpansionStore'

interface SessionRowWithChildrenProps extends Omit<
  SessionListItemProps,
  'childCount' | 'childrenExpanded' | 'onToggleChildren'
> {
  /** 父会话 id -> 子代理会话（pi/subagentSessionGrouping.ts 的产出） */
  childrenByParentId?: Map<string, UiSession[]>
  selectedSessionId: string | null
  onSelectChildSession?: (session: UiSession) => void
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}

/**
 * 侧栏会话行 + 其下的子代理会话。子代理默认收起（归档隐藏），
 * 只在父行点开时展开，深层嵌套交给 SessionChildrenSlot 递归。
 */
export function SessionRowWithChildren({
  childrenByParentId,
  selectedSessionId,
  onSelectChildSession,
  selectedSessionIds,
  onToggleSessionSelection,
  isEditMode = false,
  ...itemProps
}: SessionRowWithChildrenProps) {
  const children = childrenByParentId?.get(itemProps.session.id)
  const childCount = children?.length ?? 0
  const canExpand = childCount > 0 && !!onSelectChildSession
  const expanded = useSessionChildrenExpanded(itemProps.session.id)

  return (
    <div data-subagent-parent={canExpand ? itemProps.session.id : undefined}>
      <SessionListItem
        {...itemProps}
        isEditMode={isEditMode}
        childCount={canExpand ? childCount : 0}
        childrenExpanded={expanded}
        onToggleChildren={canExpand ? () => sessionChildrenExpansionStore.toggle(itemProps.session.id) : undefined}
      />
      {canExpand && expanded && (
        <SessionChildrenSlot
          parentSession={itemProps.session}
          selectedSessionId={selectedSessionId}
          children={children}
          childrenByParent={childrenByParentId}
          onSelect={onSelectChildSession}
          isEditMode={isEditMode}
          selectedSessionIds={selectedSessionIds}
          onToggleSessionSelection={onToggleSessionSelection}
        />
      )}
    </div>
  )
}
