// 会话列表的展示零件：拉不到的置顶行、加载指示器。从 SessionList.tsx 原样搬出（样式未改动）。
import { useTranslation } from 'react-i18next'
import { PinIcon, SpinnerIcon } from '../../components/Icons'
import { pinnedSessionsStore, type PinnedSessionEntry } from '../../store/pinnedSessionsStore'

// ============================================
// Unavailable pinned (gray title, unpin only)
// ============================================

export function UnavailablePinnedSessionItem({
  entry,
  density = 'default',
}: {
  entry: PinnedSessionEntry
  density?: 'default' | 'compact' | 'minimal'
}) {
  const { t } = useTranslation(['commands'])
  const title = entry.title || entry.sessionId.slice(0, 12) + '...'
  const isCompact = density === 'compact'
  const padding = isCompact ? 'pl-[6px] pr-3 py-2' : 'px-3 py-2.5'

  return (
    <div className={`group relative flex items-start ${padding} border border-transparent`}>
      <div className="flex-1 min-w-0 mr-1 group-hover:mr-8 transition-[margin] duration-200">
        <p
          className={`${isCompact ? 'text-[length:var(--fs-md)]' : 'text-[length:var(--fs-base)]'} truncate font-medium text-text-500`}
          title={title}
        >
          {title}
        </p>
        <div
          className={`flex items-center ${isCompact ? 'mt-1' : 'mt-1.5'} h-4 text-[length:var(--fs-xxs)] text-text-500`}
        >
          <span>{t('sessions.unavailable')}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation()
          pinnedSessionsStore.unpin(entry.sessionId)
        }}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-accent-main-100 hover:text-accent-main-200 opacity-0 group-hover:opacity-100 transition-colors"
        title={t('sessions.unpin')}
        aria-label={t('sessions.unpin')}
      >
        <PinIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// ============================================
// Loading Spinner
// ============================================

export function LoadingSpinner({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const sizeClass = size === 'sm' ? 'w-3 h-3' : 'w-5 h-5'
  return <SpinnerIcon className={`animate-spin text-text-400 ${sizeClass}`} size={size === 'sm' ? 12 : 20} />
}
