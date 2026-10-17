import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PanelRightIcon,
  PanelBottomIcon,
  ChevronDownIcon,
  SidebarIcon,
  SplitHorizontalIcon,
  MaximizeIcon,
  MinimizeIcon,
  PencilIcon,
  CopyIcon,
} from '../../components/Icons'
import { DropdownMenu, IconButton, MenuItem } from '../../components/ui'
import { ModelSelector, type ModelSelectorHandle } from './ModelSelector'
import { usePiCapabilities } from '../../pi/capabilities'
import { useLayoutStore, layoutStore } from '../../store/layoutStore'
import { useSessionContext } from '../../contexts/useSessionContext'
import { renamePiSession, loadPiSessions } from '../../pi/controllers/index.js'
import { usePiSessionTitle } from '../../pi/hooks/index.js'
import { uiErrorHandler } from '../../utils'
import { copyTextToClipboard } from '../../utils/clipboard'
import { sessionKeyToServerId, sessionKeyToSessionId } from '../../utils/sessionKey'
import { useChatViewport } from './chatViewport'
import type { Model, Api } from '@earendil-works/pi-ai'

type ModelInfo = Model<Api>

interface HeaderProps {
  /** Owning pane's session (null on home) — drives title/meta */
  sessionId: string | null
  models: ModelInfo[]
  modelsLoading: boolean
  selectedModelKey: string | null
  onModelChange: (modelKey: string, model: ModelInfo) => void
  onOpenSidebar?: () => void
  onToggleRightPanel?: () => void
  onSplitPane?: () => void
  isPaneFullscreen?: boolean
  onTogglePaneFullscreen?: () => void
  modelSelectorRef?: React.RefObject<ModelSelectorHandle | null>
}

interface SessionTitleControlProps {
  compact: boolean
  isEditingTitle: boolean
  editTitle: string
  sessionTitle: string
  titleInputRef: React.RefObject<HTMLInputElement | null>
  setEditTitle: (value: string) => void
  setIsEditingTitle: (value: boolean) => void
  handleRename: () => void
  handleStartEdit: () => void
  canRename: boolean
  onRename: () => void
  onCopyId: () => void
  clickToRenameTitle: string
  moreActionsTitle: string
  renameTitle: string
  copyIdTitle: string
}

function SessionTitleControl({
  compact,
  isEditingTitle,
  editTitle,
  sessionTitle,
  titleInputRef,
  setEditTitle,
  setIsEditingTitle,
  handleRename,
  handleStartEdit,
  canRename,
  onRename,
  onCopyId,
  clickToRenameTitle,
  moreActionsTitle,
  renameTitle,
  copyIdTitle,
}: SessionTitleControlProps) {
  // 标题右侧的 chevron 是「会话操作」入口：重命名 / 复制会话 ID 都收进这个菜单，
  // 不再单独占按钮（OCUI f4a7d7c4 同款；它的导出/移动到别处 Pi 没有对应数据源）。
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const pick = (action: () => void) => {
    setMenuOpen(false)
    action()
  }

  const inputClass = compact
    ? 'px-2 py-1.5 text-[length:var(--fs-base)] font-medium text-text-100 bg-transparent border-none outline-none w-[160px] h-full'
    : 'px-3 py-1.5 text-[length:var(--fs-base)] font-medium text-text-100 bg-transparent border-none outline-none w-[200px] lg:w-[300px] h-full text-center'
  const buttonClass = compact
    ? 'px-2 py-1.5 text-[length:var(--fs-base)] font-medium text-text-200 hover:text-text-100 transition-colors truncate max-w-[200px] cursor-text select-none'
    : 'px-3 py-1.5 text-[length:var(--fs-base)] font-medium text-text-200 hover:text-text-100 transition-colors truncate max-w-[300px] cursor-text select-none text-center'
  const dividerClass = compact
    ? 'w-[1.5px] h-3 bg-border-200/50 mx-0.5 shrink-0'
    : 'w-[1.5px] h-3 bg-border-200/50 mx-0.5 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(any-pointer:coarse)]:opacity-100 transition-opacity'
  const menuButtonClass = compact
    ? 'p-1 text-text-400 hover:text-text-100 transition-colors rounded-md hover:bg-bg-300/50 shrink-0'
    : 'p-1 text-text-400 hover:text-text-100 transition-colors rounded-md hover:bg-bg-300/50 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(any-pointer:coarse)]:opacity-100 shrink-0'

  return (
    <div
      className={`flex items-center group ${isEditingTitle ? 'bg-bg-200/50 ring-1 ring-accent-main-100' : 'bg-transparent hover:bg-bg-200/50 border border-transparent hover:border-border-200/50'} rounded-lg transition-all duration-200 p-0.5 min-w-0 shrink`}
    >
      {isEditingTitle ? (
        <input
          ref={titleInputRef}
          type="text"
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          onBlur={handleRename}
          onKeyDown={e => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setIsEditingTitle(false)
          }}
          className={inputClass}
        />
      ) : canRename ? (
        <button type="button" onClick={handleStartEdit} className={buttonClass} title={clickToRenameTitle}>
          {sessionTitle}
        </button>
      ) : (
        <span className={buttonClass.replace('cursor-text', 'cursor-default')}>{sessionTitle}</span>
      )}

      {!isEditingTitle && (
        <>
          <div className={`${dividerClass} ${menuOpen ? 'opacity-100' : ''}`} />
          <button
            ref={triggerRef}
            type="button"
            className={`${menuButtonClass} ${menuOpen ? 'opacity-100' : ''}`}
            title={moreActionsTitle}
            aria-label={moreActionsTitle}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(v => !v)}
          >
            <ChevronDownIcon size={12} />
          </button>
          <DropdownMenu
            triggerRef={triggerRef}
            isOpen={menuOpen}
            position="bottom"
            align="left"
            minWidth="208px"
            mobileFullWidth
          >
            <div ref={menuRef} role="menu" aria-label={moreActionsTitle} className="p-1">
              <MenuItem
                label={renameTitle}
                icon={<PencilIcon size={14} />}
                disabled={!canRename}
                onClick={() => pick(onRename)}
              />
              <MenuItem label={copyIdTitle} icon={<CopyIcon size={14} />} onClick={() => pick(onCopyId)} />
            </div>
          </DropdownMenu>
        </>
      )}
    </div>
  )
}

export function Header({
  sessionId,
  models,
  modelsLoading,
  selectedModelKey,
  onModelChange,
  onOpenSidebar,
  onToggleRightPanel,
  onSplitPane,
  isPaneFullscreen = false,
  onTogglePaneFullscreen,
  modelSelectorRef,
}: HeaderProps) {
  const { t } = useTranslation('chat')
  const currentSessionTitle = usePiSessionTitle(sessionId)
  const { rightPanelOpen, bottomPanelOpen } = useLayoutStore()
  const { refresh, sessions } = useSessionContext()
  const { presentation, interaction } = useChatViewport()
  const capabilities = usePiCapabilities()

  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // 与侧边栏统一消费同一份列表：新会话落盘前 piSessionInfoStore 的
  // 全局桶不会有它，标题不能卡在 "New chat"
  const listedTitle = useMemo(() => {
    if (!sessionId) return null
    const listed = sessions.find(session => session.id === sessionId)
    return listed?.title?.trim() || listed?.firstMessage?.trim() || null
  }, [sessionId, sessions])
  const sessionTitle = currentSessionTitle || listedTitle || t('header.newChat')
  const isCompact = presentation.isCompact

  useEffect(() => {
    const docTitle = currentSessionTitle || listedTitle
    document.title = docTitle ? `${docTitle} - Pi` : 'Pi'
    return () => {
      document.title = 'Pi'
    }
  }, [currentSessionTitle, listedTitle])

  // 会话切换时重置标题编辑状态：setIsEditingTitle 是父组件的 setter，
  // 无法用渲染期调整表达，属「响应 prop 变化的外部同步」
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setIsEditingTitle(false)
  }, [sessionId])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus()
      titleInputRef.current.select()
    }
  }, [isEditingTitle])

  const handleStartEdit = () => {
    if (!sessionId || !capabilities.sessionRename) return
    setEditTitle(sessionTitle)
    setIsEditingTitle(true)
  }

  const handleRename = async () => {
    if (!sessionId || !editTitle.trim() || editTitle === sessionTitle) {
      setIsEditingTitle(false)
      return
    }
    try {
      await renamePiSession(sessionId, editTitle.trim())
      void loadPiSessions(undefined, sessionKeyToServerId(sessionId)).catch(() => undefined)
      refresh()
    } catch (e) {
      uiErrorHandler('rename session', e)
    } finally {
      setIsEditingTitle(false)
    }
  }

  const handleCopySessionId = async () => {
    if (!sessionId) return
    try {
      await copyTextToClipboard(sessionKeyToSessionId(sessionId))
    } catch (e) {
      uiErrorHandler('copy session id', e)
    }
  }

  const titleControl = (
    <SessionTitleControl
      compact={isCompact}
      isEditingTitle={isEditingTitle}
      editTitle={editTitle}
      sessionTitle={sessionTitle}
      titleInputRef={titleInputRef}
      setEditTitle={setEditTitle}
      setIsEditingTitle={setIsEditingTitle}
      handleRename={handleRename}
      handleStartEdit={handleStartEdit}
      canRename={capabilities.sessionRename}
      onRename={handleStartEdit}
      onCopyId={() => void handleCopySessionId()}
      clickToRenameTitle={t('header.clickToRename')}
      moreActionsTitle={t('header.moreActions')}
      renameTitle={t('header.renameSession')}
      copyIdTitle={t('header.copySessionId')}
    />
  )

  return (
    <div
      className={`mobile-safe-topbar-14 flex justify-between items-center z-20 bg-bg-100 transition-colors duration-200 relative ${isCompact ? 'px-2' : 'px-4'}`}
    >
      <div className="flex items-center gap-2 min-w-0 shrink-1 z-20">
        {interaction.sidebarBehavior === 'overlay' && onOpenSidebar && (
          <IconButton
            aria-label={t('header.openSidebar')}
            onClick={onOpenSidebar}
            className="hover:bg-bg-200/50 text-text-300 hover:text-text-100"
          >
            <SidebarIcon size={16} />
          </IconButton>
        )}

        {!isCompact && (
          <ModelSelector
            ref={modelSelectorRef}
            models={models}
            selectedModelKey={selectedModelKey}
            onSelect={onModelChange}
            isLoading={modelsLoading}
          />
        )}

        {isCompact && <div className="min-w-0">{titleControl}</div>}
      </div>

      {!isCompact && <div className="absolute left-1/2 -translate-x-1/2 flex z-20">{titleControl}</div>}

      <div className="flex items-center gap-1 pointer-events-auto shrink-0 z-20">
        <div className="flex items-center gap-0.5">
          {onTogglePaneFullscreen && (
            <IconButton
              aria-label={isPaneFullscreen ? t('header.exitFullscreenPane') : t('header.fullscreenPane')}
              onClick={onTogglePaneFullscreen}
              className={`transition-colors ${
                isPaneFullscreen
                  ? 'text-accent-main-100 bg-bg-200/50'
                  : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'
              }`}
            >
              {isPaneFullscreen ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
            </IconButton>
          )}

          {onSplitPane && (
            <IconButton
              aria-label={t('header.splitPane')}
              onClick={onSplitPane}
              className="transition-colors text-text-300 hover:text-text-100 hover:bg-bg-200/50"
            >
              <SplitHorizontalIcon size={16} />
            </IconButton>
          )}

          <IconButton
            aria-label={bottomPanelOpen ? t('header.closeBottomPanel') : t('header.openBottomPanel')}
            onClick={() => layoutStore.toggleBottomPanel()}
            className={`transition-colors ${bottomPanelOpen ? 'text-accent-main-100 bg-bg-200/50' : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'}`}
          >
            <PanelBottomIcon size={16} />
          </IconButton>

          <IconButton
            aria-label={rightPanelOpen ? t('header.closePanel') : t('header.openPanel')}
            onClick={onToggleRightPanel ?? (() => layoutStore.toggleRightPanel())}
            className={`transition-colors ${rightPanelOpen ? 'text-accent-main-100 bg-bg-200/50' : 'text-text-300 hover:text-text-100 hover:bg-bg-200/50'}`}
          >
            <PanelRightIcon size={16} />
          </IconButton>
        </div>
      </div>

      <div
        data-chat-header-shadow
        className="absolute top-full left-0 right-0 h-8 bg-bg-100 pointer-events-none z-10 [-webkit-mask-image:linear-gradient(to_bottom,black,transparent)] [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />
    </div>
  )
}
