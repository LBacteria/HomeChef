/**
 * v0.2.2 整餐推荐 —— **纯算法**（无数据库、无 IO、无随机）。
 *
 * 职责：把「菜谱 + 库存快照」算成「这套整餐能不能做、缺什么、得几分、为什么」。
 *
 * 硬规则（与需求一致）：
 *   1. **同食材同单位先合并**：同一套餐里跨菜、以及菜谱内的重复配料行，
 *      必须先把需求量加起来再比库存 —— 绝不重复占用同一批库存。
 *   2. **不做单位换算**：只有「单位完全相同」的库存才算数（`千克` ≠ `克`）。
 *   3. **未知用量不算充分**：菜谱未填数量时记为 `unknown_quantity`，只作提示。
 *   4. **过期不可用**（默认）：已过期库存不计入可满足数量，但会单独报告。
 *   5. **调味品 presence-only**：只看「有没有」，不看数量。
 *   6. 确定性：给定相同输入，输出必然相同（组合顺序、排序、分数全部可复现）。
 */

import { roundQuantity } from './quantity.js'
import {
  COUNT_EXPIRED_AS_AVAILABLE,
  MAX_COMBINATIONS,
  RECOMMENDATION_WEIGHTS,
  SCORE_DECIMALS,
} from './recommendationConfig.js'

/* ============================================================
 * 输入类型
 * ============================================================ */

/** 菜谱的一条配料行 */
export interface RecipeLineInput {
  definition_id: number
  definition_name: string
  quantity: number | null
  unit: string | null
  /** 备注（如「切片」），仅用于展示；可选，算法不消费 */
  note?: string | null
  sort_order: number
}

/** 参与推荐的候选菜谱 */
export interface CandidateRecipeInput {
  recipe_id: number
  recipe_name: string
  tags: string[]
  lines: RecipeLineInput[]
}

/** 库存快照的一条记录 */
export interface StockLotInput {
  definition_id: number
  unit: string
  quantity: number
  /** 由 evaluateExpiryStatus 算出；推荐层只消费结果 */
  expiry_status: 'no_expiry' | 'normal' | 'expiring' | 'expired'
}

/** definition → 元信息（是否调味品、分类名） */
export interface DefinitionMeta {
  is_seasoning: boolean
  category_name: string | null
}

export type StockIndex = ReadonlyMap<number, readonly StockLotInput[]>
export type DefinitionMetaMap = ReadonlyMap<number, DefinitionMeta>

/** 一套方案中的一道菜 */
export interface DishSpec {
  recipe_id: number
  recipe_name: string
  tags: readonly string[]
  servings: number
  lines: readonly RecipeLineInput[]
}

/* ============================================================
 * 输出类型
 * ============================================================ */

export type RequirementStatus =
  | 'ok'
  | 'insufficient'
  | 'unit_mismatch'
  | 'unknown_quantity'
  | 'seasoning_missing'

/** 合并后的一条整餐需求（同食材 + 同单位已合并） */
export interface EvaluatedRequirement {
  definition_id: number
  definition_name: string
  unit: string | null
  /** 合并后的需求量；无法计算时为 null */
  required_quantity: number | null
  /** 同单位、未过期库存的可用量 */
  available_quantity: number
  /** 明确缺少的数量；无法计算时为 null */
  missing_quantity: number | null
  status: RequirementStatus
  is_seasoning: boolean
  /** 该需求是否用到了临期库存 */
  used_expiring: boolean
  /** 因过期而未计入可用的数量 */
  expired_excluded_quantity: number
  /** 中文说明（用于界面与理由） */
  note: string
}

export interface PlanEvaluation {
  requirements: EvaluatedRequirement[]
  /** 参与判定的合并需求条数（不含 unknown） */
  required_count: number
  satisfied_count: number
  /** 会造成「做不成」的缺口数（不含调味品） */
  main_missing_count: number
  /** 缺失的调味品数 */
  seasoning_missing_count: number
  /** 合计缺口 = main + seasoning */
  missing_count: number
  /** 用量未指定的合并需求数 */
  unknown_count: number
  /** 用到的临期食材数 */
  expiring_used_count: number
  /** 因过期被排除的库存条数（用于理由提示） */
  expired_excluded_count: number
  /** 满足比例（0–1，仅看 required） */
  coverage: number
  /** 组合多样性得分（分类 + 标签差异） */
  diversity_score: number
  categories_used: string[]
  tags_used: string[]
}

/* ============================================================
 * 组合枚举（确定性、带上限）
 * ============================================================ */

/**
 * 从 `indices` 中枚举全部 `k` 元组合（字典序），最多 `limit` 个。
 *
 * ⚠️ 结果顺序完全由输入顺序决定 —— 调用方必须先对候选按固定顺序排序。
 */
export function enumerateCombinations(
  indices: readonly number[],
  k: number,
  limit: number = MAX_COMBINATIONS,
): number[][] {
  if (k <= 0 || k > indices.length) return []
  const result: number[][] = []
  const current: number[] = []

  function walk(start: number): void {
    if (result.length >= limit) return
    if (current.length === k) {
      result.push([...current])
      return
    }
    for (let i = start; i < indices.length; i++) {
      current.push(indices[i])
      walk(i + 1)
      current.pop()
      if (result.length >= limit) return
    }
  }

  walk(0)
  return result
}

/* ============================================================
 * 合并需求 + 评估
 * ============================================================ */

interface MergedRequirement {
  definition_id: number
  definition_name: string
  unit: string | null
  known_required: number
  has_unknown_line: boolean
}

/** 合并键：同 definition + 同单位 视为同一条需求 */
function mergeKey(definitionId: number, unit: string | null): string {
  return `${definitionId}|${unit ?? '\u0000null'}`
}

/**
 * 评估一套整餐。
 *
 * @param dishes 该方案的菜品（含各自份数倍数）
 * @param stock  库存索引：definition_id → 库存记录
 * @param meta   definition 元信息（是否调味品 / 分类名）
 */
export function evaluateCombination(
  dishes: readonly DishSpec[],
  stock: StockIndex,
  meta: DefinitionMetaMap,
): PlanEvaluation {
  /* ---------- 1) 先合并需求（跨菜 + 菜谱内重复行） ---------- */
  const merged = new Map<string, MergedRequirement>()

  for (const dish of dishes) {
    for (const line of dish.lines) {
      const key = mergeKey(line.definition_id, line.unit)
      const existing = merged.get(key)
      const add = line.quantity === null ? 0 : line.quantity * dish.servings

      if (existing) {
        existing.known_required = roundQuantity(existing.known_required + add)
        if (line.quantity === null) existing.has_unknown_line = true
      } else {
        merged.set(key, {
          definition_id: line.definition_id,
          definition_name: line.definition_name,
          unit: line.unit,
          known_required: roundQuantity(add),
          has_unknown_line: line.quantity === null,
        })
      }
    }
  }

  /* ---------- 2) 逐条判定 ---------- */
  const requirements: EvaluatedRequirement[] = []
  const categoriesUsed = new Set<string>()
  const tagsUsed = new Set<string>()
  for (const dish of dishes) for (const t of dish.tags) tagsUsed.add(t)

  let requiredCount = 0
  let satisfiedCount = 0
  let mainMissing = 0
  let seasoningMissing = 0
  let unknownCount = 0
  let expiringUsed = 0
  let expiredExcluded = 0

  // 稳定顺序：definition_id 升序 → unit 升序（null 排最后）
  const ordered = [...merged.values()].sort((a, b) => {
    if (a.definition_id !== b.definition_id) return a.definition_id - b.definition_id
    const ua = a.unit ?? '\uffff'
    const ub = b.unit ?? '\uffff'
    return ua < ub ? -1 : ua > ub ? 1 : 0
  })

  for (const req of ordered) {
    const info = meta.get(req.definition_id)
    const isSeasoning = info?.is_seasoning === true
    if (info?.category_name) categoriesUsed.add(info.category_name)

    // ⚠️⚠️ 只要同 key 里**出现过**「未指定用量」的行，就必须计入 unknown：
    //     已知量再充足也不能把这条需求当成「够用」，更不能让方案被判为 ready。
    //     （边界用例：番茄 1 个 + 番茄「适量」混合 → 必须 unknown_count > 0）
    if (req.has_unknown_line) unknownCount++

    const lots = stock.get(req.definition_id) ?? []
    let expiredQty = 0
    let availableQty = 0
    let matchedUnit = false
    /**
     * 该需求范围内是否**存在**临期库存。
     *
     * ⚠️ 存在 ≠ 会被消耗：只有需求**被满足**（确实要用到这批货）时，
     *    才算「消耗了临期食材」。缺口/未知用量的需求不允许声称消耗了临期。
     */
    let sawExpiring = false

    for (const lot of lots) {
      // ⚠️ 单位必须**完全相同**，绝不换算
      if (req.unit === null || lot.unit !== req.unit) continue
      matchedUnit = true
      if (lot.expiry_status === 'expired') {
        expiredQty = roundQuantity(expiredQty + lot.quantity)
        continue
      }
      if (lot.expiry_status === 'expiring' && lot.quantity > 0) sawExpiring = true
      availableQty = roundQuantity(availableQty + lot.quantity)
    }

    // 调味品 presence-only：只看有没有任何库存记录
    if (isSeasoning) {
      const present = lots.length > 0
      // 调味品没有可比的数量，只有「有/无」；存在临期即视为会用到
      const usedExpiring = present && sawExpiring
      if (present) {
        // ⚠️ 刻意**不**递增 satisfiedCount：
        //    调味品不计入 requiredCount（它没有可比的数量），
        //    若这里也 +1，界面会出现「4/3 项够用」这种分子大于分母的读数。
        if (usedExpiring) expiringUsed++
        requirements.push({
          definition_id: req.definition_id,
          definition_name: req.definition_name,
          unit: req.unit,
          required_quantity: null,
          available_quantity: availableQty,
          missing_quantity: null,
          status: 'ok',
          is_seasoning: true,
          used_expiring: usedExpiring,
          expired_excluded_quantity: expiredQty,
          note: `调味品「${req.definition_name}」：家里有（调味品只记有无，不计数量）`,
        })
      } else {
        seasoningMissing++
        requirements.push({
          definition_id: req.definition_id,
          definition_name: req.definition_name,
          unit: req.unit,
          required_quantity: null,
          available_quantity: 0,
          missing_quantity: null,
          status: 'seasoning_missing',
          is_seasoning: true,
          used_expiring: false,
          expired_excluded_quantity: 0,
          note: `调味品「${req.definition_name}」：库存里没有`,
        })
      }
      // 注：unknown 已在循环开头统一计数，这里不再重复
      continue
    }

    /* ---- 普通食材 ---- */
    if (req.known_required <= 0) {
      // 只有「用量未指定」的行（unknown 已在循环开头计数）
      requirements.push({
        definition_id: req.definition_id,
        definition_name: req.definition_name,
        unit: req.unit,
        required_quantity: null,
        available_quantity: availableQty,
        missing_quantity: null,
        status: 'unknown_quantity',
        is_seasoning: false,
        // ⚠️ 保守：用量都没定，不声称会消耗临期库存
        used_expiring: false,
        expired_excluded_quantity: expiredQty,
        note: `「${req.definition_name}」未指定用量，无法判断够不够，结算时需逐项确认`,
      })
      continue
    }

    requiredCount++
    if (expiredQty > 0) expiredExcluded++

    if (!matchedUnit) {
      mainMissing++
      requirements.push({
        definition_id: req.definition_id,
        definition_name: req.definition_name,
        unit: req.unit,
        required_quantity: req.known_required,
        available_quantity: 0,
        missing_quantity: req.known_required,
        status: 'unit_mismatch',
        is_seasoning: false,
        // ⚠️ 保守：单位不匹配、需求未被满足，不声称消耗了临期库存
        used_expiring: false,
        expired_excluded_quantity: 0,
        note:
          req.unit === null
            ? `「${req.definition_name}」未指定单位，无法与库存比对`
            : `「${req.definition_name}」库存里没有以「${req.unit}」计的记录（不做单位换算）`,
      })
      continue
    }

    if (availableQty + 1e-9 < req.known_required) {
      mainMissing++
      const missing = roundQuantity(req.known_required - availableQty)
      requirements.push({
        definition_id: req.definition_id,
        definition_name: req.definition_name,
        unit: req.unit,
        required_quantity: req.known_required,
        available_quantity: availableQty,
        missing_quantity: missing,
        status: 'insufficient',
        is_seasoning: false,
        // ⚠️ 保守：需求未被满足，不声称消耗了临期库存
        used_expiring: false,
        expired_excluded_quantity: expiredQty,
        note: `「${req.definition_name}」还差 ${missing} ${req.unit}（需要 ${req.known_required}，现有 ${availableQty}）`,
      })
      continue
    }

    /* ---- 需求被满足 ---- */
    satisfiedCount++
    // 只有确实满足、且存在临期库存时，才声称「会消耗临期」
    const usedExpiring = sawExpiring
    if (usedExpiring) expiringUsed++
    requirements.push({
      definition_id: req.definition_id,
      definition_name: req.definition_name,
      unit: req.unit,
      required_quantity: req.known_required,
      available_quantity: availableQty,
      missing_quantity: 0,
      status: 'ok',
      is_seasoning: false,
      used_expiring: usedExpiring,
      expired_excluded_quantity: expiredQty,
      note: req.has_unknown_line
        ? `「${req.definition_name}」已知用量够用（需要 ${req.known_required}，现有 ${availableQty} ${req.unit}），但还有未指定用量的行，结算时需确认`
        : `「${req.definition_name}」够用（需要 ${req.known_required}，现有 ${availableQty} ${req.unit}）`,
    })
  }

  const missingCount = mainMissing + seasoningMissing
  /**
   * 满足比例。
   *
   * ⚠️ 分子分母**同一口径**：都只统计「非调味品且已知用量」的需求。
   *    调味品是 presence-only，没有可比数量，两边都不计入。
   *    这里再显式钳制到 [0,1]，杜绝任何形式的大于 100%。
   */
  const rawCoverage = requiredCount === 0 ? 1 : satisfiedCount / requiredCount
  const coverage = Math.min(1, Math.max(0, rawCoverage))

  /* ---------- 3) 组合多样性（轻量：分类差异 + 标签数量） ---------- */
  const diversityScore = categoriesUsed.size + Math.min(tagsUsed.size, 5)

  return {
    requirements,
    required_count: requiredCount,
    satisfied_count: satisfiedCount,
    main_missing_count: mainMissing,
    seasoning_missing_count: seasoningMissing,
    missing_count: missingCount,
    unknown_count: unknownCount,
    expiring_used_count: expiringUsed,
    expired_excluded_count: expiredExcluded,
    coverage: Math.round(coverage * 10000) / 10000,
    diversity_score: diversityScore,
    categories_used: [...categoriesUsed].sort(),
    tags_used: [...tagsUsed].sort(),
  }
}

/* ============================================================
 * 打分与排序键
 * ============================================================ */

/**
 * 打分（确定性）。
 *
 * 优先级：**库存全足 > 满足比例 > 消耗临期 > 组合多样**，缺口与未知用量扣分。
 */
export function scorePlan(evaluation: PlanEvaluation): number {
  const w = RECOMMENDATION_WEIGHTS
  /**
   * ⚠️ 只有**真正 ready** 才给全足奖励。
   *
   * 旧写法只看 `main_missing_count === 0`，会让「有未知用量」或「缺调味品」
   * 的方案也拿到满分奖励，从而**压过真正库存全足的方案**。
   * 现在三个条件同时成立才算全足。
   */
  const isTrulyReady =
    evaluation.main_missing_count === 0 &&
    evaluation.seasoning_missing_count === 0 &&
    evaluation.unknown_count === 0

  const raw =
    (isTrulyReady ? w.ready_bonus : 0) +
    w.coverage * evaluation.coverage +
    w.expiring_each * evaluation.expiring_used_count +
    w.diversity * evaluation.diversity_score -
    w.missing_each * evaluation.main_missing_count -
    w.seasoning_missing_each * evaluation.seasoning_missing_count -
    w.unknown_each * evaluation.unknown_count

  const factor = 10 ** SCORE_DECIMALS
  return Math.round(raw * factor) / factor
}

/** 方案签名：用于稳定去重与排序（recipe_id 升序 + 份数） */
export function planSignature(dishes: readonly DishSpec[]): string {
  return [...dishes]
    .sort((a, b) => a.recipe_id - b.recipe_id)
    .map((d) => `${d.recipe_id}x${d.servings}`)
    .join(',')
}

/** 方案等级：可做 / 缺料 */
export function planLevel(evaluation: PlanEvaluation): 'ready' | 'nearly' | 'missing' {
  if (evaluation.main_missing_count === 0) {
    return evaluation.seasoning_missing_count > 0 || evaluation.unknown_count > 0
      ? 'nearly'
      : 'ready'
  }
  return 'missing'
}

/**
 * 等级排序权重（升序即优先）。
 *
 * ⚠️ 排序必须先比等级再比分数：`ready` 方案在任何情况下都排在
 *    `nearly` / `missing` 之前，**不让分数把缺料方案顶上去**。
 */
export function planLevelRank(level: 'ready' | 'nearly' | 'missing'): number {
  if (level === 'ready') return 0
  return level === 'nearly' ? 1 : 2
}

/** 可用数量汇总（供测试与展示） */
export function availableFor(
  stock: StockIndex,
  definitionId: number,
  unit: string,
): number {
  const lots = stock.get(definitionId) ?? []
  let sum = 0
  for (const lot of lots) {
    if (lot.unit !== unit) continue
    if (!COUNT_EXPIRED_AS_AVAILABLE && lot.expiry_status === 'expired') continue
    sum = roundQuantity(sum + lot.quantity)
  }
  return sum
}
