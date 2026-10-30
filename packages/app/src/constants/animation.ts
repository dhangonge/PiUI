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
