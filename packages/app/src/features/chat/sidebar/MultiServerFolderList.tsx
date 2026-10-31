import { memo, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useSessions } from '../../../hooks/useSessions'
import { useServerStore } from '../../../hooks/useServerStore'
import { useInputCapabilities } from '../../../hooks/useInputCapabilities'
import { useRouter } from '../../../hooks/useRouter'
import { useMultiServerStore, multiServerStore } from '../../../store/multiServerStore'
import { serverStore, type ServerConfig } from '../../../store/serverStore'
import { pinnedSessionsStore } from '../../../store/pinnedSessionsStore'
import { getStorageVersion, subscribePerServerStorageVersion } from '../../../utils/perServerStorage'
import { readServerWorkspaces, reorderServerWorkspaces } from '../../../utils/serverWorkspaces'
import { filterPiSessionList } from '../../../pi/nativeSessionListModel'
import { getDirectoryName, uiErrorHandler } from '../../../utils'
import { renamePiSession } from '../../../pi/controllers'
import { SessionRowWithChildren } from './SessionRowWithChildren'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { FolderIcon, PlusIcon, SpinnerIcon, RetryIcon, ArrowUpIcon, ArrowDownIcon } from '../../../components/Icons'
import type { UiSession } from '../../../types/session'

interface Props {
  selectedSessionId: string | null
  search: string
  onSelectSession: (session: UiSession) => void
  onAddProject: () => void
  onNewSession: () => void
}

const ServerSection = memo(function ServerSection({ server, ...props }: Props & { server: ServerConfig }) {
  const { t } = useTranslation(['chat', 'settings', 'common'])
  const { preferTouchUi } = useInputCapabilities()
  const { setDirectory, directory: currentDirectory } = useRouter()
  const query = props.search.trim().toLowerCase()
  const {
    sessions,
    isLoading,
    error,
    refresh,
    remove: deleteSession,
    patchLocalSession: updateSession,
    hasMore,
    loadMore,
    subagentChildrenByParentId,
  } = useSessions({
    serverId: server.id,
    pageSize: query ? Number.MAX_SAFE_INTEGER : 30,
    groupSubagentSessions: true,
  })
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const storageVersion = useSyncExternalStore(subscribePerServerStorageVersion, getStorageVersion)
  const pins = useSyncExternalStore(pinnedSessionsStore.subscribe, pinnedSessionsStore.getScopedSnapshot)
  const savedDirectories = useMemo(() => {
    void storageVersion
    return readServerWorkspaces(server.id)
  }, [server.id, storageVersion])
  const groups = useMemo(() => {
    const serverMatches = !query || `${server.name} ${server.url}`.toLowerCase().includes(query)
    const byDirectory = new Map<string, UiSession[]>()
    for (const directory of savedDirectories) byDirectory.set(directory, [])
    for (const session of sessions) {
      const group = byDirectory.get(session.directory) ?? []
      group.push(session)
      byDirectory.set(session.directory, group)
    }
    const pinned = new Set(pins.map(pin => pin.sessionId))
    return [...byDirectory].flatMap(([directory, items]) => {
      const folderMatches = serverMatches || directory.toLowerCase().includes(query)
      const matches = folderMatches ? items : filterPiSessionList(items, query)
      if (!folderMatches && matches.length === 0) return []
      return [{ directory, items: [...matches].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id))) }]
    })
  }, [server.name, server.url, savedDirectories, sessions, query, pins])

  const focus = (directory?: string) => {
    serverStore.setActiveServer(server.id)
    multiServerStore.setFocusedServerId(server.id)
    setDirectory(directory)
  }

  return (
    <section className="border-b border-border-200/40 pb-3 mb-2" aria-label={server.name}>
      <div className="flex items-center gap-2 px-2 py-2">
        <button
          className="min-w-0 flex-1 text-left truncate text-[length:var(--fs-sm)] font-semibold text-text-200"
          onClick={() => focus()}
        >
          {server.name}
        </button>
        {isLoading && <SpinnerIcon size={12} className="animate-spin text-text-400" />}
        <button
          type="button"
          className="p-1.5 text-text-400 hover:text-text-100"
          aria-label={`${t('common:refresh')} ${server.name}`}
          onClick={() => void refresh()}
        >
          <RetryIcon size={13} />
        </button>
        <button
          type="button"
          className="p-1.5 text-text-400 hover:text-text-100"
          aria-label={`${t('common:add')} ${server.name}`}
          onClick={() => {
            focus()
            props.onAddProject()
          }}
        >
          <PlusIcon size={13} />
        </button>
      </div>
      {error && (
        <button className="mx-2 text-[length:var(--fs-xs)] text-danger-100" onClick={() => void refresh()}>
          {t('sidebar.loadFailed')} · {t('common:retry')}
        </button>
      )}
      {!isLoading && !error && groups.length === 0 && (
        <p className="px-2 text-text-400 text-[length:var(--fs-xs)]">{t('common:noMatchesFound')}</p>
      )}
      {groups.map(({ directory, items }) => (
        <details key={directory} open={Boolean(query) || !collapsed.has(directory)} className="group mb-1">
          <summary
            className="flex items-center gap-2 px-2 py-1.5 cursor-pointer text-text-400 text-[length:var(--fs-xs)]"
            onClick={event => {
              event.preventDefault()
              const same = serverStore.getActiveServerId() === server.id && currentDirectory === directory
              if (!same) focus(directory)
              setCollapsed(previous => {
                const next = new Set(previous)
                if (same && !next.has(directory)) next.add(directory)
                else next.delete(directory)
                return next
              })
            }}
          >
            <FolderIcon size={13} />
            <span className="flex-1 truncate" title={directory}>
              {getDirectoryName(directory) || directory}
            </span>
            {!query &&
              savedDirectories.includes(directory) &&
              [-1, 1].map(direction => {
                const index = savedDirectories.indexOf(directory)
                const target = savedDirectories[index + direction]
                return (
                  <button
                    key={direction}
                    type="button"
                    className="p-1 disabled:opacity-25"
                    disabled={!target}
                    aria-label={`${t(direction < 0 ? 'sidebar.moveFolderUp' : 'sidebar.moveFolderDown')} ${directory}`}
                    onClick={event => {
                      event.preventDefault()
                      event.stopPropagation()
                      if (target) reorderServerWorkspaces(server.id, directory, target)
                    }}
                  >
                    {direction < 0 ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
                  </button>
                )
              })}
            <button
              type="button"
              className="p-1"
              aria-label={`${t('sessions.newChat', { ns: 'commands' })} ${directory}`}
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                focus(directory)
                props.onNewSession()
              }}
            >
              <PlusIcon size={12} />
            </button>
          </summary>
          {items.map(session => (
            <SessionRowWithChildren
              key={session.id}
              session={session}
              isSelected={props.selectedSessionId === session.id}
              preferTouchUi={preferTouchUi}
              density="compact"
              onSelect={() => props.onSelectSession(session)}
              onDelete={() => setDeleteId(session.id)}
              onRename={title => {
                void renamePiSession(session.id, title)
                  .then(() => {
                    updateSession(session.id, { title })
                    pinnedSessionsStore.update(session.id, { title })
                  })
                  .catch(error => uiErrorHandler('rename session', error))
              }}
              childrenByParentId={subagentChildrenByParentId}
              selectedSessionId={props.selectedSessionId}
              onSelectChildSession={props.onSelectSession}
            />
          ))}
        </details>
      ))}
      {hasMore && (
        <button className="px-2 py-2 text-text-400 text-[length:var(--fs-xs)]" onClick={() => void loadMore()}>
          {t('common:loadMore')}
        </button>
      )}
      <ConfirmDialog
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title={t('common:delete')}
        description={t('sidebar.deleteChatConfirm')}
        variant="danger"
        onConfirm={() => {
          if (deleteId)
            void deleteSession(deleteId)
              .then(() => pinnedSessionsStore.unpin(deleteId))
              .catch(error => uiErrorHandler('delete session', error))
          setDeleteId(null)
        }}
      />
    </section>
  )
})

export function MultiServerFolderList(props: Props) {
  const { servers } = useServerStore()
  const { serverIds } = useMultiServerStore()
  const { t } = useTranslation('settings')
  return (
    <div className="h-full overflow-y-auto custom-scrollbar px-2 pb-3">
      {serverIds.length === 0 && (
        <p className="text-text-400 text-[length:var(--fs-sm)] p-2">{t('servers.multiServerModeOffHint')}</p>
      )}
      {servers
        .filter(server => serverIds.includes(server.id))
        .map(server => (
          <ServerSection key={server.id} server={server} {...props} />
        ))}
    </div>
  )
}
