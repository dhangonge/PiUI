import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Model, Api } from '@earendil-works/pi-ai'

function model(provider: string, id: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>
}

function readHiddenKeys(): string[] {
  const key = Object.keys(localStorage).find(k => k.endsWith(':piui-hidden-model-keys'))
  if (!key) return []
  const raw = localStorage.getItem(key)
  if (!raw) return []
  return JSON.parse(raw) as string[]
}

describe('modelVisibilityStore', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('writes the current hidden keys on every hide, not the previous snapshot', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setVisible(a, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4'])
    expect(modelVisibilityStore.isVisible(a)).toBe(false)

    modelVisibilityStore.setVisible(b, false)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4', 'openai:gpt-4o'])
  })

  it('keeps re-enabled models visible after a full store reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const a = model('openai', 'gpt-4')
    const b = model('openai', 'gpt-4o')

    modelVisibilityStore.setManyVisible([a, b], false)
    modelVisibilityStore.setVisible(a, true)
    expect(readHiddenKeys()).toEqual(['openai:gpt-4o'])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(a)).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(b)).toBe(false)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual(['openai:gpt-4o'])
  })

  it('isolates equal model IDs and shares updates only with the owning settings store', async () => {
    const { serverStore } = await import('./serverStore')
    const { getModelVisibilityStore, modelVisibilityStore } = await import('./modelVisibilityStore')
    const { serverStorage } = await import('../utils/perServerStorage')
    const a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    const b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
    const first = getModelVisibilityStore(a), second = getModelVisibilityStore(b)
    first.setVisible('same:model', false)
    expect(first.getSnapshot()).toEqual(['same:model'])
    expect(second.getSnapshot()).toEqual([])
    expect(modelVisibilityStore.getSnapshot()).toEqual(['same:model'])
    serverStore.setActiveServer(b)
    modelVisibilityStore.setVisible('another:model', false)
    expect(second.getSnapshot()).toEqual(['another:model'])
    const snapshot = first.getSnapshot()
    serverStorage.setFor('unrelated', 'value', b)
    expect(first.getSnapshot()).toBe(snapshot)
  })

  it('keeps model pins, recent usage and variant preferences in their own server shards', async () => {
    const { serverStore } = await import('./serverStore')
    const utils = await import('../utils/modelUtils')
    const a = serverStore.addServer({ name: 'A', url: 'https://a.example.test' }).id
    const b = serverStore.addServer({ name: 'B', url: 'https://b.example.test' }).id
    serverStore.setActiveServer(a)
    const same = model('same', 'model')
    utils.toggleModelPin(same, b)
    utils.recordModelUsage(same, b)
    utils.saveModelVariantPref('same:model', 'high', b)
    utils.setPreferredModelKey('same:model', b)
    expect(utils.isModelPinned(same, a)).toBe(false)
    expect(utils.isModelPinned(same, b)).toBe(true)
    expect(utils.getRecentModels([same], 5, a)).toEqual([])
    expect(utils.getRecentModels([same], 5, b)).toEqual([same])
    expect(utils.getModelVariantPref('same:model', a)).toBeUndefined()
    expect(utils.getPreferredModelKey(a)).toBeNull()
    expect(utils.getPreferredModelKey(b)).toBe('same:model')
  })

  it('persists consecutive channel toggles through reload', async () => {
    const { modelVisibilityStore } = await import('./modelVisibilityStore')
    const models = [model('anthropic', 'claude-3'), model('anthropic', 'claude-4')]

    modelVisibilityStore.setManyVisible(models, false)
    modelVisibilityStore.setManyVisible(models, true)
    expect(readHiddenKeys()).toEqual([])

    vi.resetModules()
    const reloaded = await import('./modelVisibilityStore')
    expect(reloaded.modelVisibilityStore.isVisible(models[0])).toBe(true)
    expect(reloaded.modelVisibilityStore.isVisible(models[1])).toBe(true)
    expect(reloaded.modelVisibilityStore.getSnapshot()).toEqual([])
  })
})
