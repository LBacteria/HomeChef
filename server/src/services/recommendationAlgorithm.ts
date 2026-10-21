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

import { roundQuantity, scaleLineQuantity } from './quantity.js'
import {
  COUNT_EXPIRED_AS_AVAILABLE,
  MAX_COMBINATIONS,
  RECOMMENDATION_WEIGHTS,
  SCORE_DECIMALS,
  STRUCTURE_SCORE,
} from './recommendationConfig.js'
import { DISH_ROLE_BY_NAME, resolveDishRole } from './tagConfig.js'
import type { DishRole } from './tagConfig.js'

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

/**
 * 菜谱 Tag 输入（v0.2.3）。
 *
 * ⚠️ 结构语义按 `code` 判定（预设稳定身份），名称只是回退显示；
 *    因此在界面上重命名预设 Tag **不会**让搭配逻辑失效。
 */
export interface RecipeTagInput {
  name: string
  category: string | null
  code: string | null
}

/** 参与推荐的候选菜谱 */
export interface CandidateRecipeInput {
  recipe_id: number
  recipe_name: string
  tags: string[]
  /** v0.2.3：带分类与稳定 code 的 Tag 引用（缺省时按名称回退） */
  tag_refs?: readonly RecipeTagInput[]
  lines: RecipeLineInput[]
}

/** 库存快照的一条记录 */
export interface StockLotInput {
  definition_id: number
  unit: string
  quantity: number
  /** 由 evaluateExpiryStatus 算出；推荐层只消费结果 */
  expiry_status: 'no_expiry' | 'normal' | 'expiring' | 'expired'
  /**
   * v0.2.3（R3）：批次主键，用于**结算同款 FEFO 排序的稳定 tie-breaker**。
   * 旧调用方不传时为 `undefined`，排序退化为"按数组顺序稳定"。
   */
  lot_id?: number
  /**
   * v0.2.3（R3）：到期日，用于 FEFO 排序（有到期在前 → 升序）。
   * `null` = 无到期日（结算排序把它们放最后）。
   */
  expiry_date?: string | null
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
  /** v0.2.3：带分类与稳定 code 的 Tag 引用 */
  tag_refs?: readonly RecipeTagInput[]
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
  /**
   * ⚠️ v0.2.4 起**不再产生**（保留仅为兼容旧调用方/旧数据的类型判断）。
   *    调味品的展示改用 `seasoning_reminder`。
   */
  | 'seasoning_missing'
  /** v0.2.4：调味品中性提醒（自行准备，不计库存、不扣量） */
  | 'seasoning_reminder'

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
  /**
   * ⚠️ v0.2.4：**恒为 0**。
   *    调味品不再参与缺口判定；保留字段只为响应结构兼容。
   */
  seasoning_missing_count: number
  /** v0.2.4：需要提醒自行准备的调味品数（不影响等级与评分） */
  seasoning_reminder_count: number
  /** 合计缺口（v0.2.4 = `main_missing_count`） */
  missing_count: number
  /** 用量未指定的合并需求数 */
  unknown_count: number
  /** 用到的临期食材数 */
  expiring_used_count: number
  /** 因过期被排除的库存条数（用于理由提示） */
  expired_excluded_count: number
  /** 满足比例（0–1，仅看 required，条数口径） */
  coverage: number
  /**
   * **需求满足比例**（0–1，逐条需求比率的均值，v0.2.3）。
   *
   * `mean( min(需求, 可用) / 需求 )` —— 每条需求各算一次再平均，
   * 因此不同单位的食材不会互相压制，**排序必须用它**（不能用 `utilization`，
   * 否则会反过来偏好「库存越缺越显得用得多」的方案）。
   * 无已知需求时为 1（与 coverage 同口径）。
   */
  quantity_coverage: number
  /**
   * **可用库存消耗比例**（0–1，逐条需求比率的均值，v0.2.3）。
   *
   * `mean( 满足时 需求/可用，否则 0 )` —— 即需求里的「食材利用率 / 减少浪费」。
   * ⚠️ 缺口需求恒为 0：库存不足**不会**换来奖励；
   *    未知用量、调味品、无已知需求同样为 0。
   */
  utilization: number
  /**
   * **临期可实耗比例**（0–1，逐条需求比率的均值，v0.2.3）。
   *
   * 逐条 `min(需求, 临期可用) / 需求`；缺口、未知用量、单位不匹配一律 0。
   */
  expiring_ratio: number
  /** 被 ≥2 道菜共享的食材项数（v0.2.3） */
  shared_requirement_count: number
  /** 结构搭配得分（标签层面粗略搭配，非营养数值，v0.2.3） */
  structure_score: number
  /** 本餐涉及的菜品类型角色（排序后，v0.2.3） */
  dish_roles: DishRole[]
  /** 本餐涉及的「菜品特点」标签名（排序后，v0.2.3） */
  feature_tags: string[]
  /** 组合多样性得分（分类 + 标签） */
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
  /** 合并键（definition + 单位），用于统计「跨菜共享」 */
  key: string
  definition_id: number
  definition_name: string
  unit: string | null
  known_required: number
  has_unknown_line: boolean
  /**
   * v0.2.3（R8）：是否**至少有一行写了具体数量**（含显式 `0`）。
   *
   * 用于区分两种"需求量算出来是 0"的情况：
   *   - `has_known_line = true` 且 `known_required = 0` → **显式零需求**（例如「盐 0 克」）
   *   - 否则（只有 `null` 行）→ **未知用量**
   */
  has_known_line: boolean
}

/** 合并键：同 definition + 同单位 视为同一条需求 */
function mergeKey(definitionId: number, unit: string | null): string {
  return `${definitionId}|${unit ?? '\u0000null'}`
}

/** `evaluateCombination` 的可选开关（保持纯函数：由调用方注入，不读设置） */
export interface EvaluateOptions {
  /**
   * v0.2.3（R3 边界）：**结算允许用过期食材**（`allow_expired_for_recipe = true`）时，
   * 临期收益预测必须按"**过期批次会最先被扣**"来算。
   *
   * ⚠️ 只影响**收益预测**（`expiring_ratio` / `used_expiring`）；
   *    "够不够"的判断**始终从严**（过期一律不计入可用），不受本开关影响。
   *
   * 反例：过期 100 + 临期 100、需求 50 → 结算先扣过期 → 真实临期消耗 **0**
   * → `expiring_ratio` 必须为 0（不能因为"存在临期批次"就 +12/+25）。
   */
  includeExpiredInFefo?: boolean
}

/* ============================================================
 * v0.2.3（R3）：与**结算完全同款**的 FEFO 批次分配
 * ============================================================ */

/**
 * FEFO 排序（必须与 `settlementService.availableStockRows` 的 SQL 排序一致）：
 *   1. **有到期日的排在无到期日之前**；
 *   2. `expiry_date` 升序（先消耗快过期的）；
 *   3. `lot_id` 升序（稳定 tie-breaker）。
 *
 * ⚠️ 关键认知：`normal` 只表示"**尚未进入临期阈值**"，**不代表到期更晚**。
 *    所以「临期批次一定先被消耗」是**错的** —— 一个 `normal` 批次完全可能
 *    因为到期日更早而先被扣掉。
 */
function fefoCompare(a: StockLotInput, b: StockLotInput): number {
  const aHas = a.expiry_date === null || a.expiry_date === undefined ? 1 : 0
  const bHas = b.expiry_date === null || b.expiry_date === undefined ? 1 : 0
  if (aHas !== bHas) return aHas - bHas

  const ax = a.expiry_date ?? ''
  const bx = b.expiry_date ?? ''
  if (ax !== bx) return ax < bx ? -1 : 1

  const aid = a.lot_id ?? Number.MAX_SAFE_INTEGER
  const bid = b.lot_id ?? Number.MAX_SAFE_INTEGER
  return aid - bid
}

/**
 * 按 FEFO 模拟"这条需求**实际会扣到哪些批次**"。
 *
 * - 只用**可用**批次：同单位、未过期、`quantity > 0`（与推荐侧的可用口径一致）；
 * - 分配顺序与结算的扣减顺序一致 → 结果可直接用于"临期收益"计算；
 * - 返回每个被扣批次的 `take`（累加不超过 `required`）。
 */
function allocateByFefo(
  lots: readonly StockLotInput[],
  unit: string | null,
  required: number,
  includeExpired = false,
): Array<{ lot: StockLotInput; take: number }> {
  if (unit === null || required <= 0) return []

  const usable = lots
    .filter(
      (l) =>
        l.unit === unit &&
        l.quantity > 0 &&
        (includeExpired || l.expiry_status !== 'expired'),
    )
    .slice()
    .sort(fefoCompare)

  const allocation: Array<{ lot: StockLotInput; take: number }> = []
  let remaining = required
  for (const lot of usable) {
    if (remaining <= 1e-9) break
    const take = Math.min(remaining, lot.quantity)
    allocation.push({ lot, take })
    remaining = roundQuantity(remaining - take)
  }
  return allocation
}

/**
 * 单道菜的菜品类型角色（v0.2.3）。
 *
 * 判定顺序：
 *   1. **稳定 `code`**（系统预设身份）—— 重命名预设不影响结果；
 *   2. 无 code 时，仅当分类为 `dish_type` 才按**名称**回退；
 *   3. 都没有 → 空数组（标签不完整，正常降级）。
 */
export function rolesOfDish(dish: DishSpec): DishRole[] {
  const roles = new Set<DishRole>()
  const refs = dish.tag_refs
  if (refs !== undefined && refs.length > 0) {
    for (const ref of refs) {
      const role = resolveDishRole(ref)
      if (role !== null) roles.add(role)
    }
    return [...roles].sort()
  }
  // 兼容：没有 tag_refs 的调用方（如纯算法单测）按名称回退
  for (const name of dish.tags) {
    const role = DISH_ROLE_BY_NAME[name.trim()]
    if (role !== undefined) roles.add(role)
  }
  return [...roles].sort()
}

/**
 * 结构搭配得分（v0.2.3）。
 *
 * ⚠️ 这是**标签层面的粗略搭配**，不是营养计算：
 *    不统计任何营养数值，也不给出健康建议；标签缺失时得 0（不惩罚）。
 */
function computeStructure(dishes: readonly DishSpec[]): {
  score: number
  roles: DishRole[]
  featureTags: string[]
} {
  const S = STRUCTURE_SCORE
  const roleSet = new Set<DishRole>()
  const featureSet = new Set<string>()

  for (const dish of dishes) {
    for (const role of rolesOfDish(dish)) roleSet.add(role)
    const refs = dish.tag_refs
    if (refs !== undefined) {
      for (const ref of refs) {
        if (ref.category === 'feature' && ref.name.trim().length > 0) featureSet.add(ref.name.trim())
      }
    }
  }

  const has = (r: DishRole): boolean => roleSet.has(r)
  const hasMeat = has('meat') || has('mixed')
  const hasVeg = has('vegetable') || has('mixed')

  let score = 0
  if (roleSet.size > 0) score += (roleSet.size - 1) * S.role_variety_each
  if (hasMeat && hasVeg) score += S.meat_veg_bonus
  if (has('staple')) score += S.staple_bonus
  if (has('soup') || has('cold')) score += S.soup_or_cold_bonus

  // 至少避免「全主食」；全是荤菜也轻扣
  if (roleSet.size === 1 && has('staple')) score -= S.staple_only_penalty
  if (roleSet.size === 1 && has('meat')) score -= S.meat_only_penalty

  const featureTags = [...featureSet].sort()
  if (featureTags.length > 0) score += Math.min(featureTags.length, 4) * S.feature_variety_each

  return { score, roles: [...roleSet].sort(), featureTags }
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
  options: EvaluateOptions = {},
): PlanEvaluation {
  /* ---------- 1) 先合并需求（跨菜 + 菜谱内重复行） ---------- */
  const merged = new Map<string, MergedRequirement>()
  /**
   * v0.2.3：合并键 → **出现过该键的菜**（按菜序号去重）。
   *
   * ⚠️ 统计「共享」必须以**合并键**（同 definition **且同单位**）为口径：
   *    同一食材但单位不同（1 个 vs 1 克）**不算**共享，
   *    否则「共享奖励」会把不同单位的需求也算进去。
   */
  const keyDishIndex = new Map<string, Set<number>>()
  /** 被满足的合并键（只有满足的需求才配得上「共享」奖励） */
  const satisfiedKeys = new Set<string>()

  for (let dishIndex = 0; dishIndex < dishes.length; dishIndex++) {
    const dish = dishes[dishIndex]
    for (const line of dish.lines) {
      const key = mergeKey(line.definition_id, line.unit)
      const existing = merged.get(key)
      /**
       * v0.2.3（R1）：**逐行缩放并舍入**，与结算 `collectDemands` 共用同一个函数。
       *
       * ⚠️ 不再使用未舍入的 `line.quantity * dish.servings`：
       *    那样会与结算的逐行舍入产生 0.001 级分歧，并让结果依赖配料行顺序。
       */
      const add = scaleLineQuantity(line.quantity, dish.servings) ?? 0

      const dishSet = keyDishIndex.get(key)
      if (dishSet) dishSet.add(dishIndex)
      else keyDishIndex.set(key, new Set([dishIndex]))

      if (existing) {
        existing.known_required = roundQuantity(existing.known_required + add)
        if (line.quantity === null) existing.has_unknown_line = true
        else existing.has_known_line = true
      } else {
        merged.set(key, {
          key,
          definition_id: line.definition_id,
          definition_name: line.definition_name,
          unit: line.unit,
          known_required: roundQuantity(add),
          has_unknown_line: line.quantity === null,
          has_known_line: line.quantity !== null,
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
  /** v0.2.4：恒为 0（调味品不再参与缺口判定） */
  const seasoningMissing = 0
  /** v0.2.4：需要提醒自行准备的调味品数 */
  let seasoningReminder = 0
  let unknownCount = 0
  let expiringUsed = 0
  let expiredExcluded = 0
  /* ---------- v0.2.3：逐条需求的**无量纲比率** ---------- */
  /**
   * ⚠️⚠️ 绝不把不同单位的数量相加。
   *
   * 旧写法累加 `sumRequired / sumSatisfied / sumExpiringConsumed` 再相除，
   * 于是 1000 克会压过 1 个 —— 同一个场景换个计量尺度就得到不同的指标。
   * 现在**逐条需求各算一个 0–1 比率**，最后取平均：
   *   `coverageRatios`    min(需求, 可用) / 需求   —— 需求满足比例（排序用）
   *   `utilizationRatios` 满足时 需求 / 可用，缺料时 **0** —— 可用库存消耗比例（减少浪费奖励）
   *   `expiringRatios`    min(需求, 临期可用) / 需求 —— 临期可实耗比例
   */
  const coverageRatios: number[] = []
  const utilizationRatios: number[] = []
  const expiringRatios: number[] = []


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
    //
    // ⚠️ v0.2.4：**调味品不参与 unknown 统计**（含 `0 + null` 混合）——
    //     它既不进缺口、也不进覆盖率分母，更不能让方案降级。
    if (!isSeasoning && req.has_unknown_line) unknownCount++

    const lots = stock.get(req.definition_id) ?? []
    let expiredQty = 0
    let availableQty = 0
    let matchedUnit = false

    for (const lot of lots) {
      // ⚠️ 单位必须**完全相同**，绝不换算
      if (req.unit === null || lot.unit !== req.unit) continue
      matchedUnit = true
      if (lot.expiry_status === 'expired') {
        expiredQty = roundQuantity(expiredQty + lot.quantity)
        continue
      }
      availableQty = roundQuantity(availableQty + lot.quantity)
    }

    /**
     * ⚠️⚠️ v0.2.4：调味品**完全不参与库存判定**。
     *
     * 决策：调味品只做中性备料提醒 —— 不计库存、不扣量、不阻挡开做与结算。
     * 因此这里**不看库存**、不声称「家里有 / 没有」：
     *   - 不计缺口（`seasoning_missing_count` 恒 0）
     *   - 不计未知用量（含 `0 + null` 混合）
     *   - 不进覆盖率分母 / 利用率 / 临期收益 / 共享食材奖励
     *   - 库存变化也不会改变本条的结论（因此不会影响排序）
     *
     * 唯一的输出是一条中性提醒；**显式纯零**（无 null 行且已知量 ≤ 0）不提醒。
     */
    if (isSeasoning) {
      const explicitZero = !req.has_unknown_line && req.known_required <= 0
      if (!explicitZero) {
        seasoningReminder++
        requirements.push({
          definition_id: req.definition_id,
          definition_name: req.definition_name,
          unit: req.unit,
          required_quantity: req.has_unknown_line ? null : req.known_required,
          available_quantity: 0,
          missing_quantity: null,
          status: 'seasoning_reminder',
          is_seasoning: true,
          used_expiring: false,
          expired_excluded_quantity: 0,
          note: `调味品「${req.definition_name}」请自行准备（不计库存、也不扣量）`,
        })
      }
      continue
    }

    /* ---- 普通食材 ---- */
    if (req.known_required <= 0) {
      /**
       * v0.2.3（R8）：把「**显式 0**」与「**未指定**」彻底分开。
       *
       * - `has_known_line` 且**没有** null 行 → **显式零需求**（如「盐 0 克」）：
       *   按零需求处理，`status = 'ok'`、`required_quantity = 0`、缺口 0，
       *   **不占用任何库存**，文案也不得再写成"未指定用量"。
       *   （不登记 `satisfiedKeys`：零需求没有消耗任何库存，不该拿共享奖励。）
       * - 其余（只有 null 行，或 `0 + null` 混合）→ **未知用量**：
       *   仍计入 `unknown_count`（循环开头已计），方案**不得判 ready**。
       *
       * ⚠️ 显式 `0` **不是**「适量」，也不会被伪造成 `null`。
       */
      if (req.has_known_line && !req.has_unknown_line) {
        requiredCount++
        satisfiedCount++
        coverageRatios.push(1)
        utilizationRatios.push(0)
        expiringRatios.push(0)
        requirements.push({
          definition_id: req.definition_id,
          definition_name: req.definition_name,
          unit: req.unit,
          required_quantity: 0,
          available_quantity: availableQty,
          missing_quantity: 0,
          status: 'ok',
          is_seasoning: false,
          used_expiring: false,
          expired_excluded_quantity: expiredQty,
          note: `「${req.definition_name}」用量为 0，按零需求处理（不占用库存）`,
        })
        continue
      }

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
      // 单位不匹配：需求未满足，三条比率都为 0（不虚报任何收益）
      coverageRatios.push(0)
      utilizationRatios.push(0)
      expiringRatios.push(0)
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
      // 需求满足比例（本条需求自己的口径）；缺口**不给**减少浪费奖励、也不算临期消耗
      coverageRatios.push(clamp01(req.known_required > 0 ? availableQty / req.known_required : 0))
      utilizationRatios.push(0)
      expiringRatios.push(0)
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
    // 需求满足比例 = min(需求, 可用) / 需求 = 1（已满足）
    coverageRatios.push(1)
    /** 本条需求**实际会扣到的临期批次数量**（R3：按 FEFO 分配得出） */
    let consumedExpiringQty = 0
    if (req.has_unknown_line) {
      /**
       * ⚠️⚠️ 同一 key 里混有「未指定用量」的行时：
       *    - **不**计入可用库存消耗比例（不得虚报「库存被高效利用」）
       *    - **不**声称会消耗临期食材
       * 因为「还有一行不知道要多少」，任何收益声明都是没有依据的。
       */
      utilizationRatios.push(0)
      expiringRatios.push(0)
    } else {
      // 可用库存消耗比例：满足时 = 需求 / 可用（越接近 1 越不浪费）；缺口时上面已推 0
      utilizationRatios.push(
        clamp01(availableQty > 0 ? req.known_required / availableQty : 0),
      )

      /**
       * v0.2.3（R3）：临期收益必须按**结算同款 FEFO 实际分配**计算 ——
       * 只统计"真的会被扣到的那批临期库存"被扣掉的数量。
       *
       * ⚠️ 反例（修复前会误报收益）：`normal` 批次到期 10-18、`expiring` 批次到期 10-20，
       *    需求 50 → FEFO 先扣 10-18 那个（它是 `normal`），临期批次**一颗未动**
       *    → 真实临期消耗 = 0。旧实现只看"存在临期批次"就 +12 分与 25 分比例奖励。
       */
      const allocation = allocateByFefo(
        lots,
        req.unit,
        req.known_required,
        options.includeExpiredInFefo === true,
      )
      let consumedExpiring = 0
      for (const entry of allocation) {
        if (entry.lot.expiry_status === 'expiring') {
          consumedExpiring = roundQuantity(consumedExpiring + entry.take)
        }
      }
      consumedExpiringQty = consumedExpiring
      expiringRatios.push(clamp01(consumedExpiring / req.known_required))
      // 「共享」奖励只发给**真正满足且无未知用量**的需求（缺口不给奖励）
      satisfiedKeys.add(req.key)
    }
    // 只有确实满足、且**确实会扣到临期批次**时，才声称「会消耗临期」
    const usedExpiring = !req.has_unknown_line && consumedExpiringQty > 0
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

  // v0.2.4：缺口只由主食材构成，调味品不计
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

  /**
   * v0.2.3：被 ≥2 道菜共享的食材项数（⚠️ 必须在需求循环**之后**统计，
   * 因为要先知道哪些需求被满足了）。
   *
   * 口径三条同时成立才计入：
   *   ① **同 definition 且同单位**（合并键相同）出现在 **≥2 道菜**里；
   *   ② 该条需求**已被满足**（库存不够时不给「减少浪费」奖励）；
   *   ③ 该条需求**没有未知用量**（同 F2：未知不虚报收益）。
   */
  let sharedRequirementCount = 0
  for (const [key, dishSet] of keyDishIndex) {
    if (dishSet.size >= 2 && satisfiedKeys.has(key)) sharedRequirementCount++
  }

  /**
   * v0.2.3：**需求满足比例**（排序用）。
   *
   * ⚠️ 逐条需求各算 `min(需求, 可用) / 需求`，再取**平均** ——
   *    绝不把不同单位的数量相加，因此「克」与「个」不会互相压制，
   *    同一场景换计量尺度必然得到同一指标。
   * ⚠️ 只用**合并后**的需求，同一批库存不会被重复计算。
   */
  const quantityCoverage = coverageRatios.length === 0 ? 1 : mean(coverageRatios)

  /**
   * v0.2.3：**可用库存消耗比例**（= 需求里的「食材利用率 / 减少浪费」）。
   *
   * - 需求被满足时 = `需求 / 可用`（越接近 1 说明越不浪费）；
   * - **缺口需求恒为 0** —— 缺料方案不得因为「用掉了一大半库存」而拿奖励；
   * - 未知用量、调味品、无已知需求 → 0（不虚报收益）。
   */
  const utilization = mean(utilizationRatios)

  /**
   * v0.2.3：**临期可实耗比例**（0–1）。
   *
   * 逐条需求 `min(需求, 临期可用) / 需求` 的平均值；
   * 缺口、未知用量、单位不匹配的需求一律贡献 0 ——
   * 不会出现「明明做不了却声称用掉了临期食材」。
   */
  const expiringRatio = mean(expiringRatios)

  /* ---------- 3) 组合多样性（轻量：分类差异 + 标签数量） ---------- */
  const diversityScore = categoriesUsed.size + Math.min(tagsUsed.size, 5)

  /* ---------- 4) 结构搭配（v0.2.3：标签层面粗略搭配） ---------- */
  const structure = computeStructure(dishes)

  return {
    requirements,
    required_count: requiredCount,
    satisfied_count: satisfiedCount,
    main_missing_count: mainMissing,
    seasoning_missing_count: seasoningMissing,
    seasoning_reminder_count: seasoningReminder,
    missing_count: missingCount,
    unknown_count: unknownCount,
    expiring_used_count: expiringUsed,
    expired_excluded_count: expiredExcluded,
    coverage: Math.round(coverage * 10000) / 10000,
    quantity_coverage: Math.round(quantityCoverage * 10000) / 10000,
    utilization: Math.round(utilization * 10000) / 10000,
    expiring_ratio: Math.round(expiringRatio * 10000) / 10000,
    shared_requirement_count: sharedRequirementCount,
    structure_score: structure.score,
    dish_roles: structure.roles,
    feature_tags: structure.featureTags,
    diversity_score: diversityScore,
    categories_used: [...categoriesUsed].sort(),
    tags_used: [...tagsUsed].sort(),
  }
}

/* ============================================================
 * 打分与排序键
 * ============================================================ */

/**
 * 软信号（v0.2.3）：偏好 / 烹饪历史 / 每日轮换。
 *
 * ⚠️ 三项都由 `recommendationRanking.ts` 的**纯函数**算出，
 *    这里只负责并入总分与分项呈现。
 */
export interface PlanSoftScoreInput {
  /** 点赞 − 点踩的加权结果 */
  preference: number
  /** 近期已做完的降权（通常为负） */
  history: number
  /** 每日确定性轮换 + 重复组合惩罚（可正可负） */
  rotation: number
}

export const ZERO_SOFT_SCORE: PlanSoftScoreInput = { preference: 0, history: 0, rotation: 0 }

/** 评分分项（v0.2.3：每套方案都要能向用户解释分数从哪来） */
export interface PlanScoreBreakdown {
  ready_bonus: number
  coverage: number
  utilization: number
  expiring: number
  structure: number
  shared: number
  diversity: number
  missing_penalty: number
  seasoning_penalty: number
  unknown_penalty: number
  /** 库存侧小计（不含软信号） */
  stock_total: number
  preference: number
  history: number
  rotation: number
  /** 最终总分 */
  total: number
}

function roundScore(raw: number): number {
  const factor = 10 ** SCORE_DECIMALS
  return Math.round(raw * factor) / factor
}

/** 把比率钳制到 [0,1]；非有限值（NaN/Infinity）一律为 0 */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 算术平均；空数组返回 0（调用方按需决定空集语义） */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

/**
 * 完整的评分分项（确定性）。
 *
 * 库存侧优先级：**库存全足 > 满足比例 / 用量利用率 > 消耗临期 > 结构搭配 > 组合多样**，
 * 缺口与未知用量扣分。软信号（偏好 / 历史 / 轮换）**只在库存侧之后生效**，
 * 因此不可能把「库存严重不足」的方案顶到好方案前面。
 */
export function scoreBreakdown(
  evaluation: PlanEvaluation,
  soft: PlanSoftScoreInput = ZERO_SOFT_SCORE,
): PlanScoreBreakdown {
  const w = RECOMMENDATION_WEIGHTS
  /**
   * ⚠️ 只有**真正 ready** 才给全足奖励。
   *
   * v0.2.4：**调味品不参与**。它不计库存、不扣量，
   * 因此「家里没记着有盐」不能让一套库存全足的方案丢掉满分奖励。
   * 判定条件 = 主食材无缺口 + 无未知用量。
   */
  const isTrulyReady =
    evaluation.main_missing_count === 0 && evaluation.unknown_count === 0

  const readyBonus = isTrulyReady ? w.ready_bonus : 0
  const coveragePart = w.coverage * evaluation.coverage
  const utilizationPart = w.utilization * evaluation.utilization
  const expiringPart =
    w.expiring_each * evaluation.expiring_used_count + w.expiring_ratio * evaluation.expiring_ratio
  const structurePart = w.structure * evaluation.structure_score
  const sharedPart = w.shared_each * evaluation.shared_requirement_count
  const diversityPart = w.diversity * evaluation.diversity_score
  const missingPenalty = w.missing_each * evaluation.main_missing_count
  // v0.2.4：调味品不扣分（`seasoning_missing_count` 恒 0，这里显式写 0）
  const seasoningPenalty = 0
  const unknownPenalty = w.unknown_each * evaluation.unknown_count

  const stockTotal = roundScore(
    readyBonus +
      coveragePart +
      utilizationPart +
      expiringPart +
      structurePart +
      sharedPart +
      diversityPart -
      missingPenalty -
      seasoningPenalty -
      unknownPenalty,
  )

  return {
    ready_bonus: readyBonus,
    coverage: coveragePart,
    utilization: utilizationPart,
    expiring: expiringPart,
    structure: structurePart,
    shared: sharedPart,
    diversity: diversityPart,
    missing_penalty: missingPenalty,
    seasoning_penalty: seasoningPenalty,
    unknown_penalty: unknownPenalty,
    stock_total: stockTotal,
    preference: roundScore(soft.preference),
    history: roundScore(soft.history),
    rotation: roundScore(soft.rotation),
    total: roundScore(stockTotal + soft.preference + soft.history + soft.rotation),
  }
}

/**
 * 打分（确定性，**库存侧**）。
 *
 * 保持 v0.2.2 的对外语义（不含偏好 / 历史 / 轮换），
 * 便于既有断言与单测继续成立；需要完整分项请用 `scoreBreakdown`。
 */
export function scorePlan(evaluation: PlanEvaluation): number {
  return scoreBreakdown(evaluation).stock_total
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
    /**
     * ⚠️ v0.2.4：**调味品不参与降级**。
     *    它不计库存、不扣量，不能让一套库存够的方案被判 `nearly`。
     *    仍会影响等级的是「主食材缺口」与「非调味品的未知用量」。
     */
    return evaluation.unknown_count > 0 ? 'nearly' : 'ready'
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
