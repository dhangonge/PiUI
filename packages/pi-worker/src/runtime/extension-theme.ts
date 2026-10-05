import type { Theme } from "@earendil-works/pi-coding-agent"
import { getLoadedSdk } from "../sdk-host.js"

export interface ExtensionThemeOptions {
  getThemes?: () => Theme[]
  getPreferredTheme?: () => string | undefined
}

/** Session-local theme selection, including a stable reference for SDK RPC wrappers. */
export class ExtensionThemeService {
  private selected?: Theme
  private initialized = false
  readonly current: Theme

  constructor(
    private readonly options: ExtensionThemeOptions,
    private readonly fallback: () => Theme,
    private readonly warn: (key: string, message: string) => void,
  ) {
    // SDK 1.0 spreads uiContext while binding. A new theme object on each
    // getter call would leave that wrapper, and retained factory themes, stale.
    this.current = new Proxy({} as Theme, {
      get: (_target, key) => {
        const value = Reflect.get(this.active(), key, this.active())
        if (typeof value !== "function") return value
        return (...args: unknown[]) => {
          const theme = this.active()
          return Reflect.apply(Reflect.get(theme, key, theme), theme, args)
        }
      },
    })
  }

  private available(): Theme[] {
    let builtins: Theme[] = []
    try { builtins = getLoadedSdk().builtinThemes ?? [] } catch { /* early host startup */ }
    const byName = new Map<string, Theme>()
    for (const theme of [...builtins, ...(this.options.getThemes?.() ?? [])]) {
      if (theme.name && (!byName.has(theme.name) || theme.name !== "system")) byName.set(theme.name, theme)
    }
    return [...byName.values()]
  }

  list(): Array<{ name: string; path: string | undefined }> {
    return this.available().map(theme => ({ name: theme.name!, path: theme.sourcePath }))
  }

  get(name: string): Theme | undefined {
    return this.available().find(theme => theme.name === name)
  }

  set(value: string | Theme): { success: boolean; error?: string } {
    const theme = typeof value === "string" ? this.get(value.trim()) : value
    if (!theme || theme === this.current || typeof theme.fg !== "function" || typeof theme.bg !== "function" || typeof theme.getColorMode !== "function") {
      return { success: false, error: "Theme is not available in this session" }
    }
    this.selected = theme
    this.initialized = true
    return { success: true }
  }

  reset(): void {
    this.selected = undefined
    this.initialized = false
  }

  private active(): Theme {
    if (!this.initialized) {
      this.initialized = true
      const preference = this.options.getPreferredTheme?.()
      // No terminal appearance negotiation yet: use the dark side of auto pairs.
      const name = preference?.split("/").at(-1)?.trim() || "system"
      this.selected = this.get(name)
      if (!this.selected) {
        this.warn("theme-fallback", "Configured extension theme unavailable; using the PiUI fallback palette.")
        this.selected = this.get("dark") ?? this.fallback()
      }
    }
    return this.selected!
  }
}
