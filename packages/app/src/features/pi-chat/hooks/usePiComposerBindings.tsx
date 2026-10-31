import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ReactElement, RefObject } from 'react'
import type { Api, Model } from '@earendil-works/pi-ai'
import type { FileCapabilities } from '../../../types/ui'
import { TodoWidget } from '../../../components/TodoWidget'
import type { ChatAreaHandle } from '../../chat/index.js'
import type { CollapsedDialogInfo } from '../../chat/InputBox.js'
import type { ModelSelectorHandle } from '../../chat/ModelSelector.js'
import {
  abortPiCompaction,
  abortPiOperation,
  cyclePiModel,
  cyclePiThinkingLevel,
  refreshPiSessionState,
} from '../../../pi/controllers/index.js'

/**
 * 输入框（InputBox）边界上的引用稳定层。
 *
 * `InputBox` 是 `memo` 组件，任何一项 prop 引用变化都会整块重渲染。PiChatPane
 * 之前把内联箭头函数、内联对象、内联 JSX 直接写在调用点上：父层每次无关更新
 * （流式 token、滚动、弹窗快照）都会新建这些引用，浅比较必然失配。
 *
 * 这里只做「派生绑定」，不改变任何操作语义：
 * - 值真的变了才换引用（`fileCapabilities` / `models` 浅拷贝 / Todo 插槽 /
 *   折叠胶囊）：依赖列表写全，不用宽比较器，也不冻结更新。
 * - 回调按真实语义给出依赖（`sessionId` / `compacting` 等），行为与原来内联
 *   箭头完全一致。
 * - `onCommand` 是唯一例外：它的实现体随每次流式事件重算（依赖 `items` /
 *   `state`），但它在 InputBox 里只在提交时被调用，是「调用时读取」语义。
 *   所以用 latest-handler ref 转发：引用稳定，但每次调用都走最新实现，
 *   既不会残留旧闭包，也不是把更新冻结掉。
 */
export interface PiComposerBindingsParams {
  sessionId: string | null
  /** 上下文压缩进行中：中止按钮走 abortPiCompaction */
  compacting: boolean
  /** 当前模型是否接受图片输入（home 无会话时按目录里任一模型乐观允许） */
  imageCapable: boolean
  models: readonly Model<Api>[]
  /** 折叠态挂起对话（权限/问答）标题；没有挂起对话时为 undefined */
  collapsedDialogTitle?: string
  collapsedDialogQueueLength: number
  dialogCollapsed: boolean
  /** 折叠态开关（useState setter 本身，引用天然稳定） */
  setDialogCollapsed: (collapsed: boolean) => void
  modelSelectorRef: RefObject<ModelSelectorHandle | null>
  chatAreaRef: RefObject<ChatAreaHandle | null>
  /** redo 已经在 PiChatPane 里按 session / redo 计划做了依赖稳定 */
  onRedoStep: () => Promise<void>
  onRedoAll: () => Promise<void>
  onCommand: (command: string) => Promise<boolean> | boolean
}

export interface PiComposerBindings {
  /** 浅拷贝但引用稳定：只有 models 源数组变化才换 */
  models: Model<Api>[]
  fileCapabilities: FileCapabilities
  /** Todo JSX 插槽：key 仍是 `${sessionId}:todo`，element 引用稳定 */
  todoSlot: ReactElement
  collapsedPermission: CollapsedDialogInfo | undefined
  command: (command: string) => Promise<boolean> | boolean
  cycleModel: (direction: 'forward' | 'backward') => void
  cycleThinkingLevel: () => void
  abort: () => void
  openModelSelector: () => void
  scrollToBottom: () => void
  redo: () => void
  redoAll: () => void
}

export function usePiComposerBindings({
  sessionId,
  compacting,
  imageCapable,
  models,
  collapsedDialogTitle,
  collapsedDialogQueueLength,
  dialogCollapsed,
  setDialogCollapsed,
  modelSelectorRef,
  chatAreaRef,
  onRedoStep,
  onRedoAll,
  onCommand,
}: PiComposerBindingsParams): PiComposerBindings {
  // 浅拷贝保留原接口语义（readonly 输入 → 可变数组给消费方），但只在源数组
  // 变化时换引用；直接写 [...models] 会让 Header / InputBox 每秒重渲染。
  const stableModels = useMemo(() => [...models], [models])

  const fileCapabilities = useMemo<FileCapabilities>(
    () => ({ image: imageCapable, pdf: false, audio: false, video: false }),
    [imageCapable],
  )

  // 插槽 element 一起稳定：InputBox 重渲染时 React 会因同一 element 直接跳过子树
  const todoSlot = useMemo(() => <TodoWidget key={`${sessionId}:todo`} sessionId={sessionId} />, [sessionId])

  // useState 的 setter 引用稳定，这层包装也稳定 → 胶囊对象只在内容变化时换
  const expandCollapsedDialog = useCallback(() => setDialogCollapsed(false), [setDialogCollapsed])
  const collapsedPermission = useMemo<CollapsedDialogInfo | undefined>(() => {
    if (!dialogCollapsed || collapsedDialogTitle === undefined) return undefined
    return {
      label: collapsedDialogTitle,
      queueLength: collapsedDialogQueueLength,
      onExpand: expandCollapsedDialog,
    }
  }, [dialogCollapsed, collapsedDialogTitle, collapsedDialogQueueLength, expandCollapsedDialog])

  // latest-handler ref：渲染期不写 ref，统一在提交后的 effect 同步最新实现
  const commandRef = useRef(onCommand)
  useEffect(() => {
    commandRef.current = onCommand
  })
  const command = useCallback((value: string) => commandRef.current(value), [])

  const cycleModel = useCallback(
    (direction: 'forward' | 'backward') => {
      if (!sessionId) return
      void cyclePiModel(sessionId, direction)
        .then(() => refreshPiSessionState(sessionId))
        .catch(() => undefined)
    },
    [sessionId],
  )

  const cycleThinkingLevel = useCallback(() => {
    if (!sessionId) return
    void cyclePiThinkingLevel(sessionId)
      .then(() => refreshPiSessionState(sessionId))
      .catch(() => undefined)
  }, [sessionId])

  const abort = useCallback(() => {
    if (!sessionId) return
    void (compacting ? abortPiCompaction(sessionId) : abortPiOperation(sessionId)).catch(() => undefined)
  }, [sessionId, compacting])

  const openModelSelector = useCallback(() => {
    modelSelectorRef.current?.openMenu()
  }, [modelSelectorRef])

  const scrollToBottom = useCallback(() => {
    chatAreaRef.current?.scrollToBottom()
  }, [chatAreaRef])

  return useMemo(
    () => ({
      models: stableModels,
      fileCapabilities,
      todoSlot,
      collapsedPermission,
      command,
      cycleModel,
      cycleThinkingLevel,
      abort,
      openModelSelector,
      scrollToBottom,
      redo: onRedoStep,
      redoAll: onRedoAll,
    }),
    [
      stableModels,
      fileCapabilities,
      todoSlot,
      collapsedPermission,
      command,
      cycleModel,
      cycleThinkingLevel,
      abort,
      openModelSelector,
      scrollToBottom,
      onRedoStep,
      onRedoAll,
    ],
  )
}
