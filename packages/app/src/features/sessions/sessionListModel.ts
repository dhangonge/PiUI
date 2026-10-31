// 会话列表的模型契约：时间分组类型/顺序、列表 props。从 SessionList.tsx 搬出（未改动语义）。
import type { PinnedSessionEntry } from '../../store/pinnedSessionsStore'
import type { UiSession } from '../../types/session'

// 时间分组类型
export type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older'

export const SESSION_GROUP_ORDER: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older']

export interface SessionListProps {
  sessions: UiSession[]
  selectedId: string | null
  isLoading: boolean
  isLoadingMore: boolean
  hasMore: boolean
  search: string
  onSearchChange: (search: string) => void
  onSelect: (session: UiSession) => void
  onDelete: (sessionId: string) => void
  onRename: (sessionId: string, newTitle: string) => void
  onLoadMore: () => void
  onNewChat: () => void
  showHeader?: boolean
  grouped?: boolean
  density?: 'default' | 'compact' | 'minimal'
  showDirectory?: boolean
  /** 按父 ID 分组的直接挂出来的子 session */
  inlineChildSessions?: Map<string, UiSession[]>
  onSelectChildSession?: (session: UiSession) => void
  pinnedDividerAfterIds?: Set<string>
  /** 拉不到的置顶（灰色展示，可取消） */
  unavailablePinnedEntries?: PinnedSessionEntry[]
  /** SidePanel 排好的可用置顶数量（flat 列表里用来定位插入点） */
  availablePinnedCount?: number
  // ---- 编辑模式 ----
  isEditMode?: boolean
  selectedSessionIds?: Set<string>
  onToggleSessionSelection?: (sessionId: string, options?: { shiftKey?: boolean }) => void
}
