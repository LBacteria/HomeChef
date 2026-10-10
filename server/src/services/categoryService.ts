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

/* ============================================================
 * 分类颜色（v0.1.4）
 * ============================================================ */

/** 颜色格式：严格 #RRGGBB（大小写均可） */
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

/** 兜底色：中性灰（既用于旧数据，也用于未命中默认色表的分类） */
export const DEFAULT_CATEGORY_COLOR = '#9E9E9E'

/**
 * 19 个默认分类的颜色。
 *
 * ⚠️ 以 name_normalized 为键（已 trim + toLowerCase）。
 *    未命中的分类（含用户自定义）会走 PALETTE 兜底，
 *    因此**不是**只为少数几个分类实现。
 */
const BUILTIN_COLORS: Record<string, string> = {
  蔬菜: '#4CAF50',      // 绿
  水果: '#FF9800',      // 橙
  猪肉: '#E57373',      // 红
  牛肉: '#D32F2F',      // 深红
  羊肉: '#C62828',      // 深红
  其他畜肉: '#EF5350',  // 红
  鸡肉: '#FFB74D',      // 浅橙
  鸭肉: '#FFA726',      // 橙
  鹅肉: '#FB8C00',      // 深橙
  其他禽肉: '#FFCC80',  // 浅橙
  水产: '#29B6F6',      // 蓝
  蛋类: '#FFD54F',      // 黄
  豆制品: '#AED581',    // 浅绿
  乳制品: '#B39DDB',    // 紫
  '主食/谷物': '#BCAAA4', // 棕
  '干货/菌菇': '#A1887F', // 深棕
  冷冻食品: '#4DD0E1',  // 青
  调味品: '#FFC107',    // 黄（与 v0.1.3 的黄色标签一致）
  '其他/饮品': '#90A4AE', // 蓝灰
}

/** 用户自定义分类的兜底调色板 —— 保证可区分 */
const PALETTE = [
  '#EF5350', '#AB47BC', '#5C6BC0', '#29B6F6',
  '#26A69A', '#66BB6A', '#D4E157', '#FFA726',
  '#8D6E63', '#78909C', '#EC407A', '#7E57C2',
]

/**
 * 取某个分类的默认颜色。
 *
 * 1. 命中内置色表 → 用内置色
 * 2. 未命中 → 按 categoryId 稳定取模分配调色板颜色（同名始终同色）
 */
export function defaultColorFor(name: string, categoryId: number): string {
  const key = normalizeName(name)
  const builtin = BUILTIN_COLORS[key]
  if (builtin !== undefined) {
    return builtin
  }
  // 用 id 做稳定索引，保证同一分类每次得到相同颜色
  const index = Math.abs(categoryId) % PALETTE.length
  return PALETTE[index]
}

/** 校验颜色格式，非法则抛 400 VALIDATION_ERROR */
export function assertValidColor(color: unknown): asserts color is string {
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
    throw validationError(
      `颜色格式不正确：${String(color)}。请使用 #RRGGBB 形式（例如 #4CAF50）`,
    )
  }
}

/**
 * 列出全部分类（按 sort_order，其次 id）。
 *
 * ⚠️ 返回的每个分类都保证有合法 color：
 *    数据库默认值是中性灰，若某行仍是兜底灰且能命中内置色表，
 *    则返回该分类的合理默认色（**只影响返回值，不写库**）。
 */
export function listCategories(): Category[] {
  const rows = db
    .select()
    .from(category)
    .orderBy(asc(category.sort_order), asc(category.id))
    .all()

  return rows.map((row) => ({
    ...row,
    color: row.color === DEFAULT_CATEGORY_COLOR ? defaultColorFor(row.name, row.id) : row.color,
  }))
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

  const created = db
    .insert(category)
    .values({
      name: trimmed,
      name_normalized: normalized,
      sort_order: maxSort + 1,
      // 先落库拿到 id，再据此分配一个稳定的调色板颜色
      color: DEFAULT_CATEGORY_COLOR,
      created_at: timestamp,
      updated_at: timestamp,
    })
    .returning()
    .get()

  // 用真实 id 计算默认色；命中内置色表的名称会得到内置色
  const color = defaultColorFor(created.name, created.id)

  return { ...created, color }
}

/**
 * 更新分类颜色（v0.1.4）。
 *
 * 规则：
 *   - 只改 color，**不动** name / name_normalized / sort_order / created_at
 *   - 因此不影响分类名称、顺序、与食材的关联，也不影响删除等其他操作
 *
 * @throws ServiceError VALIDATION_ERROR（格式非法）
 *                      / DEFINITION_NOT_FOUND 语义的分类不存在 404
 */
export function updateCategoryColor(id: number, color: string): Category {
  getCategoryById(id)
  assertValidColor(color)

  return db
    .update(category)
    .set({ color, updated_at: nowIso() })
    .where(eq(category.id, id))
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
