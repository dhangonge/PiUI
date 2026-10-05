import { useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { extensionUiStore } from '../pi/extensionUiStore'
import { ChevronDownIcon } from './Icons'
import { stripAnsi } from '../utils/ansiUtils'

/** Read-only widget snapshots; actions remain owned by the extension. */
export function ExtensionWidgets({ sessionId, placement }: { sessionId: string | null; placement: 'aboveEditor' | 'belowEditor' }) {
  const { t } = useTranslation('components')
  const [expanded, setExpanded] = useState(true)
  const snapshot = useSyncExternalStore(extensionUiStore.subscribe, extensionUiStore.getSnapshot, extensionUiStore.getSnapshot)
  const widgets = Object.entries(sessionId ? snapshot.sessions[sessionId]?.state.widgets ?? {} : {})
    .filter(([, widget]) => widget.placement === placement && widget.lines.some(line => stripAnsi(line).trim()))
  if (!widgets.length) return null
  return (
    <section className="mx-3 mb-2 overflow-hidden rounded-lg border border-border-200/60 bg-bg-100" aria-label={t('extensionWidgets.title')}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="flex w-full items-center justify-between px-3 py-2 text-[length:var(--fs-xs)] text-text-300 hover:bg-bg-200/50">
        <span>{t('extensionWidgets.title')} <span className="text-text-500">{widgets.length}</span></span>
        <ChevronDownIcon size={14} className={expanded ? '' : '-rotate-90'} />
      </button>
      {expanded && <div className="max-h-[28dvh] overflow-auto custom-scrollbar px-3 pb-2">
        {widgets.map(([key, widget]) => <pre key={key} aria-label={stripAnsi(key)} className="whitespace-pre-wrap break-words font-mono text-[length:var(--fs-xs)] text-text-200">{stripAnsi(widget.lines.join('\n'))}</pre>)}
      </div>}
    </section>
  )
}
