import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Attachment } from '../../attachment'
import { getPiCommandCompletions } from '../../../pi/transport/index.js'
import { apiErrorHandler } from '../../../utils'

/** 参数补全条目（pi TUI getArgumentCompletions 返回的 AutocompleteItem 序列化形态） */
interface ArgCompletionItem {
  value: string
  label: string
  description?: string
}

/** 当前补全上下文：命令名 + 参数起点（补全替换 [argStart, cursor) 区间） */
interface ArgCompletionContext {
  commandName: string
  argStart: number
}

export interface UseArgCompletionsOptions {
  /** 当前输入文本 */
  text: string
  /** 替换输入文本（InputBox 的 setText） */
  setText: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  attachments: Attachment[]
  sessionId?: string | null
  /** 命令名菜单是否打开（已打开时 Tab 交给 slash 分支） */
  slashOpen: boolean
}

/**
 * 命令参数 Tab 补全（pi TUI getArgumentCompletions parity）。
 *
 * 状态与请求逻辑从 InputBox 内聚抽离：state/ref 声明与两个生命周期 effect
 * 仍按原位置由调用方在组件顶部调用本 hook，因此 effect 注册顺序不变。
 */
export function useArgCompletions({
  text,
  setText,
  textareaRef,
  attachments,
  sessionId,
  slashOpen,
}: UseArgCompletionsOptions) {
  // 命令参数 Tab 补全状态（pi TUI getArgumentCompletions parity）
  const [argCompletionOpen, setArgCompletionOpen] = useState(false)
  const [argCompletionItems, setArgCompletionItems] = useState<ArgCompletionItem[]>([])
  const [argCompletionIndex, setArgCompletionIndex] = useState(0)
  const [argCompletionLoading, setArgCompletionLoading] = useState(false)
  const argCompletionReqRef = useRef(0)
  const argCompletionCtxRef = useRef<ArgCompletionContext | null>(null)
  const argCompletionTimerRef = useRef<number | null>(null)
  const argCompletionOpenRef = useRef(false)
  useEffect(() => {
    argCompletionOpenRef.current = argCompletionOpen
  }, [argCompletionOpen])
  useEffect(() => {
    const timerRef = argCompletionTimerRef
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const argCompletionMenuRef = useRef<HTMLDivElement>(null)
  const argCompletionListRef = useRef<HTMLDivElement>(null)

  const closeArgCompletions = useCallback(() => {
    if (argCompletionTimerRef.current !== null) {
      window.clearTimeout(argCompletionTimerRef.current)
      argCompletionTimerRef.current = null
    }
    setArgCompletionOpen(false)
    setArgCompletionItems([])
    setArgCompletionLoading(false)
    argCompletionCtxRef.current = null
    argCompletionReqRef.current += 1
  }, [])

  /**
   * 解析当前输入里的命令参数上下文：
   * 1. 优先用 command attachment（斜杠菜单选过）：光标在命令文本之后即命中
   * 2. 否则识别行首手输的 `/name args`（slashOpen 为 false 说明命令名已完整）
   * 返回 { commandName, argStart }，补全会替换 [argStart, cursor) 区间。
   */
  const resolveArgCompletionContext = useCallback(
    (currentText: string, cursorPos: number): ArgCompletionContext | null => {
      const commandAttachment = attachments.find(a => a.type === 'command' && a.commandName && a.textRange)
      if (commandAttachment && commandAttachment.textRange) {
        // 参数起点跳过命令与参数之间的分隔空白（/name <prefix>）
        let argStart = commandAttachment.textRange.end
        while (argStart < currentText.length && /[ \n]/.test(currentText[argStart]!)) argStart += 1
        if (cursorPos >= argStart) {
          return { commandName: commandAttachment.commandName!, argStart }
        }
      }
      // 行首手输命令：/name 后跟空格/换行且光标在参数区
      if (currentText.startsWith('/')) {
        const rest = currentText.slice(1)
        const spaceIndex = rest.search(/[ \n]/)
        if (spaceIndex > 0 && cursorPos > spaceIndex + 1) {
          return { commandName: rest.slice(0, spaceIndex), argStart: spaceIndex + 2 }
        }
      }
      return null
    },
    [attachments],
  )

  /** 请求并打开参数补全菜单（prefix 为空时列出全部候选，与 TUI 一致） */
  const requestArgCompletions = useCallback(
    async (ctx: ArgCompletionContext, prefix: string) => {
      if (!sessionId) {
        closeArgCompletions()
        return
      }
      const requestId = ++argCompletionReqRef.current
      argCompletionCtxRef.current = ctx
      if (argCompletionTimerRef.current !== null) {
        window.clearTimeout(argCompletionTimerRef.current)
        argCompletionTimerRef.current = null
      }
      // 已打开的菜单刷新时不闪 loading（首次打开才显示）
      if (!argCompletionOpenRef.current) setArgCompletionLoading(true)
      try {
        const result = (await getPiCommandCompletions(sessionId, ctx.commandName, prefix)) as
          ArgCompletionItem[] | null | undefined
        if (requestId !== argCompletionReqRef.current) return
        const items = Array.isArray(result) ? result : []
        if (items.length === 0) {
          closeArgCompletions()
          return
        }
        setArgCompletionItems(items)
        setArgCompletionIndex(0)
        setArgCompletionOpen(true)
      } catch (error) {
        if (requestId !== argCompletionReqRef.current) return
        apiErrorHandler('command completions', error)
        closeArgCompletions()
      } finally {
        if (requestId === argCompletionReqRef.current) {
          setArgCompletionLoading(false)
        }
      }
    },
    [closeArgCompletions, sessionId],
  )

  /** 应用选中的补全：替换 [argStart, cursor) 为 value，光标移到 value 末尾 */
  const applyArgCompletion = useCallback(
    (item: ArgCompletionItem) => {
      if (!textareaRef.current) return
      const ctx = argCompletionCtxRef.current
      if (!ctx) return
      const cursorPos = textareaRef.current.selectionStart ?? text.length
      // 参数区起点前不是空白时（用户删掉了 /command 后的空格）补一个空格，
      // 否则补全值会直接黏在命令名后面（/permissionworkspace-write）
      const needsSpace = ctx.argStart > 0 && !/[ \n]/.test(text[ctx.argStart - 1] ?? '')
      const sep = needsSpace ? ' ' : ''
      const newText = text.slice(0, ctx.argStart) + sep + item.value + text.slice(cursorPos)
      setText(newText)
      closeArgCompletions()
      requestAnimationFrame(() => {
        if (!textareaRef.current) return
        const newCursorPos = ctx.argStart + sep.length + item.value.length
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos)
        textareaRef.current.focus()
      })
    },
    [closeArgCompletions, setText, text, textareaRef],
  )

  /**
   * 防抖调度：参数区文本变化后 120ms 合并请求（选中命令自动弹出 + 输入实时筛选）。
   * 不在参数区时关闭菜单。
   */
  const scheduleArgCompletion = useCallback(
    (currentText: string, cursorPos: number) => {
      const ctx = resolveArgCompletionContext(currentText, cursorPos)
      if (!ctx) {
        closeArgCompletions()
        return
      }
      if (argCompletionTimerRef.current !== null) {
        window.clearTimeout(argCompletionTimerRef.current)
      }
      argCompletionTimerRef.current = window.setTimeout(() => {
        argCompletionTimerRef.current = null
        // 回调时用 DOM 最新值重解析，避免防抖窗口内文本再变导致 ctx 过期
        const textarea = textareaRef.current
        if (!textarea) return
        const latestCursor = textarea.selectionStart ?? textarea.value.length
        const latestCtx = resolveArgCompletionContext(textarea.value, latestCursor)
        if (!latestCtx) return
        const latestPrefix = textarea.value.slice(latestCtx.argStart, latestCursor)
        void requestArgCompletions(latestCtx, latestPrefix)
      }, 120)
    },
    [closeArgCompletions, requestArgCompletions, resolveArgCompletionContext, textareaRef],
  )

  /** Tab 键：打开/循环参数补全。返回 true 表示已处理。 */
  const handleArgCompletionTab = useCallback((): boolean => {
    if (!textareaRef.current) return false
    if (argCompletionOpen) {
      setArgCompletionIndex(prev => (prev + 1) % Math.max(argCompletionItems.length, 1))
      return true
    }
    if (slashOpen) return false // 命令名菜单优先，交给 slash 分支
    const cursorPos = textareaRef.current.selectionStart ?? text.length
    const ctx = resolveArgCompletionContext(text, cursorPos)
    if (!ctx) return false
    const prefix = text.slice(ctx.argStart, cursorPos)
    void requestArgCompletions(ctx, prefix)
    return true
  }, [
    argCompletionOpen,
    argCompletionItems.length,
    requestArgCompletions,
    resolveArgCompletionContext,
    slashOpen,
    text,
    textareaRef,
  ])

  return {
    argCompletionOpen,
    argCompletionItems,
    argCompletionIndex,
    setArgCompletionIndex,
    argCompletionLoading,
    argCompletionMenuRef,
    argCompletionListRef,
    closeArgCompletions,
    requestArgCompletions,
    applyArgCompletion,
    scheduleArgCompletion,
    handleArgCompletionTab,
  }
}
