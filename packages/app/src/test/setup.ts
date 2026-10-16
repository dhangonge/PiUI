import '@testing-library/jest-dom/vitest'
import '../i18n'

// 继承的 NODE_ENV=production 会让 React 走 production 构建（没有 React.act），
// 全套测试报 "React.act is not a function"。这里提前给出可行动的报错。
if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'NODE_ENV=production 时无法运行测试（React 会加载 production 构建）。' +
    '请用：NODE_ENV=test npm run test:run -w @piui/app',
  )
}

// Use the test window's full Storage API, not Node's process-wide storage.
// Vitest exposes its JSDOM instance even when window is aliased to globalThis.
const { jsdom } = globalThis as typeof globalThis & { jsdom: { window: Window } }
for (const key of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: jsdom.window[key],
  })
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserverMock,
  })
}

if (typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.scrollIntoView !== 'function') {
  HTMLElement.prototype.scrollIntoView = () => {}
}

if (typeof Range !== 'undefined') {
  const emptyClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  })

  const emptyRect = () => ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    toJSON: () => ({}),
  })

  if (typeof Range.prototype.getClientRects !== 'function') {
    Range.prototype.getClientRects = emptyClientRects as Range['getClientRects']
  }

  if (typeof Range.prototype.getBoundingClientRect !== 'function') {
    Range.prototype.getBoundingClientRect = emptyRect as Range['getBoundingClientRect']
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}
