/**
 * v0.2.3 推荐**排序与软信号** —— 纯函数（无数据库、无 IO、无随机）。
 *
 * 职责：
 *   1. 偏好（点赞 / 点踩）、烹饪历史、每日确定性轮换三项软信号的**可复现**计算；
 *   2. 方案排序键：**库存等级 → 主缺口 → 用量覆盖 → 软评分 → 签名**。
 *
 * 硬规则：
 *   - **无随机**：轮换用「日期 + 方案签名」的稳定哈希，同一天必然同结果；
 *     不写任何曝光记录，不需要额外状态。
 *   - **库存优先**：软信号永远排在库存等级/缺口/用量覆盖**之后**，
 *     因此不可能把库存严重不足的方案顶到前面。
 *   - **不排除**任何菜谱：点踩与历史只降权，不淘汰。
 */

import {
  HISTORY_HALF_LIFE_DAYS,
  QUANTITY_COVERAGE_BUCKET,
  RECOMMENDATION_WEIGHTS,
  ROTATION_AMPLITUDE,
  ROTATION_REPEAT_PENALTY,
} from './recommendationConfig.js'
import { daysBetween } from './dates.js'

/* ============================================================
 * 输入类型（保持纯函数：由调用方注入，不直接读库）
 * ============================================================ */

export type PreferenceValue = 'like' | 'dislike'

/** 单个菜谱的历史统计（与 cookingHistoryService 的输出对齐） */
export interface HistoryRecipeStatInput {
  last_date: string
  times: number
}

/** 一次「已做完的整餐」 */
export interface HistoryMealInput {
  recipe_ids: readonly number[]
  last_date: string
  days_ago: number
}

export interface HistorySignalInput {
  byRecipe: ReadonlyMap<number, HistoryRecipeStatInput>
  recentMeals: readonly HistoryMealInput[]
}

/** 三项软信号的结果 */
export interface PlanSoftSignals {
  /** 点赞 − 点踩 */
  preference: number
  /** 近期已做完的降权（<= 0） */
  history: number
  /** 每日轮换偏移 + 重复组合惩罚 */
  rotation: number
  /** 合计（并入总分用） */
  total: number
  /** 命中的「近期已做完」的菜谱 id（升序，供理由文案） */
  cooked_recently: number[]
  /** 命中的「被点踩」的菜谱 id（升序） */
  disliked: number[]
  /** 命中的「被点赞」的菜谱 id（升序） */
  liked: number[]
  /** 是否与近期做过的一整套菜完全重合 */
  repeated_meal: boolean
}

/* ============================================================
 * 基础工具
 * ============================================================ */

/**
 * FNV-1a 32 位字符串哈希 → [0, 1)。
 *
 * ⚠️ 刻意不使用随机数与 `Math.random`：轮换必须**同日可复现**。
 * ⚠️ 也不依赖 `crypto`，保证纯函数可在任何环境复算。
 */
export function hashToUnit(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h / 0x1_0000_0000
}

/**
 * 历史降权的衰减系数：`2^(−days/halfLife)`。
 *
 * ⚠️ 天数夹到 >= 0：未来时间戳（时钟回拨 / 脏数据）不得产生「加分」。
 */
export function decayFactor(days: number, halfLifeDays: number = HISTORY_HALF_LIFE_DAYS): number {
  const safeDays = Number.isFinite(days) ? Math.max(0, days) : 0
  const safeHalfLife = halfLifeDays > 0 ? halfLifeDays : 1
  return 2 ** (-safeDays / safeHalfLife)
}

/** 用量覆盖分桶：把连续比例量化，让软评分能真正参与同档比较 */
export function quantityCoverageBucket(utilization: number): number {
  if (!Number.isFinite(utilization)) return 0
  const clamped = Math.min(1, Math.max(0, utilization))
  return Math.round(clamped / QUANTITY_COVERAGE_BUCKET)
}

/* ============================================================
 * 软信号
 * ============================================================ */

/** 偏好调整：点赞软加权、点踩软降权（绝不排除） */
export function preferenceAdjustment(
  recipeIds: readonly number[],
  preference: ReadonlyMap<number, PreferenceValue>,
): number {
  const w = RECOMMENDATION_WEIGHTS
  let sum = 0
  for (const id of recipeIds) {
    const value = preference.get(id)
    if (value === 'like') sum += w.preference_like_each
    else if (value === 'dislike') sum -= w.preference_dislike_each
  }
  return sum
}

/**
 * 烹饪历史降权：每道近期**真正做完**的菜扣 `base × 2^(−days/7)`。
 *
 * ⚠️ 同一道菜重复做过**不叠加**（只按最近一次日期算一次），
 *    避免历史把某道菜永久埋掉；次数仅用于展示。
 */
export function historyPenalty(
  recipeIds: readonly number[],
  history: HistorySignalInput,
  today: string,
): number {
  const w = RECOMMENDATION_WEIGHTS
  let sum = 0
  for (const id of recipeIds) {
    const stat = history.byRecipe.get(id)
    if (stat === undefined) continue
    const days = Math.max(0, daysBetween(stat.last_date, today))
    sum -= w.recently_cooked_each * decayFactor(days)
  }
  return sum
}

/** 方案签名与某个历史整餐是否**完全相同**（忽略顺序） */
function sameRecipeSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort((x, y) => x - y)
  const sb = [...b].sort((x, y) => x - y)
  return sa.every((v, i) => v === sb[i])
}

/**
 * 轮换调整 = **每日确定性偏移** + **重复组合惩罚**。
 *
 * - 偏移：`(hash(today|signature) − 0.5) × 2 × amplitude`，范围 ±amplitude，
 *   同一天同一方案必然同值；日期变了会自然换一批排前面。
 * - 重复：与近期**已做完**的某套菜完全重合 → 额外 `−ROTATION_REPEAT_PENALTY`，
 *   ⚠️ 惩罚**按同样的 7 天半衰期随时间衰减**（用最近一次匹配的 `days_ago`），
 *   因此「昨天做过」比「两周前做过」扣得多，不会在窗口内固定不变。
 */
export function rotationAdjustment(
  signature: string,
  recipeIds: readonly number[],
  today: string,
  history: HistorySignalInput,
): { value: number; repeatedMeal: boolean } {
  const jitter = (hashToUnit(`${today}|${signature}`) - 0.5) * 2 * ROTATION_AMPLITUDE

  let repeated = false
  let repeatDaysAgo = 0
  for (const meal of history.recentMeals) {
    if (!sameRecipeSet(recipeIds, meal.recipe_ids)) continue
    const days = Number.isFinite(meal.days_ago)
      ? Math.max(0, meal.days_ago)
      : Math.max(0, daysBetween(meal.last_date, today))
    // 取**最近一次**匹配（days_ago 最小）→ 惩罚最重
    if (!repeated || days < repeatDaysAgo) {
      repeated = true
      repeatDaysAgo = days
    }
  }

  const repeatPenalty = repeated
    ? -ROTATION_REPEAT_PENALTY * decayFactor(repeatDaysAgo)
    : 0

  return { value: jitter + repeatPenalty, repeatedMeal: repeated }
}

/**
 * 一次算齐三项软信号（确定性）。
 *
 * @param signature 方案签名（recipe_id×servings 升序拼接）
 */
export function computeSoftSignals(params: {
  signature: string
  recipeIds: readonly number[]
  today: string
  preference: ReadonlyMap<number, PreferenceValue>
  history: HistorySignalInput
}): PlanSoftSignals {
  const { signature, recipeIds, today, preference, history } = params

  const liked: number[] = []
  const disliked: number[] = []
  for (const id of [...recipeIds].sort((a, b) => a - b)) {
    const value = preference.get(id)
    if (value === 'like') liked.push(id)
    else if (value === 'dislike') disliked.push(id)
  }

  const cookedRecently = [...recipeIds]
    .filter((id) => history.byRecipe.has(id))
    .sort((a, b) => a - b)

  const preferenceScore = preferenceAdjustment(recipeIds, preference)
  const historyScore = historyPenalty(recipeIds, history, today)
  const rotation = rotationAdjustment(signature, recipeIds, today, history)

  return {
    preference: preferenceScore,
    history: historyScore,
    rotation: rotation.value,
    total: preferenceScore + historyScore + rotation.value,
    cooked_recently: cookedRecently,
    disliked,
    liked,
    repeated_meal: rotation.repeatedMeal,
  }
}

/* ============================================================
 * 排序键
 * ============================================================ */

/**
 * 方案排序键（v0.2.3）。
 *
 * ⚠️ 顺序**不可随意调整**：
 *    ① `level_rank`（ready / nearly / missing）
 *    ② `main_missing_count`（主料缺口更少者优先）
 *    ③ `quantity_coverage` **分桶后**（用量覆盖更高的档更前）
 *    ④ `soft_total`（偏好 / 历史 / 轮换）
 *    ⑤ `signature`（保证完全确定）
 */
export interface PlanOrderKey {
  level_rank: number
  main_missing_count: number
  quantity_coverage: number
  soft_total: number
  signature: string
}

export function comparePlanOrder(a: PlanOrderKey, b: PlanOrderKey): number {
  if (a.level_rank !== b.level_rank) return a.level_rank - b.level_rank
  if (a.main_missing_count !== b.main_missing_count) {
    return a.main_missing_count - b.main_missing_count
  }
  const bucketA = quantityCoverageBucket(a.quantity_coverage)
  const bucketB = quantityCoverageBucket(b.quantity_coverage)
  if (bucketA !== bucketB) return bucketB - bucketA
  if (a.soft_total !== b.soft_total) return b.soft_total - a.soft_total
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0
}

/**
 * **候选菜谱预筛**排序键（v0.2.3）。
 *
 * ⚠️ 关键点：单菜偏好 / 历史必须在 **40 个候选截断之前**参与排序，
 *    否则「偏好只作用在最后」会失效（好菜谱可能已被丢掉）。
 */
export interface CandidateOrderKey {
  level_rank: number
  main_missing_count: number
  quantity_coverage: number
  recipe_soft_total: number
  expiring_used_count: number
  recipe_id: number
}

export function compareCandidateOrder(a: CandidateOrderKey, b: CandidateOrderKey): number {
  if (a.level_rank !== b.level_rank) return a.level_rank - b.level_rank
  if (a.main_missing_count !== b.main_missing_count) {
    return a.main_missing_count - b.main_missing_count
  }
  const bucketA = quantityCoverageBucket(a.quantity_coverage)
  const bucketB = quantityCoverageBucket(b.quantity_coverage)
  if (bucketA !== bucketB) return bucketB - bucketA
  if (a.recipe_soft_total !== b.recipe_soft_total) {
    return b.recipe_soft_total - a.recipe_soft_total
  }
  if (a.expiring_used_count !== b.expiring_used_count) {
    return b.expiring_used_count - a.expiring_used_count
  }
  return a.recipe_id - b.recipe_id
}
