import { beforeEach, describe, expect, it } from 'vitest'
import { sessionChildrenExpansionStore } from './sessionChildrenExpansionStore'

describe('sessionChildrenExpansionStore', () => {
  beforeEach(() => {
    sessionChildrenExpansionStore.clear()
  })

  it('默认收起，toggle 后展开再收起', () => {
    expect(sessionChildrenExpansionStore.isExpanded('parent')).toBe(false)

    sessionChildrenExpansionStore.toggle('parent')
    expect(sessionChildrenExpansionStore.isExpanded('parent')).toBe(true)

    sessionChildrenExpansionStore.toggle('parent')
    expect(sessionChildrenExpansionStore.isExpanded('parent')).toBe(false)
  })

  it('按父会话 id 隔离', () => {
    sessionChildrenExpansionStore.toggle('a')
    expect(sessionChildrenExpansionStore.isExpanded('a')).toBe(true)
    expect(sessionChildrenExpansionStore.isExpanded('b')).toBe(false)
  })

  it('每次变更推进版本号并通知订阅者', () => {
    const seen: number[] = []
    const unsubscribe = sessionChildrenExpansionStore.subscribe(() =>
      seen.push(sessionChildrenExpansionStore.getVersion()),
    )

    const before = sessionChildrenExpansionStore.getVersion()
    sessionChildrenExpansionStore.toggle('a')
    sessionChildrenExpansionStore.collapse('a')
    // 已收起时 collapse 不重复通知
    sessionChildrenExpansionStore.collapse('a')
    unsubscribe()

    expect(sessionChildrenExpansionStore.getVersion()).toBe(before + 2)
    expect(seen).toHaveLength(2)
  })
})
