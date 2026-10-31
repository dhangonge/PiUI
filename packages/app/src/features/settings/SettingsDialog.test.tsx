import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SettingsDialog } from './SettingsDialog'

const notificationTargets = vi.hoisted(() => ({ mode: 'both' as 'both' | 'system' | 'sound' }))
const tauriState = vi.hoisted(() => ({ mobile: false }))
const viewportState = vi.hoisted(() => ({ mobile: false }))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children, ariaLabel }: { isOpen: boolean; children: React.ReactNode; ariaLabel: string }) =>
    isOpen ? (
      <div role="dialog" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null,
}))
vi.mock('../../hooks', () => ({ useIsMobile: () => viewportState.mobile }))
vi.mock('../../utils/tauri', () => ({ isTauri: () => true, isTauriMobile: () => tauriState.mobile }))
vi.mock('./KeybindingsSection', () => ({ KeybindingsSection: () => <div>Shortcuts content</div> }))
vi.mock('./components/AgentSettings', () => ({ AgentSettings: () => <div>Agent content</div> }))
vi.mock('./components/AppearanceSettings', () => ({
  AppearanceSettings: () => (
    <div data-setting-label="Color Mode">
      <button type="button" className="hidden">
        Hidden color control
      </button>
      <button type="button">Color control</button>
    </div>
  ),
}))
vi.mock('./components/AboutSettings', () => ({ AboutSettings: () => <div>About content</div> }))
vi.mock('./components/ChatSettings', () => ({ ChatSettings: () => <div>Chat content</div> }))
vi.mock('./components/ModelsSettings', () => ({ ModelsSettings: () => <div>Models content</div> }))
vi.mock('./components/NotificationSettings', () => ({
  NotificationSettings: () => (
    <div>
      <div data-setting-label="System Notifications">
        <button type="button">System settings</button>
      </div>
      {notificationTargets.mode !== 'sound' && (
        <div data-setting-label="Session Completed" data-setting-context="Notification Types">
          <button type="button">System event control</button>
        </div>
      )}
      {notificationTargets.mode !== 'system' && (
        <div data-setting-label="Session Completed" data-setting-context="Event Sounds">
          <button type="button">Sound event control</button>
        </div>
      )}
      <div data-setting-label="Sound Settings">
        <button type="button">Sound settings</button>
      </div>
    </div>
  ),
}))
vi.mock('./components/ServiceSettings', () => ({ ServiceSettings: () => <div>Service content</div> }))
vi.mock('./components/ServersSettings', () => ({ ServersSettings: () => <div>Servers content</div> }))
vi.mock('./components/WorkspaceSettings', () => ({ WorkspaceSettings: () => <div>Workspace content</div> }))
vi.mock('./components/ConfigSettings', () => ({ ConfigSettings: () => <div>Config content</div> }))

describe('SettingsDialog search', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    notificationTargets.mode = 'both'
    tauriState.mobile = false
    viewportState.mobile = false
    vi.stubGlobal('__APP_VERSION__', 'test')
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => clearTimeout(id))
    // setup.ts 的 scrollIntoView 替身挂在 HTMLElement.prototype 上：
    // 只改 Element.prototype 会被它的原型链覆盖，断言就成了空调用。
    HTMLElement.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('restores categories and jumps to a highlighted search result', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText('Core')).toBeInTheDocument()
    expect(screen.getByText('Advanced')).toBeInTheDocument()

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Color control').parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: 'Color control' })).toHaveFocus()
  })

  it('places the service tab under Advanced', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const advancedGroup = screen.getByText('Advanced').parentElement
    expect(advancedGroup).not.toBeNull()
    expect(within(advancedGroup!).getByRole('tab', { name: 'Service' })).toBeInTheDocument()
    expect(
      within(screen.getByText('Core').parentElement!).queryByRole('tab', { name: 'Service' }),
    ).not.toBeInTheDocument()
  })

  it('hides desktop service controls in the Android shell', async () => {
    tauriState.mobile = true
    render(<SettingsDialog isOpen onClose={vi.fn()} initialTab="service" />)
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.queryByRole('tab', { name: 'Service' })).not.toBeInTheDocument()
    expect(screen.queryByText('Service content')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true')
  })

  it('distinguishes duplicate setting labels by their subgroup', async () => {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Session Completed' } })
    fireEvent.click(screen.getByRole('option', { name: /Session Completed.*Event Sounds/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText('Sound event control').parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: 'Sound event control' })).toHaveFocus()
  })

  it.each([
    { mode: 'sound' as const, context: 'Notification Types', fallback: 'System settings' },
    { mode: 'system' as const, context: 'Event Sounds', fallback: 'Sound settings' },
  ])('uses the $context fallback when its conditional target is absent', async ({ mode, context, fallback }) => {
    notificationTargets.mode = mode
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Session Completed' } })
    fireEvent.click(screen.getByRole('option', { name: new RegExp(`Session Completed.*${context}`) }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(screen.getByText(fallback).parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: fallback })).toHaveFocus()
  })

  it('cancels a pending highlight when the dialog closes', async () => {
    const { rerender } = render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scrollIntoView.mockClear()

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    rerender(<SettingsDialog isOpen={false} onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(10))

    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('scrolls the located search target smoothly', async () => {
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })
  })
})

/**
 * WAAPI 替身：只记录调用、`this` 与取消，不产生真实帧。
 * 下面的断言只说明属性 / 时长 / 取消语义，不代表真机流畅度。
 */
const animateCalls: {
  self: Element
  keyframes: Keyframe[]
  options?: KeyframeAnimationOptions
  cancel: ReturnType<typeof vi.fn>
}[] = []

function installAnimate() {
  animateCalls.length = 0
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[], options?: KeyframeAnimationOptions) {
    let rejectFinished: (reason: unknown) => void = () => {}
    const finished = new Promise<Animation>((_resolve, reject) => {
      rejectFinished = reject
    })
    const cancel = vi.fn(() => rejectFinished(new Error('cancelled')))
    animateCalls.push({ self: this, keyframes, options, cancel })
    return { finished, cancel, onfinish: null, playState: 'running' } as unknown as Animation
  } as Element['animate']
}

function removeAnimate() {
  delete (Element.prototype as { animate?: unknown }).animate
}

const tabReduceListeners = new Set<() => void>()
let tabReduceMotion = false

function installTabMatchMedia() {
  const matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-reduced-motion: reduce') ? tabReduceMotion : false,
      media: query,
      onchange: null,
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'change') tabReduceListeners.add(listener)
      },
      removeEventListener: (type: string, listener: () => void) => {
        if (type === 'change') tabReduceListeners.delete(listener)
      },
      addListener: (listener: () => void) => tabReduceListeners.add(listener),
      removeListener: (listener: () => void) => tabReduceListeners.delete(listener),
      dispatchEvent: () => true,
    }) as unknown as MediaQueryList

  window.matchMedia = matchMedia as typeof window.matchMedia
}

describe('SettingsDialog tab content feedback', () => {
  const originalMatchMedia = window.matchMedia

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    tabReduceMotion = false
    tabReduceListeners.clear()
    viewportState.mobile = false
    tauriState.mobile = false
    installTabMatchMedia()
    vi.stubGlobal('__APP_VERSION__', 'test')
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => clearTimeout(id))
    // setup.ts 的 scrollIntoView 替身挂在 HTMLElement.prototype 上：
    // 只改 Element.prototype 会被它的原型链覆盖，断言就成了空调用。
    HTMLElement.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
    installAnimate()
  })

  afterEach(() => {
    removeAnimate()
    tabReduceListeners.clear()
    window.matchMedia = originalMatchMedia
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function renderOpen() {
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    return screen.getByRole('tab', { name: 'Servers' })
  }

  it('fades the single existing tab panel on a pointer tab switch, without delaying the swap', async () => {
    await renderOpen()
    // 确认走的是桌面左导航，下面的断言才对得上
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical')
    const panel = document.getElementById('settings-panel-servers')
    expect(panel).not.toBeNull()
    // 初始打开不带动效
    expect(animateCalls).toHaveLength(0)

    const scrollTo = vi.mocked(Element.prototype.scrollTo)
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 1 })

    // 内容立刻换掉，不等动画
    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')

    expect(animateCalls).toHaveLength(1)
    expect(animateCalls[0].self).toBe(panel)
    expect(animateCalls[0].self).toHaveAttribute('role', 'tabpanel')
    expect(animateCalls[0].keyframes).toEqual([{ opacity: 0.55 }, { opacity: 1 }])
    expect(animateCalls[0].options).toEqual({ duration: 160, easing: 'cubic-bezier(0.23,1,0.32,1)' })
    // 只有一份页面：容器里仍然只有一个 tabpanel
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)

    // 滚动重置仍然走现有 rAF，没有为了动画多等一帧
    expect(scrollTo).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(1))
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
  })

  it('cancels the running fade when tabs are switched quickly', async () => {
    await renderOpen()

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 1 })
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }), { detail: 1 })

    expect(animateCalls).toHaveLength(2)
    expect(animateCalls[0].cancel).toHaveBeenCalledTimes(1)
    expect(animateCalls[1].cancel).not.toHaveBeenCalled()
    expect(screen.getByText('Chat content')).toBeInTheDocument()
  })

  it('keeps keyboard, arrow, search and repeated pointer switches instant', async () => {
    await renderOpen()

    // 键盘触发 click（detail 0）
    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 0 })
    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(animateCalls).toHaveLength(0)

    // 方向键
    const appearanceTab = screen.getByRole('tab', { name: 'Appearance' })
    fireEvent.keyDown(appearanceTab, { key: 'ArrowDown' })
    await act(async () => vi.advanceTimersByTime(1))
    const focusedTab = document.activeElement as HTMLElement
    expect(focusedTab).toHaveAttribute('role', 'tab')
    expect(focusedTab).toHaveAttribute('aria-selected', 'true')
    expect(focusedTab).not.toBe(appearanceTab)
    expect(animateCalls).toHaveLength(0)

    // 同 tab 指针点击：不重播，但滚动重置保留
    const scrollTo = vi.mocked(Element.prototype.scrollTo)
    fireEvent.click(focusedTab, { detail: 1 })
    await act(async () => vi.advanceTimersByTime(1))
    expect(animateCalls).toHaveLength(0)
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })

    // 搜索跳转
    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    await act(async () => vi.advanceTimersByTime(1))
    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(animateCalls).toHaveLength(0)
  })

  it('does not animate under reduced motion and cancels a running fade when it turns on', async () => {
    await renderOpen()
    tabReduceMotion = true
    act(() => tabReduceListeners.forEach(listener => listener()))

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 1 })
    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(animateCalls).toHaveLength(0)

    // 运行中从无到有：先起动画，再打开减少动态效果
    tabReduceMotion = false
    act(() => tabReduceListeners.forEach(listener => listener()))
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }), { detail: 1 })
    expect(animateCalls).toHaveLength(1)

    tabReduceMotion = true
    act(() => tabReduceListeners.forEach(listener => listener()))
    expect(animateCalls[0].cancel).toHaveBeenCalledTimes(1)
  })

  it('jumps instantly to the search target under reduced motion', async () => {
    tabReduceMotion = true
    await renderOpen()
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    scrollIntoView.mockClear()

    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color Mode' } })
    fireEvent.click(screen.getByRole('option', { name: /Color Mode/ }))
    await act(async () => vi.advanceTimersByTime(1))

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
    // 定位语义不变：仍然高亮并聚焦到同一个控件
    expect(screen.getByText('Color control').parentElement).toHaveClass('settings-search-highlight')
    expect(screen.getByRole('button', { name: 'Color control' })).toHaveFocus()
    expect(animateCalls).toHaveLength(0)
  })

  it('still swaps content when the WebView has no WAAPI', async () => {
    removeAnimate()
    await renderOpen()

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 1 })

    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true')
  })

  it('cancels a running fade when the dialog unmounts', async () => {
    const { unmount } = render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 1 })
    expect(animateCalls).toHaveLength(1)
    expect(animateCalls[0].cancel).not.toHaveBeenCalled()

    unmount()
    expect(animateCalls[0].cancel).toHaveBeenCalledTimes(1)
  })

  // 移动端是安卓主路径：顶部 tab 有单独的 onClick，判定要单独盖住
  it('gates the fade on pointer tabs in the mobile layout too', async () => {
    viewportState.mobile = true
    render(<SettingsDialog isOpen onClose={vi.fn()} />)
    await act(async () => vi.advanceTimersByTime(1))
    // 顶部 tab 没有 aria-orientation：确认真的换到了移动端布局
    expect(screen.getByRole('tablist')).not.toHaveAttribute('aria-orientation')

    fireEvent.click(screen.getByRole('tab', { name: 'Appearance' }), { detail: 0 })
    expect(screen.getByText('Color control')).toBeInTheDocument()
    expect(animateCalls).toHaveLength(0)

    const panel = document.getElementById('settings-panel-appearance')
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }), { detail: 1 })
    expect(screen.getByText('Chat content')).toBeInTheDocument()
    expect(animateCalls).toHaveLength(1)
    expect(animateCalls[0].self).toBe(panel)
    expect(animateCalls[0].options).toEqual({ duration: 160, easing: 'cubic-bezier(0.23,1,0.32,1)' })
  })
})
