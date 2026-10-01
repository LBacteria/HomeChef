import { eq, gt } from 'drizzle-orm'

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

  return db
    .insert(standardIngredient)
    .values({
      definition_id: input.definition_id,
      quantity: prepareQuantityForWrite(input.quantity),
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

  // 单位
  let nextUnit = current.unit
  if (input.unit !== undefined) {
    assertValidUnit(input.unit)
    assertUnitAllowed(current.definition_id, input.unit)
    nextUnit = input.unit
  }

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
  const definition = getDefinitionById(current.definition_id)
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

  return db
    .update(standardIngredient)
    .set({
      quantity: nextQuantity,
      unit: nextUnit,
      purchase_date: nextPurchaseDate,
      production_date: nextProductionDate,
      expiry_date: nextExpiryDate,
      expiry_date_source: nextExpirySource,
      storage_method: nextStorageMethod,
      note: input.note !== undefined ? normalizeNullableText(input.note) : current.note,
      updated_at: nowIso(),
    })
    .where(eq(standardIngredient.id, id))
    .returning()
    .get()
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
