import type { Model, Api } from '@earendil-works/pi-ai'

/**
 * Available Pi models store (from models.list).
 * Follows app store convention: subscribe/notify + stable snapshots.
 */
class PiModelsStore {
  private models: Model<Api>[] = []
  private loading = false
  private error: Error | null = null
  private listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    this.listeners.forEach(l => l())
  }

  setLoading(loading: boolean): void {
    this.loading = loading
    this.notify()
  }

  setModels(models: Model<Api>[]): void {
    this.models = models
    this.error = null
    this.loading = false
    this.notify()
  }

  clear(): void {
    this.models = []
    this.error = null
    this.loading = false
    this.notify()
  }

  setError(error: Error): void {
    this.error = error
    this.loading = false
    this.notify()
  }

  getModels(): readonly Model<Api>[] {
    return this.models
  }

  isLoading(): boolean {
    return this.loading
  }

  getError(): Error | null {
    return this.error
  }
}

export const piModelsStore = new PiModelsStore()
const serverStores = new Map<string, PiModelsStore>()

export function getPiModelsStore(serverId?: string): PiModelsStore {
  if (serverId === undefined) return piModelsStore
  let store = serverStores.get(serverId)
  if (!store) {
    store = new PiModelsStore()
    serverStores.set(serverId, store)
  }
  return store
}
