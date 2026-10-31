// 命令面板条目表 —— 从 App.tsx 抽出，行为不变（id / 顺序 / when 条件 / 快捷键读取方式一致）。
// App 只负责把 shell 的动作与状态传进来，条目本身保持纯数据。
import { keybindingStore, type KeybindingAction } from '../store/keybindingStore'
import { layoutStore, paneLayoutStore } from '../store'
import type { PaneControllerState } from '../store/paneControllerStore'
import type { SettingsTab } from '../features/settings/SettingsDialog'
import type { CommandItem } from './CommandPalette'

export interface AppCommandDeps {
  t: (key: string) => string
  openSettings: () => void
  openProject: () => void
  openSettingsTab: (tab: SettingsTab) => void
  handleToggleSidebar: () => void
  handleToggleRightPanel: () => void
  focusedController: PaneControllerState | null
  paneLayout: { focusedPaneId: string | null; isSplit: boolean }
  splitPaneEnabled: boolean
  handleToggleFocusedPaneFullscreen: () => void
  sessionArchive: boolean
}

/**
 * deps 以 thunk 传入：本函数在 App 的 useMemo 里（渲染期）被调用，而
 * react-hooks/refs 不允许把回调句柄当作值直接传进函数。thunk 只是把同一个
 * 对象字面量的求值推迟到函数体第一行，取值时机与直接传对象一致。
 */
export function buildAppCommandItems(getDeps: () => AppCommandDeps): CommandItem[] {
  const {
    t,
    openSettings,
    openProject,
    openSettingsTab,
    handleToggleSidebar,
    handleToggleRightPanel,
    focusedController,
    paneLayout,
    splitPaneEnabled,
    handleToggleFocusedPaneFullscreen,
    sessionArchive,
  } = getDeps()
  const getShortcut = (action: string) => keybindingStore.getKey(action as KeybindingAction)

  return [
    {
      id: 'openSettings',
      label: t('commands:openSettings'),
      description: t('commands:openSettingsDesc'),
      category: t('commands:categories.general'),
      shortcut: getShortcut('openSettings'),
      action: openSettings,
    },
    {
      id: 'openProject',
      label: t('commands:openProject'),
      description: t('commands:openProjectDesc'),
      category: t('commands:categories.general'),
      shortcut: getShortcut('openProject'),
      action: openProject,
    },
    {
      id: 'openSettingsShortcuts',
      label: t('commands:openShortcutsSettings'),
      description: t('commands:openShortcutsSettingsDesc'),
      category: t('commands:categories.general'),
      action: () => {
        openSettingsTab('keybindings')
      },
    },
    {
      id: 'toggleSidebar',
      label: t('commands:toggleSidebar'),
      description: t('commands:toggleSidebarDesc'),
      category: t('commands:categories.general'),
      shortcut: getShortcut('toggleSidebar'),
      action: handleToggleSidebar,
    },
    {
      id: 'toggleRightPanel',
      label: t('commands:toggleRightPanel'),
      description: t('commands:toggleRightPanelDesc'),
      category: t('commands:categories.general'),
      shortcut: getShortcut('toggleRightPanel'),
      action: handleToggleRightPanel,
    },
    {
      id: 'focusInput',
      label: t('commands:focusInput'),
      description: t('commands:focusInputDesc'),
      category: t('commands:categories.general'),
      shortcut: getShortcut('focusInput'),
      action: () => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-input-box] textarea')
        input?.focus()
      },
    },
    {
      id: 'newSession',
      label: t('commands:newSession'),
      description: t('commands:newSessionDesc'),
      category: t('commands:categories.session'),
      shortcut: getShortcut('newSession'),
      action: () => focusedController?.newSession(),
    },
    ...(sessionArchive
      ? [
          {
            id: 'archiveSession',
            label: t('commands:archiveSession'),
            description: t('commands:archiveSessionDesc'),
            category: t('commands:categories.session'),
            shortcut: getShortcut('archiveSession'),
            action: () => focusedController?.archiveSession(),
          },
        ]
      : []),
    {
      id: 'previousSession',
      label: t('commands:previousSession'),
      description: t('commands:previousSessionDesc'),
      category: t('commands:categories.session'),
      shortcut: getShortcut('previousSession'),
      action: () => focusedController?.previousSession(),
    },
    {
      id: 'nextSession',
      label: t('commands:nextSession'),
      description: t('commands:nextSessionDesc'),
      category: t('commands:categories.session'),
      shortcut: getShortcut('nextSession'),
      action: () => focusedController?.nextSession(),
    },
    {
      id: 'toggleTerminal',
      label: t('commands:toggleTerminal'),
      description: t('commands:toggleTerminalDesc'),
      category: t('commands:categories.terminal'),
      shortcut: getShortcut('toggleTerminal'),
      action: () => layoutStore.toggleBottomPanel(),
    },
    {
      id: 'newTerminal',
      label: t('commands:newTerminal'),
      description: t('commands:newTerminalDesc'),
      category: t('commands:categories.terminal'),
      shortcut: getShortcut('newTerminal'),
      action: () => window.dispatchEvent(new Event('piui:new-terminal')),
    },
    {
      id: 'selectModel',
      label: t('commands:selectModel'),
      description: t('commands:selectModelDesc'),
      category: t('commands:categories.model'),
      shortcut: getShortcut('selectModel'),
      action: () => focusedController?.openModelSelector(),
    },
    {
      id: 'toggleAgent',
      label: t('commands:toggleAgent'),
      description: t('commands:toggleAgentDesc'),
      category: t('commands:categories.model'),
      shortcut: getShortcut('toggleAgent'),
      action: () => focusedController?.toggleAgent(),
    },
    {
      id: 'copyLastResponse',
      label: t('commands:copyLastResponse'),
      description: t('commands:copyLastResponseDesc'),
      category: t('commands:categories.message'),
      shortcut: getShortcut('copyLastResponse'),
      action: () => focusedController?.copyLastResponse(),
    },
    {
      id: 'cancelMessage',
      label: t('commands:cancelMessage'),
      description: t('commands:cancelMessageDesc'),
      category: t('commands:categories.message'),
      shortcut: getShortcut('cancelMessage'),
      action: () => focusedController?.cancelMessage(),
      when: () => !!focusedController?.isStreaming,
    },
    // Pane
    {
      id: 'focusNextPane',
      label: t('commands:focusNextPane'),
      description: t('commands:focusNextPaneDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('focusNextPane'),
      action: () => paneLayoutStore.focusNextPane(),
    },
    {
      id: 'focusPrevPane',
      label: t('commands:focusPrevPane'),
      description: t('commands:focusPrevPaneDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('focusPrevPane'),
      action: () => paneLayoutStore.focusPrevPane(),
    },
    {
      id: 'splitRight',
      label: t('commands:splitRight'),
      description: t('commands:splitRightDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('splitRight'),
      action: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'horizontal')
      },
    },
    {
      id: 'splitDown',
      label: t('commands:splitDown'),
      description: t('commands:splitDownDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('splitDown'),
      action: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && splitPaneEnabled) paneLayoutStore.splitPane(pid, 'vertical')
      },
    },
    {
      id: 'closePane',
      label: t('commands:closePane'),
      description: t('commands:closePaneDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('closePane'),
      action: () => {
        const pid = paneLayout.focusedPaneId ?? paneLayoutStore.getFocusedPaneId()
        if (pid && paneLayout.isSplit) paneLayoutStore.closePane(pid)
      },
      when: () => paneLayout.isSplit,
    },
    {
      id: 'togglePaneFullscreen',
      label: t('commands:togglePaneFullscreen'),
      description: t('commands:togglePaneFullscreenDesc'),
      category: t('commands:categories.pane'),
      shortcut: getShortcut('togglePaneFullscreen'),
      action: () => {
        if (paneLayout.isSplit) handleToggleFocusedPaneFullscreen()
      },
      when: () => paneLayout.isSplit,
    },
  ]
}
