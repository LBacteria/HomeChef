import { asc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { SEASONING_CATEGORY_NAME, category, ingredientDefinition } from '../db/schema.js'
import type { Category } from '../db/schema.js'
import {
  categoryInUseError,
  duplicateNameError,
  notFoundError,
  validationError,
} from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'

/**
 * 食材分类 Service。
 *
 * 设计要点：
 *   - **只有一套分类机制**：内置分类与用户自定义分类结构完全相同
 *   - 名称唯一：用 normalizeName（trim + toLowerCase）做归一化后判重
 *   - 删除保护：只要仍有 ingredient_definition 引用，就拒绝删除（CATEGORY_IN_USE）
 *   - 不级联删除、不自动移动食材、不把 category_id 置 NULL
 */

function nowIso(): string {
  return new Date().toISOString()
}

/** 调味品分类名（用于调味品特殊行为判断） */
export { SEASONING_CATEGORY_NAME }

/** 列出全部分类（按 sort_order，其次 id） */
export function listCategories(): Category[] {
  return db
    .select()
    .from(category)
    .orderBy(asc(category.sort_order), asc(category.id))
    .all()
}

/** 按 id 获取分类；不存在则抛 404 */
export function getCategoryById(id: number): Category {
  const found = db.select().from(category).where(eq(category.id, id)).get()
  if (!found) {
    throw notFoundError(`分类不存在：id=${id}`)
  }
  return found
}

/**
 * 按归一化名称查找分类。
 *
 * @returns 命中则返回，否则 undefined
 */
export function findCategoryByName(name: string): Category | undefined {
  if (typeof name !== 'string' || isBlankName(name)) {
    return undefined
  }
  return db
    .select()
    .from(category)
    .where(eq(category.name_normalized, normalizeName(name)))
    .get()
}

/**
 * 创建分类。
 *
 * 名称校验：
 *   - 空字符串 / 纯空格 → 400 VALIDATION_ERROR
 *   - 归一化后重复（'调味品' / ' 调味品' / '调味品 '）→ 409 DUPLICATE_NAME
 *
 * @throws ServiceError VALIDATION_ERROR / DUPLICATE_NAME
 */
export function createCategory(name: string): Category {
  if (typeof name !== 'string' || isBlankName(name)) {
    throw validationError('分类名称不能为空')
  }

  const trimmed = name.trim()
  const normalized = normalizeName(name)

  const existing = db
    .select()
    .from(category)
    .where(eq(category.name_normalized, normalized))
    .get()

  if (existing) {
    throw duplicateNameError(`分类名称已存在：${trimmed}`)
  }

  // 新分类排在所有现有分类之后
  const all = listCategories()
  const maxSort = all.reduce((acc, c) => Math.max(acc, c.sort_order), 0)

  const timestamp = nowIso()

  return db
    .insert(category)
    .values({
      name: trimmed,
      name_normalized: normalized,
      sort_order: maxSort + 1,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returning()
    .get()
}

/** 统计某分类下的食材定义数量 */
export function countDefinitionsInCategory(categoryId: number): number {
  return db
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.category_id, categoryId))
    .all().length
}

/**
 * 删除分类。
 *
 * 规则：
 *   - 仍有 ingredient_definition 引用 → 409 CATEGORY_IN_USE（**不做任何改动**）
 *   - 无引用 → 允许删除
 *
 * ⚠️ 绝不级联删除食材、绝不自动移动食材、绝不把 category_id 置 NULL。
 *
 * @throws ServiceError DEFINITION_NOT_FOUND / HAS_STOCK 语义由 caller 区分；
 *                      此处抛 notFoundError / categoryInUseError
 */
export function deleteCategory(id: number): void {
  getCategoryById(id)

  const inUse = countDefinitionsInCategory(id)
  if (inUse > 0) {
    throw categoryInUseError(
      `该分类下还有 ${inUse} 个食材，请先将这些食材移动到其他分类。`,
    )
  }

  db.delete(category).where(eq(category.id, id)).run()
}

/**
 * 判断某个分类 id 是否为「调味品」。
 *
 * ⚠️ 调味品特殊行为**只依据分类名**判断，不引入 type 字段。
 */
export function isSeasoningCategory(categoryId: number | null | undefined): boolean {
  if (categoryId === null || categoryId === undefined) {
    return false
  }
  const found = db.select().from(category).where(eq(category.id, categoryId)).get()
  return found?.name_normalized === normalizeName(SEASONING_CATEGORY_NAME)
}

/**
 * 判断某个 definition 是否为调味品。
 *
 * 供库存 Service 与 Route 复用。
 */
export function isSeasoningDefinition(definitionId: number): boolean {
  const def = db
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.id, definitionId))
    .get()

  if (!def) {
    return false
  }

  return isSeasoningCategory(def.category_id)
}
