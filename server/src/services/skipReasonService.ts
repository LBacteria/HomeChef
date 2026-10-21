import type { DishSkipReason } from '../db/schema.js'

/**
 * **派生的必需确认原因**。
 *
 * ⚠️ v0.2.4 起：**调味品不再产生任何必需确认**。
 *    决策：调味品只做中性备料提醒，不计库存、不扣量、不阻挡开做与结算。
 *    因此 `deriveRequiredReason` 对调味品一律返回 `null`
 *    —— 连「盐 适量」这种未知用量也不要求确认。
 *
 * ⚠️ 历史兼容：v0.2.3 曾把调味品派生为 `seasoning_presence` 并落库为 `user_choice`。
 *    常量 `SEASONING_PRESENCE`、`persistedReasonFor`、`isSatisfiedBy` 中的旧分支
 *    **保留**，只用于读懂/兼容旧数据，**不会再被新逻辑产生**。
 *    `REQUIRED_DERIVED_REASONS` 已移除它 —— 它不再是必需项。
 *
 * 数据库 `cooking_session_dish_skip.reason` 的 CHECK 仍然只允许
 * `DISH_SKIP_REASONS`（`null_quantity` / `unit_mismatch` / `user_choice`），本模块不新增取值。
 *
 * ⚠️ 只有用户**真实点击确认**才会产生 `user_choice` 记录；
 *    服务端**绝不**自动伪造 `skipped_user`，也绝不把正需求写成 `consumed` 却实际扣 0。
 */
export const SEASONING_PRESENCE = 'seasoning_presence' as const

/** 派生原因（= 持久化原因 ∪ { seasoning_presence }） */
export type DerivedSkipReason = DishSkipReason | typeof SEASONING_PRESENCE

/**
 * **必需**确认的派生原因（`user_choice` 不是必需项：它由用户主动选择）。
 *
 * ⚠️ v0.2.4：`seasoning_presence` **不在**此列 —— 调味品免确认。
 */
export const REQUIRED_DERIVED_REASONS: readonly DerivedSkipReason[] = [
  'null_quantity',
  'unit_mismatch',
]

export function isRequiredDerivedReason(reason: DerivedSkipReason | null): boolean {
  return reason !== null && REQUIRED_DERIVED_REASONS.includes(reason)
}

/** 派生原因 → 实际**落库**的确认原因 */
export function persistedReasonFor(derived: DerivedSkipReason): DishSkipReason {
  return derived === SEASONING_PRESENCE ? 'user_choice' : derived
}

/** 某个派生必需项，是否已被某条**已落库**的确认所满足 */
export function isSatisfiedBy(
  derived: DerivedSkipReason,
  persisted: DishSkipReason | null,
): boolean {
  if (persisted === null) return false
  /**
   * ⚠️ v0.2.3：**用户真实主动跳过（`user_choice`）满足任何当前派生必需项**。
   *
   * 与 `settleSession` 的行为对齐：结算在完整性校验**之前**就直接忽略
   * `confirmedReason === 'user_choice'` 的需求（它不会被按量扣减）。
   * 因此预览、`requiredSkipsOf`、结算就绪判定都**不得**再要求额外确认 ——
   * 否则会出现"用户已明确跳过、界面仍要求确认、结算却被放行"的三方不一致。
   * （配方变更导致的失效由既有的 `recipe_revision` / `confirmed_revision` 机制负责清除。）
   */
  if (persisted === 'user_choice') return true
  if (derived === SEASONING_PRESENCE) {
    /**
     * 兼容：调味品确认**主路径**同样是 `user_choice`（上面已覆盖）；
     * 旧的 `unit_mismatch` 确认也接受 —— 那时调味品的必需原因就是它，
     * 且两者在结算里都是"跳过、不按量扣减"，结果一致。
     */
    return persisted === 'unit_mismatch'
  }
  return persisted === derived
}

/** `deriveRequiredReason` 的输入（两侧调用方各自按同一口径计算） */
export interface RequiredReasonInput {
  is_seasoning: boolean
  /**
   * **缩放后**的需求量（结算口径：`scaleLineQuantity`）；
   * `null` = 用量未指定。
   */
  required_quantity: number | null
  /** 是否存在**单位完全一致**的库存记录（不看数量） */
  has_unit_matched_lot: boolean
}

/**
 * 判定某条需求的**必需确认原因**（派生）。
 *
 * 规则（顺序不可颠倒）：
 *   1. **调味品 → 一律 `null`**（v0.2.4）
 *      —— 不计库存、不扣量、不阻挡开做与结算；
 *      连「适量 / 未指定」也不确认（决策原文：盐「适量」也免确认）。
 *      它只作为中性备料提醒出现在推荐与预览里。
 *   2. 用量未指定（`null`）→ `null_quantity`（**明确确认**，不自动跳过）
 *   3. **显式零需求**（`required_quantity <= 0`，含份数缩放为 0）→ `null`
 *      —— 不需要任何库存，也不需要确认
 *   4. 普通食材：单位为 `null` 或没有单位完全一致的库存记录 → `unit_mismatch`
 *   5. 其余 → `null`（按量扣减流程正常处理）
 *
 * ⚠️ 第 1 条必须排在 `null_quantity` 之前：否则「盐 适量」仍会被要求确认。
 */
export function deriveRequiredReason(input: RequiredReasonInput): DerivedSkipReason | null {
  if (input.is_seasoning) return null
  if (input.required_quantity === null) return 'null_quantity'
  if (input.required_quantity <= 0) return null
  if (input.has_unit_matched_lot) return null
  return 'unit_mismatch'
}
