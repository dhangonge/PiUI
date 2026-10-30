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
  /** 会话不可用（404 / 加载失败）时不再向服务端同步编辑器状态 */
  sessionUnavailable?: boolean
}

export interface PiExtensionEditorBridge {
  /** InputBox 的 onTextChange：记录本地最新文本 + 500ms 防抖同步到 worker */
  handleTextChange: (text: string) => void
  /** 外部（fork 种子 / 树导航）已经把文本同步进 worker 时，登记为已知镜像值 */
  setLastEditorText: (text: string) => void
  /** 取消挂起的输入同步防抖（会话 / 服务器切换、卸载） */
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
 */
export function usePiExtensionEditorBridge({
  sessionId,
  inputBoxRef,
  sessionUnavailable = false,
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
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  const editorSyncTimerRef = useRef<number | null>(null)
  const sessionUnavailableRef = useRef(false)
  useEffect(() => {
    sessionUnavailableRef.current = sessionUnavailable
  })

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
  }, [extensionState, sessionId, inputBoxRef])

  const cancelEditorSync = useCallback(() => {
    if (editorSyncTimerRef.current !== null) {
      window.clearTimeout(editorSyncTimerRef.current)
      editorSyncTimerRef.current = null
    }
  }, [])

  // 卸载取消挂起的同步（会话/服务器切换的清理由调用方用同一函数处理）
  useEffect(() => cancelEditorSync, [cancelEditorSync])

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
    [sessionId, cancelEditorSync],
  )

  const setLastEditorText = useCallback((text: string) => {
    lastEditorTextRef.current = text
  }, [])

  const clearExtensionEditorState = useCallback(
    (targetSessionId: string) => {
      cancelEditorSync()
      void setPiExtensionEditorState(targetSessionId, '').catch(() => undefined)
    },
    [cancelEditorSync],
  )

  return { handleTextChange, setLastEditorText, cancelEditorSync, clearExtensionEditorState }
}
