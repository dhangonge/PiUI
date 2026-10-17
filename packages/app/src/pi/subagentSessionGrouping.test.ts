import { describe, expect, it } from 'vitest'
import type { UiSession } from '../types/session'
import { groupSubagentSessions, isSubagentChildSession } from './subagentSessionGrouping'

function session(overrides: Partial<UiSession> & { id: string }): UiSession {
  return {
    directory: '/repo',
    title: overrides.title ?? overrides.id,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function subagent(id: string, title: string, parentId: string): UiSession {
  return session({
    id,
    title,
    isNamed: true,
    path: `/tmp/${parentId.split('::').pop()}.jsonl`,
    parentSessionPath: `/tmp/${parentId.split('::').pop()}.jsonl`,
    forkParentId: parentId,
  })
}

describe('isSubagentChildSession', () => {
  it('识别 <类型>#<短 id> 命名的子会话', () => {
    expect(isSubagentChildSession(subagent('child', 'Explore#a1b2c3d4', 'parent'))).toBe(true)
    expect(
      isSubagentChildSession(
        session({ id: 'x', title: 'general-purpose#deadbeef', isNamed: true, parentSessionPath: '/tmp/a.jsonl' }),
      ),
    ).toBe(true)
  })

  it('用户 fork 与普通会话不算子代理', () => {
    expect(isSubagentChildSession(session({ id: 'fork', title: '重构会话', parentSessionPath: '/tmp/a.jsonl' }))).toBe(
      false,
    )
    expect(isSubagentChildSession(session({ id: 'plain', title: 'Explore#a1b2c3d4' }))).toBe(false)
  })
})

describe('groupSubagentSessions', () => {
  it('子代理从顶层摘出并按父 id 归桶', () => {
    const parent = session({ id: 'parent', title: '主会话' })
    const first = subagent('c1', 'Explore#aaaaaaaa', 'parent')
    const second = subagent('c2', 'Explore#bbbbbbbb', 'parent')
    const other = session({ id: 'other', title: '别的会话' })

    const groups = groupSubagentSessions([parent, first, other, second])

    expect(groups.roots.map(item => item.id)).toEqual(['parent', 'other'])
    expect(groups.childrenByParentId.get('parent')?.map(item => item.id)).toEqual(['c1', 'c2'])
  })

  it('父会话不在本批数据里时子代理仍留在顶层（搜索结果可见）', () => {
    const orphan = subagent('c1', 'Explore#aaaaaaaa', 'missing-parent')

    const groups = groupSubagentSessions([orphan])

    expect(groups.roots.map(item => item.id)).toEqual(['c1'])
    expect(groups.childrenByParentId.size).toBe(0)
  })

  it('用户 fork 留在顶层，只有子代理进桶', () => {
    const parent = session({ id: 'parent', title: '主会话' })
    const fork = session({
      id: 'fork',
      title: '我 fork 的会话',
      parentSessionPath: '/tmp/parent.jsonl',
      forkParentId: 'parent',
    })
    const child = subagent('c1', 'Explore#aaaaaaaa', 'parent')

    const groups = groupSubagentSessions([parent, fork, child])

    expect(groups.roots.map(item => item.id)).toEqual(['parent', 'fork'])
    expect(groups.childrenByParentId.get('parent')?.map(item => item.id)).toEqual(['c1'])
  })

  it('自引用（forkParentId 指向自己）不会被吞掉', () => {
    const self = subagent('c1', 'Explore#aaaaaaaa', 'c1')

    const groups = groupSubagentSessions([self])

    expect(groups.roots.map(item => item.id)).toEqual(['c1'])
  })
})
