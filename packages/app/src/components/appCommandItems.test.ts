/**
 * 命令面板条目表契约测试（H 独立验证）。
 *
 * 覆盖从 App 抽出的 buildAppCommandItems：id 与顺序、archive 条件项、when 条件、
 * deps thunk 只求值一次、focused pane 命令打到「最新登记录入」的 controller，
 * 以及原操作（设置 / 项目 / 侧栏 / 面板 / 焦点 / 全屏 / 终端）行为不丢。
 *
 * 不触发真实服务、网络或设备：仅 spy 本地 store 方法，i18n 用恒等函数代替。
 * 本测试不修改生产代码，也不断言命令表之外的表结构。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAppCommandItems, type AppCommandDeps } from './appCommandItems'
import type { CommandItem } from './CommandPalette'
import { keybindingStore } from '../store/keybindingStore'
import { layoutStore, paneLayoutStore } from '../store'
import type { PaneControllerState } from '../store/paneControllerStore'

const ALL_IDS_WITH_ARCHIVE = [
  'openSettings',
  'openProject',
  'openSettingsShortcuts',
  'toggleSidebar',
  'toggleRightPanel',
  'focusInput',
  'newSession',
  'archiveSession',
  'previousSession',
  'nextSession',
  'toggleTerminal',
  'newTerminal',
  'selectModel',
  'toggleAgent',
  'copyLastResponse',
  'cancelMessage',
  'focusNextPane',
  'focusPrevPane',
  'splitRight',
  'splitDown',
  'closePane',
  'togglePaneFullscreen',
]

function makeController(overrides: Partial<PaneControllerState> = {}): PaneControllerState {
  return {
    paneId: 'pane-1',
    sessionId: 'session-1',
    effectiveDirectory: '/workspace',
    isStreaming: false,
    newSession: vi.fn(),
    archiveSession: vi.fn(),
    previousSession: vi.fn(),
    nextSession: vi.fn(),
    toggleAgent: vi.fn(),
    copyLastResponse: vi.fn(),
    cancelMessage: vi.fn(),
    openModelSelector: vi.fn(),
    toggleFullAuto: vi.fn(),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<AppCommandDeps> = {}): AppCommandDeps {
  return {
    t: (key: string) => key,
    openSettings: vi.fn(),
    openProject: vi.fn(),
    openSettingsTab: vi.fn(),
    handleToggleSidebar: vi.fn(),
    handleToggleRightPanel: vi.fn(),
    focusedController: makeController(),
    paneLayout: { focusedPaneId: 'pane-1', isSplit: false },
    splitPaneEnabled: true,
    handleToggleFocusedPaneFullscreen: vi.fn(),
    sessionArchive: true,
    ...overrides,
  }
}

function build(deps: AppCommandDeps): CommandItem[] {
  return buildAppCommandItems(() => deps)
}

function itemOf(items: CommandItem[], id: string): CommandItem {
  const found = items.find(item => item.id === id)
  if (!found) throw new Error(`missing command item: ${id}`)
  return found
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('buildAppCommandItems：id 与顺序', () => {
  it('保留原条目顺序（含 archive 条件项）', () => {
    expect(build(makeDeps()).map(item => item.id)).toEqual(ALL_IDS_WITH_ARCHIVE)
  })

  it('sessionArchive=false 时只摘掉 archiveSession，其余顺序不变', () => {
    const ids = build(makeDeps({ sessionArchive: false })).map(item => item.id)
    expect(ids).toEqual(ALL_IDS_WITH_ARCHIVE.filter(id => id !== 'archiveSession'))
  })

  it('条目 id 唯一，且每条都有非空 label / action', () => {
    const items = build(makeDeps())
    expect(new Set(items.map(item => item.id)).size).toBe(items.length)
    for (const item of items) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(typeof item.action).toBe('function')
    }
  })

  it('deps thunk 每次构建只求值一次', () => {
    const getDeps = vi.fn(() => makeDeps())
    buildAppCommandItems(getDeps)
    expect(getDeps).toHaveBeenCalledTimes(1)
  })

  it('快捷键读取沿用 keybindingStore（id 与 action 对应）', () => {
    const items = build(makeDeps())
    for (const [id, action] of [
      ['openSettings', 'openSettings'],
      ['toggleSidebar', 'toggleSidebar'],
      ['cancelMessage', 'cancelMessage'],
      ['focusNextPane', 'focusNextPane'],
    ] as const) {
      expect(itemOf(items, id).shortcut).toBe(keybindingStore.getKey(action))
    }
  })
})

describe('buildAppCommandItems：when 条件', () => {
  it('cancelMessage 只在 focused controller 流式时可见', () => {
    const idle = build(makeDeps())
    expect(itemOf(idle, 'cancelMessage').when?.()).toBe(false)

    const streaming = build(makeDeps({ focusedController: makeController({ isStreaming: true }) }))
    expect(itemOf(streaming, 'cancelMessage').when?.()).toBe(true)
  })

  it('无 focused controller 时 cancelMessage 不可见且执行不抛错', () => {
    const items = build(makeDeps({ focusedController: null }))
    expect(itemOf(items, 'cancelMessage').when?.()).toBe(false)
    for (const id of ['cancelMessage', 'newSession', 'previousSession', 'nextSession', 'selectModel']) {
      expect(() => itemOf(items, id).action()).not.toThrow()
    }
  })

  it('分屏相关条目随 paneLayout.isSplit 变化', () => {
    const single = build(makeDeps())
    expect(itemOf(single, 'closePane').when?.()).toBe(false)
    expect(itemOf(single, 'togglePaneFullscreen').when?.()).toBe(false)
    expect(itemOf(single, 'focusNextPane').when).toBeUndefined()

    const split = build(makeDeps({ paneLayout: { focusedPaneId: 'pane-2', isSplit: true } }))
    expect(itemOf(split, 'closePane').when?.()).toBe(true)
    expect(itemOf(split, 'togglePaneFullscreen').when?.()).toBe(true)
  })
})

describe('buildAppCommandItems：原操作接线', () => {
  it('通用操作各调用一次对应 deps 回调', () => {
    const deps = makeDeps()
    const items = build(deps)

    itemOf(items, 'openSettings').action()
    itemOf(items, 'openProject').action()
    itemOf(items, 'openSettingsShortcuts').action()
    itemOf(items, 'toggleSidebar').action()
    itemOf(items, 'toggleRightPanel').action()

    expect(deps.openSettings).toHaveBeenCalledTimes(1)
    expect(deps.openProject).toHaveBeenCalledTimes(1)
    expect(deps.openSettingsTab).toHaveBeenCalledTimes(1)
    expect(deps.openSettingsTab).toHaveBeenCalledWith('keybindings')
    expect(deps.handleToggleSidebar).toHaveBeenCalledTimes(1)
    expect(deps.handleToggleRightPanel).toHaveBeenCalledTimes(1)
  })

  it('focused pane 命令各动作打到当前 controller，各方法只调一次', () => {
    const controller = makeController()
    const deps = makeDeps({ focusedController: controller })
    const items = build(deps)

    itemOf(items, 'newSession').action()
    itemOf(items, 'previousSession').action()
    itemOf(items, 'nextSession').action()
    itemOf(items, 'selectModel').action()
    itemOf(items, 'toggleAgent').action()
    itemOf(items, 'copyLastResponse').action()
    itemOf(items, 'cancelMessage').action()
    itemOf(items, 'archiveSession').action()

    expect(controller.newSession).toHaveBeenCalledTimes(1)
    expect(controller.previousSession).toHaveBeenCalledTimes(1)
    expect(controller.nextSession).toHaveBeenCalledTimes(1)
    expect(controller.openModelSelector).toHaveBeenCalledTimes(1)
    expect(controller.toggleAgent).toHaveBeenCalledTimes(1)
    expect(controller.copyLastResponse).toHaveBeenCalledTimes(1)
    expect(controller.cancelMessage).toHaveBeenCalledTimes(1)
    expect(controller.archiveSession).toHaveBeenCalledTimes(1)
  })

  it('controller 重建后：新生成的条目绑定新 controller，旧条目仍指向旧对象', () => {
    // 命令表是快照：重建只会让「之后重新构建的」条目拿到新 controller，
    // 已持有的旧条目不会自动跟随（它闭包住构建时的 controller）。
    const oldController = makeController({ paneId: 'pane-old' })
    const oldItems = build(makeDeps({ focusedController: oldController }))
    itemOf(oldItems, 'newSession').action()
    expect(oldController.newSession).toHaveBeenCalledTimes(1)

    const newController = makeController({ paneId: 'pane-new' })
    const newItems = build(makeDeps({ focusedController: newController }))
    itemOf(newItems, 'newSession').action()
    expect(newController.newSession).toHaveBeenCalledTimes(1)
    expect(oldController.newSession).toHaveBeenCalledTimes(1)

    // 再按一次旧条目：仍然打旧 controller，不会「自动升级」到新的。
    itemOf(oldItems, 'newSession').action()
    expect(oldController.newSession).toHaveBeenCalledTimes(2)
    expect(newController.newSession).toHaveBeenCalledTimes(1)
  })

  it('分屏 / 关闭 / 全屏动作按 paneLayout 与开关边界执行', () => {
    const splitPane = vi.spyOn(paneLayoutStore, 'splitPane').mockImplementation(() => null)
    const closePane = vi.spyOn(paneLayoutStore, 'closePane').mockImplementation(() => {})

    const enabled = makeDeps({ paneLayout: { focusedPaneId: 'pane-9', isSplit: true } })
    const items = build(enabled)
    itemOf(items, 'splitRight').action()
    itemOf(items, 'splitDown').action()
    itemOf(items, 'closePane').action()
    itemOf(items, 'togglePaneFullscreen').action()

    expect(splitPane).toHaveBeenNthCalledWith(1, 'pane-9', 'horizontal')
    expect(splitPane).toHaveBeenNthCalledWith(2, 'pane-9', 'vertical')
    expect(closePane).toHaveBeenCalledWith('pane-9')
    expect(enabled.handleToggleFocusedPaneFullscreen).toHaveBeenCalledTimes(1)

    // 未分屏时不关面板、不全屏；开关关闭时不分屏
    splitPane.mockClear()
    closePane.mockClear()
    const single = makeDeps({ paneLayout: { focusedPaneId: 'pane-1', isSplit: false } })
    itemOf(build(single), 'closePane').action()
    itemOf(build(single), 'togglePaneFullscreen').action()
    expect(closePane).not.toHaveBeenCalled()
    expect(single.handleToggleFocusedPaneFullscreen).not.toHaveBeenCalled()

    const disabled = makeDeps({ splitPaneEnabled: false })
    itemOf(build(disabled), 'splitRight').action()
    expect(splitPane).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('焦点切换命令打到 paneLayoutStore', () => {
    const focusNext = vi.spyOn(paneLayoutStore, 'focusNextPane').mockImplementation(() => {})
    const focusPrev = vi.spyOn(paneLayoutStore, 'focusPrevPane').mockImplementation(() => {})
    const items = build(makeDeps())
    itemOf(items, 'focusNextPane').action()
    itemOf(items, 'focusPrevPane').action()
    expect(focusNext).toHaveBeenCalledTimes(1)
    expect(focusPrev).toHaveBeenCalledTimes(1)
  })

  it('终端命令调用本地 store / 派发本地事件，不碰真实设备', () => {
    const toggle = vi.spyOn(layoutStore, 'toggleBottomPanel').mockImplementation(() => {})
    const listener = vi.fn()
    window.addEventListener('piui:new-terminal', listener)
    try {
      const items = build(makeDeps())
      itemOf(items, 'toggleTerminal').action()
      itemOf(items, 'newTerminal').action()
    } finally {
      window.removeEventListener('piui:new-terminal', listener)
    }
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('focusInput 聚焦输入框 textarea，缺少输入框时不抛错', () => {
    const items = build(makeDeps())
    expect(() => itemOf(items, 'focusInput').action()).not.toThrow()

    const host = document.createElement('div')
    host.setAttribute('data-input-box', '')
    const textarea = document.createElement('textarea')
    host.appendChild(textarea)
    document.body.appendChild(host)

    itemOf(items, 'focusInput').action()
    expect(document.activeElement).toBe(textarea)
  })
})
