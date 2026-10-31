import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { layoutStore, type PanelPosition } from '../store/layoutStore'
import { notificationStore } from '../store/notificationStore'
import { serverStore } from '../store/serverStore'
import { createHostTerminal, listHostTerminals, removeHostTerminal, updateHostTerminal } from '../pi/transport/index.js'
import { resolveWorkspacePath } from '../pi/workspaces'
import { getServerRevision, makeSessionKey, splitSessionKey } from '../utils/sessionKey'
import { serverStorage, uiErrorHandler } from '../utils'

export function useTerminalActions(
  directory: string | undefined,
  serverId: string | undefined,
  position: PanelPosition,
) {
  const { t } = useTranslation('components')
  const handleNewTerminal = useCallback(async () => {
    if (!serverId) return
    const revision = getServerRevision(serverId)
    try {
      const workspacePath = await resolveWorkspacePath(directory, serverId)
      if (!workspacePath) throw new Error('no workspace available')
      const shell = serverStorage.getFor('piui-terminal-shell', serverId) || undefined
      const terminal = await createHostTerminal(workspacePath, { shell }, undefined, serverId)
      if (serverStore.getActiveServerId() !== serverId || getServerRevision(serverId) !== revision) return
      layoutStore.setCurrentTerminalDirectory(workspacePath, serverId)
      layoutStore.addTerminalTab(
        {
          id: makeSessionKey(serverId, terminal.id),
          workspacePath,
          title: terminal.title,
          shell: terminal.shell,
          cwd: terminal.cwd,
          status: 'connecting',
        },
        true,
        position,
      )
    } catch (error) {
      uiErrorHandler('create terminal', error)
      notificationStore.push(
        'error',
        t('terminal.createTerminalFailed'),
        error instanceof Error ? error.message : String(error),
        '',
      )
    }
  }, [directory, serverId, position, t])

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      const owner = splitSessionKey(terminalId).serverId
      const revision = getServerRevision(owner)
      const tab = layoutStore.getState().panelTabs.find(item => item.id === terminalId)
      const path = tab?.workspacePath ?? directory
      try {
        const workspacePath = await resolveWorkspacePath(path, owner)
        if (!workspacePath) return
        await removeHostTerminal(workspacePath, terminalId, undefined, owner)
      } catch (error) {
        uiErrorHandler('close terminal', error)
        try {
          const workspacePath = await resolveWorkspacePath(path, owner)
          if (!workspacePath) return
          const result = await listHostTerminals(workspacePath, undefined, owner)
          if (serverStore.getActiveServerId() === owner && getServerRevision(owner) === revision) {
            layoutStore.syncTerminalSessions(workspacePath, result.terminals, owner)
          }
        } catch {
          // A later workspace refresh can restore the tab if the server is offline.
        }
      }
    },
    [directory],
  )

  const handleRenameTerminal = useCallback(
    async (terminalId: string, title: string) => {
      const owner = splitSessionKey(terminalId).serverId
      const revision = getServerRevision(owner)
      const tab = layoutStore.getState().panelTabs.find(item => item.id === terminalId)
      const workspacePath = await resolveWorkspacePath(tab?.workspacePath ?? directory, owner)
      if (!workspacePath) return
      const terminal = await updateHostTerminal(workspacePath, terminalId, { title }, undefined, owner)
      if (getServerRevision(owner) === revision) layoutStore.updateTerminalCustomTitle(terminalId, terminal.title)
    },
    [directory],
  )

  return { handleNewTerminal, handleCloseTerminal, handleRenameTerminal }
}
