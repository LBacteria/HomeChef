/**
 * v0.2.2 整餐推荐 —— **服务层**（取数、编排、快照指纹、生成中文理由）。
 *
 * ⚠️ 本模块的**推荐**路径只读：绝不写库（库存扣减只发生在既有结算流程）。
 * ⚠️ 算法本身在 `recommendationAlgorithm.ts`（纯函数，便于单测与复现）。
 */

import { createHash } from 'node:crypto'
import { asc, eq, inArray } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  category,
  ingredientDefinition,
  recipe,
  recipeIngredient,
  recipeStep,
} from '../db/schema.js'
import {
  DEFAULT_RECIPE_BASE_SERVINGS,
  HISTORY_HALF_LIFE_DAYS,
  HISTORY_WINDOW_DAYS,
  MAX_CANDIDATE_RECIPES,
  MAX_COMBINATIONS,
  MAX_PEOPLE,
  MAX_PLANS,
  MEAL_SIZE_BY_PEOPLE,
  MIN_PEOPLE,
  MIN_PLANS,
} from './recommendationConfig.js'
import {
  enumerateCombinations,
  evaluateCombination,
  planLevel,
  planLevelRank,
  planSignature,
  scoreBreakdown,
} from './recommendationAlgorithm.js'
import type {
  CandidateRecipeInput,
  DefinitionMeta,
  DefinitionMetaMap,
  DishSpec,
  EvaluatedRequirement,
  PlanEvaluation,
  PlanScoreBreakdown,
  EvaluateOptions,
  RecipeLineInput,
  RecipeTagInput,
  StockIndex,
  StockLotInput,
} from './recommendationAlgorithm.js'
import {
  compareCandidateOrder,
  comparePlanOrder,
  computeSoftSignals,
  preferenceAdjustment,
  historyPenalty,
  quantityCoverageBucket,
} from './recommendationRanking.js'
import type { PlanOrderKey, PlanSoftSignals, PreferenceValue } from './recommendationRanking.js'
import { getPreferenceMap } from './preferenceService.js'
import {
  mainDishAnchorOf,
  mainIngredientIdsOf,
  sideComplementScore,
} from './mainDish.js'
import { selectDistinctMainPlans } from './planSelection.js'
import type { SelectablePlan } from './planSelection.js'
import { loadCookingHistory } from './cookingHistoryService.js'
import type { CookingHistory } from './cookingHistoryService.js'
import { DISH_ROLE_LABELS } from './tagConfig.js'
import { evaluateExpiryStatus } from './expiryStatusService.js'
import { getSettings } from './settingsService.js'
import { getRecipeById, listRecipes, listTagRefsByRecipeIds } from './recipeService.js'
import type { RecipeTagRef } from './recipeService.js'
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
  /** v0.2.4：本餐中的角色（后端唯一权威，前端不猜） */
  role_in_meal: 'main' | 'side'
  /** 份数倍数（= 人数 ÷ 基准人数） */
  servings: number
  tags: string[]
  content_revision: number
  /** 该道菜**缩放后**的配料（可直接照着备料） */
  ingredients: RecommendationDishIngredient[]
  /** 该道菜的步骤 */
  steps: RecommendationDishStep[]
}

/** 一条明确的缺口（v0.2.3：不足方案必须逐项标明缺什么） */
export interface RecommendationShortage {
  definition_id: number
  definition_name: string
  unit: string | null
  required_quantity: number | null
  available_quantity: number
  /** 还差多少；单位不匹配时为 null（无法换算） */
  missing_quantity: number | null
  status: 'insufficient' | 'unit_mismatch' | 'seasoning_missing'
  is_seasoning: boolean
  note: string
}

/** 软信号明细（v0.2.3：可解释，便于界面展示） */
export interface RecommendationSignals {
  preference: number
  history: number
  rotation: number
  /** 被点赞的菜谱 id（升序） */
  liked: number[]
  /** 被点踩的菜谱 id（升序） */
  disliked: number[]
  /** 近期已做完的菜谱 id（升序） */
  cooked_recently: number[]
  /** 是否与近期做过的一整套菜完全重合 */
  repeated_meal: boolean
}

export interface RecommendationPlan {
  /** 稳定标识：recipe_id×servings 的升序拼接 */
  plan_id: string
  /**
   * v0.2.4：本套方案的**唯一主菜锚点**（`dishes` 里必有且只有一条
   * `role_in_meal === 'main'` 与之对应）。
   */
  main_dish_recipe_id: number
  /**
   * 快照指纹：apply 时必须原样回传。
   *
   * 覆盖会影响用量与可用性的全部服务端事实（菜谱配料与内容版本、
   * 相关食材的分类/调味品属性与全部库存批次、临期设置、当天日期）。
   * 期间任何一项变化 → apply 返回 **409 SNAPSHOT_STALE**。
   *
   * ⚠️ 有意**不含**偏好、烹饪历史与标签：它们只影响排序，
   *    不影响「用什么、用多少」，因此不会让用户已确认的用量失效。
   */
  snapshot_id: string
  level: 'ready' | 'nearly' | 'missing'
  score: number
  /** 评分分项（v0.2.3：库存侧 + 软信号，逐项可解释） */
  score_breakdown: PlanScoreBreakdown
  /** 软信号明细 */
  signals: RecommendationSignals
  /** 缺口清单（无缺口时为空数组） */
  shortages: RecommendationShortage[]
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
    /** 需求满足比例（0–1，逐条需求比率均值；**排序用**，v0.2.3） */
    quantity_coverage: number
    /** 可用库存消耗比例（0–1，库存不足时为 0；减少浪费奖励用，v0.2.3） */
    utilization: number
    /** 临期可实耗比例（0–1，v0.2.3） */
    expiring_ratio: number
    /** 被 ≥2 道菜共享的食材项数（v0.2.3） */
    shared_requirement_count: number
    /** 结构搭配得分（标签层面粗略搭配，非营养数值，v0.2.3） */
    structure_score: number
    /** 本餐涉及的菜品类型角色（v0.2.3） */
    dish_roles: string[]
    /** 本餐涉及的「菜品特点」标签（v0.2.3） */
    feature_tags: string[]
    categories_used: string[]
    tags_used: string[]
  }
  /** 中文可解释理由 */
  reasons: string[]
}

/** 推荐的筛选条件（v0.2.3：标签也参与推荐筛选） */
export interface MealPlanFilter {
  /** 选中的 Tag 名称；空数组 = 不筛选 */
  tags?: string[]
  /** Tag 筛选模式：'and'（默认）| 'or' */
  tagMode?: 'and' | 'or'
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
  /** v0.2.3：本次使用的标签筛选（回显，便于界面提示） */
  tag_filter: {
    tags: string[]
    tag_mode: 'and' | 'or'
    /** 经过标签筛选后仍有配料的菜谱数 */
    matched_recipe_count: number
  }
  /** v0.2.3：命中的烹饪历史概览（只读派生信号） */
  history: {
    window_days: number
    /** 窗口内「已结算且确有完成菜品」的会话数 */
    settled_meals: number
    /** 窗口内做过的不同菜谱数 */
    cooked_recipes: number
  }
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
      // v0.2.3（R3）：FEFO 需要与结算一致的 (到期日, 批次 id) 排序输入
      lot_id: row.id,
      expiry_date: row.expiry_date,
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

function loadRecipe(recipeId: number, tagRefs: readonly RecipeTagInput[]): LoadedRecipe {
  const detail = getRecipeById(recipeId)
  return {
    recipe_id: detail.id,
    recipe_name: detail.name,
    tags: detail.tags,
    // v0.2.3：带分类与稳定 code 的 Tag 引用（结构语义按 code 判定）
    tag_refs: tagRefs.map((r) => ({ name: r.name, category: r.category, code: r.code })),
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

/**
 * 取全部候选（按 id 升序，确定性）。
 *
 * v0.2.3：支持按 Tag 筛选（复用既有 `listRecipes` 的 AND / OR 语义），
 * 并一次性取回全部 Tag 引用（避免逐菜谱查询）。
 */
function loadAllCandidates(filter: MealPlanFilter): { all: LoadedRecipe[]; withIngredients: number } {
  const summaries = listRecipes({
    tagNames: filter.tags ?? [],
    tagMode: filter.tagMode,
  })
    .filter((r) => r.ingredient_count > 0)
    .sort((a, b) => a.id - b.id)

  const ids = summaries.map((s) => s.id)
  const tagRefs = listTagRefsByRecipeIds(ids)
  const loaded = loadRecipesBulk(ids, tagRefs)

  return {
    all: ids.map((id) => loaded.get(id)!).filter((r) => r !== undefined),
    withIngredients: summaries.length,
  }
}

/** inArray 参数安全分块（SQLite 变量数上限远高于此，留足余量） */
const BULK_LOAD_CHUNK = 400

function chunkIds(ids: readonly number[], size: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

/**
 * v0.2.4：**批量**加载菜谱候选（菜谱 / 配料 / 步骤各 1 条查询）。
 *
 * 为什么需要：1200 道菜时逐菜 `getRecipeById` 会产生约 5000 条 SQL。
 *
 * ⚠️ 语义必须与 `loadRecipe` 完全一致：
 *   - 配料按 `sort_order` 升序、其次 `id` 升序；
 *   - 步骤按 `step_no` 升序、其次 `id` 升序；
 *   - Tag 名称按关联记录 id 升序（由 `listTagRefsByRecipeIds` 保证）；
 *   - 不在 id 列表里的菜谱不会凭空出现。
 */
function loadRecipesBulk(
  ids: readonly number[],
  tagRefs: Map<number, RecipeTagRef[]>,
): Map<number, LoadedRecipe> {
  const result = new Map<number, LoadedRecipe>()
  if (ids.length === 0) return result

  const linesByRecipe = new Map<number, RecipeLineInput[]>()
  const stepsByRecipe = new Map<number, Array<{ step_no: number; content: string }>>()
  const metaById = new Map<number, { name: string; content_revision: number }>()

  for (const chunk of chunkIds(ids, BULK_LOAD_CHUNK)) {
    for (const row of db
      .select({ id: recipe.id, name: recipe.name, content_revision: recipe.content_revision })
      .from(recipe)
      .where(inArray(recipe.id, chunk))
      .all()) {
      metaById.set(row.id, { name: row.name, content_revision: row.content_revision })
    }

    for (const row of db
      .select({
        recipe_id: recipeIngredient.recipe_id,
        definition_id: recipeIngredient.definition_id,
        definition_name: ingredientDefinition.name,
        quantity: recipeIngredient.quantity,
        unit: recipeIngredient.unit,
        note: recipeIngredient.note,
        sort_order: recipeIngredient.sort_order,
      })
      .from(recipeIngredient)
      .innerJoin(
        ingredientDefinition,
        eq(ingredientDefinition.id, recipeIngredient.definition_id),
      )
      .where(inArray(recipeIngredient.recipe_id, chunk))
      .orderBy(
        asc(recipeIngredient.recipe_id),
        asc(recipeIngredient.sort_order),
        asc(recipeIngredient.id),
      )
      .all()) {
      const line: RecipeLineInput = {
        definition_id: row.definition_id,
        definition_name: row.definition_name,
        quantity: row.quantity,
        unit: row.unit,
        note: row.note,
        sort_order: row.sort_order,
      }
      const list = linesByRecipe.get(row.recipe_id)
      if (list) list.push(line)
      else linesByRecipe.set(row.recipe_id, [line])
    }

    for (const row of db
      .select({
        recipe_id: recipeStep.recipe_id,
        step_no: recipeStep.step_no,
        content: recipeStep.content,
      })
      .from(recipeStep)
      .where(inArray(recipeStep.recipe_id, chunk))
      .orderBy(asc(recipeStep.recipe_id), asc(recipeStep.step_no), asc(recipeStep.id))
      .all()) {
      const step = { step_no: row.step_no, content: row.content }
      const list = stepsByRecipe.get(row.recipe_id)
      if (list) list.push(step)
      else stepsByRecipe.set(row.recipe_id, [step])
    }
  }

  for (const id of ids) {
    const meta = metaById.get(id)
    if (meta === undefined) continue
    const refs = tagRefs.get(id) ?? []
    result.set(id, {
      recipe_id: id,
      recipe_name: meta.name,
      tags: refs.map((r) => r.name),
      tag_refs: refs.map((r) => ({ name: r.name, category: r.category, code: r.code })),
      content_revision: meta.content_revision,
      steps: stepsByRecipe.get(id) ?? [],
      lines: linesByRecipe.get(id) ?? [],
    })
  }
  return result
}

/* ============================================================
 * 候选排序（条目⑤）：先按**单菜库存匹配**排序，再截断
 * ============================================================ */

/**
 * 按「这道菜单独看能不能做、能覆盖多少」排序。
 *
 * ⚠️ 旧实现直接按 recipe_id 截断前 40 个，会把**后新增的、明明库存充足**
 *    的菜谱丢掉。现在先按单菜匹配度排序再截断，且排序键完全确定：
 *    等级 → 主缺口数 → 用量覆盖（分桶） → **单菜软评分** → 临期消耗 → recipe_id。
 *
 * ⚠️⚠️ v0.2.3 关键点：偏好 / 历史**必须在这里就参与排序**。
 *    若只在最后给方案打分，被截断掉的菜谱会永远轮不到，
 *    「点赞加权 / 历史降权」就等于没生效。
 */
function orderCandidatesByStock(
  candidates: readonly LoadedRecipe[],
  stock: StockIndex,
  meta: DefinitionMetaMap,
  multiplier: number,
  recipeSoftScore: (recipeId: number) => number,
  evalOptions: EvaluateOptions,
): LoadedRecipe[] {
  const keyed = candidates.map((c) => {
    const e = evaluateCombination([toDishSpec(c, multiplier)], stock, meta, evalOptions)
    return {
      c,
      key: {
        level_rank: planLevelRank(planLevel(e)),
        main_missing_count: e.main_missing_count,
        // ⚠️ 排序必须用「需求满足比例」，不能用库存消耗比例
        //    （后者在库存越缺时反而越大，会偏好更缺的方案）
        quantity_coverage: e.quantity_coverage,
        recipe_soft_total: recipeSoftScore(c.recipe_id),
        expiring_used_count: e.expiring_used_count,
        recipe_id: c.recipe_id,
      },
    }
  })

  keyed.sort((a, b) => compareCandidateOrder(a.key, b.key))
  return keyed.map((s) => s.c)
}

function toDishSpec(recipe: LoadedRecipe, servings: number): DishSpec {
  return {
    recipe_id: recipe.recipe_id,
    recipe_name: recipe.recipe_name,
    tags: recipe.tags,
    tag_refs: recipe.tag_refs,
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
        /**
         * ⚠️ v0.2.4：**调味品的批次不参与快照**。
         *
         * 调味品不计库存、不扣量，只做备料提醒 —— 改盐的库存数量
         * 不应该让用户确认过的整餐快照失效。
         * 但 `is_seasoning` / `category_name` 仍保留：
         * 把某个食材从「调味品」改成普通分类（或反过来）会改变语义，**必须**失效。
         */
        lots: (ctx.meta.get(id)?.is_seasoning === true ? [] : (ctx.stock.get(id) ?? []))
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
    // ⚠️ 快照**有意不含** Tag（偏好/历史/标签都不影响用量），
    //    因此这里不需要 Tag 引用，传空数组即可。
    recipes.set(id, loadRecipe(id, []))
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

/**
 * 缺口清单（v0.2.3：不足方案必须**逐项**标明缺什么）。
 *
 * ⚠️ `unit_mismatch` 的 `missing_quantity` 为 null —— 不做单位换算，
 *    因此不谎报一个「差多少克」的数字。
 */
function buildShortages(evaluation: PlanEvaluation): RecommendationShortage[] {
  /**
   * ⚠️ v0.2.4：调味品**不进缺口清单**。
   *    它只做中性备料提醒（见 `seasoning_reminder`），
   *    既不占库存、也不影响能否开做，不能出现在「缺什么」里。
   */
  return evaluation.requirements
    .filter((r) => r.status === 'insufficient' || r.status === 'unit_mismatch')
    .map((r) => ({
      definition_id: r.definition_id,
      definition_name: r.definition_name,
      unit: r.unit,
      required_quantity: r.required_quantity,
      available_quantity: r.available_quantity,
      missing_quantity: r.missing_quantity,
      status: r.status as RecommendationShortage['status'],
      is_seasoning: r.is_seasoning,
      note: r.note,
    }))
}

function buildReasons(
  evaluation: PlanEvaluation,
  dishes: readonly DishSpec[],
  soft: PlanSoftSignals,
): string[] {
  const reasons: string[] = []
  /**
   * ⚠️ v0.2.4：调味品不计入「是否全足」。
   *    它不占库存、不扣量，因此不能说「没记着有盐 → 不能直接开做」。
   */
  const clean = evaluation.main_missing_count === 0 && evaluation.unknown_count === 0

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
  }

  /**
   * ⚠️ v0.2.4：调味品只做**中性提醒**。
   *    不根据库存说「家里有 / 没有」，也不写进缺口或「能不能开做」的结论里。
   */
  const seasoningReminders = evaluation.requirements
    .filter((r) => r.status === 'seasoning_reminder')
    .map((r) => r.definition_name)
  if (seasoningReminders.length > 0) {
    reasons.push(
      `调味品 ${seasoningReminders.length} 项（${seasoningReminders.slice(0, 4).join('、')}）` +
        `请自行准备：不计库存、也不扣量。`,
    )
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

  /* ---------- v0.2.3：结构搭配（标签层面粗略搭配，非营养数值） ---------- */
  if (evaluation.dish_roles.length > 0) {
    const roleNames = evaluation.dish_roles
      .map((r) => DISH_ROLE_LABELS[r as keyof typeof DISH_ROLE_LABELS] ?? r)
      .join('、')
    if (evaluation.structure_score < 0) {
      reasons.push(
        `菜型较单一（${roleNames}），建议再搭配一道不同类型的菜；标签搭配只是粗略参考，不代表营养数值。`,
      )
    } else if (evaluation.dish_roles.length >= 2) {
      reasons.push(`菜型较完整：${roleNames}；这只是按标签做的粗略搭配，不计算营养数值。`)
    }
  }

  /* ---------- v0.2.3：软信号（偏好 / 历史 / 轮换） ---------- */
  if (soft.disliked.length > 0) {
    reasons.push(`已按你的点踩降低这 ${soft.disliked.length} 道菜的排序权重（不会排除它们）。`)
  }
  if (soft.liked.length > 0) {
    reasons.push(`包含 ${soft.liked.length} 道你点赞过的菜，排序略有加权。`)
  }
  if (soft.cooked_recently.length > 0) {
    reasons.push(
      `有 ${soft.cooked_recently.length} 道菜最近刚做过，已按时间衰减降低权重，避免连续重复。`,
    )
  }
  if (soft.repeated_meal) {
    reasons.push('这套组合与你最近做过的一整餐完全相同，已额外降低排序权重。')
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
 * @param filter    v0.2.3：标签筛选（不传 = 不筛选）
 *
 * ⚠️ 全程只读，不写数据库（偏好 / 历史也只读）。
 */
export function recommendMealPlans(
  rawPeople: unknown,
  today: string = todayDateString(),
  filter: MealPlanFilter = {},
): MealPlanResult {
  const people = validatePeople(rawPeople)
  const multiplier = multiplierFor(people)
  const notes: string[] = []

  const rule = currentRule()
  /**
   * v0.2.3（R3 边界）：结算若允许用过期食材，临期收益预测必须按"过期先被扣"计算。
   * ⚠️ 只影响收益预测；"够不够"始终从严（过期不计入可用），与 `COUNT_EXPIRED_AS_AVAILABLE` 无关。
   */
  const evalOptions: EvaluateOptions = {
    includeExpiredInFefo: getSettings().allow_expired_for_recipe,
  }
  const { index: stock, lotCount } = buildStockIndex(today, rule)
  const meta = buildDefinitionMeta()

  /* ---------- v0.2.3：软信号（全部只读） ---------- */
  const preference: ReadonlyMap<number, PreferenceValue> = getPreferenceMap()
  const history: CookingHistory = loadCookingHistory(today, HISTORY_WINDOW_DAYS)

  const tags = (filter.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0)
  const tagMode: 'and' | 'or' = filter.tagMode === 'or' ? 'or' : 'and'

  const { all, withIngredients } = loadAllCandidates({ tags, tagMode })

  const desired = desiredDishCount(people)

  /** 单菜软评分：偏好 + 历史（**必须在候选截断前**生效） */
  const recipeSoftScore = (recipeId: number): number =>
    preferenceAdjustment([recipeId], preference) + historyPenalty([recipeId], history, today)

  // 条目⑤：**先按单菜库存匹配 + 单菜软评分排序，再截断**
  const ordered = orderCandidatesByStock(all, stock, meta, multiplier, recipeSoftScore, evalOptions)
  const considered = ordered.slice(0, MAX_CANDIDATE_RECIPES)
  const candidateTruncated = ordered.length > considered.length

  const dishCount = Math.min(desired, considered.length)

  notes.push(
    `菜谱按 ${DEFAULT_RECIPE_BASE_SERVINGS} 人份为基准；${people} 人时每道菜按 ${multiplier} 倍量做。`,
  )
  if (tags.length > 0) {
    notes.push(
      `已按标签筛选菜谱：${tags.join('、')}（${tagMode === 'and' ? '需同时满足' : '满足任一'}），` +
        `筛后仍有配料的菜谱 ${withIngredients} 个。`,
    )
  }
  if (candidateTruncated) {
    notes.push(
      `候选菜谱共 ${ordered.length} 个，仅评估「单菜库存匹配 + 偏好/历史」排序后的前 ` +
        `${MAX_CANDIDATE_RECIPES} 个` +
        `（排序键固定：等级 → 主缺口 → 用量覆盖 → 单菜软评分 → 临期消耗 → 菜谱 id），可能错过更优组合。`,
    )
  }
  if (history.recentMeals.length > 0) {
    notes.push(
      `已参考最近 ${HISTORY_WINDOW_DAYS} 天内真正做完的 ${history.byRecipe.size} 道菜` +
        `（按 ${HISTORY_HALF_LIFE_DAYS} 天半衰期降低权重），并做每日确定性轮换；` +
        `放弃的会话与未完成的菜不计入。`,
    )
  }
  if (history.clamped_future > 0) {
    notes.push(`有 ${history.clamped_future} 条烹饪记录的时间戳在未来，已按「今天」处理，未产生负天数。`)
  }
  if (history.skipped_invalid > 0) {
    notes.push(`有 ${history.skipped_invalid} 条烹饪记录的时间戳无效，已跳过。`)
  }
  if (dishCount < desired && dishCount > 0) {
    notes.push(`可用菜谱不足 ${desired} 道，按简餐（${dishCount} 道菜）推荐。`)
  }
  if (lotCount === 0) {
    notes.push('当前没有任何库存记录，推荐结果会以「缺料」为主。')
  }

  const historySummary = {
    window_days: HISTORY_WINDOW_DAYS,
    settled_meals: history.recentMeals.length,
    cooked_recipes: history.byRecipe.size,
  }
  const tagFilterSummary = { tags, tag_mode: tagMode, matched_recipe_count: withIngredients }

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
      tag_filter: tagFilterSummary,
      history: historySummary,
      plans: [],
      notes: [
        ...notes,
        tags.length > 0
          ? '按当前标签筛选后没有带配料的菜谱，换一组标签或先到「菜谱」里补充吧。'
          : '还没有带配料的菜谱，先到「菜谱」里建几个吧。',
      ],
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
    /** 完整排序键（等级 → 主缺口 → 覆盖 → 软评分 → 签名） */
    orderKey: PlanOrderKey
    /** 同档分组键（等级 | 主缺口 | 覆盖分桶）：软分只在同档内改变先后 */
    tierKey: string
    /** v0.2.4：主菜锚点与挑选用的附加信息 */
    selectable: SelectablePlan
  }

  const candidates: Candidate[] = []

  for (const combo of combos) {
    const dishes: DishSpec[] = combo.map((idx) => toDishSpec(considered[idx], multiplier))
    const evaluation = evaluateCombination(dishes, stock, meta, evalOptions)
    const level = planLevel(evaluation)
    const signature = planSignature(dishes)
    const recipeIds = [...new Set(dishes.map((d) => d.recipe_id))]

    // v0.2.3：软信号（偏好 / 历史 / 每日轮换 + 重复组合惩罚）
    const soft = computeSoftSignals({ signature, recipeIds, today, preference, history })
    const breakdown = scoreBreakdown(evaluation, {
      preference: soft.preference,
      history: soft.history,
      rotation: soft.rotation,
    })

    const dishPayload = combo.map((idx) => ({ recipe_id: considered[idx].recipe_id, servings: multiplier }))
    const snapshotId = fingerprintOf(canonicalSnapshotPayload(dishPayload, ctx))

    const levelRank = planLevelRank(level)
    const bucket = quantityCoverageBucket(evaluation.quantity_coverage)

    /**
     * v0.2.4：主菜锚点（同一集合与顺序无关）。
     * 一餐最多一个主菜，其余全是配菜。
     */
    const anchor = mainDishAnchorOf(dishes)
    if (anchor === null) continue // 空方案不可能出现，防御性跳过
    const anchorDish = dishes.find((d) => d.recipe_id === anchor.recipe_id)
    const mainDefinitionIds = new Set<number>(
      anchorDish === undefined
        ? []
        : [...mainIngredientIdsOf(anchorDish, (id) => meta.get(id)?.is_seasoning === true)],
    )
    const sideComplement = sideComplementScore(dishes, anchor.recipe_id)
    const tierKey = `${levelRank}|${evaluation.main_missing_count}|${bucket}`

    candidates.push({
      recipeIds,
      signature,
      tierKey,
      selectable: {
        plan_id: signature,
        tier_key: tierKey,
        score: breakdown.total,
        main_dish_recipe_id: anchor.recipe_id,
        main_dish_rank: anchor.rank,
        recipe_ids: recipeIds,
        main_definition_ids: [...mainDefinitionIds],
        side_complement: sideComplement,
      },
      orderKey: {
        level_rank: levelRank,
        main_missing_count: evaluation.main_missing_count,
        quantity_coverage: evaluation.quantity_coverage,
        soft_total: soft.total,
        signature,
      },
      plan: {
        plan_id: signature,
        main_dish_recipe_id: anchor.recipe_id,
        snapshot_id: snapshotId,
        level,
        score: breakdown.total,
        score_breakdown: breakdown,
        signals: {
          preference: soft.preference,
          history: soft.history,
          rotation: soft.rotation,
          liked: soft.liked,
          disliked: soft.disliked,
          cooked_recently: soft.cooked_recently,
          repeated_meal: soft.repeated_meal,
        },
        shortages: buildShortages(evaluation),
        /**
         * v0.2.4：**主菜排第一**，其余按 recipe_id 升序；
         * 每道菜显式带 `role_in_meal`，前端不再自己猜。
         */
        dishes: [...dishes]
          .sort((a, b) => {
            if (a.recipe_id === anchor.recipe_id) return -1
            if (b.recipe_id === anchor.recipe_id) return 1
            return a.recipe_id - b.recipe_id
          })
          .map((d) => {
            const loaded = recipesById.get(d.recipe_id)!
            return {
              recipe_id: d.recipe_id,
              recipe_name: d.recipe_name,
              role_in_meal: d.recipe_id === anchor.recipe_id ? ('main' as const) : ('side' as const),
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
          quantity_coverage: evaluation.quantity_coverage,
          utilization: evaluation.utilization,
          expiring_ratio: evaluation.expiring_ratio,
          shared_requirement_count: evaluation.shared_requirement_count,
          structure_score: evaluation.structure_score,
          dish_roles: evaluation.dish_roles,
          feature_tags: evaluation.feature_tags,
          categories_used: evaluation.categories_used,
          tags_used: evaluation.tags_used,
        },
        reasons: buildReasons(evaluation, dishes, soft),
      },
    })
  }

  candidates.sort((a, b) => comparePlanOrder(a.orderKey, b.orderKey))

  /**
   * ---------- 选 top N（v0.2.4：主菜优先变化） ----------
   *
   * 纯函数 `selectDistinctMainPlans` 负责：
   *   - 硬 tier 顺序不变（等级 → 主缺口 → 覆盖分桶），`ready` 不会被越过；
   *   - 每个主菜最多一套、签名不重复；
   *   - 同 tier 内先比「主菜食材变化 / 配菜互补」，再比既有总分。
   * 因此「换副菜凑五套」与「同一主菜多套」都不会发生。
   */
  const selectedIndexes = selectDistinctMainPlans(
    candidates.map((c) => c.selectable),
    MAX_PLANS,
  )
  const selected: Candidate[] = selectedIndexes.map((i) => candidates[i])

  if (selected.length < MIN_PLANS && candidates.length > 0) {
    // 用户语言：不展示候选上限 / 哈希 / 相似度之类的实现细节
    notes.push(
      `这次只凑出 ${selected.length} 套「主菜各不相同」的整餐，就不为了凑数重复同样的主菜了。` +
        `再多准备一两道不同的主菜，就能给出更多选择。`,
    )
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
    tag_filter: tagFilterSummary,
    history: historySummary,
    plans: selected.map((s) => s.plan),
    notes,
  }
}

/** 供测试与调试：读取当前临期规则快照 */
export function currentExpiryRule(): ExpiryRuleSnapshot {
  return currentRule()
}

/** 供类型导出的补充（避免未使用告警） */
export type { RecipeLineInput }
