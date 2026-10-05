import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessions } from '../../../hooks/useSessions'
import { useServerStore } from '../../../hooks/useServerStore'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { useRouter } from '../../../hooks/useRouter'
import { useMultiServerStore, multiServerStore } from '../../../store/multiServerStore'
import { serverStore, type ServerConfig } from '../../../store/serverStore'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'
import { getStorageVersion, subscribePerServerStorageVersion } from '../../../utils/perServerStorage'
import { readServerWorkspaces } from '../../../utils/serverWorkspaces'
import { getDirectoryName, uiErrorHandler } from '../../../utils'
import { renamePiSession } from '../../../pi/controllers'
import { SessionListItem } from '../../sessions/SessionList'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { FolderIcon, PlusIcon, SpinnerIcon, RetryIcon } from '../../../components/Icons'
import type { UiSession } from '../../../types/session'

interface Props {
  selectedSessionId: string | null
  search: string
  onSelectSession: (session: UiSession) => void
  onAddProject: () => void
  onNewSession: () => void
}

function ServerSection({ server, ...props }: Props & { server: ServerConfig }) {
  const { t } = useTranslation(['chat', 'settings', 'common'])
  const { preferTouchUi } = useInputCapabilities()
  const { setDirectory } = useRouter()
  const { sessions, isLoading, error, refresh, search, setSearch, remove: deleteSession, patchLocalSession: updateSession, hasMore, loadMore } = useSessions({ serverId: server.id, pageSize: 30 })
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const storageVersion = useSyncExternalStore(subscribePerServerStorageVersion, getStorageVersion)
  const pins = useSyncExternalStore(pinnedSessionsStore.subscribe, pinnedSessionsStore.getScopedSnapshot)
  useEffect(() => { if (search !== props.search) setSearch(props.search) }, [props.search, search, setSearch])
  const groups = useMemo(() => {
    void storageVersion
    const byDirectory = new Map<string, UiSession[]>()
    if (!props.search) for (const directory of readServerWorkspaces(server.id)) byDirectory.set(directory, [])
    for (const session of sessions) {
      const group = byDirectory.get(session.directory) ?? []
      group.push(session)
      byDirectory.set(session.directory, group)
    }
    const pinned = new Set(pins.map(pin => pin.sessionId))
    return [...byDirectory].map(([directory, items]) => ({ directory, items: items.sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id))) }))
  }, [server.id, sessions, props.search, storageVersion, pins])

  const focus = (directory?: string) => {
    serverStore.setActiveServer(server.id)
    multiServerStore.setFocusedServerId(server.id)
    setDirectory(directory)
  }

  return <section className="border-b border-border-200/40 pb-3 mb-2" aria-label={server.name}>
    <div className="flex items-center gap-2 px-2 py-2">
      <button className="min-w-0 flex-1 text-left truncate text-[length:var(--fs-sm)] font-semibold text-text-200" onClick={() => focus()}>{server.name}</button>
      {isLoading && <SpinnerIcon size={12} className="animate-spin text-text-400" />}
      <button type="button" className="p-1.5 text-text-400 hover:text-text-100" aria-label={`${t('common:refresh')} ${server.name}`} onClick={() => void refresh()}><RetryIcon size={13} /></button>
      <button type="button" className="p-1.5 text-text-400 hover:text-text-100" aria-label={`${t('common:add')} ${server.name}`} onClick={() => { focus(); props.onAddProject() }}><PlusIcon size={13} /></button>
    </div>
    {error && <button className="mx-2 text-[length:var(--fs-xs)] text-danger-100" onClick={() => void refresh()}>{t('sidebar.loadFailed')} · {t('common:retry')}</button>}
    {!isLoading && !error && groups.length === 0 && <p className="px-2 text-text-400 text-[length:var(--fs-xs)]">{t('common:noMatchesFound')}</p>}
    {groups.map(({ directory, items }) => <details key={directory} open className="group mb-1">
      <summary className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-text-400 text-[length:var(--fs-xs)]">
        <FolderIcon size={13} /><span className="flex-1 truncate" title={directory}>{getDirectoryName(directory) || directory}</span>
        <button type="button" className="p-1" aria-label={`${t('sessions.newChat', { ns: 'commands' })} ${directory}`} onClick={event => { event.preventDefault(); focus(directory); props.onNewSession() }}><PlusIcon size={12} /></button>
      </summary>
      {items.map(session => <SessionListItem key={session.id} session={session} isSelected={props.selectedSessionId === session.id} preferTouchUi={preferTouchUi} density="compact"
        onSelect={() => props.onSelectSession(session)} onDelete={() => setDeleteId(session.id)}
        onRename={title => { void renamePiSession(session.id, title).then(() => { updateSession(session.id, { title }); pinnedSessionsStore.update(session.id, { title }) }).catch(error => uiErrorHandler('rename session', error)) }} />)}
    </details>)}
    {hasMore && <button className="px-2 py-2 text-text-400 text-[length:var(--fs-xs)]" onClick={() => void loadMore()}>{t('common:loadMore')}</button>}
    <ConfirmDialog isOpen={deleteId !== null} onClose={() => setDeleteId(null)} title={t('common:delete')} description={t('sidebar.deleteChatConfirm')} variant="danger"
      onConfirm={() => { if (deleteId) void deleteSession(deleteId).then(() => pinnedSessionsStore.unpin(deleteId)).catch(error => uiErrorHandler('delete session', error)); setDeleteId(null) }} />
  </section>
}

export function MultiServerFolderList(props: Props) {
  const { servers } = useServerStore()
  const { serverIds } = useMultiServerStore()
  const { t } = useTranslation('settings')
  return <div className="h-full overflow-y-auto custom-scrollbar px-2 pb-3">
    {serverIds.length === 0 && <p className="text-text-400 text-[length:var(--fs-sm)] p-2">{t('servers.multiServerModeOffHint')}</p>}
    {servers.filter(server => serverIds.includes(server.id)).map(server => <ServerSection key={server.id} server={server} {...props} />)}
  </div>
}
