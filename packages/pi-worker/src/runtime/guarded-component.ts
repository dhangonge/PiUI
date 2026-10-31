import { truncateToWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from '@earendil-works/pi-tui'

export type ComponentPhase = 'render' | 'invalidate' | 'input' | 'focus' | 'dispose' | 'layout'
export type DisposableComponent = Component & { dispose?: () => void; focused?: boolean }

/** Catch at the callback boundary: requestRender() itself runs before rendering. */
export class GuardedComponent implements Component {
  private failed = false
  private disposed = false

  constructor(
    private readonly inner: DisposableComponent,
    private readonly onFailure: (phase: ComponentPhase) => void,
    private readonly onRender?: (lines: string[]) => void,
  ) {}

  render(width: number): string[] {
    return this.call(
      'render',
      () => {
        const lines = this.inner.render(width)
        if (
          !Array.isArray(lines) ||
          lines.length > 4096 ||
          lines.some(line => typeof line !== 'string' || line.length > 256 * 1024)
        ) {
          throw new Error('Invalid extension render result')
        }
        // A component can otherwise make pi-tui throw outside its render callback.
        const rendered = lines.map(line => truncateToWidth(line, Math.max(1, width), ''))
        this.onRender?.(rendered)
        return rendered
      },
      [],
    )
  }

  invalidate(): void {
    this.call('invalidate', () => this.inner.invalidate(), undefined)
  }
  handleInput(data: string): void {
    this.call('input', () => this.inner.handleInput?.(data), undefined)
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.call('input', () => this.inner.handleMouse?.(event), undefined)
  }
  get wantsKeyRelease(): boolean {
    return this.call('input', () => this.inner.wantsKeyRelease ?? false, false)
  }
  get focused(): boolean {
    return this.call('focus', () => this.inner.focused ?? false, false)
  }
  set focused(value: boolean) {
    this.call(
      'focus',
      () => {
        this.inner.focused = value
      },
      undefined,
    )
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    try {
      this.inner.dispose?.()
    } catch {
      this.onFailure('dispose')
    }
  }

  private call<T>(phase: ComponentPhase, action: () => T, fallback: T): T {
    if (this.failed || this.disposed) return fallback
    try {
      return action()
    } catch {
      this.failed = true
      this.onFailure(phase)
      return fallback
    }
  }
}
