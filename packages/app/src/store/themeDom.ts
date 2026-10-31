/**
 * 主题 DOM 落地：把 store 里的主题状态写到 document（CSS 变量、字号覆盖、
 * 自定义 CSS、毛玻璃标记、meta theme-color 与 Android 原生 system bars）。
 *
 * 这里是唯一的命令式副作用出口，store 只负责状态与持久化。
 */

import { themeColorsToCSSVars } from '../themes'
import type { ThemeColors } from '../themes'
import type { ColorMode } from './themeStore'

/**
 * 将浏览器 getComputedStyle 返回的任意格式颜色字符串转为 #RRGGBB 十六进制
 *
 * 现代 Chromium WebView 可能返回多种格式：
 * - rgb(29, 36, 50)   — 逗号分隔
 * - rgb(29 36 50)     — 空格分隔 (CSS Color Level 4)
 * - color(srgb 0.11 0.14 0.20) — sRGB 函数
 * - oklch(...)        — OKLab 色彩空间
 *
 * 利用 Canvas 2D 做万能转换，让浏览器自己解析任何合法 CSS 颜色
 */
function computedColorToHex(cssColor: string): string | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = cssColor
    // ctx.fillStyle 会被浏览器标准化为 #rrggbb 或 rgba(...) 格式
    const normalized = ctx.fillStyle
    if (normalized.startsWith('#')) return normalized
    // 如果返回 rgba/rgb 格式，提取数值转 hex
    const match = normalized.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    if (match) {
      const r = parseInt(match[1], 10)
      const g = parseInt(match[2], 10)
      const b = parseInt(match[3], 10)
      return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
    }
    return null
  } catch {
    return null
  }
}

const STYLE_ID_THEME = 'piui-theme-vars'
const STYLE_ID_FONT_SCALE = 'piui-font-scale'
const STYLE_ID_CUSTOM = 'piui-custom-css'

export interface ThemeDomSnapshot {
  colorMode: ColorMode
  resolvedMode: 'light' | 'dark'
  colors?: ThemeColors
  customCSS: string
}

/** 将主题状态落到 DOM；调用顺序与拆出前一致（属性 → 颜色变量 → 自定义 CSS → 异步 meta/原生栏） */
export function applyThemeToDom({ colorMode, resolvedMode, colors, customCSS }: ThemeDomSnapshot): void {
  const root = document.documentElement

  // 1. 设置 data-mode（驱动 CSS 中日/夜模式相关的非颜色规则，以及 Terminal、Shiki 等联动）
  if (colorMode === 'system') {
    root.removeAttribute('data-mode')
  } else {
    root.setAttribute('data-mode', colorMode)
  }

  // 2. 注入主题颜色变量
  if (colors) injectThemeStyle(colors)

  // 3. 应用自定义 CSS
  applyCustomCSSToDom(customCSS)

  // 4. 更新 meta theme-color
  requestAnimationFrame(() => {
    const bg = getComputedStyle(root).getPropertyValue('--color-bg-100').trim()
    if (!bg) return

    // 将计算后的颜色统一转为 HEX 格式，避免不同浏览器/WebView 返回
    // 不同格式（rgb, oklch, color(srgb ...)）导致 Android 原生端解析失败或色差
    const hex = computedColorToHex(bg)
    if (!hex) return

    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', hex)

    const androidBridge = (
      window as unknown as { __piui_android?: { setSystemBars?: (mode: string, bg: string) => void } }
    ).__piui_android
    if (androidBridge?.setSystemBars) {
      androidBridge.setSystemBars(resolvedMode, hex)
    }
  })
}

function injectThemeStyle(colors: ThemeColors) {
  let el = document.getElementById(STYLE_ID_THEME) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID_THEME
    document.head.appendChild(el)
  }

  // 用高优先级选择器覆盖 :root 中的默认值
  // 使用 :root:root 提升特异性，确保覆盖 index.css 中的所有定义
  el.textContent = `:root:root {\n  ${themeColorsToCSSVars(colors)}\n}`
}

/**
 * 字号偏移覆盖。
 * 两个维度均为 0 时不注入覆盖，直接用 index.css :root 里的默认值。
 * 非零时通过 :root:root 高优先级覆盖 --fs-* 变量。
 *
 * 基准值（偏移 0）：
 *   UI:   xxs=11  xs=12  sm=13  md=13  base=14  lg=16
 *         heading-3=16  heading-2=18  heading-1=20
 *   Code: code=13  code-line-height=24  terminal=13  terminal-line-height=1.4
 */
export function applyFontScaleToDom(ui: number, code: number) {
  let el = document.getElementById(STYLE_ID_FONT_SCALE) as HTMLStyleElement | null

  if (ui === 0 && code === 0) {
    if (el) el.remove()
    return
  }

  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID_FONT_SCALE
    document.head.appendChild(el)
  }

  const vars: string[] = []

  if (ui !== 0) {
    vars.push(
      `--fs-xxs: ${11 + ui}px`,
      `--fs-xs: ${12 + ui}px`,
      `--fs-sm: ${13 + ui}px`,
      `--fs-md: ${13 + ui}px`,
      `--fs-base: ${14 + ui}px`,
      `--fs-lg: ${16 + ui}px`,
      `--fs-heading-3: ${16 + ui}px`,
      `--fs-heading-2: ${18 + ui}px`,
      `--fs-heading-1: ${20 + ui}px`,
    )
  }

  if (code !== 0) {
    const codePx = 13 + code
    // 行高 = 基准 24 + 偏移 * 2（每 1px 字号对应 2px 行高增量）
    const lineH = 24 + code * 2
    const termPx = 13 + code
    const termLH = Math.round((1.4 + code * 0.05) * 100) / 100
    vars.push(
      `--fs-code: ${codePx}px`,
      `--fs-code-line-height: ${lineH}px`,
      `--fs-terminal: ${termPx}px`,
      `--fs-terminal-line-height: ${termLH}`,
    )
  }

  el.textContent = `:root:root {\n  ${vars.join(';\n  ')};\n}`
}

export function applyCustomCSSToDom(rawCss: string) {
  const css = rawCss.trim()
  let el = document.getElementById(STYLE_ID_CUSTOM) as HTMLStyleElement | null

  if (!css) {
    if (el) el.remove()
    return
  }

  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID_CUSTOM
    document.head.appendChild(el)
  }
  el.textContent = css
}

/** 毛玻璃开关：data-glass 属性驱动 CSS */
export function applyGlassToDom(enabled: boolean) {
  const root = document.documentElement
  if (enabled) {
    root.setAttribute('data-glass', '')
  } else {
    root.removeAttribute('data-glass')
  }
}
