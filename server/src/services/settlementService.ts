import { asc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  cookingSession,
  cookingSessionDish,
  cookingSessionDishSkip,
  cookingSettlement,
  cookingSettlementItem,
  ingredientDefinition,
  recipeIngredient,
  standardIngredient,
} from '../db/schema.js'
import type { DishSkipReason, SettlementOutcome } from '../db/schema.js'
import {
  insufficientStockError,
  revisionStaleError,
  sessionNotFoundError,
  sessionStateInvalidError,
  validationError,
} from './errors.js'
import { QUANTITY_EPSILON, prepareQuantityForWrite, roundQuantity, scaleLineQuantity } from './quantity.js'
import { availableStockRows, hasUnitMatchedLot } from './stockAvailability.js'
import {
  deriveRequiredReason,
  isSatisfiedBy,
  persistedReasonFor,
} from './skipReasonService.js'
import type { DerivedSkipReason } from './skipReasonService.js'
import { isSeasoningDefinition } from './categoryService.js'

/**
 * 烹饪会话结算 Service（v0.2.1 B3）。
 *
 * 职责：把一次烹饪会话的原料需求，转成真实库存扣减 + 不可篡改的结算凭证。
 *
 * ⚠️⚠️ 三条不可违反的设计约束：
 *   1. **全部写操作在同一事务内**——库存扣减、凭证、明细、会话状态。
 *      任一失败 → 整体回滚，绝不留下「扣了库存没凭证」或「有凭证没扣库存」。
 *   2. **幂等由数据库唯一约束保证**——`cooking_settlement.session_id` 是 UNIQUE。
 *      事务第一步就 INSERT 凭证，冲突即表示已结算，**不依赖应用层「先查后插」**。
 *   3. **必需跳过确认在事务内重新计算**，绝不信任 `confirmed_revision` 缓存值。
 *      库存单位可能在确认之后变化，从而产生新的必需确认项。
 */

/** 终态：不可再结算 */
const TERMINAL_STATUSES = ['settled', 'abandoned'] as const

/** 必需跳过项的原因（参与完整性判定） */

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 事务对象的类型。
 *
 * ⚠️ 与 cookingService 同理：不能写成 `typeof db`（`db` 带 `$client`）。
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 「可执行查询的对象」——事务对象或全局 db。
 *
 * ⚠️ 单独定义是因为 `db` 带 `$client` 而事务对象没有，两者类型不兼容（实测 TS2345）。
 *    这样收集需求与单位判定的函数既能用于事务内结算，也能用于只读预览。
 */
type Queryable = Tx | typeof db

/** 结算明细项（返回给调用方） */
export interface SettlementItemResult {
  dish_id: number
  line_key: string | null
  definition_id: number
  definition_name: string
  unit: string | null
  required_quantity: number | null
  consumed_quantity: number
  outcome: SettlementOutcome
}

/** 结算结果 */
export interface SettlementResult {
  settlement_id: number
  session_id: number
  settled_at: string
  items: SettlementItemResult[]
  /** 各 outcome 的计数，便于前端展示摘要 */
  summary: Record<SettlementOutcome, number>
}

/** 事务内描述的单个原料需求 */
interface Demand {
  dish_id: number
  line_key: string | null
  definition_id: number
  unit: string | null
  quantity: number | null
  /** 该 line_key 在会话中已有的确认（若有） */
  confirmedReason: DishSkipReason | null
}

/* ============================================================
 * 事务内辅助
 * ============================================================ */

/** 读取会话；不存在抛 404 */
function requireSessionInTx(tx: Tx, sessionId: number) {
  const found = tx.select().from(cookingSession).where(eq(cookingSession.id, sessionId)).get()
  if (!found) {
    throw sessionNotFoundError(`烹饪会话不存在：id=${sessionId}`)
  }
  return found
}

/**
 * 收集本会话的**全部原料需求**（逐条，未经聚合）。
 *
 * 需求 = 菜品行 × 其菜谱的食材行；需求量 = 原料用量 × 份数（经 `roundQuantity` 归一）。
 */
function collectDemands(q: Queryable, sessionId: number): Demand[] {
  const dishes = q
    .select()
    .from(cookingSessionDish)
    .where(eq(cookingSessionDish.session_id, sessionId))
    .orderBy(asc(cookingSessionDish.sort_order), asc(cookingSessionDish.id))
    .all()

  const demands: Demand[] = []

  for (const dish of dishes) {
    const lines = q
      .select({
        line_key: recipeIngredient.line_key,
        definition_id: recipeIngredient.definition_id,
        unit: recipeIngredient.unit,
        quantity: recipeIngredient.quantity,
      })
      .from(recipeIngredient)
      .where(eq(recipeIngredient.recipe_id, dish.recipe_id))
      .orderBy(asc(recipeIngredient.sort_order), asc(recipeIngredient.id))
      .all()

    const skips = q
      .select({ line_key: cookingSessionDishSkip.line_key, reason: cookingSessionDishSkip.reason })
      .from(cookingSessionDishSkip)
      .where(eq(cookingSessionDishSkip.dish_id, dish.id))
      .all()

    const skipByLineKey = new Map<string, DishSkipReason>()
    for (const s of skips) {
      skipByLineKey.set(s.line_key, s.reason as DishSkipReason)
    }

    for (const line of lines) {
      demands.push({
        dish_id: dish.id,
        line_key: line.line_key,
        definition_id: line.definition_id,
        unit: line.unit,
        quantity: scaleLineQuantity(line.quantity, dish.servings),
        confirmedReason:
          line.line_key === null ? null : (skipByLineKey.get(line.line_key) ?? null),
      })
    }
  }

  return demands
}

/**
 * 判定某需求是否为「必需跳过项」。
 *
 * 必需的两类：
 *   - `null_quantity`   —— 用量为 null（「适量」），无法计算扣减量
 *   - `unit_mismatch`   —— 用量非 null，但该食材**没有单位完全一致的库存记录**
 *
 * ⚠️ 单位匹配只看**单位是否存在**，不看数量是否为 0
 *    （数量充足性由后续扣减阶段处理，两者不得混淆）。
 */
function requiredReasonOf(q: Queryable, d: Demand): DerivedSkipReason | null {
  return deriveRequiredReason({
    is_seasoning: isSeasoningDefinition(d.definition_id),
    required_quantity: d.quantity,
    has_unit_matched_lot: d.unit !== null && hasUnitMatchedLot(q, d.definition_id, d.unit),
  })
}

/**
 * 可用库存记录（含 **FEFO 排序**与过期策略）已提取到 `stockAvailability.ts`。
 *
 * v0.2.3（R2）：结算扣减、结算预览、需求确认判定（`requiredReasonOf`）
 * 与菜谱侧的必需跳过项计算（`cookingService.requiredSkipsOf`）
 * **共用同一实现**，避免"预览说可扣、结算说不足"或"确认项算错"这类跨模块分歧。
 * 规则见该文件顶部说明（同单位、`quantity > 0`、FEFO、默认排除过期）。
 */

/**
 * 跨多条库存记录扣减（到期日优先）。
 *
 * ⚠️ 同一份库存**绝不**被多个需求重复分配：本函数返回后，
 *    调用方用 `remaining` 递减，下一次调用会读到已更新的数量。
 * ⚠️ 精度：写入前经 `prepareQuantityForWrite`（先钳制后舍入），
 *    不足判定用 `QUANTITY_EPSILON` 容差，与 `consumeStock` 一致。
 * ⚠️ 绝不产生负库存：每次扣减 `take <= row.quantity`。
 *
 * @returns 实际扣减的数量
 */
function consumeAcrossRecords(
  tx: Tx,
  definitionId: number,
  unit: string,
  amount: number,
  timestamp: string,
): number {
  let remaining = roundQuantity(amount)
  let consumed = 0

  const rows = availableStockRows(tx, definitionId, unit)

  for (const row of rows) {
    if (remaining <= QUANTITY_EPSILON) break

    const take = Math.min(remaining, row.quantity)
    const nextQuantity = prepareQuantityForWrite(row.quantity - take)

    tx.update(standardIngredient)
      .set({ quantity: nextQuantity, updated_at: timestamp })
      .where(eq(standardIngredient.id, row.id))
      .run()

    consumed = roundQuantity(consumed + take)
    remaining = roundQuantity(remaining - take)
  }

  return consumed
}

/* ============================================================
 * 结算主流程
 * ============================================================ */

/**
 * 结算烹饪会话：扣减库存并写入不可篡改的结算凭证。
 *
 * 事务顺序（**顺序本身是幂等与一致性的关键**）：
 *   ① 校验会话存在且非终态
 *   ② **INSERT `cooking_settlement`** —— UNIQUE 冲突即表示已结算，抛 409
 *   ③ 收集全部原料需求（事务内重新读取）
 *   ④ 逐个判定必需跳过项 → 未确认则抛错 → **整体回滚**（凭证也一并撤销）
 *   ⑤ 对可扣需求逐条跨记录扣减库存
 *   ⑥ 写入全部 `cooking_settlement_item`
 *   ⑦ 更新会话为 `settled`
 *   ⑧ COMMIT
 *
 * @throws SESSION_NOT_FOUND / SESSION_STATE_INVALID / RECIPE_NOT_FOUND
 *         / REVISION_STALE（确认不完整）/ INSUFFICIENT_STOCK / VALIDATION_ERROR
 */
export function settleSession(sessionId: number): SettlementResult {
  return db.transaction((tx) => {
    const timestamp = nowIso()

    /* ---- ① 会话必须存在且非终态 ---- */
    const session = requireSessionInTx(tx, sessionId)

    if ((TERMINAL_STATUSES as readonly string[]).includes(session.status)) {
      throw sessionStateInvalidError(
        `烹饪会话 ${sessionId} 处于终态「${session.status}」，不可结算`,
      )
    }

    /* ---- ② 幂等防线：先占位凭证 ----
     *
     * ⚠️ UNIQUE(session_id) 使并发下只有一个事务能成功插入。
     *    冲突时直接抛错让事务回滚，**绝不吞掉错误继续扣减**。
     */
    const existing = tx
      .select({ id: cookingSettlement.id })
      .from(cookingSettlement)
      .where(eq(cookingSettlement.session_id, sessionId))
      .get()

    if (existing) {
      throw sessionStateInvalidError(`烹饪会话 ${sessionId} 已完成结算，不可重复结算`)
    }

    let settlementId: number
    try {
      settlementId = tx
        .insert(cookingSettlement)
        .values({ session_id: sessionId, settled_at: timestamp, created_at: timestamp })
        .returning({ id: cookingSettlement.id })
        .get().id
    } catch (e) {
      // 唯一约束冲突 = 并发下另一个事务已结算
      throw sessionStateInvalidError(
        `烹饪会话 ${sessionId} 已完成结算（并发冲突），不可重复结算：` +
          (e instanceof Error ? e.message : String(e)),
      )
    }

    /* ---- ③ 收集需求（事务内重新读取，不信任预检结果）---- */
    const demands = collectDemands(tx, sessionId)

    if (demands.length === 0) {
      throw validationError(`烹饪会话 ${sessionId} 没有任何菜品，无法结算`)
    }

    /* ---- ④ 重新计算必需跳过项并校验确认 ----
     *
     * ⚠️⚠️ 这是防止「库存单位变化后放行」的关键：
     *    必须基于**当前库存状态**重算，绝不只看 confirmed_revision。
     */
    const unconfirmed: string[] = []

    for (const d of demands) {
      // 忽略跳过的需求：用户主动跳过的项不参与扣减，也不要求确认
      if (d.confirmedReason === 'user_choice') continue

      const required = requiredReasonOf(tx, d)
      if (required === null) continue

      // 必须存在**针对该 line_key** 且能真正满足该派生原因的确认记录
      // （`seasoning_presence` 需要的是落库为 `user_choice` 的真实确认）
      const satisfied = isSatisfiedBy(required, d.confirmedReason)

      if (!satisfied) {
        unconfirmed.push(
          `${d.line_key ?? '(无标识)'}(${required})`,
        )
      }
    }

    if (unconfirmed.length > 0) {
      throw revisionStaleError(
        `会话 ${sessionId} 有 ${unconfirmed.length} 项必需跳过确认尚未完成：` +
          unconfirmed.join('、'),
      )
    }

    /* ---- ⑤ 扣减库存 + ⑥ 写入明细 ---- */
    const results: SettlementItemResult[] = []
    const summary: Record<SettlementOutcome, number> = {
      consumed: 0,
      skipped_null_quantity: 0,
      skipped_unit_mismatch: 0,
      skipped_user: 0,
      insufficient: 0,
    }

    // ⚠️ 需求行来自菜谱食材表；菜谱若在会话创建后被删除，
    //    FK ON DELETE RESTRICT 会阻止删除，因此这里无需额外校验。
    for (const d of demands) {
      let outcome: SettlementOutcome
      let consumed = 0

      if (d.quantity !== null && d.quantity <= 0) {
        /**
         * v0.2.3（R8 结算侧）：**显式零需求**如实记为「已处理、0 扣减」。
         *
         * ⚠️ 不得落到下面 `unit === null → skipped_unit_mismatch` 的分支 ——
         *    单位是否为空与"零需求"无关，误记会污染凭证语义。
         */
        outcome = 'consumed'
      } else if (d.quantity === null) {
        outcome = 'skipped_null_quantity'
      } else if (d.confirmedReason === 'user_choice') {
        outcome = 'skipped_user'
      } else if (d.confirmedReason === 'unit_mismatch') {
        outcome = 'skipped_unit_mismatch'
      } else if (d.confirmedReason === 'null_quantity') {
        // 情形：原本判为 null_quantity 并确认，但用量后来被改成非 null。
        // 保守处理：尊重既有确认，视为跳过（不猜测用户意图）。
        outcome = 'skipped_null_quantity'
      } else {
        // 可扣项：单位已匹配（requiredReasonOf 已返回 null）
        const unit = d.unit
        if (unit === null) {
          // 理论上不可达：unit 为 null 时 requiredReasonOf 必返回 unit_mismatch
          outcome = 'skipped_unit_mismatch'
        } else {
          consumed = consumeAcrossRecords(tx, d.definition_id, unit, d.quantity, timestamp)
          const shortfall = roundQuantity(d.quantity - consumed)

          if (shortfall > QUANTITY_EPSILON) {
            // ⚠️ 库存不足 → 整个结算失败回滚，**绝不记为 consumed**
            throw insufficientStockError(
              `库存不足：食材 definition_id=${d.definition_id} 需要 ${d.quantity}` +
                `${unit}，实际可扣 ${consumed}${unit}`,
            )
          }

          outcome = 'consumed'
        }
      }

      const definitionRow = tx
        .select({ name: ingredientDefinition.name })
        .from(ingredientDefinition)
        .where(eq(ingredientDefinition.id, d.definition_id))
        .get()

      tx.insert(cookingSettlementItem)
        .values({
          settlement_id: settlementId,
          dish_id: d.dish_id,
          line_key: d.line_key,
          definition_id: d.definition_id,
          unit: d.unit,
          required_quantity: d.quantity,
          consumed_quantity: consumed,
          outcome,
          created_at: timestamp,
        })
        .run()

      summary[outcome] += 1
      results.push({
        dish_id: d.dish_id,
        line_key: d.line_key,
        definition_id: d.definition_id,
        definition_name: definitionRow?.name ?? '(已删除)',
        unit: d.unit,
        required_quantity: d.quantity,
        consumed_quantity: consumed,
        outcome,
      })
    }

    /* ---- ⑦ 会话置为终态 ---- */
    tx.update(cookingSession)
      .set({ status: 'settled', settled_at: timestamp, updated_at: timestamp })
      .where(eq(cookingSession.id, sessionId))
      .run()

    return {
      settlement_id: settlementId,
      session_id: sessionId,
      settled_at: timestamp,
      items: results,
      summary,
    }
  })
}

/**
 * 结算预览（**只读，无任何副作用**）。
 *
 * 逐项给出当前需求、判定结果与缺口，供前端在结算前展示给用户确认。
 *
 * ⚠️ 与 `settleSession` 一样**基于当前库存重新计算**，
 *    因此预览结果与实际结算时的判定一致（结算时还会再算一次）。
 * ⚠️ 本函数**不写任何数据**，也不占位凭证。
 */
export function previewSettlement(sessionId: number): {
  session_id: number
  status: string
  items: Array<{
    dish_id: number
    line_key: string | null
    definition_id: number
    definition_name: string
    unit: string | null
    required_quantity: number | null
    /**
     * v0.2.3（R4）：处理到**这一行时**该 (食材, 单位) 的**剩余**可用总量
     * （已经扣掉前面需求占用的部分）。
     *
     * ⚠️ 旧实现是"逐行都取全量可用"，于是两个需求各 2、库存 3 时**两条都显示可扣**，
     *    实际结算第二条却会失败。
     */
    available_quantity: number
    required_reason: DerivedSkipReason | null
    /**
     * 客户端确认时应**回传**的持久化原因。
     *
     * ⚠️ `seasoning_presence` 必须映射为既有的 `user_choice`（不新增 Schema 取值）。
     */
    confirm_reason: DishSkipReason | null
    confirmed: boolean
    /** 本行在**真实顺序分配**之后是否确实能扣到所需量 */
    can_consume: boolean
    /** 已确认跳过（`user_choice` / `null_quantity` / `unit_mismatch`）→ **不占用库存** */
    skipped: boolean
  }>
  needing_confirmation: number
  /** ⚠️ `ready` 的语义是「**待确认项为 0**」，**不是**「库存充足」 */
  ready: boolean
  /** v0.2.3（R4）：所有会扣减的行**都真的能扣到**（即库存总量足够） */
  stock_sufficient: boolean
} {
  const session = db.select().from(cookingSession).where(eq(cookingSession.id, sessionId)).get()
  if (!session) {
    throw sessionNotFoundError(`烹饪会话不存在：id=${sessionId}`)
  }

  const demands = collectDemands(db, sessionId)

  /**
   * v0.2.3（R4）：**库存副本**。
   *
   * ⚠️ 只用内存副本做分配，**绝不写库**（预览是只读接口）。
   * ⚠️ 行来自 `availableStockRows`，因此与结算**同一套可用规则**
   *    （默认排除过期、遵守 allow_expired_for_recipe、只看 quantity > 0），
   *    并保持同一 FEFO 顺序（有到期在前 → 到期升序 → id 升序）。
   */
  const stockCopy = new Map<string, Array<{ id: number; quantity: number }>>()
  function remainingRows(definitionId: number, unit: string) {
    const key = `${definitionId}|${unit}`
    let rows = stockCopy.get(key)
    if (rows === undefined) {
      rows = availableStockRows(db, definitionId, unit).map((r) => ({
        id: r.id,
        quantity: r.quantity,
      }))
      stockCopy.set(key, rows)
    }
    return rows
  }
  const totalOf = (rows: Array<{ quantity: number }>): number =>
    rows.reduce((sum, r) => roundQuantity(sum + r.quantity), 0)

  const items: Array<{
    dish_id: number
    line_key: string | null
    definition_id: number
    definition_name: string
    unit: string | null
    required_quantity: number | null
    available_quantity: number
    required_reason: DerivedSkipReason | null
    /**
     * 客户端确认时应**回传**的持久化原因。
     *
     * ⚠️ `seasoning_presence` 必须映射为既有的 `user_choice`（不新增 Schema 取值）。
     */
    confirm_reason: DishSkipReason | null
    confirmed: boolean
    can_consume: boolean
    skipped: boolean
  }> = []

  let needingConfirmation = 0
  let stockSufficient = true

  for (const d of demands) {
    const requiredReason = requiredReasonOf(db, d)

    const satisfied = requiredReason !== null && isSatisfiedBy(requiredReason, d.confirmedReason)

    if (requiredReason !== null && !satisfied) needingConfirmation += 1

    /**
     * 结算会**跳过且不扣减**的情形 —— 必须与 `settleSession` 的判定完全一致：
     *   - `quantity === null`      → `skipped_null_quantity`
     *   - 已确认 `user_choice`     → `skipped_user`
     *   - 已确认 `unit_mismatch`   → `skipped_unit_mismatch`
     *   - 已确认 `null_quantity`   → `skipped_null_quantity`
     */
    const willSkip =
      d.quantity === null ||
      d.confirmedReason === 'user_choice' ||
      d.confirmedReason === 'unit_mismatch' ||
      d.confirmedReason === 'null_quantity'

    let available = 0
    let canConsume = false

    /**
     * v0.2.3（R8 边界）：**已知零需求**（含份数缩放为 0）不需要任何库存，
     * 结算会如实记为 `consumed` 且扣减 0。因此这里必须 `can_consume = true`，
     * 否则界面会把"零需求"显示成"库存不足"（单位恰好为 `null` 时尤其明显）。
     */
    const isZeroDemand = d.quantity !== null && d.quantity <= 0

    if (isZeroDemand) {
      canConsume = true
    } else if (d.unit !== null) {
      const rows = remainingRows(d.definition_id, d.unit)
      available = totalOf(rows)

      if (!willSkip && d.quantity !== null) {
        // 按真实顺序 + FEFO 从副本里分配（与结算扣减同序）
        let need = d.quantity
        for (const row of rows) {
          if (need <= QUANTITY_EPSILON) break
          const take = Math.min(need, row.quantity)
          row.quantity = roundQuantity(row.quantity - take)
          need = roundQuantity(need - take)
        }
        canConsume = available + QUANTITY_EPSILON >= d.quantity
        if (!canConsume) stockSufficient = false
      }
    }

    const definitionRow = db
      .select({ name: ingredientDefinition.name })
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, d.definition_id))
      .get()

    items.push({
      dish_id: d.dish_id,
      line_key: d.line_key,
      definition_id: d.definition_id,
      definition_name: definitionRow?.name ?? '(已删除)',
      unit: d.unit,
      required_quantity: d.quantity,
      available_quantity: available,
      required_reason: requiredReason,
      confirm_reason: requiredReason === null ? null : persistedReasonFor(requiredReason),
      confirmed: satisfied,
      can_consume: canConsume,
      skipped: willSkip,
    })
  }

  return {
    session_id: sessionId,
    status: session.status,
    items,
    needing_confirmation: needingConfirmation,
    ready: needingConfirmation === 0,
    stock_sufficient: stockSufficient,
  }
}
