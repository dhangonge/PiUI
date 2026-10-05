import { useMemo, useSyncExternalStore } from 'react'
import { extensionUiStore } from '../pi/extensionUiStore'
import { TodoList, type TodoItem } from '../features/message/tools/renderers/TodoRenderer'
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
 * surfaced here and it reuses the tool-result list presentation, so both look
 * the same as the rest of the app. Other widget mirrors stay in the extensions
 * panel instead of crowding the composer.
 */
export function TodoWidget({ sessionId }: { sessionId: string | null }) {
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
  return (
    <div className="mx-3 mb-2">
      <TodoList todos={parsed.todos} stateKey={`todo-widget:${sessionId ?? ''}`} counts={parsed.counts} />
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
    items.push({ id: match[2] ?? `${offset + items.length}`, content, status, priority: 'medium' })
  }
  return items
}
