import { useCallback, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/Button'
import {
  clearClientErrors,
  formatClientErrorReport,
  getClientErrors,
  subscribeClientErrors,
  type ClientErrorEntry,
} from '../../../store/clientErrorLog'
import { copyTextToClipboard } from '../../../utils'
import { SettingsSection } from './SettingsUI'

const VISIBLE_ENTRIES = 10

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function EntryRow({ entry }: { entry: ClientErrorEntry }) {
  return (
    <div className="min-w-0 rounded-lg bg-bg-200/60 border border-border-100/40 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[length:var(--fs-xs)] text-text-400 font-mono tabular-nums">
        <span>{formatTime(entry.lastAt)}</span>
        <span>{entry.source}</span>
        <span>
          {entry.category}/{entry.operation}
        </span>
        {entry.count > 1 && <span className="text-warning-100">×{entry.count}</span>}
      </div>
      <div className="mt-1 min-w-0 break-words text-[length:var(--fs-sm)] text-text-100 leading-relaxed">
        {entry.message}
      </div>
    </div>
  )
}

/**
 * 诊断卡片：最近记录的客户端错误。
 *
 * 桌面壳和 Android WebView 都没有 devtools，这些错误在界面上原本完全不可见；
 * 留在这里至少能复制出来。条数上限见 clientErrorLog.MAX_CLIENT_ERRORS。
 */
export function DiagnosticsCard() {
  const { t } = useTranslation(['settings'])
  const entries = useSyncExternalStore(subscribeClientErrors, getClientErrors, getClientErrors)
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    void copyTextToClipboard(formatClientErrorReport())
      .then(() => setCopied(true))
      .catch(() => undefined)
  }, [])

  const handleClear = useCallback(() => {
    clearClientErrors()
  }, [])

  const recent = entries.slice(-VISIBLE_ENTRIES).reverse()

  return (
    <SettingsSection title={t('about.diagnosticsCardTitle')} description={t('about.diagnosticsCardDesc')}>
      {entries.length === 0 ? (
        <div className="rounded-lg bg-bg-200/60 border border-border-100/40 px-3.5 py-3 text-[length:var(--fs-sm)] text-text-300">
          {t('about.diagnosticsEmpty')}
        </div>
      ) : (
        <>
          <div className="text-[length:var(--fs-sm)] text-text-300">
            {t('about.diagnosticsCount', { count: entries.length })}
          </div>
          <div className="flex flex-col gap-2">
            {recent.map(entry => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </div>
          {entries.length > recent.length && (
            <div className="text-[length:var(--fs-sm)] text-text-400">
              {t('about.diagnosticsTruncated', { count: entries.length - recent.length })}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? t('about.diagnosticsCopied') : t('about.diagnosticsCopy')}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleClear}>
              {t('about.diagnosticsClear')}
            </Button>
          </div>
        </>
      )}
    </SettingsSection>
  )
}
