/** 主题切换时禁用过渡的时间窗口 */
export const THEME_SWITCH_DISABLE_MS = 400

/**
 * 基础动效语义 token。
 *
 * 曲线与时长来自 docs/FRONTEND_REWRITE_PLAN.md §3，JS（motion）与 CSS（Tailwind 类）
 * 共用同一组语义值。Tailwind 只认静态字面量，所以 CSS 侧的数值写在下面的类字符串里，
 * 改这里时必须同步改那里。
 */
export const MOTION_EASE_OUT = [0.23, 1, 0.32, 1] as const

/** 按压 / 释放反馈时长，普通模式下与 MOTION_EASE_OUT 一起用于按钮类交互 */
export const PRESS_FEEDBACK_MS = 140

/**
 * 弹层（Dialog / ModalShell）进出场参数。
 *
 * 常规态保持既有 200ms 外观与退场等待；减少动态效果时去掉位移 / 缩放，
 * 只留一节更短的 opacity 淡出，退场等待也跟着缩短，不留空等。
 * 下面的毫秒数同时出现在 hook 的退场延迟和内联 transition 字符串里，
 * 改这里就等于改时长，两边不会各说各的。
 */
export const OVERLAY_MOTION = {
  /** 常规进出场时长（ms），退场也按这个时长等待后卸载 */
  durationMs: 200,
  /** 减少动态效果时的 opacity 淡出时长（ms），不含位移与缩放 */
  reducedDurationMs: 120,
  /** 减少动态效果时退场卸载前多留的余量（ms），避免淡出最后一帧被截断 */
  reducedExitGuardMs: 30,
} as const

/**
 * 按钮 / 图标按钮 / 菜单项的过渡类。
 *
 * 显式列属性而不是 transition-all：后者会把布局属性也带上（掉帧且不可控）。
 * 列的是这几个组件真正会变的状态：
 *   - background-color / color：变体、hover、选中
 *   - opacity：disabled:opacity-40
 *   - scale：按压缩放。Tailwind 4 的 scale-* 输出独立的 scale 属性
 *     （`scale: var(--tw-scale-x) var(--tw-scale-y)`），不是 transform；
 *     只写 transform 会让按压瞬间跳到目标值。
 * 这三个组件自身不使用 border / box-shadow / ring，所以不列它们。
 * motion-safe 前缀把「按压缩放」从减少动态效果里摘出去，颜色反馈仍然保留。
 */
export const PRESS_TRANSITION_CLASS =
  'transition-[background-color,color,opacity,scale] duration-[140ms] ease-[cubic-bezier(0.23,1,0.32,1)]'
