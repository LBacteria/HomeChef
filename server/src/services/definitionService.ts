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
  definitionNotFoundError,
  duplicateNameError,
  hasStockError,
  notFoundError,
  unitInUseError,
  unitNotAllowedError,
  validationError,
} from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'

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
 * @param normalized 归一化后的名称
 * @param excludeDefinitionId 修改 definition 名称时排除自己
 * @param excludeAliasId 修改 alias 时排除自己
 */
export function assertNameAvailableAcrossTables(
  normalized: string,
  options: { excludeDefinitionId?: number; excludeAliasId?: number } = {},
): void {
  // 1. 是否被某个 definition 的默认名称占用
  const byDefinition = db
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

  const byAlias = db.select().from(ingredientAlias).where(aliasCondition).get()

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

/** 查询某定义的允许单位 */
export function listAllowedUnits(definitionId: number): string[] {
  const rows = db
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
  /** 至少一个允许单位 */
  units: string[]
  /** 默认预估保质期（天），可选 */
  estimated_shelf_life_days?: number | null
  /** 初始别名，可选 */
  aliases?: string[]
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

  // 2. 至少一个允许单位
  if (!Array.isArray(input.units) || input.units.length === 0) {
    throw validationError('食材定义必须至少有一个允许单位')
  }

  const uniqueUnits = [...new Set(input.units)]
  for (const u of uniqueUnits) {
    assertValidUnit(u)
  }

  // 3. 保质期校验
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
}

/**
 * 更新食材定义（名称、默认预估保质期）。
 *
 * ⚠️ 修改 estimated_shelf_life_days **只影响以后新建的库存记录**，
 *    绝不自动修改已有库存记录。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
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

  const updated = db
    .update(ingredientDefinition)
    .set({
      name: nextName,
      name_normalized: nextNameNormalized,
      estimated_shelf_life_days: nextShelfLife,
      updated_at: timestamp,
    })
    .where(eq(ingredientDefinition.id, id))
    .returning()
    .get()

  return updated
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

  // 2. 定义必须至少保留一个允许单位
  const remaining = listAllowedUnits(definitionId)
  if (remaining.length <= 1) {
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
