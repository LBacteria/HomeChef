import type { IngredientDefinition } from '../db/schema.js'

/**
 * 食材库排序 Service（v0.1.2 Batch 3）。
 *
 * 只支持**名称排序**两个方向：
 *   A → Z （asc）
 *   Z → A （desc）
 *
 * 排序主键：`ingredient_definition.name`
 * 稳定 tie-breaker：`id` ASC（名称完全相同时）
 *
 * ⚠️ 与**库存排序**（stockSortService）是两个独立功能：
 *    本文件只处理 ingredient_definition 的查询展示顺序，
 *    不涉及库存、不涉及临期、不涉及自动合并。
 *
 * ⚠️ 别名（alias）**不参与**排序。
 */

/** 允许的排序字段（白名单）—— 本批次只有 name */
export const DEFINITION_SORT_FIELDS = ['name'] as const

export type DefinitionSortField = (typeof DEFINITION_SORT_FIELDS)[number]

/** 允许的排序方向（白名单） */
export const DEFINITION_SORT_ORDERS = ['asc', 'desc'] as const

export type DefinitionSortOrder = (typeof DEFINITION_SORT_ORDERS)[number]

/** 默认排序：名称 A → Z */
export const DEFAULT_DEFINITION_SORT: DefinitionSortField = 'name'
export const DEFAULT_DEFINITION_ORDER: DefinitionSortOrder = 'asc'

/**
 * 名称比较。
 *
 * 使用 localeCompare 并指定中文与数字感知：
 *   - 中文按 Unicode 码点顺序（不引入拼音库）
 *   - numeric: true 让「2」排在「10」前面（对含数字的名称更自然）
 *
 * 与库存排序的 compareName 保持一致的比较语义，
 * 但**不共享代码** —— 两者是独立功能，避免耦合。
 */
function compareDefinitionName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

/**
 * 按名称排序（不改动入参）。
 *
 * @param items 定义列表（来自 listDefinitions / searchDefinitions）
 * @param order asc = A→Z，desc = Z→A
 * @returns 排序后的新数组
 */
export function sortDefinitions(
  items: IngredientDefinition[],
  order: DefinitionSortOrder,
): IngredientDefinition[] {
  const sorted = [...items]

  sorted.sort((a, b) => {
    const cmp = compareDefinitionName(a.name, b.name)
    if (cmp !== 0) {
      return order === 'asc' ? cmp : -cmp
    }
    // 名称完全相同时，按 id ASC 稳定排序
    return a.id - b.id
  })

  return sorted
}

/** 校验排序字段是否在白名单内 */
export function isValidDefinitionSortField(value: unknown): value is DefinitionSortField {
  return typeof value === 'string' && (DEFINITION_SORT_FIELDS as readonly string[]).includes(value)
}

/** 校验排序方向是否在白名单内 */
export function isValidDefinitionSortOrder(value: unknown): value is DefinitionSortOrder {
  return typeof value === 'string' && (DEFINITION_SORT_ORDERS as readonly string[]).includes(value)
}
