import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { InputBoxHandle } from '../../chat/index.js'
import { setPiExtensionEditorState } from '../../../pi/controllers/index.js'
import { extensionUiStore, getEditorTextSource } from '../../../pi/extensionUiStore'

/** 输入框 → worker 编辑器镜像的防抖窗口 */
export const EDITOR_SYNC_DEBOUNCE_MS = 500

export interface PiExtensionEditorBridgeOptions {
  sessionId: string | null
  /** 输入框句柄：扩展 set/paste 与镜像恢复都通过它写入 composer */
  inputBoxRef: RefObject<InputBoxHandle | null>
  /**
   * 已应用到输入框的编辑器文本。由调用方持有并在原位置声明——fork seed
   * effect 要先于本 hook 的镜像回填 effect 运行，所以这个 ref 必须留在
   * 调用方「更早」的位置上，而不是在 hook 内部新建。
   */
  lastEditorTextRef: RefObject<string | undefined>
  /** 会话不可用（404 / 加载失败）时不再向服务端同步编辑器状态 */
  sessionUnavailableRef: RefObject<boolean>
  /** 会话 / 服务器身份；变化时取消防抖中的同步（切换、卸载） */
  resetKey?: string
}

export interface PiExtensionEditorBridge {
  /** InputBox 的 onTextChange：记录本地最新文本 + 500ms 防抖同步到 worker */
  handleTextChange: (text: string) => void
  /** 取消挂起的输入同步防抖 */
  cancelEditorSync: () => void
  /** 发送前清理：先取消防抖，再清空 worker 编辑器状态（顺序不可换） */
  clearExtensionEditorState: (targetSessionId: string) => void
}

/**
 * 扩展 editor 镜像桥接。
 *
 * 双向：worker 的 `editorText` 镜像 → 输入框（恢复场景）；输入框 → worker
 * （500ms 防抖）。镜像必然滞后于用户正在敲的内容，所以只有「本挂载里还没
 * 输入过」或扩展真实发出 set/paste（source='extension'）时才允许回填，
 * 否则输入框会被打回旧文本。发送前必须先取消防抖、再清空 worker 状态，
 * 否则 500ms 后旧文本被写回 worker，下一次 state 刷新又会把它回填进输入框。
 *
 * 生效顺序约定：调用点必须排在 fork seed effect 之后（PiChatPane 里的原
 * 位置），镜像回填才是「后跑」的那一个；否则旧镜像会先于种子回填输入框。
 */
export function usePiExtensionEditorBridge({
  sessionId,
  inputBoxRef,
  lastEditorTextRef,
  sessionUnavailableRef,
  resetKey,
}: PiExtensionEditorBridgeOptions): PiExtensionEditorBridge {
  const extensionState = useSyncExternalStore(
    extensionUiStore.subscribe,
    () => (sessionId ? extensionUiStore.getSnapshot().sessions[sessionId]?.state : undefined),
    () => undefined,
  )
  // 输入框的本地最新文本（onTextChange 每次变化都记录）。桥接层用它与
  // worker 镜像比较，防止滞后的镜像把用户正在编辑的内容打回旧值。
  const localComposerTextRef = useRef<string | undefined>(undefined)
  const composerMountedRef = useRef(false)
  const editorSyncTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!extensionState || extensionState.editorText === lastEditorTextRef.current) return
    const source = getEditorTextSource(sessionId)
    // 镜像回填只服务于恢复场景（页面刷新/重连后输入框为空）。它来自
    // state 刷新——本地 → worker 有 500ms 防抖同步窗口，镜像必然滞后：
    // 只要用户在本挂载里输入/删除过内容（localComposerTextRef 已记录且
    // 与镜像不同），就跳过回填，否则输入框会被反复打回旧文本。
    // 扩展真实发出的 editor set/paste 事件（'extension'）不受此限。
    const localText = localComposerTextRef.current
    if (source === 'mirror' && localText !== undefined && localText !== extensionState.editorText) {
      lastEditorTextRef.current = localText
      return
    }
    lastEditorTextRef.current = extensionState.editorText
    inputBoxRef.current?.setEditorText(extensionState.editorText)
  }, [extensionState, sessionId, inputBoxRef, lastEditorTextRef])

  const cancelEditorSync = useCallback(() => {
    if (editorSyncTimerRef.current !== null) {
      window.clearTimeout(editorSyncTimerRef.current)
      editorSyncTimerRef.current = null
    }
  }, [])

  // 会话 / 服务器切换与卸载：取消挂起的同步（只清 cleanup，不额外跳过一次同步）
  useEffect(() => () => cancelEditorSync(), [sessionId, resetKey, cancelEditorSync])

  const handleTextChange = useCallback(
    (text: string) => {
      // 忽略 InputBox 挂载时的回显（首次渲染触发 onTextChange('')，不是
      // 用户输入）；从真实输入开始记录本地最新文本，供镜像回填判断。
      if (!composerMountedRef.current) {
        composerMountedRef.current = true
        if (text === '') return
      }
      localComposerTextRef.current = text
      // 会话已不可用时别再往服务端同步编辑器状态（每敲一个字一个 404）
      if (!sessionId || sessionUnavailableRef.current) return
      cancelEditorSync()
      editorSyncTimerRef.current = window.setTimeout(() => {
        editorSyncTimerRef.current = null
        void setPiExtensionEditorState(sessionId, text).catch(() => undefined)
      }, EDITOR_SYNC_DEBOUNCE_MS)
    },
    [sessionId, sessionUnavailableRef, cancelEditorSync],
  )

  const clearExtensionEditorState = useCallback(
    (targetSessionId: string) => {
      cancelEditorSync()
      void setPiExtensionEditorState(targetSessionId, '').catch(() => undefined)
    },
    [cancelEditorSync],
  )

  return { handleTextChange, cancelEditorSync, clearExtensionEditorState }
}
