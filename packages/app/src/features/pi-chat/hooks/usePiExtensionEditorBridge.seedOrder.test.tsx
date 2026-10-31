import { render } from '@testing-library/react'
import { useEffect, useRef, type RefObject } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { extensionUiStore } from '../../../pi/extensionUiStore'
import { stashForkText, takeForkText } from '../../../pi/pendingForkText'
import type { InputBoxHandle } from '../../chat/index.js'
import { usePiExtensionEditorBridge } from './usePiExtensionEditorBridge'

/**
 * 调用点顺序契约（PiChatPane 里的真实排布）：
 *
 *   lastEditorTextRef 声明 → fork seed effect → 桥接 hook（镜像回填 effect）
 *
 * hook 内部的镜像回填 effect 随调用点注册，所以 hook 必须排在 seed effect
 * 之后；否则「旧 mirror 回填」先跑，抢在种子之前把输入框写回旧文本。这里
 * 用真实 extensionUiStore + 真实 pendingForkText 跑那两条 effect 的相对
 * 顺序，而不是只测某个 setter。
 */

const { setEditorStateMock } = vi.hoisted(() => ({ setEditorStateMock: vi.fn() }))

vi.mock('../../../pi/controllers/index.js', () => ({
  setPiExtensionEditorState: (...args: unknown[]) => setEditorStateMock(...args),
}))

interface HostProps {
  sessionId: string
}

function useInputBox(setEditorText: (text: string) => void): RefObject<InputBoxHandle | null> {
  const ref = useRef<InputBoxHandle | null>(null)
  useEffect(() => {
    ref.current = { setEditorText }
  }, [setEditorText])
  return ref
}

/** PiChatPane 的 fork seed effect 本体（取走一次性种子并写入两侧） */
function useForkSeedEffect(sessionId: string, lastEditorTextRef: RefObject<string | undefined>) {
  const appliedRef = useRef<string | null>(null)
  useEffect(() => {
    if (appliedRef.current === sessionId) return
    const seed = takeForkText(sessionId)
    if (!seed) return
    appliedRef.current = sessionId
    extensionUiStore.editorCommand(sessionId, { kind: 'set', text: seed })
    lastEditorTextRef.current = seed
    void setEditorStateMock(sessionId, seed)
  }, [sessionId, lastEditorTextRef])
}

/** 与 PiChatPane 相同的顺序：seed effect 先注册，镜像回填 effect 后注册 */
function SeedThenBridge({ sessionId, setEditorText }: HostProps & { setEditorText: (t: string) => void }) {
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  const sessionUnavailableRef = useRef(false)
  const inputBoxRef = useInputBox(setEditorText)
  useForkSeedEffect(sessionId, lastEditorTextRef)
  usePiExtensionEditorBridge({ sessionId, inputBoxRef, lastEditorTextRef, sessionUnavailableRef })
  return null
}

/** 反证用：hook 提到 seed effect 之前（错误排布），用于确认用例能区分顺序 */
function BridgeThenSeed({ sessionId, setEditorText }: HostProps & { setEditorText: (t: string) => void }) {
  const lastEditorTextRef = useRef<string | undefined>(undefined)
  const sessionUnavailableRef = useRef(false)
  const inputBoxRef = useInputBox(setEditorText)
  usePiExtensionEditorBridge({ sessionId, inputBoxRef, lastEditorTextRef, sessionUnavailableRef })
  useForkSeedEffect(sessionId, lastEditorTextRef)
  return null
}

/** 旧 mirror：worker 里这个会话的 editorText 还是上一次的旧值 */
function primeStaleMirror(sessionId: string, text: string) {
  extensionUiStore.restore(sessionId, { patches: [], editorText: text, toolsExpanded: false })
}

describe('editor bridge / fork seed effect order', () => {
  beforeEach(() => {
    setEditorStateMock.mockReset()
    setEditorStateMock.mockResolvedValue(undefined)
    extensionUiStore.reset()
    sessionStorage.clear()
  })

  it('consumes the fork seed before the stale mirror restore touches the composer', () => {
    const sessionId = 'session-1'
    const setEditorText = vi.fn()
    primeStaleMirror(sessionId, 'stale editor text')
    stashForkText(sessionId, 'seed from fork')

    render(<SeedThenBridge sessionId={sessionId} setEditorText={setEditorText} />)

    const texts = setEditorText.mock.calls.map(call => call[0] as string)
    expect(texts.at(-1)).toBe('seed from fork')
    // 种子落地之后，旧 mirror 不再覆盖输入框
    expect(texts.slice(texts.lastIndexOf('seed from fork'))).not.toContain('stale editor text')
  })

  it('fails the invariant when the hook is registered before the seed effect (order really matters)', () => {
    const sessionId = 'session-1'
    const setEditorText = vi.fn()
    primeStaleMirror(sessionId, 'stale editor text')
    stashForkText(sessionId, 'seed from fork')

    render(<BridgeThenSeed sessionId={sessionId} setEditorText={setEditorText} />)

    // 错误排布：旧 mirror 抢先回填，最终停在旧文本上——正是本测试要防的回归
    expect(setEditorText.mock.calls.at(-1)?.[0]).toBe('stale editor text')
  })

  it('still restores the mirror when there is no pending seed', () => {
    const sessionId = 'session-1'
    const setEditorText = vi.fn()
    primeStaleMirror(sessionId, 'stale editor text')

    render(<SeedThenBridge sessionId={sessionId} setEditorText={setEditorText} />)

    // 无种子的恢复场景语义不变
    expect(setEditorText.mock.calls.at(-1)?.[0]).toBe('stale editor text')
  })
})
