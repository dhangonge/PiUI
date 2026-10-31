import { beforeEach, describe, expect, it } from 'vitest'

describe.each(['localStorage', 'sessionStorage'] as const)('%s environment', name => {
  beforeEach(() => {
    globalThis[name].clear()
  })

  it('supports length, indexed keys and enumerable named values', () => {
    const storage = globalThis[name]
    storage.setItem('one', '1')
    storage.setItem('two', '2')
    expect(storage.length).toBe(2)
    expect([storage.key(0), storage.key(1)].sort()).toEqual(['one', 'two'])
    expect(storage.key(2)).toBeNull()
    expect(Object.keys(storage).sort()).toEqual(['one', 'two'])
    expect(storage.getItem('one')).toBe('1')
    storage.removeItem('one')
    expect(storage.length).toBe(1)
    storage.clear()
    expect(storage.length).toBe(0)
    expect(Object.keys(storage)).toEqual([])
  })
})
