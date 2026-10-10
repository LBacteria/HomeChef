import { and, eq, like, ne, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  UNITS,
  ingredientAlias,
  ingredientDefinition,
  ingredientDefinitionUnit,
  standardIngredient,
} from '../db/schema.js'
import type { IngredientDefinition, IngredientDefinitionUnit, Unit } from '../db/schema.js'
import {
  categoryTransitionNotAllowedError,
  definitionNotFoundError,
  duplicateNameError,
  hasStockError,
  notFoundError,
  unitInUseError,
  unitNotAllowedError,
  validationError,
} from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'
import { getCategoryById, isSeasoningCategory } from './categoryService.js'

/**
 * 食材定义 Service（食材库）
 *
 * 职责：
 *   - 食材定义 CRUD
 *   - 默认名称修改（切换默认名称）
 *   - 允许单位管理
 *   - estimated_shelf_life_days 管理
 *
 * 核心约束：
 *   - ingredient_definition.id 是食材的**稳定身份**，改名不改 ID
 *   - 名称与别名全局唯一（跨表由本 Service 保证）
 *   - 每个 definition **至少有一个** allowed unit
 *   - 有库存时拒绝删除定义
 */

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
 * 跨表唯一性检查：某个 normalized 名称不能同时被任何 definition 名称或 alias 占用。
 *
 * 数据库有两张表各自的 UNIQUE 约束，但**无法跨表强制**，
 * 因此这条规则完全由 Service 保证。
 *
 * ⚠️ 可选参数 queryable 用于在**事务内**显式使用事务对象
 *    （与 listAllowedUnits / assertCategoryChangeAllowed 同一模式）。
 *    默认仍为 db，现有调用方无需改动。
 *
 * @param normalized 归一化后的名称
 * @param options.excludeDefinitionId 修改 definition 名称时排除自己
 * @param options.excludeAliasId 修改 alias 时排除自己
 * @param options.queryable 查询对象（事务内应传 tx）
 */
export function assertNameAvailableAcrossTables(
  normalized: string,
  options: {
    excludeDefinitionId?: number
    excludeAliasId?: number
    queryable?: Pick<typeof db, 'select'>
  } = {},
): void {
  const q = options.queryable ?? db

  // 1. 是否被某个 definition 的默认名称占用
  const byDefinition = q
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.name_normalized, normalized))
    .get()

  if (byDefinition && byDefinition.id !== options.excludeDefinitionId) {
    throw duplicateNameError(
      `名称已被食材定义占用：${byDefinition.name}（归一化名称：${normalized}）`,
    )
  }

  // 2. 是否被某个 alias 占用
  const aliasCondition =
    options.excludeAliasId === undefined
      ? eq(ingredientAlias.alias_normalized, normalized)
      : and(
          eq(ingredientAlias.alias_normalized, normalized),
          ne(ingredientAlias.id, options.excludeAliasId),
        )

  const byAlias = q.select().from(ingredientAlias).where(aliasCondition).get()

  if (byAlias) {
    throw duplicateNameError(`名称已被别名占用：${byAlias.alias}（归一化名称：${normalized}）`)
  }
}

/**
 * 确认定义存在。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND
 */
export function getDefinitionById(id: number): IngredientDefinition {
  const found = db
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.id, id))
    .get()

  if (!found) {
    throw definitionNotFoundError(`食材定义不存在：id=${id}`)
  }

  return found
}

/**
 * 查询某定义的允许单位。
 *
 * ⚠️ 可选参数 queryable 用于在**事务内**显式使用事务对象，
 *    避免在事务回调中误用模块级 db（两者类型相同，写法与
 *    assertCategoryChangeAllowed 的 Pick<typeof db, 'select'> 保持一致）。
 *    默认仍为 db，现有调用方无需改动。
 */
export function listAllowedUnits(
  definitionId: number,
  queryable: Pick<typeof db, 'select'> = db,
): string[] {
  const rows = queryable
    .select()
    .from(ingredientDefinitionUnit)
    .where(eq(ingredientDefinitionUnit.definition_id, definitionId))
    .orderBy(ingredientDefinitionUnit.id)
    .all()

  return rows.map((r) => r.unit)
}

/** 查询某定义的别名列表 */
export function listDefinitionAliases(definitionId: number) {
  return db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.definition_id, definitionId))
    .orderBy(ingredientAlias.id)
    .all()
}

/* ============================================================
 * 创建 / 更新 / 删除定义
 * ============================================================ */

export interface CreateDefinitionInput {
  name: string
  /** 至少一个允许单位（**调味品允许 0 个**） */
  units: string[]
  /** 默认预估保质期（天），可选 */
  estimated_shelf_life_days?: number | null
  /** 初始别名，可选 */
  aliases?: string[]
  /**
   * 所属分类（v0.1.3）。
   *
   * 分类为「调味品」时：units 允许为空、保质期可为 null。
   * 其他分类：units 至少一个。
   */
  category_id?: number | null
}

/**
 * 创建食材定义。
 *
 * @throws ServiceError VALIDATION_ERROR / DUPLICATE_NAME
 */
export function createDefinition(input: CreateDefinitionInput): IngredientDefinition {
  // 1. 名称校验
  if (typeof input.name !== 'string' || isBlankName(input.name)) {
    throw validationError('食材名称不能为空')
  }

  // 2. 分类校验（v0.1.3）
  //
  // 分类决定「是否调味品」，因此必须在单位校验之前确定。
  const categoryId = input.category_id ?? null
  if (categoryId !== null) {
    getCategoryById(categoryId)
  }
  const seasoning = categoryId !== null && isSeasoningCategory(categoryId)

  // 3. 允许单位
  //
  // ⚠️ v0.1.3 起规则分两种：
  //     - 普通食材：**至少 1 个**允许单位
  //     - 调味品：**允许 0 个**（库存只表达"有"，不管理数量与单位）
  const rawUnits = Array.isArray(input.units) ? input.units : []

  if (!seasoning && rawUnits.length === 0) {
    throw validationError('食材定义必须至少有一个允许单位')
  }

  const uniqueUnits = [...new Set(rawUnits)]
  for (const u of uniqueUnits) {
    assertValidUnit(u)
  }

  // 4. 保质期校验
  const shelfLife = input.estimated_shelf_life_days ?? null
  if (shelfLife !== null) {
    if (!Number.isInteger(shelfLife) || shelfLife < 0) {
      throw validationError(
        `默认预估保质期必须是非负整数或留空，当前为：${String(input.estimated_shelf_life_days)}`,
      )
    }
  }

  const nameNormalized = normalizeName(input.name)

  // 4. 跨表唯一性：名称
  assertNameAvailableAcrossTables(nameNormalized)

  // 5. 跨表唯一性：初始别名
  const aliases = (input.aliases ?? []).filter((a) => typeof a === 'string' && !isBlankName(a))
  for (const a of aliases) {
    assertNameAvailableAcrossTables(normalizeName(a))
  }

  const timestamp = nowIso()

  return db.transaction((tx) => {
    const created = tx
      .insert(ingredientDefinition)
      .values({
        name: input.name.trim(),
        name_normalized: nameNormalized,
        estimated_shelf_life_days: shelfLife,
        category_id: categoryId,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .returning()
      .get()

    for (const u of uniqueUnits) {
      tx.insert(ingredientDefinitionUnit)
        .values({ definition_id: created.id, unit: u, created_at: timestamp })
        .run()
    }

    for (const a of aliases) {
      tx.insert(ingredientAlias)
        .values({
          definition_id: created.id,
          alias: a.trim(),
          alias_normalized: normalizeName(a),
          created_at: timestamp,
        })
        .run()
    }

    return created
  })
}

export interface UpdateDefinitionInput {
  name?: string
  estimated_shelf_life_days?: number | null
  /** 所属分类（v0.1.4）；null 表示清空分类 */
  category_id?: number | null
}

/**
 * 更新食材定义（名称、默认预估保质期、分类）。
 *
 * ⚠️ 修改 estimated_shelf_life_days **只影响以后新建的库存记录**，
 *    绝不自动修改已有库存记录。
 *
 * ⚠️ v0.1.4：分类变更的完整规则见 assertCategoryChangeAllowed。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR /
 *                      DUPLICATE_NAME / CATEGORY_TRANSITION_NOT_ALLOWED
 */
export function updateDefinition(id: number, input: UpdateDefinitionInput): IngredientDefinition {
  const current = getDefinitionById(id)
  const timestamp = nowIso()

  let nextName = current.name
  let nextNameNormalized = current.name_normalized

  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || isBlankName(input.name)) {
      throw validationError('食材名称不能为空')
    }
    nextName = input.name.trim()
    nextNameNormalized = normalizeName(input.name)
    // 排除自己，检查是否与其他名称/别名冲突
    assertNameAvailableAcrossTables(nextNameNormalized, { excludeDefinitionId: id })
  }

  // ---- 分类变更（v0.1.4）----
  //
  // 校验必须在写入之前完成，且「检查库存引用」与「更新」放在**同一个事务**里，
  // 避免检查通过后、写入前有库存插入造成不一致。
  let nextCategoryId = current.category_id

  if (input.category_id !== undefined) {
    nextCategoryId = input.category_id

    if (nextCategoryId !== null) {
      // 分类必须存在（不存在 → 404 DEFINITION_NOT_FOUND 语义由 getCategoryById 抛出）
      getCategoryById(nextCategoryId)
    }
  }

  let nextShelfLife = current.estimated_shelf_life_days
  if (input.estimated_shelf_life_days !== undefined) {
    const v = input.estimated_shelf_life_days
    if (v !== null) {
      if (!Number.isInteger(v) || v < 0) {
        throw validationError(`默认预估保质期必须是非负整数或留空，当前为：${String(v)}`)
      }
    }
    nextShelfLife = v
  }

  // ---- 分类变更的跨类保护 + 实际写入（同一事务）----
  //
  // 规则（v0.1.4，用户确认）：
  //   1. 普通食材之间允许改分类，**即使已有库存**也不禁止
  //   2. 跨越「普通食材 ↔ 调味品」边界时：
  //        - 只要存在**任何**库存记录（含 quantity = 0）→ 409 CATEGORY_TRANSITION_NOT_ALLOWED
  //        - 完全没有库存记录 → 允许转换
  //   3. 调味品 → 普通食材时，普通食材必须有**至少 1 个**允许单位
  //        （调味品合法地允许 0 个单位，但普通食材不允许 0 单位，
  //          否则会产生绕过 createDefinition 校验的非法状态）
  //   4. 检查与写入必须在同一事务内，避免检查通过后有库存插入
  //
  // ⚠️ 不得重算任何已有库存的到期日期 —— 本函数只改 definition 行，
  //    从不触碰 standard_ingredient。
  // ⚠️ 不自动添加/删除单位。
  return db.transaction((tx) => {
    if (nextCategoryId !== current.category_id) {
      // 先查跨类（有库存 → 409），再查单位要求
      assertCategoryChangeAllowed(
        tx,
        id,
        current.category_id,
        nextCategoryId,
      )

      // 调味品 → 普通食材：普通食材必须至少有一个允许单位（E1）
      if (
        isSeasoningCategory(current.category_id) &&
        !isSeasoningCategory(nextCategoryId)
      ) {
        const unitCount = listAllowedUnits(id, tx).length
        if (unitCount === 0) {
          throw validationError(
            '该食材目前没有任何允许单位，无法改为普通食材。' +
              '请先为它添加至少一个单位，再修改分类。',
          )
        }
      }
    }

    return tx
      .update(ingredientDefinition)
      .set({
        name: nextName,
        name_normalized: nextNameNormalized,
        estimated_shelf_life_days: nextShelfLife,
        category_id: nextCategoryId,
        updated_at: timestamp,
      })
      .where(eq(ingredientDefinition.id, id))
      .returning()
      .get()
  })
}

/**
 * 分类变更的跨类保护（v0.1.4）。
 *
 * 只在「普通食材 ↔ 调味品」边界上生效；普通食材之间互相改分类一律放行。
 *
 * ⚠️ 库存检查**不区分数量**：`quantity = 0` 的记录同样算「存在库存」，
 *    因此不能用 `quantity > 0` 过滤。
 *
 * ⚠️ 参数类型取 Pick<typeof db, 'select'>，这样 db 与 db.transaction 传入的 tx
 *    都能接受（与 standardIngredientService 的 BatchQueryable 同一做法）。
 *
 * @throws ServiceError CATEGORY_TRANSITION_NOT_ALLOWED
 */
function assertCategoryChangeAllowed(
  tx: Pick<typeof db, 'select'>,
  definitionId: number,
  fromCategoryId: number | null,
  toCategoryId: number | null,
): void {
  const fromIsSeasoning = isSeasoningCategory(fromCategoryId)
  const toIsSeasoning = isSeasoningCategory(toCategoryId)

  // 同侧（普通 → 普通，或调味品 → 调味品）：允许
  if (fromIsSeasoning === toIsSeasoning) {
    return
  }

  // 跨类：只要有任何库存记录就拒绝
  const stockCount = tx
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.definition_id, definitionId))
    .all().length

  if (stockCount > 0) {
    const from = fromIsSeasoning ? '调味品' : '普通食材'
    const to = toIsSeasoning ? '调味品' : '普通食材'
    throw categoryTransitionNotAllowedError(
      `「${from}」与「${to}」之间不能切换分类：该食材下还有 ${stockCount} 条库存记录` +
        `（含数量为 0 的记录）。请先删除这些库存记录，再修改分类。`,
    )
  }
}

/**
 * 删除食材定义。
 *
 * 规则：
 *   - 只要还有**任何**库存记录 → 拒绝（HAS_STOCK，409）
 *   - 无库存 → 允许删除，别名与允许单位级联删除
 *
 * ⚠️ 绝不级联删除库存记录。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / HAS_STOCK
 */
export function deleteDefinition(id: number): void {
  getDefinitionById(id)

  const stockCount = db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.definition_id, id))
    .all().length

  if (stockCount > 0) {
    throw hasStockError(
      `该食材还有 ${stockCount} 条库存记录，无法删除。请先删除这些库存记录。`,
    )
  }

  // 别名与允许单位由外键 ON DELETE CASCADE 自动删除
  db.delete(ingredientDefinition).where(eq(ingredientDefinition.id, id)).run()
}

/* ============================================================
 * 允许单位管理
 * ============================================================ */

/**
 * 添加允许单位。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
 */
export function addAllowedUnit(definitionId: number, unit: string): IngredientDefinitionUnit {
  getDefinitionById(definitionId)
  assertValidUnit(unit)

  const existing = db
    .select()
    .from(ingredientDefinitionUnit)
    .where(
      and(
        eq(ingredientDefinitionUnit.definition_id, definitionId),
        eq(ingredientDefinitionUnit.unit, unit),
      ),
    )
    .get()

  if (existing) {
    throw duplicateNameError(`该单位已存在：${unit}`)
  }

  return db
    .insert(ingredientDefinitionUnit)
    .values({ definition_id: definitionId, unit, created_at: nowIso() })
    .returning()
    .get()
}

/**
 * 移除允许单位。
 *
 * 规则：
 *   - 若该单位的库存正在使用 → 拒绝（UNIT_IN_USE，409）
 *   - 若这是**最后一个**允许单位 → 拒绝（定义必须至少有一个单位）
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR / UNIT_IN_USE
 */
export function removeAllowedUnit(definitionId: number, unit: string): void {
  getDefinitionById(definitionId)
  assertValidUnit(unit)

  const existing = db
    .select()
    .from(ingredientDefinitionUnit)
    .where(
      and(
        eq(ingredientDefinitionUnit.definition_id, definitionId),
        eq(ingredientDefinitionUnit.unit, unit),
      ),
    )
    .get()

  if (!existing) {
    throw notFoundError(`该单位不存在：${unit}`)
  }

  // 1. 是否仍有库存使用该单位
  const inUse = db
    .select()
    .from(standardIngredient)
    .where(
      and(
        eq(standardIngredient.definition_id, definitionId),
        eq(standardIngredient.unit, unit),
      ),
    )
    .all().length

  if (inUse > 0) {
    throw unitInUseError(
      `单位「${unit}」仍被 ${inUse} 条库存记录使用，无法移除。请先修改或删除这些库存记录。`,
    )
  }

  // 2. 单位数量下限
  //
  // ⚠️ v0.1.3 起规则分两种：
  //     - 普通食材：必须至少保留 1 个允许单位
  //     - 调味品：允许删到 0 个（库存不管理数量与单位）
  const remaining = listAllowedUnits(definitionId)
  const definition = getDefinitionById(definitionId)
  const seasoning = isSeasoningCategory(definition.category_id)

  if (!seasoning && remaining.length <= 1) {
    throw validationError('食材定义必须至少保留一个允许单位')
  }

  db.delete(ingredientDefinitionUnit)
    .where(eq(ingredientDefinitionUnit.id, existing.id))
    .run()
}

/* ============================================================
 * 别名管理
 * ============================================================ */

/**
 * 添加别名。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
 */
export function addAlias(definitionId: number, alias: string) {
  getDefinitionById(definitionId)

  if (typeof alias !== 'string' || isBlankName(alias)) {
    throw validationError('别名不能为空')
  }

  const aliasNormalized = normalizeName(alias)
  assertNameAvailableAcrossTables(aliasNormalized)

  return db
    .insert(ingredientAlias)
    .values({
      definition_id: definitionId,
      alias: alias.trim(),
      alias_normalized: aliasNormalized,
      created_at: nowIso(),
    })
    .returning()
    .get()
}

/**
 * 修改别名。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
 */
export function updateAlias(aliasId: number, newAlias: string) {
  const existing = db.select().from(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).get()

  if (!existing) {
    throw notFoundError(`别名不存在：id=${aliasId}`)
  }

  if (typeof newAlias !== 'string' || isBlankName(newAlias)) {
    throw validationError('别名不能为空')
  }

  const aliasNormalized = normalizeName(newAlias)
  assertNameAvailableAcrossTables(aliasNormalized, { excludeAliasId: aliasId })

  return db
    .update(ingredientAlias)
    .set({ alias: newAlias.trim(), alias_normalized: aliasNormalized })
    .where(eq(ingredientAlias.id, aliasId))
    .returning()
    .get()
}

/**
 * 删除别名。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function deleteAlias(aliasId: number): void {
  const existing = db.select().from(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).get()

  if (!existing) {
    throw notFoundError(`别名不存在：id=${aliasId}`)
  }

  db.delete(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).run()
}

/* ============================================================
 * 默认名称切换
 * ============================================================ */

/**
 * 把某个别名设为默认名称。
 *
 * 行为（必须原子）：
 *   1. 原默认名称自动变成 alias
 *   2. 新默认名称从 alias 中移除
 *   3. 全程保持同一个 definition_id
 *
 * 例：
 *   番茄 ★ 默认 / 别名：西红柿、番茄子
 *   → 设置「西红柿」为默认
 *   → 西红柿 ★ 默认 / 别名：番茄、番茄子
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / INGREDIENT_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
 */
export function setDefaultName(definitionId: number, aliasId: number): IngredientDefinition {
  const definition = getDefinitionById(definitionId)

  const alias = db.select().from(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).get()

  if (!alias) {
    throw notFoundError(`别名不存在：id=${aliasId}`)
  }

  if (alias.definition_id !== definitionId) {
    throw notFoundError(`别名不属于该食材：别名 id=${aliasId}，食材 id=${definitionId}`)
  }

  const newName = alias.alias
  const newNameNormalized = alias.alias_normalized
  const oldName = definition.name
  const oldNameNormalized = definition.name_normalized
  const timestamp = nowIso()

  // 新默认名称不能与其他 definition 或其他别名冲突。
  // 排除：自己这个 definition 的名称 + 正在被提升的这个 alias 自己。
  assertNameAvailableAcrossTables(newNameNormalized, {
    excludeDefinitionId: definitionId,
    excludeAliasId: aliasId,
  })

  return db.transaction((tx) => {
    // 1. 删除被提升的 alias（它即将成为默认名称）
    tx.delete(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).run()

    // 2. 原默认名称降级为 alias
    //    注意：此时原名称已不在 alias 表中（刚删的是被提升那个），不会冲突
    tx.insert(ingredientAlias)
      .values({
        definition_id: definitionId,
        alias: oldName,
        alias_normalized: oldNameNormalized,
        created_at: timestamp,
      })
      .run()

    // 3. 更新默认名称
    const updated = tx
      .update(ingredientDefinition)
      .set({
        name: newName,
        name_normalized: newNameNormalized,
        updated_at: timestamp,
      })
      .where(eq(ingredientDefinition.id, definitionId))
      .returning()
      .get()

    return updated
  })
}

/* ============================================================
 * 查询与搜索
 * ============================================================ */

/** 列出全部食材定义 */
export function listDefinitions(): IngredientDefinition[] {
  return db.select().from(ingredientDefinition).orderBy(ingredientDefinition.id).all()
}

/**
 * 食材库**搜索**（包含匹配）。
 *
 * ⚠️ 这与"精确解析"是两回事：
 *   - 本函数：包含匹配（LIKE %x%），用于 UI 搜索框
 *     输入「土」→ 可返回 土豆 / 土鸡 / 土猪肉 / 观音土
 *   - resolveDefinitionByName：归一化精确匹配，用于"用户选定某个名称"
 *
 * 匹配范围：默认名称 + 别名。
 *
 * @param query 搜索词（会做 trim + toLowerCase）
 * @returns 命中的定义（去重，按 id 排序）
 */
export function searchDefinitions(query: string): IngredientDefinition[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return listDefinitions()
  }

  // LIKE 的转义：% 和 _ 是通配符，用户输入需转义
  const escaped = trimmed.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)
  const pattern = `%${escaped}%`

  // 名称匹配
  const byName = db
    .select()
    .from(ingredientDefinition)
    .where(like(ingredientDefinition.name_normalized, pattern))
    .all()

  // 别名匹配 → 取所属定义
  const aliasRows = db
    .select({ definition_id: ingredientAlias.definition_id })
    .from(ingredientAlias)
    .where(like(ingredientAlias.alias_normalized, pattern))
    .all()

  const matchedIds = new Set<number>(byName.map((d) => d.id))
  for (const row of aliasRows) {
    matchedIds.add(row.definition_id)
  }

  if (matchedIds.size === 0) {
    return []
  }

  const ids = [...matchedIds]
  return db
    .select()
    .from(ingredientDefinition)
    .where(sql`${ingredientDefinition.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)
    .orderBy(ingredientDefinition.id)
    .all()
}

/**
 * 精确解析：按归一化名称或别名精确查找 definition。
 *
 * 解析顺序：**优先默认名称**，其次别名。
 * 精确匹配，不做模糊/拼音/繁简/全角半角处理。
 *
 * @returns 命中则返回定义，未命中返回 undefined
 */
export function resolveDefinitionByName(input: string): IngredientDefinition | undefined {
  if (typeof input !== 'string' || isBlankName(input)) {
    return undefined
  }

  const normalized = normalizeName(input)

  // 1. 优先默认名称
  const byName = db
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.name_normalized, normalized))
    .get()

  if (byName) {
    return byName
  }

  // 2. 再查别名
  const alias = db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.alias_normalized, normalized))
    .get()

  if (alias) {
    return db
      .select()
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, alias.definition_id))
      .get()
  }

  return undefined
}

/** 确认某个单位是该定义的允许单位 */
export function assertUnitAllowed(definitionId: number, unit: string): void {
  const allowed = listAllowedUnits(definitionId)
  if (!allowed.includes(unit)) {
    throw unitNotAllowedError(
      `单位「${unit}」不是该食材的允许单位。允许：${allowed.join('、')}`,
    )
  }
}

/* ============================================================
 * 统一保存（v0.1.4 第二批）
 *
 * 背景：前端「食材快捷编辑」有多个可编辑字段
 *       （名称 / 分类 / 保质期 / 别名 / 单位 / 设为默认）。
 *       若前端用多个独立请求提交，会出现「部分成功」：
 *       例如设为默认已生效、但后续别名请求失败，用户重试时
 *       会用到已被删除的 alias id → 404，陷入无法恢复的状态。
 *
 * 本函数把全部改动放进**同一个数据库事务**：
 *   要么全部成功，要么全部回滚 —— 不存在部分保存。
 * ============================================================ */

/** 别名草稿项：id 为 null 表示新增 */
export interface AliasDraftInput {
  id: number | null
  alias: string
}

export interface SaveDefinitionFullInput {
  name?: string
  category_id?: number | null
  estimated_shelf_life_days?: number | null
  /**
   * 别名全量草稿（客户端最终状态）。
   * undefined = 不改动别名；数组 = 以此为最终状态做差异同步。
   */
  aliases?: AliasDraftInput[]
  /** 允许单位全量草稿。undefined = 不改动单位 */
  units?: string[]
  /** 要提升为默认名称的别名 id（后端在该事务内完成名称↔别名交换） */
  set_default_alias_id?: number
}

/**
 * 统一保存食材定义。
 *
 * ⚠️ 全部写操作在**同一个 `db.transaction`** 内，任一步抛错则整体回滚。
 *    事务对象 `tx` 显式传给每个内部步骤，确保它们使用同一连接。
 *
 * 执行顺序（在同一事务内）：
 *   1. 设为默认（名称 ↔ 别名交换）
 *   2. 基础字段（名称 / 分类 / 保质期）
 *   3. 别名差异同步（先删后增）
 *   4. 单位差异同步（先删后增）
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR /
 *                      DUPLICATE_NAME / CATEGORY_TRANSITION_NOT_ALLOWED /
 *                      UNIT_IN_USE / notFoundError
 */
export function saveDefinitionFull(
  id: number,
  input: SaveDefinitionFullInput,
): IngredientDefinition {
  // 先确认定义存在（不存在则 404，与既有行为一致）
  getDefinitionById(id)
  const timestamp = nowIso()

  return db.transaction((tx) => {
    /* ---------- 1. 设为默认（名称 ↔ 别名交换）---------- */
    if (input.set_default_alias_id !== undefined) {
      applySetDefaultNameInTx(tx, id, input.set_default_alias_id, timestamp)
    }

    /* ---------- 2. 基础字段 ---------- */
    const afterDefault = tx
      .select()
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, id))
      .get()!

    let nextName = afterDefault.name
    let nextNameNormalized = afterDefault.name_normalized

    if (input.name !== undefined) {
      if (typeof input.name !== 'string' || isBlankName(input.name)) {
        throw validationError('食材名称不能为空')
      }
      const trimmed = input.name.trim()
      const normalized = normalizeName(input.name)
      // 仅当名称真的变化时才做唯一性检查与写入
      if (normalized !== afterDefault.name_normalized) {
        assertNameAvailableAcrossTables(normalized, {
          excludeDefinitionId: id,
          queryable: tx,
        })
        nextName = trimmed
        nextNameNormalized = normalized
      }
    }

    let nextCategoryId = afterDefault.category_id
    if (input.category_id !== undefined) {
      nextCategoryId = input.category_id
      if (nextCategoryId !== null) {
        getCategoryById(nextCategoryId)
      }
      // 跨类保护（有库存则 409；调味品→普通需至少 1 单位）
      if (nextCategoryId !== afterDefault.category_id) {
        assertCategoryChangeAllowed(tx, id, afterDefault.category_id, nextCategoryId)
      }
    }

    let nextShelfLife = afterDefault.estimated_shelf_life_days
    if (input.estimated_shelf_life_days !== undefined) {
      const v = input.estimated_shelf_life_days
      if (v !== null && (!Number.isInteger(v) || v < 0)) {
        throw validationError(`默认预估保质期必须是非负整数或留空，当前为：${String(v)}`)
      }
      nextShelfLife = v
    }

    // 单位草稿决定「最终是否调味品语义」时，需要一并校验单位数量
    const finalUnits =
      input.units !== undefined
        ? [...new Set(input.units)]
        : listAllowedUnits(id, tx)

    const finalIsSeasoning = isSeasoningCategory(nextCategoryId)
    if (!finalIsSeasoning && finalUnits.length === 0) {
      throw validationError('普通食材必须至少保留一个允许单位')
    }
    for (const u of finalUnits) {
      assertValidUnit(u)
    }

    tx.update(ingredientDefinition)
      .set({
        name: nextName,
        name_normalized: nextNameNormalized,
        estimated_shelf_life_days: nextShelfLife,
        category_id: nextCategoryId,
        updated_at: timestamp,
      })
      .where(eq(ingredientDefinition.id, id))
      .run()

    /* ---------- 3. 别名差异同步 ---------- */
    if (input.aliases !== undefined) {
      syncAliasesInTx(tx, id, input.aliases, timestamp)
    }

    /* ---------- 4. 单位差异同步 ---------- */
    if (input.units !== undefined) {
      syncUnitsInTx(tx, id, finalUnits)
    }

    // 返回事务内的最终状态
    return tx
      .select()
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, id))
      .get()!
  })
}

/* ---------- 事务内部步骤（全部显式接收 tx）---------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * 设为默认名称（事务内版本）。
 *
 * 语义与既有 setDefaultName 完全一致：
 *   1. 删除被提升的别名
 *   2. 原默认名称降级为新别名
 *   3. 更新默认名称
 */
function applySetDefaultNameInTx(
  tx: Tx,
  definitionId: number,
  aliasId: number,
  timestamp: string,
): void {
  const definition = tx
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.id, definitionId))
    .get()
  if (!definition) {
    throw definitionNotFoundError(`食材定义不存在：id=${definitionId}`)
  }

  const alias = tx.select().from(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).get()
  if (!alias) {
    throw notFoundError(`别名不存在：id=${aliasId}`)
  }
  if (alias.definition_id !== definitionId) {
    throw notFoundError(`别名不属于该食材：别名 id=${aliasId}，食材 id=${definitionId}`)
  }

  const newName = alias.alias
  const newNameNormalized = alias.alias_normalized
  const oldName = definition.name
  const oldNameNormalized = definition.name_normalized

  assertNameAvailableAcrossTables(newNameNormalized, {
    excludeDefinitionId: definitionId,
    excludeAliasId: aliasId,
    queryable: tx,
  })

  tx.delete(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).run()

  tx.insert(ingredientAlias)
    .values({
      definition_id: definitionId,
      alias: oldName,
      alias_normalized: oldNameNormalized,
      created_at: timestamp,
    })
    .run()

  tx.update(ingredientDefinition)
    .set({
      name: newName,
      name_normalized: newNameNormalized,
      updated_at: timestamp,
    })
    .where(eq(ingredientDefinition.id, definitionId))
    .run()
}

/**
 * 别名差异同步（事务内版本）。
 *
 * 以草稿为**最终状态**：不在草稿里的已有别名删除，草稿中文本不存在的别名新增。
 * 比较用**文本**而非 id，因此「设为默认」刚产生的新别名 id 也能被正确处理。
 */
function syncAliasesInTx(
  tx: Tx,
  definitionId: number,
  drafts: AliasDraftInput[],
  timestamp: string,
): void {
  // 规范化草稿文本（trim + 去重，保持顺序）
  const wanted: string[] = []
  for (const d of drafts) {
    if (typeof d.alias !== 'string' || isBlankName(d.alias)) continue
    const t = d.alias.trim()
    if (!wanted.includes(t)) wanted.push(t)
  }

  const existing = tx
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.definition_id, definitionId))
    .all()

  // 1. 删除不在草稿中的
  for (const a of existing) {
    if (!wanted.includes(a.alias)) {
      tx.delete(ingredientAlias).where(eq(ingredientAlias.id, a.id)).run()
    }
  }

  // 2. 新增草稿中尚不存在的
  const keptTexts = new Set(
    tx
      .select()
      .from(ingredientAlias)
      .where(eq(ingredientAlias.definition_id, definitionId))
      .all()
      .map((a) => a.alias),
  )
  for (const text of wanted) {
    if (keptTexts.has(text)) continue
    const normalized = normalizeName(text)
    // 跨表唯一性（排除自己的默认名称）
    assertNameAvailableAcrossTables(normalized, {
      excludeDefinitionId: definitionId,
      queryable: tx,
    })
    tx.insert(ingredientAlias)
      .values({
        definition_id: definitionId,
        alias: text,
        alias_normalized: normalized,
        created_at: timestamp,
      })
      .run()
  }
}

/**
 * 单位差异同步（事务内版本）。
 *
 * ⚠️ 移除单位时遵守既有规则：仍被库存使用时拒绝（UNIT_IN_USE）。
 */
function syncUnitsInTx(tx: Tx, definitionId: number, wanted: string[]): void {
  const existing = tx
    .select()
    .from(ingredientDefinitionUnit)
    .where(eq(ingredientDefinitionUnit.definition_id, definitionId))
    .all()

  // 1. 删除不在草稿中的
  for (const row of existing) {
    if (wanted.includes(row.unit)) continue

    const inUse = tx
      .select()
      .from(standardIngredient)
      .where(
        and(
          eq(standardIngredient.definition_id, definitionId),
          eq(standardIngredient.unit, row.unit),
        ),
      )
      .all().length

    if (inUse > 0) {
      throw unitInUseError(
        `单位「${row.unit}」仍被 ${inUse} 条库存记录使用，无法移除。请先修改或删除这些库存记录。`,
      )
    }

    tx.delete(ingredientDefinitionUnit).where(eq(ingredientDefinitionUnit.id, row.id)).run()
  }

  // 2. 新增草稿中尚不存在的
  const keptTexts = new Set(
    tx
      .select()
      .from(ingredientDefinitionUnit)
      .where(eq(ingredientDefinitionUnit.definition_id, definitionId))
      .all()
      .map((r) => r.unit),
  )
  for (const u of wanted) {
    if (keptTexts.has(u)) continue
    tx.insert(ingredientDefinitionUnit)
      .values({ definition_id: definitionId, unit: u, created_at: nowIso() })
      .run()
  }
}
