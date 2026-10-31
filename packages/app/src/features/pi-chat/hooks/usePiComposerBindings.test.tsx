// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { createRef, useEffect, useLayoutEffect } from 'react'
import type { Api, Model } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePiComposerBindings } from './usePiComposerBindings'

/**
 * `usePiComposerBindings` 的 onCommand 新鲜度。
 *
 * 这个 hook 把 PiChatPane 每次渲染都新建的 handleCommand 收进 latest-handler
 * ref，让 InputBox 的 `onCommand` 引用稳定。同步时机是本文件要锁的部分：
 *
 * - 用 `useLayoutEffect` + `[onCommand]` 同步：同一次提交里，排在 hook 之后的
 *   父组件 layout effect 就能读到本次 handler；子组件的 passive effect 更晚，
 *   自然也是本次的。
 * - 若退回 passive `useEffect`：它晚于 layout 阶段，同一次提交里更早的
 *   父 layout effect 读到的还是上一次的 handler。前两条用例就是按这个差异写的
 *   （把 hook 里的 useLayoutEffect 换成 useEffect，它们会红）。
 *
 * 覆盖面说明：只断言「hook 之后的父 layout effect」和「子组件 passive effect」
 * 这两层。子组件自己的 layout effect 在 React 里本来就早于父 layout effect
 * （子先父后），那一阶段这层 ref 同步追不上——本文件不覆盖、也不声称覆盖它，
 * 同样不声称 InputBox 之外还有别的调用点。
 */

const MODEL = {
  id: 'fast',
  name: 'fast',
  api: 'openai-completions',
  provider: 'openai',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
} as Model<Api>

/** hook 需要的非 command 参数：全是稳定引用，不参与本文件的断言 */
const baseParams = {
  sessionId: 'session-1',
  compacting: false,
  imageCapable: false,
  models: [MODEL] as readonly Model<Api>[],
  collapsedDialogTitle: undefined,
  collapsedDialogQueueLength: 0,
  dialogCollapsed: false,
  setDialogCollapsed: () => {},
  modelSelectorRef: createRef<never>(),
  chatAreaRef: createRef<never>(),
  onRedoStep: async () => {},
  onRedoAll: async () => {},
}

type Handler = (command: string) => Promise<boolean> | boolean

interface Trace {
  /** 每次 handler 被调用的记录，形如 `h2:probe` */
  calls: string[]
  /** 最近一次真正跑到的 handler 名字 */
  lastHandled: string | null
  /** 父组件（hook 之后）layout effect 读到的东西 */
  layoutReads: string[]
  /** 子组件 passive effect 读到的东西 */
  passiveReads: string[]
}

function createTrace(): Trace {
  return { calls: [], lastHandled: null, layoutReads: [], passiveReads: [] }
}

function makeHandler(name: string, trace: Trace): Handler {
  return (command: string) => {
    trace.lastHandled = name
    trace.calls.push(`${name}:${command}`)
    return true
  }
}

function Child({
  command,
  trace,
  phase,
}: {
  command: (command: string) => Promise<boolean> | boolean
  trace: Trace
  phase: string
}) {
  // 子组件的 passive effect：晚于父组件的 layout effect
  useEffect(() => {
    trace.calls.push(`${phase}:child-passive`)
    command('child-passive-probe')
    trace.passiveReads.push(trace.lastHandled ?? 'none')
  })
  return null
}

function Harness({ onCommand, trace }: { onCommand: Handler; trace: Trace }) {
  const bindings = usePiComposerBindings({ ...baseParams, onCommand })
  // 排在 hook 之后的 layout effect（无依赖 → 每次提交都跑）：本次提交内读取 handler
  useLayoutEffect(() => {
    bindings.command('probe')
    trace.layoutReads.push(trace.lastHandled ?? 'none')
  })
  return <Child command={bindings.command} trace={trace} phase="same-commit" />
}

function renderHarness(onCommand: Handler, trace: Trace = createTrace()) {
  const view = render(<Harness onCommand={onCommand} trace={trace} />)
  return {
    trace,
    rerenderWith: (next: Handler) => view.rerender(<Harness onCommand={next} trace={trace} />),
    unmount: view.unmount,
  }
}

afterEach(() => {
  cleanup()
})

describe('usePiComposerBindings onCommand freshness', () => {
  it('lets a layout effect placed after the hook read the handler of the same commit', () => {
    const trace = createTrace()
    const h1 = makeHandler('h1', trace)
    const view = render(<Harness onCommand={h1} trace={trace} />)
    expect(trace.layoutReads).toEqual(['h1'])

    const h2 = makeHandler('h2', trace)
    act(() => {
      view.rerender(<Harness onCommand={h2} trace={trace} />)
    })

    // 同一次提交里：父 layout effect 必须先读到 h2，而不是上一次的 h1
    expect(trace.layoutReads).toEqual(['h1', 'h2'])
    // 子组件的 effect 之后也读到 h2
    expect(trace.passiveReads).toEqual(['h1', 'h2'])
    view.unmount()
  })

  it('commits the newest handler before any of those effects run (no stale dispatch)', () => {
    const trace = createTrace()
    const { rerenderWith, unmount } = renderHarness(makeHandler('h1', trace), trace)

    for (const name of ['h2', 'h3', 'h4']) {
      const next = makeHandler(name, trace)
      act(() => {
        rerenderWith(next)
      })
    }

    // 每次提交只允许出现「本次 handler」的调用，且顺序是先 layout 后 child
    expect(trace.layoutReads).toEqual(['h1', 'h2', 'h3', 'h4'])
    expect(trace.passiveReads).toEqual(['h1', 'h2', 'h3', 'h4'])
    // 探针调用里不应出现任何旧 handler 名称的后续调用
    const layoutCalls = trace.calls.filter(call => call.endsWith(':probe'))
    expect(layoutCalls).toEqual(['h1:probe', 'h2:probe', 'h3:probe', 'h4:probe'])
    unmount()
  })

  it('keeps the command reference stable while following the handler', () => {
    const trace = createTrace()
    const identities: unknown[] = []
    const Probe = ({ handler }: { handler: Handler }) => {
      const bindings = usePiComposerBindings({ ...baseParams, onCommand: handler })
      identities.push(bindings.command)
      return null
    }

    const view = render(<Probe handler={makeHandler('h1', trace)} />)
    act(() => {
      view.rerender(<Probe handler={makeHandler('h2', trace)} />)
    })

    expect(identities).toHaveLength(2)
    expect(identities[0]).toBe(identities[1])
    view.unmount()
  })

  it('passes the argument through and returns whatever the handler returns', async () => {
    const seen: string[] = []
    const asyncHandler = vi.fn(async (command: string) => {
      seen.push(command)
      return command === '/copy'
    })
    const results: unknown[] = []

    function CommandCaller() {
      const bindings = usePiComposerBindings({ ...baseParams, onCommand: asyncHandler })
      // 在 effect 里调用：拿到的是 memo 边界上那个引用稳定的 command
      useEffect(() => {
        results.push(bindings.command('/copy'))
        results.push(bindings.command('/unknown'))
      })
      return null
    }

    render(<CommandCaller />)

    expect(seen).toEqual(['/copy', '/unknown'])
    expect(await Promise.resolve(results[0])).toBe(true)
    expect(await Promise.resolve(results[1])).toBe(false)
  })
})
