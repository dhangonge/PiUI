import { useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { extensionUiStore } from '../pi/extensionUiStore'
import { TodoRows, type TodoItem } from '../features/message/tools/renderers/TodoRenderer'
import { ChevronDownIcon, PermissionListIcon } from './Icons'
import { chevronClass, MessageExpandPanel } from '../features/message/messageExpand'
import { stripAnsi } from '../utils/ansiUtils'

const TODO_WIDGET_KEY = /todo/i
const ROW = /^[├└]─\s*(○|◐|✓|●|✗|⊘)\s+(?:#(\d+)\s+)?(.*)$/
const STATUS_BY_GLYPH: Record<string, TodoItem['status']> = {
  '○': 'pending',
  '◐': 'in_progress',
  '✓': 'completed',
  '●': 'completed',
  '✗': 'cancelled',
  '⊘': 'cancelled',
}

/**
 * Live todo widget beside the composer.
 *
 * Extensions render a terminal component; the worker mirrors its text snapshot
 * (see packages/pi-worker/src/runtime/extension-tui.ts). Only the todo widget is
 * surfaced here, and it uses the app's own card chrome — the same shell as the
 * questionnaire card above the composer — instead of reproducing plugin drawing.
 * Other widget mirrors stay in the extensions panel.
 */
export function TodoWidget({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation(['message', 'components'])
  const [collapsed, setCollapsed] = useState(false)
  const snapshot = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)
  const widgets = useMemo(
    () => (sessionId ? snapshot.sessions[sessionId]?.state.widgets ?? {} : {}),
    [sessionId, snapshot],
  )
  const parsed = useMemo(() => {
    const todos: TodoItem[] = []
    let counts: { completed: number; total: number } | undefined
    for (const [key, widget] of Object.entries(widgets)) {
      if (!TODO_WIDGET_KEY.test(key)) continue
      counts ??= parseCounts(widget.lines)
      todos.push(...parseRows(widget.lines, todos.length))
    }
    return { todos, counts }
  }, [widgets])

  if (parsed.todos.length === 0) return null

  const completed = parsed.counts?.completed ?? parsed.todos.filter(todo => todo.status === 'completed').length
  const total = parsed.counts?.total ?? parsed.todos.length

  return (
    <div data-todo-widget className="todo-widget shrink-0 min-w-0 overflow-hidden rounded-xl border border-border-200/60 bg-bg-100 shadow-float text-[length:var(--fs-xs)] leading-5">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(value => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-bg-200/40"
      >
        <PermissionListIcon size={16} className="shrink-0 text-text-400" />
        <span className="font-medium text-text-100">{t('message:todo.tasks')}</span>
        <span className="text-[length:var(--fs-xs)] tabular-nums font-mono text-text-500">
          {t('message:todo.completedCount', { completed, total })}
        </span>
        <span className="ml-auto shrink-0 rounded-md p-1 text-text-400">
          <ChevronDownIcon size={14} className={chevronClass(!collapsed, 'md')} />
        </span>
      </button>
      <MessageExpandPanel open={!collapsed} variant="fade" className="todo-widget-panel">
        <div className="max-h-[32dvh] overflow-y-auto custom-scrollbar border-t border-border-200/40">
          <TodoRows todos={parsed.todos} compact />
        </div>
      </MessageExpandPanel>
    </div>
  )
}

/** `● Todos (1/3)` — the widget's own totals, which also count hidden rows. */
function parseCounts(lines: string[]): { completed: number; total: number } | undefined {
  for (const line of lines) {
    const match = stripAnsi(line).match(/\((\d+)\/(\d+)\)/)
    if (match) return { completed: Number(match[1]), total: Number(match[2]) }
  }
  return undefined
}

/** Widget rows: `├─ ✓ #2 subject` / `└─ ◐ subject`, plus `└─ +N more` summaries. */
function parseRows(lines: string[], offset: number): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of lines) {
    const match = stripAnsi(line).trimEnd().match(ROW)
    if (!match) continue
    const status = STATUS_BY_GLYPH[match[1]]
    const content = match[3].trim()
    if (!status || !content) continue
    // The plugin's own `#N` numbering restarts per widget and skips unnumbered rows,
    // so it cannot be used as a React key; the running index stays unique.
    items.push({ id: `${offset + items.length}`, content, status, priority: 'medium' })
  }
  return items
}
