/**
 * SettingsDialog 合同测试（H 独立验证，只钉关键契约，不重复 SettingsDialog.test.tsx 的 6 个搜索用例）。
 *
 * 契约：
 *   1. 'general' 是 'servers' 的别名，不存在字面上的 General tab；
 *   2. capabilities 关闭的 config tab 不进导航、不可作为初始 tab，也不进搜索索引；
 *      capability 打开后立即出现；
 *   3. tab 键盘导航用可见列表环绕，活动 tab 是唯一 tabIndex=0；
 *   4. 搜索用 Enter 选中：切 tab、清空输入并失焦；
 *   5. 搜索中按 Escape 只清空输入，不关闭设置。
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SettingsDialog, type SettingsTab } from './SettingsDialog'

const capabilities = vi.hoisted(() => ({ config: false }))

vi.mock('../../components/ui/Dialog', () => ({
  Dialog: ({ isOpen, children, ariaLabel }: { isOpen: boolean; children: React.ReactNode; ariaLabel: string }) =>
    isOpen ? (
      <div role="dialog" aria-label={ariaLabel}>
        {children}
      </div>
    ) : null,
}))
vi.mock('../../hooks', () => ({ useIsMobile: () => false }))
vi.mock('../../utils/tauri', () => ({ isTauri: () => true, isTauriMobile: () => false }))
vi.mock('../../pi/capabilities', () => ({
  usePiCapabilities: () => ({
    pty: false,
    share: false,
    fork: false,
    sessionTree: false,
    sessionNavigate: false,
    sessionDelete: false,
    sessionImport: false,
    promptSteer: false,
    promptFollowUp: false,
    queueManage: false,
    retryManage: false,
    compactionManage: false,
    toolsManage: false,
    fileWrite: false,
    gitDiff: false,
    sessionRename: false,
    sessionArchive: false,
    mcp: false,
    worktree: false,
    config: capabilities.config,
  }),
}))
vi.mock('./KeybindingsSection', () => ({ KeybindingsSection: () => <div>Shortcuts content</div> }))
vi.mock('./components/AgentSettings', () => ({ AgentSettings: () => <div>Agent content</div> }))
vi.mock('./components/AppearanceSettings', () => ({ AppearanceSettings: () => <div>Appearance content</div> }))
vi.mock('./components/AboutSettings', () => ({ AboutSettings: () => <div>About content</div> }))
vi.mock('./components/ChatSettings', () => ({ ChatSettings: () => <div>Chat content</div> }))
vi.mock('./components/ModelsSettings', () => ({ ModelsSettings: () => <div>Models content</div> }))
vi.mock('./components/NotificationSettings', () => ({ NotificationSettings: () => <div>Notifications content</div> }))
vi.mock('./components/PiManagementSettings', () => ({ PiManagementSettings: () => <div>Management content</div> }))
vi.mock('./components/ServersSettings', () => ({ ServersSettings: () => <div>Servers content</div> }))
vi.mock('./components/ServiceSettings', () => ({ ServiceSettings: () => <div>Service content</div> }))
vi.mock('./components/WorkspaceSettings', () => ({ WorkspaceSettings: () => <div>Workspace content</div> }))

/** 打开设置并跑掉挂载时的 rAF（滚动定位、初始 tab 归一） */
async function renderOpen(initialTab?: SettingsTab | 'general') {
  const view = render(<SettingsDialog isOpen onClose={vi.fn()} initialTab={initialTab} />)
  await act(async () => vi.advanceTimersByTime(10))
  return view
}

describe('SettingsDialog contracts', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    capabilities.config = false
    vi.stubGlobal('__APP_VERSION__', 'test')
    vi.useFakeTimers()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(0), 0))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => clearTimeout(id))
    Element.prototype.scrollIntoView = vi.fn()
    Element.prototype.scrollTo = vi.fn()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('treats "general" as an alias of the servers tab', async () => {
    // 不等 rAF：别名若缺失，首帧 tab 会是 'general'，没有任何 tab 处于选中态
    render(<SettingsDialog isOpen onClose={vi.fn()} initialTab="general" />)
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true')

    await act(async () => vi.advanceTimersByTime(10))
    expect(screen.getByText('Servers content')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'General' })).not.toBeInTheDocument()
  })

  it('keeps a capability-gated tab out of nav, initial tab and search until enabled', async () => {
    const { rerender } = await renderOpen('config')

    // 初始目标是隐藏 tab 时回落到第一个可见 tab
    expect(screen.queryByRole('tab', { name: 'Management' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Servers' })).toHaveAttribute('aria-selected', 'true')

    // 搜索索引同样被过滤：只剩无结果提示
    const input = screen.getByRole('combobox', { name: 'Search settings' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Management' } })
    expect(screen.getByRole('status')).toHaveTextContent('No matching settings')

    capabilities.config = true
    rerender(<SettingsDialog isOpen onClose={vi.fn()} initialTab="servers" />)
    await act(async () => vi.advanceTimersByTime(10))

    const management = screen.getByRole('tab', { name: 'Management' })
    fireEvent.click(management)
    expect(management).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Management content')).toBeInTheDocument()
  })

  it('wraps tab keyboard navigation over visible tabs with a roving tabIndex', async () => {
    await renderOpen()

    const servers = screen.getByRole('tab', { name: 'Servers' })
    expect(servers).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('tabindex', '-1')

    // 第一个 tab 上按向上键环绕到最后一个可见 tab（隐藏的 config 不在列表里）
    fireEvent.keyDown(servers, { key: 'ArrowUp' })
    await act(async () => vi.advanceTimersByTime(10))

    const about = screen.getByRole('tab', { name: 'About' })
    expect(about).toHaveAttribute('aria-selected', 'true')
    expect(about).toHaveFocus()

    // 最后一个 tab 上按向下键环绕回第一个
    fireEvent.keyDown(about, { key: 'ArrowDown' })
    await act(async () => vi.advanceTimersByTime(10))
    expect(servers).toHaveAttribute('aria-selected', 'true')

    // 从 Notifications 下一项直接到 Shortcuts：隐藏的 config 被跳过
    fireEvent.click(screen.getByRole('tab', { name: 'Notifications' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Notifications' }), { key: 'ArrowDown' })
    await act(async () => vi.advanceTimersByTime(10))
    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true')
  })

  it('selects a search result with Enter, switching tab and clearing the query', async () => {
    await renderOpen()
    const input = screen.getByRole('combobox', { name: 'Search settings' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Keyboard Shortcuts' } })
    const option = screen.getByRole('option', { name: /Keyboard Shortcuts/ })
    expect(option).toHaveAttribute('aria-selected', 'true')

    fireEvent.keyDown(input, { key: 'Enter' })
    await act(async () => vi.advanceTimersByTime(10))

    expect(screen.getByRole('tab', { name: 'Shortcuts' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Shortcuts content')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(input).not.toHaveFocus()
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('clears the search on Escape without closing the dialog', async () => {
    await renderOpen()
    const input = screen.getByRole('combobox', { name: 'Search settings' })

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'Color' } })
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    await act(async () => vi.advanceTimersByTime(10))

    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
