/**
 * 贴底信号（输入区 dock / 回底按钮）的几何滞回
 *
 * 只服务 UI 展示，不参与 useAutoScroll 的 userScrolled 判定：
 * userScrolled 必须保持「上滚立刻离底、10px 内回底」的小阈值语义
 * （见 ChatArea 里 useAutoScroll(10) 的注释），否则会被 HTML 时钟拉回底。
 * 但直接拿它驱动输入区收起，在底部附近来回蹭时会反复收起/展开。
 * 所以 UI 侧用远/近两个阈值做滞回：中间灰区维持上一个状态。
 */

/** 回底阈值：距离底部小于它才算回到「底部」（与 userScrolled 的 10px 一致） */
export const NEAR_BOTTOM_PX = 10
/** 离底阈值：距离底部超过它才算真的离底 */
export const FAR_FROM_BOTTOM_PX = 48

export type AtBottomThresholds = {
  nearPx?: number
  farPx?: number
}

/**
 * @param prev 上一次的贴底信号
 * @param distance scrollHeight - clientHeight - scrollTop
 * @param userScrolled 用户是否已主动离底（贴底跟随开关，本身无滞回）
 */
export function resolveAtBottom(
  prev: boolean,
  distance: number,
  userScrolled: boolean,
  thresholds: AtBottomThresholds = {},
): boolean {
  const nearPx = thresholds.nearPx ?? NEAR_BOTTOM_PX
  const farPx = thresholds.farPx ?? FAR_FROM_BOTTOM_PX
  // 贴底跟随没被打破（程序滚动 / 流式长高）：立刻视为在底部
  if (!userScrolled) return true
  // 已离底：只有真的滚回底部区才恢复
  if (!prev) return distance < nearPx
  // 仍在底部：只有真的滚出去超过 farPx 才算离底，中间灰区维持
  return distance <= farPx
}
