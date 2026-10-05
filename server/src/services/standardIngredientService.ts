import { and, eq, gt, ne, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { standardIngredient } from '../db/schema.js'
import type { ExpiryDateSource, StandardIngredient, StorageMethod, Unit } from '../db/schema.js'
import { STORAGE_METHODS, UNITS } from '../db/schema.js'
import {
  assertUnitAllowed,
  getDefinitionById,
} from './definitionService.js'
import {
  insufficientStockError,
  invalidDateRangeError,
  notFoundError,
  validationError,
} from './errors.js'
import { addDays, isValidDateString, todayDateString } from './dates.js'
import {
  QUANTITY_EPSILON,
  isValidQuantity,
  prepareQuantityForWrite,
  roundQuantity,
} from './quantity.js'

/**
 * 库存记录 Service
 *
 * 模型：ingredient_definition → standard_ingredient 是 **1:N**。
 *   - 同一食材可以有多条库存记录（3 个 / 1 袋 / 1 千克）
 *   - 绝不自动合并、绝不自动聚合、绝不做单位换算
 *   - 消耗针对**具体的库存记录 id**
 *
 * 日期逻辑见 computeExpiry()。
 */

/* ============================================================
 * 输入类型
 * ============================================================ */

export interface CreateStockInput {
  definition_id: number
  quantity: number
  unit: string
  /** 入库日期；不提供则默认今天 */
  purchase_date?: string | null
  /** 生产日期；nullable，绝不反推 */
  production_date?: string | null
  /** 到期日期；提供则 source = manual */
  expiry_date?: string | null
  storage_method?: string
  note?: string | null
}

export interface UpdateStockInput {
  /**
   * 更换该库存记录所属的食材定义。
   *
   * optional：不提供则保持现有 definition_id 不变。
   * 提供时会校验新定义存在、且**最终 unit** 在新定义的允许单位内。
   *
   * ⚠️ 更换 definition **不会**重算任何日期（expiry 保持不变）。
   */
  definition_id?: number
  quantity?: number
  unit?: string
  purchase_date?: string | null
  production_date?: string | null
  /** 显式提供（含 null）表示用户明确设置/清空到期日期 */
  expiry_date?: string | null
  storage_method?: string
  note?: string | null
}

/* ============================================================
 * 校验工具
 * ============================================================ */

function nowIso(): string {
  return new Date().toISOString()
}

function assertValidUnit(unit: string): asserts unit is Unit {
  if (!UNITS.includes(unit as Unit)) {
    throw validationError(`单位不合法：${unit}。允许的单位：${UNITS.join('、')}`)
  }
}

function assertValidStorageMethod(method: string): asserts method is StorageMethod {
  if (!STORAGE_METHODS.includes(method as StorageMethod)) {
    throw validationError(
      `储存方式不合法：${method}。允许：${STORAGE_METHODS.join('、')}`,
    )
  }
}

function assertValidQuantityValue(quantity: unknown): asserts quantity is number {
  if (!isValidQuantity(quantity)) {
    throw validationError(`数量不合法：${String(quantity)}。必须是有限的非负数字`)
  }
}

/** 规范化可空文本：undefined / 空串 → null */
function normalizeNullableText(value: string | null | undefined): string | null {
  if (value == null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 规范化可空日期：必须是合法 YYYY-MM-DD 或 null */
function normalizeNullableDate(
  value: string | null | undefined,
  fieldName: string,
): string | null {
  if (value == null) return null
  const trimmed = String(value).trim()
  if (trimmed.length === 0) return null
  if (!isValidDateString(trimmed)) {
    throw validationError(`${fieldName} 格式必须是 YYYY-MM-DD，当前为：${trimmed}`)
  }
  return trimmed
}

/* ============================================================
 * 到期日期计算
 * ============================================================ */

export interface ExpiryComputation {
  expiry_date: string | null
  expiry_date_source: ExpiryDateSource | null
}

/**
 * 计算到期日期（创建与重算共用）。
 *
 * 规则（严格按设计）：
 *
 *   情况 A：用户提供了 expiry_date
 *     → 使用用户日期，source = 'manual'
 *
 *   情况 B：未提供，且定义有 estimated_shelf_life_days，且有 production_date
 *     → expiry = production_date + 天数，source = 'estimated'
 *
 *   情况 C：未提供，且定义有 estimated_shelf_life_days，无 production_date
 *     → expiry = purchase_date + 天数，source = 'estimated'
 *
 *   情况 D：定义无 estimated_shelf_life_days
 *     → expiry = NULL, source = NULL
 *
 * ⚠️ 用户提供的 expiry_date 永远优先，绝不被自动覆盖。
 * ⚠️ 绝不根据入库日期反推 production_date。
 */
export function computeExpiry(params: {
  /** 用户是否显式提供了 expiry_date（含显式传 null） */
  userProvidedExpiry: boolean
  userExpiryDate: string | null
  purchaseDate: string
  productionDate: string | null
  estimatedShelfLifeDays: number | null
}): ExpiryComputation {
  const { userProvidedExpiry, userExpiryDate, purchaseDate, productionDate, estimatedShelfLifeDays } =
    params

  // 情况 A：用户明确提供
  if (userProvidedExpiry) {
    if (userExpiryDate === null) {
      // 用户显式清空 → 清空两者，**不自动重算**
      return { expiry_date: null, expiry_date_source: null }
    }
    return { expiry_date: userExpiryDate, expiry_date_source: 'manual' }
  }

  // 情况 D：没有保质期 → 无法推算
  if (estimatedShelfLifeDays === null) {
    return { expiry_date: null, expiry_date_source: null }
  }

  // 情况 B / C
  const baseDate = productionDate ?? purchaseDate
  return {
    expiry_date: addDays(baseDate, estimatedShelfLifeDays),
    expiry_date_source: 'estimated',
  }
}

/**
 * 校验日期关系。
 *
 * 规则：
 *   - production_date <= purchase_date（若 production 存在）
 *   - **manual** expiry >= purchase_date（若存在）
 *   - **estimated** expiry **允许**早于 purchase_date
 *     （例：生产 9/28、入库 10/2、保质期 2 天 → 9/30 < 10/2，合法）
 */
function assertDateConsistency(params: {
  purchaseDate: string
  productionDate: string | null
  expiryDate: string | null
  expirySource: ExpiryDateSource | null
}): void {
  const { purchaseDate, productionDate, expiryDate, expirySource } = params

  if (productionDate !== null && productionDate > purchaseDate) {
    throw invalidDateRangeError(
      `生产日期不能晚于入库日期：生产 ${productionDate}，入库 ${purchaseDate}`,
    )
  }

  if (expiryDate !== null && expirySource === 'manual' && expiryDate < purchaseDate) {
    throw invalidDateRangeError(
      `手动填写的到期日期不能早于入库日期：到期 ${expiryDate}，入库 ${purchaseDate}`,
    )
  }

  // estimated 到期日期故意不做下界校验（见上方说明）
}

/* ============================================================
 * 同批次查找（Phase 4 自动合并的基础）
 * ============================================================ */

/** 同批次键：五项完全相同才视为同一批次 */
export interface BatchKey {
  definition_id: number
  purchase_date: string
  storage_method: string
  unit: string
  /** ⚠️ 最终实际保存的 expiry_date；可为 NULL */
  expiry_date: string | null
}

/**
 * findBatchMatch 只依赖 select，因此用一个最小结构类型，
 * 这样 db 与 db.transaction 传入的 tx 都能接受。
 */
type BatchQueryable = Pick<typeof db, 'select'>

/**
 * 查找同批次库存记录。
 *
 * 同批次键严格为五项：
 *   definition_id / purchase_date / storage_method / unit / expiry_date
 *
 * ⚠️⚠️ expiry_date 必须使用 SQL 的 **IS**（NULL-safe 相等），不能用 `=`：
 *
 *     `expiry_date = NULL`   → 结果恒为 NULL，永不匹配
 *       ⇒ 两条 expiry_date 均为 NULL 的记录永远无法合并（静默失效）
 *
 *     `expiry_date IS NULL`  → 真
 *     `expiry_date IS '2026-10-07'` → 按值比较
 *
 *     SQLite 的 IS 是「NULL 安全相等」，正好符合本业务「NULL == NULL 视为相同」的要求。
 *
 * 其余四项在数据库中均为 NOT NULL，用 `=` 是安全的。
 *
 * ⚠️ **不比较 expiry_date_source**：它是来源标记，不是同批次条件。
 *    estimated 与 manual 只要最终 expiry_date 相同，就属于同一批次。
 *
 * @param tx 事务句柄（必须在事务内调用，保证查找与写入的原子性）
 * @param key 同批次键
 * @param excludeId 编辑时排除自身，避免把自己判为匹配
 */
function findBatchMatch(
  tx: BatchQueryable,
  key: BatchKey,
  excludeId?: number,
): StandardIngredient | undefined {
  const conditions = [
    eq(standardIngredient.definition_id, key.definition_id),
    eq(standardIngredient.purchase_date, key.purchase_date),
    eq(standardIngredient.storage_method, key.storage_method),
    eq(standardIngredient.unit, key.unit),
    // ⚠️ 必须用 IS，不能用 =（NULL-safe）
    sql`${standardIngredient.expiry_date} IS ${key.expiry_date}`,
  ]

  if (excludeId !== undefined) {
    conditions.push(ne(standardIngredient.id, excludeId))
  }

  return tx
    .select()
    .from(standardIngredient)
    .where(and(...conditions))
    .orderBy(standardIngredient.id)
    .limit(1)
    .get()
}

/* ============================================================
 * 创建库存记录
 * ============================================================ */

/**
 * 创建库存记录。
 *
 * ⚠️ 同一 definition 可以创建**多条**记录，这是 1:N 模型的核心。
 *    再次添加同一种食材会创建新记录，而不是拒绝重复。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR /
 *                      UNIT_NOT_ALLOWED / INVALID_DATE_RANGE
 */
export function createStock(input: CreateStockInput): StandardIngredient {
  // 1. 定义必须存在
  const definition = getDefinitionById(input.definition_id)

  // 2. 单位校验：必须在固定枚举内，且属于该定义的允许单位
  assertValidUnit(input.unit)
  assertUnitAllowed(input.definition_id, input.unit)

  // 3. 数量校验
  assertValidQuantityValue(input.quantity)

  // 4. 入库日期：不提供则默认今天
  const purchaseDate =
    input.purchase_date == null || String(input.purchase_date).trim() === ''
      ? todayDateString()
      : normalizeNullableDate(input.purchase_date, '入库日期')!
  if (purchaseDate === null) {
    throw validationError('入库日期不能为空')
  }

  // 5. 生产日期：nullable，**绝不反推**
  const productionDate = normalizeNullableDate(input.production_date, '生产日期')

  // 6. 到期日期：区分"用户提供"与"未提供"
  const userProvidedExpiry = input.expiry_date !== undefined
  const userExpiryDate = userProvidedExpiry
    ? normalizeNullableDate(input.expiry_date, '到期日期')
    : null

  const computed = computeExpiry({
    userProvidedExpiry,
    userExpiryDate,
    purchaseDate,
    productionDate,
    estimatedShelfLifeDays: definition.estimated_shelf_life_days,
  })

  // 7. 日期一致性
  assertDateConsistency({
    purchaseDate,
    productionDate,
    expiryDate: computed.expiry_date,
    expirySource: computed.expiry_date_source,
  })

  // 8. 储存方式
  const storageMethod = input.storage_method ?? '常温'
  assertValidStorageMethod(storageMethod)

  const timestamp = nowIso()
  const incomingQuantity = prepareQuantityForWrite(input.quantity)

  // 9. 写入：先查找同批次记录，找到则合并数量，否则新建。
  //
  //    必须在**最终 expiry_date 计算完成之后**才查找（上面第 6 步已完成），
  //    否则会拿未确定的到期日期去匹配，导致漏合并或误合并。
  //
  //    整个「查找 + UPDATE/INSERT」在一个事务内完成，保证原子性。
  return db.transaction((tx) => {
    const match = findBatchMatch(tx, {
      definition_id: input.definition_id,
      purchase_date: purchaseDate,
      storage_method: storageMethod,
      unit: input.unit,
      expiry_date: computed.expiry_date,
    })

    // 9a. 命中同批次 → 合并数量，**保留已有记录的 ID 与 note / production_date**
    if (match) {
      const mergedQuantity = prepareQuantityForWrite(match.quantity + incomingQuantity)

      return tx
        .update(standardIngredient)
        .set({
          quantity: mergedQuantity,
          updated_at: timestamp,
        })
        .where(eq(standardIngredient.id, match.id))
        .returning()
        .get()
    }

    // 9b. 未命中 → 新建记录
    return tx
      .insert(standardIngredient)
      .values({
        definition_id: input.definition_id,
        quantity: incomingQuantity,
        unit: input.unit,
        purchase_date: purchaseDate,
        production_date: productionDate,
        expiry_date: computed.expiry_date,
        expiry_date_source: computed.expiry_date_source,
        storage_method: storageMethod,
        note: normalizeNullableText(input.note),
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning()
      .get()
  })
}

/* ============================================================
 * 查询
 * ============================================================ */

/** 列出全部库存记录（含 quantity = 0，UI 负责过滤） */
export function listStock(): StandardIngredient[] {
  return db.select().from(standardIngredient).orderBy(standardIngredient.id).all()
}

/**
 * 列出全部库存记录（仅 quantity > 0）。
 *
 * 供库存列表使用：0 数量记录在数据库中**保留**，但列表不显示。
 */
export function listStockWithQuantity(): StandardIngredient[] {
  return db
    .select()
    .from(standardIngredient)
    .where(gt(standardIngredient.quantity, 0))
    .orderBy(standardIngredient.id)
    .all()
}

/**
 * 按 definition 列出库存记录。
 */
export function listStockByDefinition(definitionId: number): StandardIngredient[] {
  return db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.definition_id, definitionId))
    .orderBy(standardIngredient.id)
    .all()
}

/**
 * 按 ID 查询库存记录。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function getStockById(id: number): StandardIngredient {
  const found = db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.id, id))
    .get()

  if (!found) {
    throw notFoundError(`库存记录不存在：id=${id}`)
  }

  return found
}

/* ============================================================
 * 更新库存记录
 * ============================================================ */

/**
 * 更新库存记录。
 *
 * 到期日期行为（严格按设计）：
 *
 *   1. PATCH **明确包含** expiry_date：
 *      - 非 null → 设置该值，source = 'manual'
 *      - null    → 清空 expiry 与 source，**不自动重算**
 *
 *   2. PATCH **没有** expiry_date，但修改了 purchase_date 或 production_date：
 *      - 当前 source = 'estimated' → 重新计算
 *      - 当前 source = NULL        → 若有 shelf life 则计算（否则仍 NULL）
 *      - 当前 source = 'manual'    → **保持原值，不自动修改**
 *
 *   3. 只修改 quantity / unit / note / storage_method：
 *      → **不重新计算**
 *
 * ⚠️ 一旦用户手动设置 expiry，**永远不会自动变回 estimated**。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND / VALIDATION_ERROR /
 *                      UNIT_NOT_ALLOWED / INVALID_DATE_RANGE
 */
export function updateStock(id: number, input: UpdateStockInput): StandardIngredient {
  const current = getStockById(id)

  // ---- 最终 definition ----
  //
  // 若提供了 definition_id 则更换食材，否则保持原样。
  // 必须在处理 unit 之前确定，因为单位合法性要针对**最终 definition**判断。
  let nextDefinitionId = current.definition_id
  if (input.definition_id !== undefined) {
    if (!Number.isInteger(input.definition_id) || input.definition_id <= 0) {
      throw validationError(`非法 definition_id：${String(input.definition_id)}。必须是正整数`)
    }
    // 定义不存在 → DEFINITION_NOT_FOUND（404），绝不自动创建
    getDefinitionById(input.definition_id)
    nextDefinitionId = input.definition_id
  }

  // ---- 最终 unit ----
  //
  // 校验对象是 nextDefinitionId，即**最终**所属定义，
  // 因此「同时换 definition + 换 unit」时会用 (新定义, 新单位) 判断，
  // 不会误用 (旧定义, 新单位) 或 (新定义, 旧单位)。
  let nextUnit = current.unit
  if (input.unit !== undefined) {
    assertValidUnit(input.unit)
    nextUnit = input.unit
  }

  // 只要 definition 或 unit 任一发生变化，就针对最终组合重新校验单位合法性。
  // 即使两者都未显式提供，该组合原本就合法，重复校验也不会误伤。
  assertUnitAllowed(nextDefinitionId, nextUnit)

  // 数量
  let nextQuantity = current.quantity
  if (input.quantity !== undefined) {
    assertValidQuantityValue(input.quantity)
    nextQuantity = prepareQuantityForWrite(input.quantity)
  }

  // 入库日期
  let nextPurchaseDate = current.purchase_date
  if (input.purchase_date !== undefined) {
    const d = normalizeNullableDate(input.purchase_date, '入库日期')
    if (d === null) {
      throw validationError('入库日期不能为空')
    }
    nextPurchaseDate = d
  }

  // 生产日期
  let nextProductionDate = current.production_date
  if (input.production_date !== undefined) {
    nextProductionDate = normalizeNullableDate(input.production_date, '生产日期')
  }

  // 储存方式
  let nextStorageMethod = current.storage_method
  if (input.storage_method !== undefined) {
    assertValidStorageMethod(input.storage_method)
    nextStorageMethod = input.storage_method
  }

  // ---- 到期日期处理 ----
  //
  // ⚠️ 使用**最终** definition 的 shelf life。
  //    注意：更换 definition **本身不会触发重算**——
  //    只有 purchase_date / production_date 发生变化时才走重算分支（见下方条件）。
  const definition = getDefinitionById(nextDefinitionId)
  const purchaseOrProductionChanged =
    (input.purchase_date !== undefined && nextPurchaseDate !== current.purchase_date) ||
    (input.production_date !== undefined && nextProductionDate !== current.production_date)

  let nextExpiryDate = current.expiry_date
  let nextExpirySource = current.expiry_date_source as ExpiryDateSource | null

  if (input.expiry_date !== undefined) {
    // 规则 1：用户明确提供
    const userExpiry = normalizeNullableDate(input.expiry_date, '到期日期')
    const computed = computeExpiry({
      userProvidedExpiry: true,
      userExpiryDate: userExpiry,
      purchaseDate: nextPurchaseDate,
      productionDate: nextProductionDate,
      estimatedShelfLifeDays: definition.estimated_shelf_life_days,
    })
    nextExpiryDate = computed.expiry_date
    nextExpirySource = computed.expiry_date_source
  } else if (purchaseOrProductionChanged) {
    // 规则 2：基础日期变了
    if (current.expiry_date_source === 'manual') {
      // manual 保持原值，不自动修改
      nextExpiryDate = current.expiry_date
      nextExpirySource = 'manual'
    } else {
      // estimated 或 NULL → 重算
      const computed = computeExpiry({
        userProvidedExpiry: false,
        userExpiryDate: null,
        purchaseDate: nextPurchaseDate,
        productionDate: nextProductionDate,
        estimatedShelfLifeDays: definition.estimated_shelf_life_days,
      })
      nextExpiryDate = computed.expiry_date
      nextExpirySource = computed.expiry_date_source
    }
  }
  // 规则 3：其他字段变动 → 不动 expiry

  assertDateConsistency({
    purchaseDate: nextPurchaseDate,
    productionDate: nextProductionDate,
    expiryDate: nextExpiryDate,
    expirySource: nextExpirySource,
  })

  const nextNote = input.note !== undefined ? normalizeNullableText(input.note) : current.note
  const timestamp = nowIso()

  // 最终写入：先查找**除自身外**的同批次记录，找到则合并。
  //
  // 合并策略（Phase 4 已确认）：
  //   保留**当前正在编辑的记录 A** 的 ID 与 note / production_date，
  //   把目标记录 B 的数量并入 A，然后**删除 B**。
  //
  //   即：A.quantity = A.quantity + B.quantity; DELETE B; 保留 A。
  //
  // ⚠️ UPDATE A + DELETE B 必须在同一事务内 ——
  //    否则可能出现「A 数量已加但 B 未删除」或「B 已删但 A 未更新」。
  return db.transaction((tx) => {
    const match = findBatchMatch(
      tx,
      {
        definition_id: nextDefinitionId,
        purchase_date: nextPurchaseDate,
        storage_method: nextStorageMethod,
        unit: nextUnit,
        expiry_date: nextExpiryDate,
      },
      id, // 排除自身
    )

    // 命中同批次 → 把目标记录的数量并入当前记录，并删除目标记录
    if (match) {
      const mergedQuantity = prepareQuantityForWrite(nextQuantity + match.quantity)

      const updated = tx
        .update(standardIngredient)
        .set({
          definition_id: nextDefinitionId,
          quantity: mergedQuantity,
          unit: nextUnit,
          purchase_date: nextPurchaseDate,
          production_date: nextProductionDate,
          expiry_date: nextExpiryDate,
          expiry_date_source: nextExpirySource,
          storage_method: nextStorageMethod,
          note: nextNote,
          updated_at: timestamp,
        })
        .where(eq(standardIngredient.id, id))
        .returning()
        .get()

      // 删除被合并掉的目标记录 B（其 note / production_date 按约定不保留）
      tx.delete(standardIngredient).where(eq(standardIngredient.id, match.id)).run()

      return updated
    }

    // 未命中 → 正常更新当前记录（Phase 3.1 行为不变）
    return tx
      .update(standardIngredient)
      .set({
        definition_id: nextDefinitionId,
        quantity: nextQuantity,
        unit: nextUnit,
        purchase_date: nextPurchaseDate,
        production_date: nextProductionDate,
        expiry_date: nextExpiryDate,
        expiry_date_source: nextExpirySource,
        storage_method: nextStorageMethod,
        note: nextNote,
        updated_at: timestamp,
      })
      .where(eq(standardIngredient.id, id))
      .returning()
      .get()
  })
}

/* ============================================================
 * 删除库存记录
 * ============================================================ */

/**
 * 删除库存记录。
 *
 * ⚠️ 只删这一条记录，**完全不影响** ingredient_definition、别名、允许单位。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function deleteStock(id: number): void {
  getStockById(id)
  db.delete(standardIngredient).where(eq(standardIngredient.id, id)).run()
}

/* ============================================================
 * 消耗
 * ============================================================ */

/**
 * 消耗库存（扣减）。
 *
 * ⚠️ 必须针对**具体的库存记录 id**，而不是 definition。
 *    同一食材的多条记录互不影响。
 *
 * 规则：
 *   - amount 必须是有限数字且 > 0
 *   - 库存不足 → INSUFFICIENT_STOCK，整笔拒绝
 *   - 允许扣到 0，**保留记录**（不自动删除）
 *   - 读取 → 校验 → 计算 → 写回 在一个事务内
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND / VALIDATION_ERROR / INSUFFICIENT_STOCK
 */
export function consumeStock(id: number, amount: number): StandardIngredient {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw validationError(`消耗数量不合法：${String(amount)}。必须是有限的数字`)
  }
  if (amount <= 0) {
    throw validationError(`消耗数量必须大于 0，当前为：${amount}`)
  }

  const requestedAmount = roundQuantity(amount)
  if (requestedAmount <= 0) {
    throw validationError(`消耗数量过小，舍入后为 0：${amount}`)
  }

  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(standardIngredient)
      .where(eq(standardIngredient.id, id))
      .get()

    if (!current) {
      throw notFoundError(`库存记录不存在：id=${id}`)
    }

    const raw = current.quantity - requestedAmount

    // 容差比较：只有**真实不足**才拒绝，浮点噪声不算
    if (raw < 0 && raw <= -QUANTITY_EPSILON) {
      throw insufficientStockError(
        `库存不足：需要 ${requestedAmount}，现有 ${current.quantity}（单位：${current.unit}）`,
      )
    }

    const nextQuantity = prepareQuantityForWrite(raw)

    return tx
      .update(standardIngredient)
      .set({ quantity: nextQuantity, updated_at: nowIso() })
      .where(eq(standardIngredient.id, id))
      .returning()
      .get()
  })
}
