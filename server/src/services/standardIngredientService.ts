import { and, eq, ne } from 'drizzle-orm'

import { db } from '../db/index.js'
import { UNITS, ingredientAlias, standardIngredient } from '../db/schema.js'
import type { StandardIngredient, Unit } from '../db/schema.js'
import {
  alreadyExistsError,
  duplicateNameError,
  insufficientStockError,
  invalidDateRangeError,
  notFoundError,
  validationError,
} from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'
import {
  QUANTITY_EPSILON,
  isValidQuantity,
  prepareQuantityForWrite,
  roundQuantity,
} from './quantity.js'

/**
 * 标准食材 Service（v0.1 第一阶段）
 *
 * 实现范围：创建 / 查询全部 / 按 ID 查询 / 更新 / 删除。
 *
 * 不在本阶段范围：别名管理、consume、seed、API。
 *
 * 分层职责见 ARCHITECTURE.md 第 2.3 节：
 * 名称归一化、唯一性检查、库存校验都在这一层，不允许散落到别处。
 */

/** 创建标准食材的输入 */
export interface CreateStandardIngredientInput {
  /** 用户输入的原始名称（会保留到 name，仅去掉首尾空格前的原样） */
  name: string
  /** 数量，可选，默认 0 */
  quantity?: number
  /** 单位，必须是固定枚举之一 */
  unit: string
  /** 购买日期，可选，YYYY-MM-DD */
  purchase_date?: string | null
  /** 过期日期，可选，YYYY-MM-DD */
  expiry_date?: string | null
  /** 备注，可选 */
  note?: string | null
}

/** 更新标准食材的输入（所有字段可选，未提供则保留原值） */
export interface UpdateStandardIngredientInput {
  name?: string
  quantity?: number
  unit?: string
  purchase_date?: string | null
  expiry_date?: string | null
  note?: string | null
}

/** 当前 UTC 时间，ISO 8601 格式 */
function nowIso(): string {
  return new Date().toISOString()
}

/** 校验单位是否属于固定枚举 */
function assertValidUnit(unit: string): asserts unit is Unit {
  if (!UNITS.includes(unit as Unit)) {
    throw validationError(`单位不合法：${unit}。允许的单位：${UNITS.join('、')}`)
  }
}

/**
 * 校验数量。
 *
 * STRICT 表不可用后的补偿（DATABASE_DESIGN.md 第 10.6 节）：
 * 写入前校验数值类型，拒绝 NaN / Infinity / 非数字。
 */
function assertValidQuantity(quantity: unknown): asserts quantity is number {
  if (!isValidQuantity(quantity)) {
    throw validationError(`数量不合法：${String(quantity)}。必须是有限的非负数字`)
  }
}

/**
 * 校验日期关系：过期日期不能早于购买日期。
 *
 * 依赖 ISO 8601 的"字典序 = 时间序"，字符串比较即正确的日期比较。
 * 两个日期都可选，任一为 null 时跳过检查。
 *
 * 注意 >= 而不是 >：同一天购买并过期是合法的。
 */
function assertValidDateRange(
  purchaseDate: string | null | undefined,
  expiryDate: string | null | undefined,
): void {
  if (purchaseDate == null || expiryDate == null) {
    return
  }
  if (expiryDate < purchaseDate) {
    throw invalidDateRangeError(
      `过期日期不能早于购买日期：购买 ${purchaseDate}，过期 ${expiryDate}`,
    )
  }
}

/** 规范化可空的文本字段：undefined / 空字符串 → null */
function normalizeNullableText(value: string | null | undefined): string | null {
  if (value == null) {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * 检查 name_normalized 是否已被其他标准食材占用。
 *
 * 这是**同表**唯一性检查（standard_ingredient 内部）。
 * 跨表检查（与 alias 的冲突）由 assertAliasNameNotTaken 负责。
 *
 * @param nameNormalized 归一化后的名称
 * @param excludeId 排除的 ID（更新时排除自己）
 */
function assertNameNotTaken(nameNormalized: string, excludeId?: number): void {
  const condition =
    excludeId === undefined
      ? eq(standardIngredient.name_normalized, nameNormalized)
      : and(
          eq(standardIngredient.name_normalized, nameNormalized),
          ne(standardIngredient.id, excludeId),
        )

  const existing = db.select().from(standardIngredient).where(condition).get()

  if (existing) {
    throw alreadyExistsError(`食材已存在：${existing.name}（归一化名称：${nameNormalized}）`)
  }
}

/**
 * 跨表检查：标准名称不能与任何**别名**冲突。
 *
 * 对应 DATABASE_DESIGN.md 第 6.5 / 6.6 节：
 * 数据库无法跨表建立 UNIQUE 约束，因此这条规则由 Service 保证。
 *
 * 例：
 *   已有别名「西红柿」 → 创建标准名「西红柿」必须被拒绝（DUPLICATE_NAME）
 *
 * @param nameNormalized 归一化后的标准名称
 * @throws ServiceError DUPLICATE_NAME
 */
function assertAliasNameNotTaken(nameNormalized: string): void {
  const conflict = db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.alias_normalized, nameNormalized))
    .get()

  if (conflict) {
    throw duplicateNameError(
      `名称已被别名占用：${conflict.alias}（归一化名称：${nameNormalized}）`,
    )
  }
}

/**
 * 创建标准食材。
 *
 * 行为：
 * - name 保存用户输入的原始形式（仅去掉首尾空格）
 * - name_normalized 由统一的 normalizeName 生成
 * - 不允许因大小写/前后空格不同而创建重复食材
 * - **不自动合并**已存在的食材：已存在则直接报错，由调用方提示用户去修改
 *
 * @throws ServiceError VALIDATION_ERROR / INGREDIENT_EXISTS
 */
export function createStandardIngredient(
  input: CreateStandardIngredientInput,
): StandardIngredient {
  // 1. 名称校验：不能为空（必须在归一化之后判断，"   " 也算空）
  if (typeof input.name !== 'string' || isBlankName(input.name)) {
    throw validationError('食材名称不能为空')
  }

  // 2. name 保留原始输入形式，仅去掉首尾空格（不做大小写改写）
  const displayName = input.name.trim()

  // 3. name_normalized 使用统一的归一化函数
  const nameNormalized = normalizeName(input.name)

  // 4. 单位校验
  assertValidUnit(input.unit)

  // 5. 数量校验（默认 0），拒绝 NaN / Infinity / 负数
  const rawQuantity = input.quantity ?? 0
  assertValidQuantity(rawQuantity)

  // 6. 日期关系校验
  const purchaseDate = normalizeNullableText(input.purchase_date)
  const expiryDate = normalizeNullableText(input.expiry_date)
  assertValidDateRange(purchaseDate, expiryDate)

  // 7. 唯一性检查：已存在则报错，不自动合并
  //
  //    7a. 同表检查：不能与其他标准食材重名
  //    7b. 跨表检查：不能与任何别名重名（DATABASE_DESIGN.md 第 6.5 节）
  assertNameNotTaken(nameNormalized)
  assertAliasNameNotTaken(nameNormalized)

  // 8. 写入前统一做数量舍入（DATABASE_DESIGN.md 第 7.6 节措施 ①）
  const quantity = prepareQuantityForWrite(rawQuantity)

  const timestamp = nowIso()

  const created = db
    .insert(standardIngredient)
    .values({
      name: displayName,
      name_normalized: nameNormalized,
      quantity,
      unit: input.unit,
      purchase_date: purchaseDate,
      expiry_date: expiryDate,
      note: normalizeNullableText(input.note),
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returning()
    .get()

  return created
}

/**
 * 查询全部标准食材。
 *
 * v0.1 列表一次全取（DATABASE_DESIGN.md 第 9.3 节），不做分页。
 * 按 id 升序，保证结果稳定。
 */
export function listStandardIngredients(): StandardIngredient[] {
  return db.select().from(standardIngredient).orderBy(standardIngredient.id).all()
}

/**
 * 按 ID 查询标准食材。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function getStandardIngredientById(id: number): StandardIngredient {
  const found = db.select().from(standardIngredient).where(eq(standardIngredient.id, id)).get()

  if (!found) {
    throw notFoundError(`食材不存在：id=${id}`)
  }

  return found
}

/**
 * 按名称精确查询标准食材（归一化后匹配）。
 *
 * 这是"精确名称解析"的第一步，**不是模糊搜索**
 * （DATABASE_DESIGN.md 第 9.4 节：不做 LIKE / FTS / 编辑距离）。
 *
 * @returns 命中则返回食材，未命中返回 undefined
 */
export function findStandardIngredientByName(name: string): StandardIngredient | undefined {
  if (isBlankName(name)) {
    return undefined
  }

  const nameNormalized = normalizeName(name)

  return db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.name_normalized, nameNormalized))
    .get()
}

/**
 * 更新标准食材。
 *
 * 行为：
 * - 只更新提供的字段，未提供的字段保留原值
 * - 修改 name 时重新计算 name_normalized，并重新检查唯一性
 * - **不自动修改或转换 quantity / unit**
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND / VALIDATION_ERROR /
 *                      INGREDIENT_EXISTS / INVALID_DATE_RANGE
 */
export function updateStandardIngredient(
  id: number,
  input: UpdateStandardIngredientInput,
): StandardIngredient {
  // 1. 确认存在
  const current = getStandardIngredientById(id)

  // 2. 逐字段处理，未提供的保留原值
  let nextName = current.name
  let nextNameNormalized = current.name_normalized

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || isBlankName(input.name)) {
      throw validationError('食材名称不能为空')
    }
    nextName = input.name.trim()
    nextNameNormalized = normalizeName(input.name)

    // 修改名称时重新检查唯一性（排除自己）
    //
    // 同表检查排除自己；跨表检查无需排除（别名表与自己的 id 无关）
    assertNameNotTaken(nextNameNormalized, id)
    assertAliasNameNotTaken(nextNameNormalized)
  }

  let nextQuantity = current.quantity
  if (input.quantity !== undefined) {
    assertValidQuantity(input.quantity)
    // 写入前统一舍入；注意**不做任何单位换算**
    nextQuantity = prepareQuantityForWrite(input.quantity)
  }

  let nextUnit = current.unit
  if (input.unit !== undefined) {
    assertValidUnit(input.unit)
    nextUnit = input.unit
  }

  // 3. 日期：支持部分更新，必须与现有值合并后再校验
  //    （DATABASE_DESIGN.md 第 8.2 节：只改 expiry_date 时必须取出
  //     数据库中现有的 purchase_date 一起判断）
  const nextPurchaseDate =
    input.purchase_date !== undefined
      ? normalizeNullableText(input.purchase_date)
      : current.purchase_date
  const nextExpiryDate =
    input.expiry_date !== undefined ? normalizeNullableText(input.expiry_date) : current.expiry_date

  assertValidDateRange(nextPurchaseDate, nextExpiryDate)

  const updated = db
    .update(standardIngredient)
    .set({
      name: nextName,
      name_normalized: nextNameNormalized,
      quantity: nextQuantity,
      unit: nextUnit,
      purchase_date: nextPurchaseDate,
      expiry_date: nextExpiryDate,
      note: input.note !== undefined ? normalizeNullableText(input.note) : current.note,
      updated_at: nowIso(),
    })
    .where(eq(standardIngredient.id, id))
    .returning()
    .get()

  return updated
}

/**
 * 删除标准食材。
 *
 * 别名由数据库的 ON DELETE CASCADE 自动删除
 * （DATABASE_DESIGN.md 第 5.3 节；前提是连接已开启 PRAGMA foreign_keys）。
 *
 * ⚠️ **不在 Service 中自己模拟删除别名** —— 那是数据库的职责。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function deleteStandardIngredient(id: number): void {
  // 确认存在：不存在时给出明确错误，而不是静默成功
  getStandardIngredientById(id)

  db.delete(standardIngredient).where(eq(standardIngredient.id, id)).run()
}

/**
 * 查询某标准食材的别名数量。
 *
 * 仅用于验证 ON DELETE CASCADE 是否生效 —— 不对外暴露为业务功能。
 * 本阶段不实现别名管理（增删改），因此这里只做只读统计。
 */
export function countAliasesForIngredient(ingredientId: number): number {
  return db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.ingredient_id, ingredientId))
    .all().length
}

/**
 * 消耗标准食材（扣减库存）。
 *
 * 对应 DATABASE_DESIGN.md 第 6 节"消耗事务设计"与 ARCHITECTURE.md 第 6 节。
 *
 * 规则：
 * - id 必须存在，否则 INGREDIENT_NOT_FOUND
 * - amount 必须是有限数字
 * - amount > 0
 * - 库存不足 → INSUFFICIENT_STOCK，**整笔拒绝，不部分扣减**
 * - 允许恰好扣到 0，且**保留记录**、不删除
 * - 不做单位换算，不记录消耗历史
 * - 读取 → 校验 → 计算 → 写回 全部在**一个事务内**完成
 *
 * @param id 标准食材 ID
 * @param amount 消耗数量（必须为正的有限数）
 * @returns 更新后的食材记录
 * @throws ServiceError INGREDIENT_NOT_FOUND / VALIDATION_ERROR / INSUFFICIENT_STOCK
 */
export function consumeStandardIngredient(id: number, amount: number): StandardIngredient {
  // ---- 事务外的入参校验（与库存无关，不需要进事务）----

  // amount 必须是有限数字（拒绝 NaN / Infinity / 字符串 / null 等）
  // 注意：这里不能用 isValidQuantity，因为它允许 0；consume 要求 amount > 0
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw validationError(`消耗数量不合法：${String(amount)}。必须是有限的数字`)
  }

  if (amount <= 0) {
    throw validationError(`消耗数量必须大于 0，当前为：${amount}`)
  }

  // 消耗数量同样要经过统一的舍入（DATABASE_DESIGN.md 第 7.6 节措施 ①）。
  // 若舍入后变成 0（例如 0.0001 舍入到 3 位小数），说明实际消耗量太小，
  // 应当拒绝，而不是静默地"什么也没扣"。
  const requestedAmount = roundQuantity(amount)
  if (requestedAmount <= 0) {
    throw validationError(`消耗数量过小，舍入后为 0：${amount}`)
  }

  // ---- 事务：读取 → 校验 → 计算 → 写回 ----
  //
  // 读取和写回必须在同一事务内，否则并发下可能把库存扣成负数
  // （ARCHITECTURE.md 第 6 节）。
  const result = db.transaction((tx) => {
    // 1. 查询当前库存（在事务内读取，保证看到的是最新值）
    const current = tx
      .select()
      .from(standardIngredient)
      .where(eq(standardIngredient.id, id))
      .get()

    // 2. 不存在 → 回滚
    if (!current) {
      throw notFoundError(`食材不存在：id=${id}`)
    }

    // 3. 校验库存是否足够
    //
    //    使用容差比较（DATABASE_DESIGN.md 第 7.6 节措施 ④），
    //    但**只容忍浮点噪声，不容忍真实不足**：
    //
    //      quantity=0.3, amount=0.2 → raw = 0.09999999999999998（正常，允许）
    //      quantity=0.1, amount=0.2 → raw = -0.1（真实不足，拒绝）
    //
    //    判据：raw < 0 且 raw <= -EPSILON 时才算真实不足。
    //    这样"接近 0 的负值"不算不足，而真正的负数会被拒绝。
    const raw = current.quantity - requestedAmount

    if (raw < 0 && raw <= -QUANTITY_EPSILON) {
      // 真实库存不足 → 抛错，事务回滚
      throw insufficientStockError(
        `库存不足：需要 ${requestedAmount}，现有 ${current.quantity}（单位：${current.unit}）`,
      )
    }

    // 4. 统一舍入 / 钳制
    //
    //    这里调用 prepareQuantityForWrite：先钳制容差内的负值为 0，
    //    再舍入到固定精度。
    //
    //    ⚠️ 到达这一步时 raw 已经过上面的判据过滤：
    //       只有"容差内的伪负值"或"非负值"会走到这里。
    //       真实不足在步骤 3 已经抛错，**不会被钳制成 0 掩盖掉**。
    const nextQuantity = prepareQuantityForWrite(raw)

    // 5. 更新数据库（同一事务内）
    const updated = tx
      .update(standardIngredient)
      .set({
        quantity: nextQuantity,
        updated_at: nowIso(),
      })
      .where(eq(standardIngredient.id, id))
      .returning()
      .get()

    return updated
  })

  return result
}
