import { and, eq, ne } from 'drizzle-orm'

import { db } from '../db/index.js'
import { ingredientAlias, standardIngredient } from '../db/schema.js'
import type { IngredientAlias, StandardIngredient } from '../db/schema.js'
import { duplicateNameError, notFoundError, validationError } from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'

/**
 * 食材别名 Service（v0.1）
 *
 * 关系：
 *   一个标准食材 → 可以有多个别名
 *   一个别名 → 只能属于一个标准食材
 *
 * 对应 DATABASE_DESIGN.md：
 *   - 第 4 节   ingredient_alias 字段设计
 *   - 第 5.4 节 UNIQUE 约束（alias_normalized 全局唯一）
 *   - 第 6.3 节 "同一个别名只能属于一个标准食材"如何保证
 *   - 第 6.5/6.6 节 跨表重名由 Service 检查，不引入 Trigger
 *
 * ⚠️ 跨表唯一性是本模块的核心职责：
 *    一个字符串经过 normalize 之后，**不能同时作为任何标准名或任何别名存在**。
 *    数据库有两张表各自的 UNIQUE 约束，但**无法跨表强制**，
 *    因此这条规则完全由本 Service 保证（不使用 SQLite trigger）。
 */

/** 当前 UTC 时间，ISO 8601 格式 */
function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 检查某个 normalized 名称是否已被任何标准名占用（跨表检查的第一半）。
 *
 * @param normalized 归一化后的名称
 * @returns 占用它的标准食材；未被占用则 undefined
 */
function findStandardByNameNormalized(normalized: string): StandardIngredient | undefined {
  return db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.name_normalized, normalized))
    .get()
}

/**
 * 检查某个 normalized 名称是否已被任何**其他**别名占用（跨表检查的第二半）。
 *
 * @param normalized 归一化后的名称
 * @param excludeAliasId 排除的别名 ID（修改时排除自己）
 * @returns 占用它的别名；未被占用则 undefined
 */
function findAliasByNormalized(
  normalized: string,
  excludeAliasId?: number,
): IngredientAlias | undefined {
  const condition =
    excludeAliasId === undefined
      ? eq(ingredientAlias.alias_normalized, normalized)
      : and(
          eq(ingredientAlias.alias_normalized, normalized),
          ne(ingredientAlias.id, excludeAliasId),
        )

  return db.select().from(ingredientAlias).where(condition).get()
}

/**
 * 跨表唯一性检查：确认某个 normalized 名称既不是标准名，也不是别名。
 *
 * 这是 DATABASE_DESIGN.md 第 6.5 节那个"UNIQUE 约束覆盖不到的情况"的落地：
 *
 *   standard_ingredient.name_normalized = '西红柿'   ← 单独看合法
 *   ingredient_alias.alias_normalized   = '西红柿'   ← 单独看也合法
 *   但两者不能同时存在
 *
 * @param normalized 归一化后的名称
 * @param excludeAliasId 修改别名时排除自己
 * @param excludeIngredientId 修改标准名时排除自己
 * @throws ServiceError DUPLICATE_NAME
 */
export function assertNameAvailableAcrossTables(
  normalized: string,
  options: { excludeAliasId?: number; excludeIngredientId?: number } = {},
): void {
  // 1. 是否已被某个标准名占用
  const occupiedByStandard = findStandardByNameNormalized(normalized)

  if (occupiedByStandard && occupiedByStandard.id !== options.excludeIngredientId) {
    throw duplicateNameError(
      `名称已被标准食材占用：${occupiedByStandard.name}（归一化名称：${normalized}）`,
    )
  }

  // 2. 是否已被某个别名占用
  const occupiedByAlias = findAliasByNormalized(normalized, options.excludeAliasId)

  if (occupiedByAlias) {
    throw duplicateNameError(
      `名称已被别名占用：${occupiedByAlias.alias}（归一化名称：${normalized}）`,
    )
  }
}

/**
 * 确认标准食材存在。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
function assertIngredientExists(ingredientId: number): StandardIngredient {
  const found = db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.id, ingredientId))
    .get()

  if (!found) {
    throw notFoundError(`食材不存在：id=${ingredientId}`)
  }

  return found
}

/**
 * 创建别名。
 *
 * 行为：
 * 1. ingredient 必须存在
 * 2. alias 必须是有效字符串，normalize 后不能为空
 * 3. 跨表唯一性检查（不能与任何标准名或别名冲突）
 * 4. 冲突 → DUPLICATE_NAME
 *
 * @throws ServiceError VALIDATION_ERROR / INGREDIENT_NOT_FOUND / DUPLICATE_NAME
 */
export function createAlias(ingredientId: number, alias: string): IngredientAlias {
  // 1. 食材必须存在
  assertIngredientExists(ingredientId)

  // 2. alias 校验：必须是字符串且 normalize 后不为空
  if (typeof alias !== 'string' || isBlankName(alias)) {
    throw validationError('别名不能为空')
  }

  // 3. 归一化（复用统一的 normalizeName，不重新实现）
  const aliasNormalized = normalizeName(alias)

  // 4. 跨表唯一性检查
  assertNameAvailableAcrossTables(aliasNormalized)

  // 5. 创建（alias 保留原始输入形式，仅去掉首尾空格）
  const created = db
    .insert(ingredientAlias)
    .values({
      ingredient_id: ingredientId,
      alias: alias.trim(),
      alias_normalized: aliasNormalized,
      created_at: nowIso(),
    })
    .returning()
    .get()

  return created
}

/**
 * 获取某个标准食材的全部别名。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND（食材不存在时）
 */
export function listAliases(ingredientId: number): IngredientAlias[] {
  // 食材不存在 → 404，而不是返回空数组
  assertIngredientExists(ingredientId)

  return db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.ingredient_id, ingredientId))
    .orderBy(ingredientAlias.id)
    .all()
}

/**
 * 按别名 ID 查询别名。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND（别名不存在时）
 */
export function getAliasById(aliasId: number): IngredientAlias {
  const found = db.select().from(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).get()

  if (!found) {
    throw notFoundError(`别名不存在：id=${aliasId}`)
  }

  return found
}

/**
 * 按别名 ID 查询，并确认它属于指定的标准食材。
 *
 * 用于 PATCH / DELETE /api/ingredients/:id/aliases/:aliasId 这类
 * URL 中同时包含食材 ID 与别名 ID 的端点：
 * 若别名不属于该食材，说明 URL 描述的归属关系不成立 → 404。
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND
 */
export function getAliasOfIngredient(ingredientId: number, aliasId: number): IngredientAlias {
  const alias = getAliasById(aliasId)

  if (alias.ingredient_id !== ingredientId) {
    throw notFoundError(`别名不属于该食材：别名 id=${aliasId}，食材 id=${ingredientId}`)
  }

  return alias
}

/**
 * 修改别名。
 *
 * 行为：
 * 1. alias 必须存在
 * 2. normalize
 * 3. 跨表唯一性检查，**排除当前 alias 自己**
 * 4. 冲突 → DUPLICATE_NAME
 *
 * @param aliasId 别名 ID
 * @param newAlias 新别名
 * @param expectedIngredientId 可选：要求该别名必须属于此食材（URL 归属校验）
 *
 * @throws ServiceError VALIDATION_ERROR / INGREDIENT_NOT_FOUND / DUPLICATE_NAME
 */
export function updateAlias(
  aliasId: number,
  newAlias: string,
  expectedIngredientId?: number,
): IngredientAlias {
  // 1. 别名必须存在（带归属校验时同时确认归属）
  if (expectedIngredientId === undefined) {
    getAliasById(aliasId)
  } else {
    getAliasOfIngredient(expectedIngredientId, aliasId)
  }

  // 2. 新名称校验
  if (typeof newAlias !== 'string' || isBlankName(newAlias)) {
    throw validationError('别名不能为空')
  }

  // 3. 归一化
  const aliasNormalized = normalizeName(newAlias)

  // 4. 跨表唯一性检查，排除自己
  //    （"改成自己当前的 normalized name" 应当允许）
  assertNameAvailableAcrossTables(aliasNormalized, { excludeAliasId: aliasId })

  // 5. 更新
  const updated = db
    .update(ingredientAlias)
    .set({
      alias: newAlias.trim(),
      alias_normalized: aliasNormalized,
    })
    .where(eq(ingredientAlias.id, aliasId))
    .returning()
    .get()

  return updated
}

/**
 * 删除别名。
 *
 * @param aliasId 别名 ID
 * @param expectedIngredientId 可选：要求该别名必须属于此食材（URL 归属校验）
 *
 * @throws ServiceError INGREDIENT_NOT_FOUND（别名不存在时）
 */
export function deleteAlias(aliasId: number, expectedIngredientId?: number): void {
  // 不存在 → 404，而不是静默成功
  if (expectedIngredientId === undefined) {
    getAliasById(aliasId)
  } else {
    getAliasOfIngredient(expectedIngredientId, aliasId)
  }

  db.delete(ingredientAlias).where(eq(ingredientAlias.id, aliasId)).run()
}

/**
 * 统一名称解析：输入任意名称 → 对应的标准食材。
 *
 * 解析顺序（DATABASE_DESIGN.md 第 9.4 节）：
 *
 *   输入
 *    ↓
 *   normalize(input)
 *    ↓
 *   查 standard_ingredient.name_normalized   ← 优先标准名
 *    ↓ 找到 → 返回
 *   否则查 ingredient_alias.alias_normalized
 *    ↓ 找到 → 返回对应的标准食材
 *   都找不到 → INGREDIENT_NOT_FOUND
 *
 * **精确匹配**：不做模糊匹配、不做 AI 推断、不做拼音、不做编辑距离。
 *
 * @throws ServiceError VALIDATION_ERROR（输入为空）/ INGREDIENT_NOT_FOUND
 */
export function resolveIngredientByName(input: string): StandardIngredient {
  if (typeof input !== 'string' || isBlankName(input)) {
    throw validationError('名称不能为空')
  }

  const normalized = normalizeName(input)

  // 1. 优先按标准名称精确查找
  const byStandardName = db
    .select()
    .from(standardIngredient)
    .where(eq(standardIngredient.name_normalized, normalized))
    .get()

  if (byStandardName) {
    return byStandardName
  }

  // 2. 再按别名精确查找，返回其所属的标准食材
  const alias = db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.alias_normalized, normalized))
    .get()

  if (alias) {
    const owner = db
      .select()
      .from(standardIngredient)
      .where(eq(standardIngredient.id, alias.ingredient_id))
      .get()

    if (owner) {
      return owner
    }
  }

  // 3. 都找不到
  throw notFoundError(`找不到对应的食材：${input}`)
}

/**
 * 解析名称，但**不抛错**（未命中返回 undefined）。
 *
 * `resolveIngredientByName` 的宽松版本，便于调用方自行处理"未命中"。
 */
export function tryResolveIngredientByName(input: string): StandardIngredient | undefined {
  if (typeof input !== 'string' || isBlankName(input)) {
    return undefined
  }

  try {
    return resolveIngredientByName(input)
  } catch {
    return undefined
  }
}
