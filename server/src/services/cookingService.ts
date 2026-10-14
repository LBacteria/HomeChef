import { and, asc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  cookingSession,
  cookingSessionDish,
  cookingSessionDishSkip,
  ingredientDefinition,
  recipe,
  recipeIngredient,
  recipeStep,
  standardIngredient,
} from '../db/schema.js'
import type { CookingSessionStatus, DishSkipReason } from '../db/schema.js'
import {
  dishNotFoundError,
  recipeNotFoundError,
  revisionStaleError,
  sessionNotFoundError,
  sessionStateInvalidError,
  validationError,
} from './errors.js'

/**
 * 烹饪会话 Service（v0.2.1 B2）。
 *
 * 本阶段实现：
 *   - 会话创建 / 查询 / 状态流转 / 放弃
 *   - 加菜（含**重复菜品合并份数**）/ 改份数 / 删菜
 *   - 烹饪进度读写（`current_step_no`）
 *   - 跳过确认的保存与失效重算（`cooking_session_dish_skip`）
 *
 * ❌ **不实现**：结算与库存扣减（B3）、前端（B4）。
 *
 * 设计要点：
 *   - 终态（`settled` / `abandoned`）**一律拒绝**任何写操作
 *   - `settled` 不可撤销；`abandoned` 不可恢复为活动状态
 *   - `confirmed_revision` 是**派生值**：只有「全部必需跳过项均已确认」
 *     才写入 `session.recipe_revision`，否则保持 `0`
 */

/** 终态：不可再修改 */
const TERMINAL_STATUSES: readonly CookingSessionStatus[] = ['settled', 'abandoned']

/** 必需跳过项的原因（参与 `confirmed_revision` 完整性判定） */
const REQUIRED_SKIP_REASONS: readonly DishSkipReason[] = ['null_quantity', 'unit_mismatch']

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 事务对象的类型。
 *
 * ⚠️ 不能写成 `typeof db` —— `db` 带 `$client` 属性而事务对象没有，
 *    沿用项目既有做法（见 definitionService / recipeService 的 `type Tx`）。
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 「可执行查询的对象」——事务对象或全局 db。
 *
 * ⚠️ 单独定义它是因为 `db` 带 `$client` 属性而事务对象没有，
 *    两者类型不兼容（实测 TS2345）。需要用联合类型表达。
 *    这样 `requiredSkipsOf()` 既能被事务内调用，也能被只读路径调用。
 */
type Queryable = Tx | typeof db

/* ============================================================
 * 类型
 * ============================================================ */

/** 会话列表项 / 详情中的菜品行 */
export interface CookingDishDetail {
  id: number
  recipe_id: number
  recipe_name: string
  servings: number
  status: 'pending' | 'done'
  current_step_no: number | null
  confirmed_revision: number
  sort_order: number
  /** 该菜谱当前步骤总数（供前端校验进度上界） */
  step_count: number
  /** 已确认齐全且版本一致 */
  confirmed: boolean
}

/** 会话详情 */
export interface CookingSessionDetail {
  id: number
  status: CookingSessionStatus
  recipe_revision: number
  started_at: string
  finished_at: string | null
  settled_at: string | null
  abandoned_at: string | null
  created_at: string
  updated_at: string
  dishes: CookingDishDetail[]
}

/** 跳过确认的输入项 */
export interface SkipConfirmation {
  dish_id: number
  line_key: string
  reason: DishSkipReason
}

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 读取会话；不存在则抛 404 */
function requireSession(sessionId: number) {
  const found = db.select().from(cookingSession).where(eq(cookingSession.id, sessionId)).get()
  if (!found) {
    throw sessionNotFoundError(`烹饪会话不存在：id=${sessionId}`)
  }
  return found
}

/** 会话是否可写（非终态） */
function assertWritable(status: CookingSessionStatus, sessionId: number): void {
  if (TERMINAL_STATUSES.includes(status)) {
    throw sessionStateInvalidError(
      `烹饪会话 ${sessionId} 处于终态「${status}」，不允许修改`,
    )
  }
}

/** 读取菜品行（限定属于该会话）；不存在则抛 404 */
function requireDish(sessionId: number, dishId: number) {
  const found = db
    .select()
    .from(cookingSessionDish)
    .where(and(eq(cookingSessionDish.id, dishId), eq(cookingSessionDish.session_id, sessionId)))
    .get()
  if (!found) {
    throw dishNotFoundError(`会话 ${sessionId} 中不存在菜品：dish_id=${dishId}`)
  }
  return found
}

/**
 * 计算某道菜的「必需跳过项」集合。
 *
 * 必需项有两类：
 *   ① `null_quantity` —— 原料行用量为 `null`（「适量」），无法计算扣减量
 *   ② `unit_mismatch` —— 用量非 null，但该食材**没有任何**单位与原料行
 *      完全一致的库存记录（含「完全没有库存记录」的情况）
 *
 * ⚠️ 单位匹配规则（已确认）：
 *    - 只要存在**至少一条** `unit` 完全一致的库存记录即为匹配
 *    - 该记录的 `quantity` 为 0 **也算匹配**（数量充足性属 B3，本函数不管）
 *    - **不做**任何单位换算（克 ≠ 个）
 *
 * ⚠️ `user_choice` 不参与本函数 —— 它由用户主动选择，不是必需项。
 */
function requiredSkipsOf(
  q: Queryable,
  recipeId: number,
): Array<{ line_key: string; definition_id: number; unit_key: string; reason: DishSkipReason }> {
  const rows = q
    .select({
      line_key: recipeIngredient.line_key,
      definition_id: recipeIngredient.definition_id,
      unit: recipeIngredient.unit,
      quantity: recipeIngredient.quantity,
    })
    .from(recipeIngredient)
    .where(eq(recipeIngredient.recipe_id, recipeId))
    .all()

  const result: Array<{
    line_key: string
    definition_id: number
    unit_key: string
    reason: DishSkipReason
  }> = []

  for (const r of rows) {
    if (r.line_key === null) continue // 无稳定标识的行无法被确认，跳过

    // ① 用量为 null（「适量」）→ 必需确认跳过
    if (r.quantity === null) {
      result.push({
        line_key: r.line_key,
        definition_id: r.definition_id,
        unit_key: r.unit ?? '',
        reason: 'null_quantity',
      })
      continue
    }

    // ② 用量非 null → 检查是否存在单位一致的库存记录
    //
    // 原料行 unit 为 null 时，没有任何库存单位能与之「完全一致」，
    // 因此同样构成 unit_mismatch。
    const hasUnitMatch =
      r.unit !== null &&
      q
        .select({ id: standardIngredient.id })
        .from(standardIngredient)
        .where(
          and(
            eq(standardIngredient.definition_id, r.definition_id),
            eq(standardIngredient.unit, r.unit),
          ),
        )
        .get() !== undefined

    if (!hasUnitMatch) {
      result.push({
        line_key: r.line_key,
        definition_id: r.definition_id,
        unit_key: r.unit ?? '',
        reason: 'unit_mismatch',
      })
    }
  }

  return result
}

/**
 * 重算并写入某道菜的 `confirmed_revision`。
 *
 * ⚠️ 这是**派生值**，绝不在写入确认行时简单置位：
 *    只有当「全部必需跳过项」都存在对应确认行时，
 *    才写入 `session.recipe_revision`；否则写入 `0`。
 *
 * @returns 重算后的值
 */
function recomputeConfirmedRevision(tx: Tx, sessionId: number, dishId: number): number {
  const session = tx.select().from(cookingSession).where(eq(cookingSession.id, sessionId)).get()
  if (!session) {
    throw sessionNotFoundError(`烹饪会话不存在：id=${sessionId}`)
  }

  const dish = tx.select().from(cookingSessionDish).where(eq(cookingSessionDish.id, dishId)).get()
  if (!dish) {
    throw dishNotFoundError(`菜品不存在：dish_id=${dishId}`)
  }

  const required = requiredSkipsOf(tx, dish.recipe_id)

  const confirmedKeys = new Set(
    tx
      .select({ line_key: cookingSessionDishSkip.line_key, reason: cookingSessionDishSkip.reason })
      .from(cookingSessionDishSkip)
      .where(eq(cookingSessionDishSkip.dish_id, dishId))
      .all()
      .filter((r) => (REQUIRED_SKIP_REASONS as readonly string[]).includes(r.reason))
      .map((r) => r.line_key),
  )

  // ★ 必须「全部必需项 ⊆ 已确认」才算齐全 —— 部分确认一律为 0
  const allConfirmed = required.every((r) => confirmedKeys.has(r.line_key))
  const next = allConfirmed ? session.recipe_revision : 0

  tx.update(cookingSessionDish)
    .set({ confirmed_revision: next, updated_at: nowIso() })
    .where(eq(cookingSessionDish.id, dishId))
    .run()

  return next
}

/**
 * 清空某会话的全部跳过确认，并把所有菜品的 `confirmed_revision` 归零。
 *
 * ⚠️ 用于「份数变化」等使既有确认失效的场景。
 */
function clearSkipsOfSession(tx: Tx, sessionId: number, timestamp: string): void {
  tx.delete(cookingSessionDishSkip).where(eq(cookingSessionDishSkip.session_id, sessionId)).run()
  tx.update(cookingSessionDish)
    .set({ confirmed_revision: 0, updated_at: timestamp })
    .where(eq(cookingSessionDish.session_id, sessionId))
    .run()
}

/** 组装会话详情 */
function buildDetail(sessionId: number): CookingSessionDetail {
  const session = requireSession(sessionId)

  const dishes = db
    .select({
      id: cookingSessionDish.id,
      recipe_id: cookingSessionDish.recipe_id,
      recipe_name: recipe.name,
      servings: cookingSessionDish.servings,
      status: cookingSessionDish.status,
      current_step_no: cookingSessionDish.current_step_no,
      confirmed_revision: cookingSessionDish.confirmed_revision,
      sort_order: cookingSessionDish.sort_order,
    })
    .from(cookingSessionDish)
    .innerJoin(recipe, eq(recipe.id, cookingSessionDish.recipe_id))
    .where(eq(cookingSessionDish.session_id, sessionId))
    .orderBy(asc(cookingSessionDish.sort_order), asc(cookingSessionDish.id))
    .all()

  const detailed: CookingDishDetail[] = dishes.map((d) => {
    // ⚠️ 步骤总数必须查 recipe_step（不是 recipe_ingredient）
    const stepCount = db
      .select({ id: recipeStep.id })
      .from(recipeStep)
      .where(eq(recipeStep.recipe_id, d.recipe_id))
      .all().length

    return {
      id: d.id,
      recipe_id: d.recipe_id,
      recipe_name: d.recipe_name,
      servings: d.servings,
      status: d.status as 'pending' | 'done',
      current_step_no: d.current_step_no,
      confirmed_revision: d.confirmed_revision,
      sort_order: d.sort_order,
      step_count: stepCount,
      confirmed: d.confirmed_revision !== 0 && d.confirmed_revision === session.recipe_revision,
    }
  })

  return {
    id: session.id,
    status: session.status as CookingSessionStatus,
    recipe_revision: session.recipe_revision,
    started_at: session.started_at,
    finished_at: session.finished_at,
    settled_at: session.settled_at,
    abandoned_at: session.abandoned_at,
    created_at: session.created_at,
    updated_at: session.updated_at,
    dishes: detailed,
  }
}

/* ============================================================
 * 会话：创建 / 查询 / 放弃
 * ============================================================ */

/**
 * 创建烹饪会话（状态 `active`）。
 */
export function createSession(): CookingSessionDetail {
  const timestamp = nowIso()

  const created = db
    .insert(cookingSession)
    .values({
      status: 'active',
      recipe_revision: 0,
      started_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returning({ id: cookingSession.id })
    .get()

  return buildDetail(created.id)
}

/** 列出全部会话（最近创建的在前） */
export function listSessions(): Array<{
  id: number
  status: CookingSessionStatus
  recipe_revision: number
  started_at: string
  dish_count: number
  created_at: string
  updated_at: string
}> {
  const rows = db
    .select()
    .from(cookingSession)
    .orderBy(asc(cookingSession.id))
    .all()

  return rows.map((s) => ({
    id: s.id,
    status: s.status as CookingSessionStatus,
    recipe_revision: s.recipe_revision,
    started_at: s.started_at,
    dish_count: db
      .select({ id: cookingSessionDish.id })
      .from(cookingSessionDish)
      .where(eq(cookingSessionDish.session_id, s.id))
      .all().length,
    created_at: s.created_at,
    updated_at: s.updated_at,
  }))
}

/** 会话详情 */
export function getSessionById(id: number): CookingSessionDetail {
  return buildDetail(id)
}

/**
 * 放弃会话（终态 `abandoned`）。
 *
 * ⚠️ 不扣减任何库存。已放弃的会话**不可恢复**为活动状态。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID
 */
export function abandonSession(id: number): CookingSessionDetail {
  const session = requireSession(id)
  assertWritable(session.status as CookingSessionStatus, id)

  const timestamp = nowIso()
  db.update(cookingSession)
    .set({ status: 'abandoned', abandoned_at: timestamp, updated_at: timestamp })
    .where(eq(cookingSession.id, id))
    .run()

  return buildDetail(id)
}

/* ============================================================
 * 菜品：加菜 / 改份数 / 删菜
 * ============================================================ */

/**
 * 向会话添加菜品。
 *
 * ⚠️⚠️ **重复添加同一菜谱 = 合并份数**（不新增行）——
 *    由 `UNIQUE(session_id, recipe_id)` 与显式查询共同保证。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / RECIPE_NOT_FOUND / VALIDATION_ERROR
 */
export function addDish(
  sessionId: number,
  recipeId: number,
  servings: number,
): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)

  const targetRecipe = db.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, recipeId)).get()
  if (!targetRecipe) {
    throw recipeNotFoundError(`菜谱不存在：id=${recipeId}`)
  }

  if (typeof servings !== 'number' || !Number.isFinite(servings) || servings <= 0) {
    throw validationError(`份数必须是大于 0 的有限数字，当前为：${String(servings)}`)
  }

  db.transaction((tx) => {
    const timestamp = nowIso()

    const existing = tx
      .select()
      .from(cookingSessionDish)
      .where(
        and(
          eq(cookingSessionDish.session_id, sessionId),
          eq(cookingSessionDish.recipe_id, recipeId),
        ),
      )
      .get()

    if (existing) {
      // ★ 合并份数：不新增行
      tx.update(cookingSessionDish)
        .set({ servings: existing.servings + servings, updated_at: timestamp })
        .where(eq(cookingSessionDish.id, existing.id))
        .run()

      // ★ 份数变化 → 需求量变化 → 该会话既有跳过确认一律失效
      //   （与 updateDishServings 保持一致，否则会产生陈旧确认）
      clearSkipsOfSession(tx, sessionId, timestamp)

      tx.update(cookingSession)
        .set({ updated_at: timestamp })
        .where(eq(cookingSession.id, sessionId))
        .run()
      return
    }

    const maxOrder = tx
      .select({ sort_order: cookingSessionDish.sort_order })
      .from(cookingSessionDish)
      .where(eq(cookingSessionDish.session_id, sessionId))
      .all()
      .reduce((m, r) => Math.max(m, r.sort_order), -1)

    tx.insert(cookingSessionDish)
      .values({
        session_id: sessionId,
        recipe_id: recipeId,
        servings,
        status: 'pending',
        current_step_no: null,
        confirmed_revision: 0,
        sort_order: maxOrder + 1,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .run()

    // ★ 菜品集合变化 → 清空该会话既有确认，避免陈旧确认残留
    clearSkipsOfSession(tx, sessionId, timestamp)

    tx.update(cookingSession)
      .set({ updated_at: timestamp })
      .where(eq(cookingSession.id, sessionId))
      .run()
  })

  return buildDetail(sessionId)
}

/**
 * 修改菜品份数。
 *
 * ⚠️ 份数变化会使该会话的**全部跳过确认失效**（需求量已变），
 *    因此同时清空确认并把 `confirmed_revision` 归零。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / DISH_NOT_FOUND / VALIDATION_ERROR
 */
export function updateDishServings(
  sessionId: number,
  dishId: number,
  servings: number,
): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)
  requireDish(sessionId, dishId)

  if (typeof servings !== 'number' || !Number.isFinite(servings) || servings <= 0) {
    throw validationError(`份数必须是大于 0 的有限数字，当前为：${String(servings)}`)
  }

  db.transaction((tx) => {
    const timestamp = nowIso()

    tx.update(cookingSessionDish)
      .set({ servings, updated_at: timestamp })
      .where(eq(cookingSessionDish.id, dishId))
      .run()

    // ★ 份数变化 → 需求变化 → 既有确认一律失效
    clearSkipsOfSession(tx, sessionId, timestamp)

    tx.update(cookingSession)
      .set({ updated_at: timestamp })
      .where(eq(cookingSession.id, sessionId))
      .run()
  })

  return buildDetail(sessionId)
}

/**
 * 从会话中移除菜品。
 *
 * ⚠️ 该菜品的跳过确认由 FK `ON DELETE CASCADE` 自动清理；
 *    同时把该会话其余菜品的确认一并失效（与其他写操作保持一致）。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / DISH_NOT_FOUND
 */
export function removeDish(sessionId: number, dishId: number): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)
  requireDish(sessionId, dishId)

  db.transaction((tx) => {
    const timestamp = nowIso()

    tx.delete(cookingSessionDish).where(eq(cookingSessionDish.id, dishId)).run()
    clearSkipsOfSession(tx, sessionId, timestamp)

    tx.update(cookingSession)
      .set({ updated_at: timestamp })
      .where(eq(cookingSession.id, sessionId))
      .run()
  })

  return buildDetail(sessionId)
}

/* ============================================================
 * 进度：菜品完成状态 与 步骤进度
 * ============================================================ */

/**
 * 更新菜品进度。
 *
 * @param status        'pending' | 'done'（可选）
 * @param currentStepNo 当前步骤序号（可选；`null` 表示重置为未开始）
 *
 * ⚠️ 全部菜品为 `done` 时，会话自动进入 `awaiting_settlement`。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / DISH_NOT_FOUND / VALIDATION_ERROR
 */
export function updateDishProgress(
  sessionId: number,
  dishId: number,
  status?: 'pending' | 'done',
  currentStepNo?: number | null,
): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)
  requireDish(sessionId, dishId)

  if (status !== undefined && status !== 'pending' && status !== 'done') {
    throw validationError(`菜品状态只能是 pending 或 done，当前为：${String(status)}`)
  }

  if (
    currentStepNo !== undefined &&
    currentStepNo !== null &&
    (typeof currentStepNo !== 'number' || !Number.isSafeInteger(currentStepNo) || currentStepNo < 1)
  ) {
    throw validationError(`步骤序号必须是正整数或 null，当前为：${String(currentStepNo)}`)
  }

  db.transaction((tx) => {
    const timestamp = nowIso()

    const patch: Record<string, unknown> = { updated_at: timestamp }
    if (status !== undefined) patch.status = status
    if (currentStepNo !== undefined) patch.current_step_no = currentStepNo

    tx.update(cookingSessionDish)
      .set(patch)
      .where(eq(cookingSessionDish.id, dishId))
      .run()

    // 全部菜品 done → 自动进入 awaiting_settlement
    const all = tx
      .select({ status: cookingSessionDish.status })
      .from(cookingSessionDish)
      .where(eq(cookingSessionDish.session_id, sessionId))
      .all()

    const allDone = all.length > 0 && all.every((d) => d.status === 'done')
    const patchSession: Record<string, unknown> = { updated_at: timestamp }

    if (allDone && session.status !== 'awaiting_settlement') {
      patchSession.status = 'awaiting_settlement'
      patchSession.finished_at = timestamp
    } else if (!allDone && session.status === 'awaiting_settlement') {
      // 有菜品被改回 pending → 退回 cooking
      patchSession.status = 'cooking'
      patchSession.finished_at = null
    } else if (!allDone && session.status === 'active' && all.length > 0) {
      patchSession.status = 'cooking'
    }

    tx.update(cookingSession)
      .set(patchSession)
      .where(eq(cookingSession.id, sessionId))
      .run()
  })

  return buildDetail(sessionId)
}

/* ============================================================
 * 跳过确认
 * ============================================================ */

/** 读取某会话的全部跳过确认 */
export function listSkips(sessionId: number): Array<{
  id: number
  dish_id: number
  line_key: string
  definition_id: number
  definition_name: string
  unit_key: string
  reason: DishSkipReason
  confirmed_at: string
}> {
  requireSession(sessionId)

  return db
    .select({
      id: cookingSessionDishSkip.id,
      dish_id: cookingSessionDishSkip.dish_id,
      line_key: cookingSessionDishSkip.line_key,
      definition_id: cookingSessionDishSkip.definition_id,
      definition_name: ingredientDefinition.name,
      unit_key: cookingSessionDishSkip.unit_key,
      reason: cookingSessionDishSkip.reason,
      confirmed_at: cookingSessionDishSkip.confirmed_at,
    })
    .from(cookingSessionDishSkip)
    .innerJoin(
      ingredientDefinition,
      eq(ingredientDefinition.id, cookingSessionDishSkip.definition_id),
    )
    .where(eq(cookingSessionDishSkip.session_id, sessionId))
    .orderBy(asc(cookingSessionDishSkip.dish_id), asc(cookingSessionDishSkip.id))
    .all()
    .map((r) => ({ ...r, reason: r.reason as DishSkipReason }))
}

/**
 * 保存跳过确认（幂等 upsert）。
 *
 * ⚠️ 每条确认必须指向**该菜品所属菜谱当前真实存在**的 `line_key`，
 *    否则 400（防止确认错项）。
 * ⚠️ `confirmed_revision` 由 `recomputeConfirmedRevision()` **重算**，
 *    绝不是「写一条确认就置位」——部分确认时保持 0。
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / DISH_NOT_FOUND / VALIDATION_ERROR
 */
export function saveSkipConfirmations(
  sessionId: number,
  confirmations: SkipConfirmation[],
): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)

  if (!Array.isArray(confirmations)) {
    throw validationError('confirmations 必须是数组')
  }

  // ① 事务外做纯格式校验
  for (const [index, c] of confirmations.entries()) {
    if (typeof c !== 'object' || c === null) {
      throw validationError(`第 ${index + 1} 条确认格式不正确`)
    }
    if (!Number.isSafeInteger(c.dish_id) || c.dish_id <= 0) {
      throw validationError(`第 ${index + 1} 条确认的 dish_id 必须是正整数`)
    }
    if (typeof c.line_key !== 'string' || c.line_key.trim().length === 0) {
      throw validationError(`第 ${index + 1} 条确认的 line_key 必须是非空字符串`)
    }
    if (!(REQUIRED_SKIP_REASONS as readonly string[]).includes(c.reason) &&
        c.reason !== 'user_choice') {
      throw validationError(`第 ${index + 1} 条确认的 reason 不合法：${String(c.reason)}`)
    }
  }

  db.transaction((tx) => {
    const timestamp = nowIso()
    const touchedDishes = new Set<number>()

    for (const c of confirmations) {
      const dish = tx
        .select()
        .from(cookingSessionDish)
        .where(
          and(eq(cookingSessionDish.id, c.dish_id), eq(cookingSessionDish.session_id, sessionId)),
        )
        .get()

      if (!dish) {
        throw dishNotFoundError(`会话 ${sessionId} 中不存在菜品：dish_id=${c.dish_id}`)
      }

      // ★ 核对 line_key 确实属于该菜谱的当前食材行
      const line = tx
        .select({
          line_key: recipeIngredient.line_key,
          definition_id: recipeIngredient.definition_id,
          unit: recipeIngredient.unit,
        })
        .from(recipeIngredient)
        .where(
          and(
            eq(recipeIngredient.recipe_id, dish.recipe_id),
            eq(recipeIngredient.line_key, c.line_key),
          ),
        )
        .get()

      if (!line) {
        throw validationError(
          `第 ${c.dish_id} 号菜品的 line_key 不属于其菜谱：${c.line_key}`,
        )
      }

      const existing = tx
        .select({ id: cookingSessionDishSkip.id })
        .from(cookingSessionDishSkip)
        .where(
          and(
            eq(cookingSessionDishSkip.dish_id, c.dish_id),
            eq(cookingSessionDishSkip.line_key, c.line_key),
          ),
        )
        .get()

      if (existing) {
        // 幂等：重复确认只更新原因与时间
        tx.update(cookingSessionDishSkip)
          .set({ reason: c.reason, confirmed_at: timestamp })
          .where(eq(cookingSessionDishSkip.id, existing.id))
          .run()
      } else {
        tx.insert(cookingSessionDishSkip)
          .values({
            session_id: sessionId,
            dish_id: c.dish_id,
            line_key: c.line_key,
            definition_id: line.definition_id,
            unit_key: line.unit ?? '',
            reason: c.reason,
            confirmed_at: timestamp,
          })
          .run()
      }

      touchedDishes.add(c.dish_id)
    }

    // ★ 重算受影响菜品的 confirmed_revision（派生值，不是简单置位）
    for (const dishId of touchedDishes) {
      if (TERMINAL_STATUSES.includes(session.status as CookingSessionStatus)) break
      recomputeConfirmedRevision(tx, sessionId, dishId)
    }
  })

  return buildDetail(sessionId)
}

/** 删除某条跳过确认，并重算该菜品的 `confirmed_revision` */
export function deleteSkipConfirmation(
  sessionId: number,
  dishId: number,
  lineKey: string,
): CookingSessionDetail {
  const session = requireSession(sessionId)
  assertWritable(session.status as CookingSessionStatus, sessionId)
  requireDish(sessionId, dishId)

  db.transaction((tx) => {
    tx.delete(cookingSessionDishSkip)
      .where(
        and(
          eq(cookingSessionDishSkip.dish_id, dishId),
          eq(cookingSessionDishSkip.line_key, lineKey),
        ),
      )
      .run()

    recomputeConfirmedRevision(tx, sessionId, dishId)
  })

  return buildDetail(sessionId)
}

/**
 * 校验会话内所有菜品的确认是否**齐全且版本一致**。
 *
 * ⚠️ 供 B3 结算前调用；本阶段仅提供校验能力，不做扣减。
 * ⚠️ 这是**重新计算**，不信任 `confirmed_revision` 缓存值。
 *
 * @returns 未齐全的菜品列表（空数组 = 全部就绪）
 */
export function findStaleDishes(sessionId: number): Array<{
  dish_id: number
  recipe_id: number
  recipe_name: string
  reason: 'revision_stale' | 'unconfirmed_skips'
  missing_line_keys: string[]
}> {
  const session = requireSession(sessionId)
  const result: Array<{
    dish_id: number
    recipe_id: number
    recipe_name: string
    reason: 'revision_stale' | 'unconfirmed_skips'
    missing_line_keys: string[]
  }> = []

  const dishes = db
    .select()
    .from(cookingSessionDish)
    .where(eq(cookingSessionDish.session_id, sessionId))
    .all()

  for (const dish of dishes) {
    if (dish.confirmed_revision !== session.recipe_revision) {
      const recipeRow = db
        .select({ name: recipe.name })
        .from(recipe)
        .where(eq(recipe.id, dish.recipe_id))
        .get()

      result.push({
        dish_id: dish.id,
        recipe_id: dish.recipe_id,
        recipe_name: recipeRow?.name ?? '(已删除)',
        reason: 'revision_stale',
        missing_line_keys: [],
      })
      continue
    }

    const required = requiredSkipsOf(db, dish.recipe_id)
    const confirmedKeys = new Set(
      db
        .select({ line_key: cookingSessionDishSkip.line_key, reason: cookingSessionDishSkip.reason })
        .from(cookingSessionDishSkip)
        .where(eq(cookingSessionDishSkip.dish_id, dish.id))
        .all()
        .filter((r) => (REQUIRED_SKIP_REASONS as readonly string[]).includes(r.reason))
        .map((r) => r.line_key),
    )

    const missing = required.filter((r) => !confirmedKeys.has(r.line_key)).map((r) => r.line_key)
    if (missing.length > 0) {
      const recipeRow = db
        .select({ name: recipe.name })
        .from(recipe)
        .where(eq(recipe.id, dish.recipe_id))
        .get()

      result.push({
        dish_id: dish.id,
        recipe_id: dish.recipe_id,
        recipe_name: recipeRow?.name ?? '(已删除)',
        reason: 'unconfirmed_skips',
        missing_line_keys: missing,
      })
    }
  }

  return result
}

/** 断言会话全部就绪（供 B3 结算前调用） */
export function assertSessionReadyToSettle(sessionId: number): void {
  const stale = findStaleDishes(sessionId)
  if (stale.length > 0) {
    throw revisionStaleError(
      `会话 ${sessionId} 尚有 ${stale.length} 道菜品未完成确认或版本已过期：` +
        stale.map((s) => `${s.recipe_name}(${s.reason})`).join('、'),
    )
  }
}
