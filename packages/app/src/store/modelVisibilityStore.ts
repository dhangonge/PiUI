import { useSyncExternalStore } from 'react'
import { serverStorage, subscribePerServerStorageVersion } from '../utils/perServerStorage'
import { getModelKey, type AnyModel } from '../utils/modelUtils'
import { serverStore } from './serverStore'

type Listener = () => void

const STORAGE_KEY_HIDDEN_MODELS = 'piui-hidden-model-keys'

function loadHiddenModelKeys(serverId?: string): string[] {
  const stored = serverId
    ? serverStorage.getJSONFor<unknown>(STORAGE_KEY_HIDDEN_MODELS, serverId)
    : serverStorage.getJSON<unknown>(STORAGE_KEY_HIDDEN_MODELS)
  if (!Array.isArray(stored)) return []
  return stored.filter((item): item is string => typeof item === 'string')
}

class ModelVisibilityStore {
  private hiddenModelKeys = new Set<string>()
  private listeners = new Set<Listener>()
  private snapshot: string[] = []

  private readonly serverId?: string

  constructor(serverId?: string) {
    this.serverId = serverId
    this.reload()
    const reload = () => {
      const previous = JSON.stringify(this.snapshot)
      this.reload()
      if (JSON.stringify(this.snapshot) !== previous) this.emit()
    }
    if (!serverId) serverStore.onServerChange(reload)
    subscribePerServerStorageVersion(reload)
  }

  private syncSnapshot() {
    const next = Array.from(this.hiddenModelKeys).sort()
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) this.snapshot = next
  }

  private emit() {
    this.listeners.forEach(listener => listener())
  }

  private commit() {
    this.syncSnapshot()
    if (this.serverId) serverStorage.setJSONFor(STORAGE_KEY_HIDDEN_MODELS, this.snapshot, this.serverId)
    else serverStorage.setJSON(STORAGE_KEY_HIDDEN_MODELS, this.snapshot)
    this.emit()
  }

  private reload() {
    this.hiddenModelKeys = new Set(loadHiddenModelKeys(this.serverId))
    this.syncSnapshot()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): string[] => this.snapshot

  isVisible(model: AnyModel | string): boolean {
    const key = typeof model === 'string' ? model : getModelKey(model)
    return !this.hiddenModelKeys.has(key)
  }

  setVisible(model: AnyModel | string, visible: boolean) {
    const key = typeof model === 'string' ? model : getModelKey(model)
    let changed = false
    if (visible) {
      changed = this.hiddenModelKeys.delete(key)
    } else if (!this.hiddenModelKeys.has(key)) {
      this.hiddenModelKeys.add(key)
      changed = true
    }
    if (!changed) return
    this.commit()
  }

  setManyVisible(models: AnyModel[], visible: boolean) {
    let changed = false
    for (const model of models) {
      const key = getModelKey(model)
      if (visible) {
        changed = this.hiddenModelKeys.delete(key) || changed
      } else if (!this.hiddenModelKeys.has(key)) {
        this.hiddenModelKeys.add(key)
        changed = true
      }
    }
    if (!changed) return
    this.commit()
  }
}

export const modelVisibilityStore = new ModelVisibilityStore()

const scopedStores = new Map<string, ModelVisibilityStore>()

export function getModelVisibilityStore(serverId?: string): ModelVisibilityStore {
  if (!serverId) return modelVisibilityStore
  let store = scopedStores.get(serverId)
  if (!store) {
    store = new ModelVisibilityStore(serverId)
    scopedStores.set(serverId, store)
  }
  return store
}

export function useHiddenModelKeys(serverId?: string): string[] {
  const store = getModelVisibilityStore(serverId)
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
