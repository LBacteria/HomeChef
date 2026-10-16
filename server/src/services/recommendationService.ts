/**
 * v0.2.2 整餐推荐 —— **服务层**（取数、编排、快照指纹、生成中文理由）。
 *
 * ⚠️ 本模块的**推荐**路径只读：绝不写库（库存扣减只发生在既有结算流程）。
 * ⚠️ 算法本身在 `recommendationAlgorithm.ts`（纯函数，便于单测与复现）。
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { category, ingredientDefinition, recipe } from '../db/schema.js'
import {
  DEFAULT_RECIPE_BASE_SERVINGS,
  MAX_CANDIDATE_RECIPES,
  MAX_COMBINATIONS,
  MAX_PEOPLE,
  MAX_PLANS,
  MEAL_SIZE_BY_PEOPLE,
  MIN_PEOPLE,
  MIN_PLANS,
  OVERLAP_PENALTY,
} from './recommendationConfig.js'
import {
  enumerateCombinations,
  evaluateCombination,
  planLevel,
  planLevelRank,
  planSignature,
  scorePlan,
} from './recommendationAlgorithm.js'
import type {
  CandidateRecipeInput,
  DefinitionMeta,
  DefinitionMetaMap,
  DishSpec,
  EvaluatedRequirement,
  PlanEvaluation,
  RecipeLineInput,
  StockIndex,
  StockLotInput,
} from './recommendationAlgorithm.js'
import { evaluateExpiryStatus } from './expiryStatusService.js'
import { getSettings } from './settingsService.js'
import { getRecipeById, listRecipes } from './recipeService.js'
import { listStock } from './standardIngredientService.js'
import { todayDateString } from './dates.js'
import { recipeNotFoundError, snapshotStaleError, validationError } from './errors.js'
import { roundQuantity } from './quantity.js'

/* ============================================================
 * 对外类型
 * ============================================================ */

export interface RecommendationDishIngredient {
  definition_id: number
  definition_name: string
  /** **已按份数倍数缩放**的需求量；未指定用量时为 null */
  quantity: number | null
  unit: string | null
  note: string | null
  is_seasoning: boolean
}

export interface RecommendationDishStep {
  step_no: number
  content: string
}

export interface RecommendationDish {
  recipe_id: number
  recipe_name: string
  /** 份数倍数（= 人数 ÷ 基准人数） */
  servings: number
  tags: string[]
  content_revision: number
  /** 该道菜**缩放后**的配料（可直接照着备料） */
  ingredients: RecommendationDishIngredient[]
  /** 该道菜的步骤 */
  steps: RecommendationDishStep[]
}

export interface RecommendationPlan {
  /** 稳定标识：recipe_id×servings 的升序拼接 */
  plan_id: string
  /**
   * 快照指纹：apply 时必须原样回传。
   *
   * 覆盖会影响用量与可用性的全部服务端事实（菜谱配料与内容版本、
   * 相关食材的分类/调味品属性与全部库存批次、临期设置、当天日期）。
   * 期间任何一项变化 → apply 返回 **409 SNAPSHOT_STALE**。
   */
  snapshot_id: string
  level: 'ready' | 'nearly' | 'missing'
  score: number
  dishes: RecommendationDish[]
  requirements: EvaluatedRequirement[]
  summary: {
    required_count: number
    satisfied_count: number
    missing_count: number
    main_missing_count: number
    seasoning_missing_count: number
    unknown_count: number
    expiring_used_count: number
    expired_excluded_count: number
    coverage: number
    categories_used: string[]
    tags_used: string[]
  }
  /** 中文可解释理由 */
  reasons: string[]
}

export interface MealPlanResult {
  people: number
  base_servings: number
  multiplier: number
  dish_count: number
  candidate_recipe_count: number
  /** 参与组合的候选数（截断后） */
  considered_recipe_count: number
  /** 是否因候选上限发生截断 */
  candidate_truncated: boolean
  combinations_evaluated: number
  truncated: boolean
  /** 用于计算保质期状态的「今天」，便于复现 */
  today: string
  plans: RecommendationPlan[]
  notes: string[]
}

/** apply 的输入（人数 + 每道菜的份数倍数 + 用户确认时的快照指纹） */
export interface MealSnapshotInput {
  people: number
  dishes: Array<{ recipe_id: number; servings: number }>
  snapshot_id: string
}

/* ============================================================
 * 输入校验
 * ============================================================ */

/** 校验并返回人数（严格：必须是整数且在范围内） */
export function validatePeople(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw validationError(`人数必须是整数，当前为：${String(raw)}`)
  }
  if (raw < MIN_PEOPLE || raw > MAX_PEOPLE) {
    throw validationError(`人数必须在 ${MIN_PEOPLE}–${MAX_PEOPLE} 之间，当前为：${raw}`)
  }
  return raw
}

/** 人数 → 份数倍数（推荐与结算共用同一倍率） */
export function multiplierFor(people: number): number {
  return roundQuantity(people / DEFAULT_RECIPE_BASE_SERVINGS)
}

function desiredDishCount(people: number): number {
  for (const rule of MEAL_SIZE_BY_PEOPLE) {
    if (people <= rule.max_people) return rule.dishes
  }
  return MEAL_SIZE_BY_PEOPLE[MEAL_SIZE_BY_PEOPLE.length - 1].dishes
}

/* ============================================================
 * 取数（全部只读）
 * ============================================================ */

function buildDefinitionMeta(): DefinitionMetaMap {
  const defs = db.select().from(ingredientDefinition).all()
  const cats = db.select().from(category).all()
  const catName = new Map<number, string>()
  for (const c of cats) catName.set(c.id, c.name)

  const map = new Map<number, DefinitionMeta>()
  for (const d of defs) {
    const name = d.category_id === null ? null : (catName.get(d.category_id) ?? null)
    map.set(d.id, {
      is_seasoning: name !== null && name === '调味品',
      category_name: name,
    })
  }
  return map
}

interface ExpiryRuleSnapshot {
  mode: string
  threshold: number
  /** 结算侧是否允许消耗过期库存（推荐侧**一律从严**，但它是快照的一部分） */
  allow_expired: boolean
}

function currentRule(): ExpiryRuleSnapshot {
  const s = getSettings()
  return {
    mode: s.expiry_warning_mode,
    threshold: s.expiry_warning_threshold,
    allow_expired: s.allow_expired_for_recipe,
  }
}

function buildStockIndex(today: string, rule: ExpiryRuleSnapshot): { index: StockIndex; lotCount: number } {
  const rows = listStock()
  const index = new Map<number, StockLotInput[]>()
  for (const row of rows) {
    const evaluation = evaluateExpiryStatus(
      {
        expiry_date: row.expiry_date,
        purchase_date: row.purchase_date,
        production_date: row.production_date,
      },
      { mode: rule.mode as never, threshold: rule.threshold },
      today,
    )
    const lot: StockLotInput = {
      definition_id: row.definition_id,
      unit: row.unit,
      quantity: row.quantity,
      expiry_status: evaluation.status,
    }
    const list = index.get(row.definition_id)
    if (list) list.push(lot)
    else index.set(row.definition_id, [lot])
  }
  return { index, lotCount: rows.length }
}

/** 候选菜谱（含配料、步骤、内容版本） */
interface LoadedRecipe extends CandidateRecipeInput {
  content_revision: number
  steps: Array<{ step_no: number; content: string }>
}

function loadRecipe(recipeId: number): LoadedRecipe {
  const detail = getRecipeById(recipeId)
  return {
    recipe_id: detail.id,
    recipe_name: detail.name,
    tags: detail.tags,
    content_revision: detail.content_revision,
    steps: detail.steps.map((s) => ({ step_no: s.step_no, content: s.content })),
    lines: detail.ingredients
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((l) => ({
        definition_id: l.definition_id,
        definition_name: l.definition_name,
        quantity: l.quantity,
        unit: l.unit,
        note: l.note,
        sort_order: l.sort_order,
      })),
  }
}

/** 取全部候选（按 id 升序，确定性） */
function loadAllCandidates(): { all: LoadedRecipe[]; withIngredients: number } {
  const summaries = listRecipes()
    .filter((r) => r.ingredient_count > 0)
    .sort((a, b) => a.id - b.id)
  return {
    all: summaries.map((s) => loadRecipe(s.id)),
    withIngredients: summaries.length,
  }
}

/* ============================================================
 * 候选排序（条目⑤）：先按**单菜库存匹配**排序，再截断
 * ============================================================ */

/**
 * 按「这道菜单独看能不能做、能覆盖多少」排序。
 *
 * ⚠️ 旧实现直接按 recipe_id 截断前 40 个，会把**后新增的、明明库存充足**
 *    的菜谱丢掉。现在先按单菜匹配度排序再截断，且排序键完全确定：
 *    等级 → 主缺口数 → 覆盖比例降序 → 临期消耗降序 → recipe_id 升序。
 */
function orderCandidatesByStock(
  candidates: readonly LoadedRecipe[],
  stock: StockIndex,
  meta: DefinitionMetaMap,
  multiplier: number,
): LoadedRecipe[] {
  const scored = candidates.map((c) => {
    const e = evaluateCombination([toDishSpec(c, multiplier)], stock, meta)
    return {
      c,
      level: planLevelRank(planLevel(e)),
      missing: e.main_missing_count,
      coverage: e.coverage,
      expiring: e.expiring_used_count,
    }
  })

  scored.sort((a, b) => {
    if (a.level !== b.level) return a.level - b.level
    if (a.missing !== b.missing) return a.missing - b.missing
    if (b.coverage !== a.coverage) return b.coverage - a.coverage
    if (b.expiring !== a.expiring) return b.expiring - a.expiring
    return a.c.recipe_id - b.c.recipe_id
  })

  return scored.map((s) => s.c)
}

function toDishSpec(recipe: LoadedRecipe, servings: number): DishSpec {
  return {
    recipe_id: recipe.recipe_id,
    recipe_name: recipe.recipe_name,
    tags: recipe.tags,
    servings,
    lines: recipe.lines,
  }
}

/* ============================================================
 * 快照指纹（条目⑪）
 * ============================================================ */

interface SnapshotContext {
  today: string
  rule: ExpiryRuleSnapshot
  stock: StockIndex
  meta: DefinitionMetaMap
  recipes: ReadonlyMap<number, LoadedRecipe>
}

/**
 * 规范化快照载荷：只包含**会影响用量或可用性**的服务端事实。
 *
 * 全部数组按确定顺序排列，保证同一状态必然得到同一字符串。
 */
function canonicalSnapshotPayload(
  dishes: ReadonlyArray<{ recipe_id: number; servings: number }>,
  ctx: SnapshotContext,
): string {
  const recipeIds = [...new Set(dishes.map((d) => d.recipe_id))].sort((a, b) => a - b)

  const defIds = new Set<number>()
  for (const id of recipeIds) {
    for (const l of ctx.recipes.get(id)?.lines ?? []) defIds.add(l.definition_id)
  }

  const payload = {
    v: 1,
    today: ctx.today,
    settings: {
      expiry_warning_mode: ctx.rule.mode,
      expiry_warning_threshold: ctx.rule.threshold,
      allow_expired_for_recipe: ctx.rule.allow_expired,
    },
    dishes: [...dishes]
      .sort((a, b) => a.recipe_id - b.recipe_id)
      .map((d) => {
        const r = ctx.recipes.get(d.recipe_id)
        return {
          recipe_id: d.recipe_id,
          servings: d.servings,
          content_revision: r?.content_revision ?? null,
          lines: (r?.lines ?? [])
            .map((l) => [l.definition_id, l.quantity, l.unit, l.sort_order])
            .sort((a, b) => Number(a[3]) - Number(b[3])),
        }
      }),
    definitions: [...defIds]
      .sort((a, b) => a - b)
      .map((id) => ({
        definition_id: id,
        is_seasoning: ctx.meta.get(id)?.is_seasoning ?? false,
        category_name: ctx.meta.get(id)?.category_name ?? null,
        lots: (ctx.stock.get(id) ?? [])
          .map((l) => [l.unit, l.quantity, l.expiry_status])
          .sort((a, b) => {
            const ua = String(a[0])
            const ub = String(b[0])
            if (ua !== ub) return ua < ub ? -1 : 1
            const qa = Number(a[1])
            const qb = Number(b[1])
            if (qa !== qb) return qa - qb
            return String(a[2]) < String(b[2]) ? -1 : 1
          }),
      })),
  }

  return JSON.stringify(payload)
}

function fingerprintOf(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

/**
 * 计算一份「人数 + 菜品 + 份数」的服务端快照指纹。
 *
 * ⚠️ 完全基于**当前数据库事实**重算；客户端的任何字段都不参与。
 */
export function computeMealSnapshotId(
  dishes: ReadonlyArray<{ recipe_id: number; servings: number }>,
  today: string = todayDateString(),
): string {
  const rule = currentRule()
  const { index } = buildStockIndex(today, rule)
  const meta = buildDefinitionMeta()
  const recipes = new Map<number, LoadedRecipe>()
  for (const id of [...new Set(dishes.map((d) => d.recipe_id))]) {
    recipes.set(id, loadRecipe(id))
  }
  return fingerprintOf(
    canonicalSnapshotPayload(dishes, { today, rule, stock: index, meta, recipes }),
  )
}

/**
 * 校验 apply 提交的快照指纹，不一致则抛 **409 SNAPSHOT_STALE**。
 *
 * ⚠️ 绝不静默用新配方开做：菜谱配料、相关库存、分类或临期设置变了，
 *    都必须让用户重新确认后再来。
 */
export function assertSnapshotFresh(input: MealSnapshotInput, today: string = todayDateString()): void {
  const actual = computeMealSnapshotId(input.dishes, today)
  if (actual !== input.snapshot_id) {
    throw snapshotStaleError(
      '菜谱或库存在你确认之后发生了变化，为避免按旧配方开做，请返回重新生成并确认推荐。',
    )
  }
}

/** 校验菜谱存在（apply 前置）：不存在抛 404 */
export function assertRecipesExist(recipeIds: readonly number[]): void {
  for (const id of recipeIds) {
    const found = db.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, id)).get()
    if (!found) {
      throw recipeNotFoundError(`菜谱不存在：id=${id}`)
    }
  }
}

/* ============================================================
 * 中文理由（条目③：unknown / 缺调味品 不得写成「可以直接开做」）
 * ============================================================ */

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n)
}

function buildReasons(evaluation: PlanEvaluation, dishes: readonly DishSpec[]): string[] {
  const reasons: string[] = []
  const clean =
    evaluation.main_missing_count === 0 &&
    evaluation.seasoning_missing_count === 0 &&
    evaluation.unknown_count === 0

  if (clean) {
    reasons.push(`${dishes.length} 道菜的主要食材库存都够，可以直接开做。`)
  } else {
    // ⚠️ 先讲缺口，再讲不确定；**任何不确定都不能被描述成「都够」**
    if (evaluation.main_missing_count > 0) {
      const gaps = evaluation.requirements
        .filter((r) => r.status === 'insufficient' || r.status === 'unit_mismatch')
        .slice(0, 4)
        .map((r) =>
          r.status === 'insufficient' && r.missing_quantity !== null
            ? `${r.definition_name}（差 ${fmtQty(r.missing_quantity)} ${r.unit ?? ''}）`.trim()
            : `${r.definition_name}（单位不匹配）`,
        )
      reasons.push(`还缺 ${evaluation.main_missing_count} 项：${gaps.join('、')}。`)
    } else {
      reasons.push(`${dishes.length} 道菜的主要食材已知用量都够。`)
    }

    if (evaluation.unknown_count > 0) {
      reasons.push(
        `但有 ${evaluation.unknown_count} 项用量未指定（如「适量」），够不够无法判断，` +
          `仍需核对，结算时需逐项确认。`,
      )
    }
    if (evaluation.seasoning_missing_count > 0) {
      reasons.push(`还缺 ${evaluation.seasoning_missing_count} 项调味品。`)
    }
  }

  const expiringNames = evaluation.requirements
    .filter((r) => r.used_expiring)
    .map((r) => r.definition_name)
  if (expiringNames.length > 0) {
    reasons.push(
      `会用掉 ${expiringNames.length} 项临期食材：${expiringNames.slice(0, 4).join('、')}，可以优先消耗。`,
    )
  }

  if (evaluation.expired_excluded_count > 0) {
    reasons.push(
      `有 ${evaluation.expired_excluded_count} 项库存已过期，已按「不可用」处理，不计入上面的用量。`,
    )
  }

  if (evaluation.categories_used.length >= 3) {
    reasons.push(`食材分类较丰富：${evaluation.categories_used.slice(0, 6).join('、')}。`)
  }

  return reasons
}

/* ============================================================
 * 主入口
 * ============================================================ */

/**
 * 生成整餐推荐方案。
 *
 * @param rawPeople 人数（会严格校验）
 * @param today     注入「今天」，便于确定性测试；默认取系统今天
 *
 * ⚠️ 全程只读，不写数据库。
 */
export function recommendMealPlans(
  rawPeople: unknown,
  today: string = todayDateString(),
): MealPlanResult {
  const people = validatePeople(rawPeople)
  const multiplier = multiplierFor(people)
  const notes: string[] = []

  const rule = currentRule()
  const { index: stock, lotCount } = buildStockIndex(today, rule)
  const meta = buildDefinitionMeta()
  const { all, withIngredients } = loadAllCandidates()

  const desired = desiredDishCount(people)

  // 条目⑤：**先按单菜库存匹配排序，再截断**
  const ordered = orderCandidatesByStock(all, stock, meta, multiplier)
  const considered = ordered.slice(0, MAX_CANDIDATE_RECIPES)
  const candidateTruncated = ordered.length > considered.length

  const dishCount = Math.min(desired, considered.length)

  notes.push(
    `菜谱按 ${DEFAULT_RECIPE_BASE_SERVINGS} 人份为基准；${people} 人时每道菜按 ${multiplier} 倍量做。`,
  )
  if (candidateTruncated) {
    notes.push(
      `候选菜谱共 ${ordered.length} 个，仅评估「单菜库存匹配度最高」的前 ${MAX_CANDIDATE_RECIPES} 个` +
        `（排序键固定：等级 → 缺口 → 覆盖比例 → 临期消耗 → 菜谱 id），可能错过更优组合。`,
    )
  }
  if (dishCount < desired && dishCount > 0) {
    notes.push(`可用菜谱不足 ${desired} 道，按简餐（${dishCount} 道菜）推荐。`)
  }
  if (lotCount === 0) {
    notes.push('当前没有任何库存记录，推荐结果会以「缺料」为主。')
  }

  if (dishCount <= 0) {
    return {
      people,
      base_servings: DEFAULT_RECIPE_BASE_SERVINGS,
      multiplier,
      dish_count: 0,
      candidate_recipe_count: withIngredients,
      considered_recipe_count: 0,
      candidate_truncated: false,
      combinations_evaluated: 0,
      truncated: false,
      today,
      plans: [],
      notes: [...notes, '还没有带配料的菜谱，先到「菜谱」里建几个吧。'],
    }
  }

  const recipesById = new Map<number, LoadedRecipe>()
  for (const r of considered) recipesById.set(r.recipe_id, r)
  const ctx: SnapshotContext = { today, rule, stock, meta, recipes: recipesById }

  const indices = considered.map((_, i) => i)
  const combos = enumerateCombinations(indices, dishCount, MAX_COMBINATIONS)
  const truncated = combos.length >= MAX_COMBINATIONS

  interface Candidate {
    plan: RecommendationPlan
    recipeIds: number[]
    signature: string
    levelRank: number
  }

  const candidates: Candidate[] = []

  for (const combo of combos) {
    const dishes: DishSpec[] = combo.map((idx) => toDishSpec(considered[idx], multiplier))
    const evaluation = evaluateCombination(dishes, stock, meta)
    const level = planLevel(evaluation)
    const score = scorePlan(evaluation)
    const signature = planSignature(dishes)

    const dishPayload = combo.map((idx) => ({ recipe_id: considered[idx].recipe_id, servings: multiplier }))
    const snapshotId = fingerprintOf(canonicalSnapshotPayload(dishPayload, ctx))

    candidates.push({
      // 稳定排序键：分数降序 → 主缺口升序 → 临期消耗降序 → 签名升序
      recipeIds: [...new Set(dishes.map((d) => d.recipe_id))],
      signature,
      levelRank: planLevelRank(level),
      plan: {
        plan_id: signature,
        snapshot_id: snapshotId,
        level,
        score,
        dishes: [...dishes]
          .sort((a, b) => a.recipe_id - b.recipe_id)
          .map((d) => {
            const loaded = recipesById.get(d.recipe_id)!
            return {
              recipe_id: d.recipe_id,
              recipe_name: d.recipe_name,
              servings: d.servings,
              tags: [...d.tags],
              content_revision: loaded.content_revision,
              // 条目⑦⑨：**每道菜缩放后的配料与步骤**，可直接照着备料
              ingredients: loaded.lines.map((l) => ({
                definition_id: l.definition_id,
                definition_name: l.definition_name,
                quantity: l.quantity === null ? null : roundQuantity(l.quantity * d.servings),
                unit: l.unit,
                note: l.note ?? null,
                is_seasoning: meta.get(l.definition_id)?.is_seasoning ?? false,
              })),
              steps: loaded.steps.map((s) => ({ step_no: s.step_no, content: s.content })),
            }
          }),
        requirements: evaluation.requirements,
        summary: {
          required_count: evaluation.required_count,
          satisfied_count: evaluation.satisfied_count,
          missing_count: evaluation.missing_count,
          main_missing_count: evaluation.main_missing_count,
          seasoning_missing_count: evaluation.seasoning_missing_count,
          unknown_count: evaluation.unknown_count,
          expiring_used_count: evaluation.expiring_used_count,
          expired_excluded_count: evaluation.expired_excluded_count,
          coverage: evaluation.coverage,
          categories_used: evaluation.categories_used,
          tags_used: evaluation.tags_used,
        },
        reasons: buildReasons(evaluation, dishes),
      },
    })
  }

  candidates.sort((a, b) => {
    if (a.levelRank !== b.levelRank) return a.levelRank - b.levelRank
    if (b.plan.score !== a.plan.score) return b.plan.score - a.plan.score
    if (a.plan.summary.main_missing_count !== b.plan.summary.main_missing_count) {
      return a.plan.summary.main_missing_count - b.plan.summary.main_missing_count
    }
    return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0
  })

  /* ---------- 选 top N：等级优先 + 轻量重叠惩罚（条目⑤） ---------- */
  const pool = [...candidates]
  const selected: Candidate[] = []

  while (selected.length < MAX_PLANS && pool.length > 0) {
    // ⚠️ 同一等级内才比分数：保证「库存足够」永远优先于「缺料」
    const bestRank = pool[0].levelRank
    let bestIdx = 0
    let bestAdjusted = Number.NEGATIVE_INFINITY

    for (let i = 0; i < pool.length; i++) {
      const cand = pool[i]
      if (cand.levelRank !== bestRank) break
      const overlap = maxOverlapWithSelected(cand.recipeIds, selected)
      const adjusted = cand.plan.score - OVERLAP_PENALTY * overlap
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted
        bestIdx = i
      }
    }

    selected.push(pool[bestIdx])
    pool.splice(bestIdx, 1)
  }

  if (selected.length < MIN_PLANS && candidates.length > 0) {
    notes.push(`符合条件的组合只有 ${selected.length} 套（少于 ${MIN_PLANS} 套）。`)
  }

  return {
    people,
    base_servings: DEFAULT_RECIPE_BASE_SERVINGS,
    multiplier,
    dish_count: dishCount,
    candidate_recipe_count: withIngredients,
    considered_recipe_count: considered.length,
    candidate_truncated: candidateTruncated,
    combinations_evaluated: combos.length,
    truncated,
    today,
    plans: selected.map((s) => s.plan),
    notes,
  }
}

/** 与已选方案的最大菜品重合数 */
function maxOverlapWithSelected(
  recipeIds: readonly number[],
  selected: ReadonlyArray<{ recipeIds: number[] }>,
): number {
  let max = 0
  for (const s of selected) {
    let shared = 0
    for (const id of recipeIds) if (s.recipeIds.includes(id)) shared++
    if (shared > max) max = shared
  }
  return max
}

/** 供测试与调试：读取当前临期规则快照 */
export function currentExpiryRule(): ExpiryRuleSnapshot {
  return currentRule()
}

/** 供类型导出的补充（避免未使用告警） */
export type { RecipeLineInput }
