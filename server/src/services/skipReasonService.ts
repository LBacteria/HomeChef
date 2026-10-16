import type { DishSkipReason } from '../db/schema.js'

/**
 * v0.2.3（R2）：**派生的必需确认原因**。
 *
 * ⚠️ 关键约定：`seasoning_presence` 是**只在计算与展示中存在的派生原因**，
 *    **绝不写入数据库**。数据库 `cooking_session_dish_skip.reason` 的 CHECK
 *    只允许 `DISH_SKIP_REASONS`（`null_quantity` / `unit_mismatch` / `user_choice`）。
 *
 * 为什么需要它：调味品库存是 **presence 哨兵**（`quantity = 0, unit = '个'`），
 * 结算**不会**按量扣减。当菜谱写「盐 2 个」而库存只有哨兵时：
 *   - 旧行为：`requiredReasonOf` 认为"单位匹配、不是必需跳过" → 扣减 0 → 硬失败
 *     `INSUFFICIENT_STOCK`，用户**没有任何确认入口**；
 *   - 现在：派生为 `seasoning_presence` → 用户**明确确认**「调味品只记有无、不按量扣减」，
 *     该确认**落库为既有的 `user_choice`**（语义真实：确实是用户主动选择跳过计量），
 *     结算记 `skipped_user`。
 *
 * ⚠️ 只有用户**真实点击确认**才会产生 `user_choice` 记录；
 *    服务端**绝不**自动伪造 `skipped_user`，也绝不把正需求写成 `consumed` 却实际扣 0。
 */
export const SEASONING_PRESENCE = 'seasoning_presence' as const

/** 派生原因（= 持久化原因 ∪ { seasoning_presence }） */
export type DerivedSkipReason = DishSkipReason | typeof SEASONING_PRESENCE

/** **必需**确认的派生原因（`user_choice` 不是必需项：它由用户主动选择） */
export const REQUIRED_DERIVED_REASONS: readonly DerivedSkipReason[] = [
  'null_quantity',
  'unit_mismatch',
  SEASONING_PRESENCE,
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
 *   1. 用量未指定（`null`）→ `null_quantity`（**明确确认**，不自动跳过）
 *   2. **显式零需求**（`required_quantity <= 0`，含份数缩放为 0）→ `null`
 *      —— 不需要任何库存，也不需要确认
 *   3. **调味品且需求量 > 0** → **一律** `seasoning_presence`
 *      —— 调味品是 **presence-only**，**不依赖单位是否匹配、也不看库存数量**；
 *      用户明确确认「已备该调味品、不按量扣减」后，结算记 `skipped_user`
 *      （真实：确实是用户选择跳过计量），**不做按量扣减**
 *   4. 普通食材：单位为 `null` 或没有单位完全一致的库存记录 → `unit_mismatch`
 *   5. 其余 → `null`（按量扣减流程正常处理）
 *
 * ⚠️ 第 3 条为什么**不看数量**：调味品在业务上不按量管理，
 *    但历史 / 测试数据里可能存在**正数量**批次。若按"够不够"判定，会出现
 *    「两道菜各需 1、调味品库存 1」→ 各自判定足够、都不要求确认 →
 *    结算按量扣减、第二条失败 的同类冲突。统一走确认后，语义只有一套。
 */
export function deriveRequiredReason(input: RequiredReasonInput): DerivedSkipReason | null {
  if (input.required_quantity === null) return 'null_quantity'
  if (input.required_quantity <= 0) return null
  if (input.is_seasoning) return SEASONING_PRESENCE
  if (input.has_unit_matched_lot) return null
  return 'unit_mismatch'
}
