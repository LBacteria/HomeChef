import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  RECIPE_SORT_FIELDS,
  RECIPE_SORT_ORDERS,
  RECIPE_TAG_MODES,
  appSettings,
} from '../db/schema.js'
import type { RecipeSortField, RecipeSortOrder, RecipeTagMode } from '../db/schema.js'
import { validationError } from './errors.js'

/**
 * 菜谱列表设置 Service（v0.2.0 Phase 3 —— 批次 3）。
 *
 * 复用现有 `app_settings` 单行表，新增 4 个 **nullable** 列：
 *   recipe_sort_field / recipe_sort_order / recipe_tag_mode / recipe_selected_tags
 *
 * 设计要点：
 *   - **默认值定义在 Service**（与既有 `DEFAULT_APP_SETTINGS` 一致），前端不决定默认值
 *   - 表中列值为 NULL、缺失、或**数据损坏** → 一律回退默认值，**绝不抛错导致 500**
 *   - 写入前做白名单 + JSON 结构校验
 *   - 只读写这 4 个字段，**不触碰**临期设置等其他列
 */

/** 数据库单行 id（与 settingsService 一致） */
const SETTINGS_ROW_ID = 1

/**
 * 菜谱列表设置的默认值。
 *
 * ⚠️ 这是**唯一**的默认值来源。
 */
export const DEFAULT_RECIPE_LIST_SETTINGS: Readonly<RecipeListSettings> = Object.freeze({
  sort_field: 'updated_at' as RecipeSortField,   // 最近修改时间
  sort_order: 'desc' as RecipeSortOrder,         // 倒序
  tag_mode: 'and' as RecipeTagMode,              // AND
  selected_tags: [] as string[],                 // 空数组 = 不做 Tag 筛选
})

/** 应用层的菜谱列表设置表示 */
export interface RecipeListSettings {
  sort_field: RecipeSortField
  sort_order: RecipeSortOrder
  tag_mode: RecipeTagMode
  /** 选中的 Tag 名称列表；空数组表示不按 Tag 筛选 */
  selected_tags: string[]
}

function nowIso(): string {
  return new Date().toISOString()
}

/* ------------------------------------------------------------
 * 容错解析（读取路径）
 * ------------------------------------------------------------ */

/** 排序字段：非法 → 回退默认 */
function safeSortField(raw: unknown): RecipeSortField {
  return typeof raw === 'string' && (RECIPE_SORT_FIELDS as readonly string[]).includes(raw)
    ? (raw as RecipeSortField)
    : DEFAULT_RECIPE_LIST_SETTINGS.sort_field
}

/** 排序方向：非法 → 回退默认 */
function safeSortOrder(raw: unknown): RecipeSortOrder {
  return typeof raw === 'string' && (RECIPE_SORT_ORDERS as readonly string[]).includes(raw)
    ? (raw as RecipeSortOrder)
    : DEFAULT_RECIPE_LIST_SETTINGS.sort_order
}

/** Tag 模式：非法 → 回退默认（AND） */
function safeTagMode(raw: unknown): RecipeTagMode {
  return typeof raw === 'string' && (RECIPE_TAG_MODES as readonly string[]).includes(raw)
    ? (raw as RecipeTagMode)
    : DEFAULT_RECIPE_LIST_SETTINGS.tag_mode
}

/**
 * 解析 `recipe_selected_tags` 的 JSON 字符串。
 *
 * ⚠️ 容错要求（任一情况都**不得抛错**）：
 *    - 值为 NULL / 空串            → []
 *    - JSON 解析失败（数据损坏）    → []
 *    - 解析结果不是数组             → []
 *    - 数组元素含非字符串           → **丢弃该元素**，保留其余合法项
 *    - 元素为空白串                 → 丢弃
 *    - 重复元素                     → 去重（保留首次出现顺序）
 */
function safeSelectedTags(raw: unknown): string[] {
  if (raw === null || raw === undefined) return []
  if (typeof raw !== 'string' || raw.trim().length === 0) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 数据损坏（例如被手工改坏）→ 安全回退，不影响其他设置
    return []
  }

  if (!Array.isArray(parsed)) return []

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/* ------------------------------------------------------------
 * 校验（写入路径）
 * ------------------------------------------------------------ */

/** 校验排序字段（写入时必须显式合法，不退让） */
export function assertSortField(raw: unknown): RecipeSortField {
  if (typeof raw !== 'string' || !(RECIPE_SORT_FIELDS as readonly string[]).includes(raw)) {
    throw validationError(
      `排序字段不合法：${String(raw)}。允许：${RECIPE_SORT_FIELDS.join('、')}`,
    )
  }
  return raw as RecipeSortField
}

/** 校验排序方向 */
export function assertSortOrder(raw: unknown): RecipeSortOrder {
  if (typeof raw !== 'string' || !(RECIPE_SORT_ORDERS as readonly string[]).includes(raw)) {
    throw validationError(
      `排序方向不合法：${String(raw)}。允许：${RECIPE_SORT_ORDERS.join('、')}`,
    )
  }
  return raw as RecipeSortOrder
}

/** 校验 Tag 模式 */
export function assertTagMode(raw: unknown): RecipeTagMode {
  if (typeof raw !== 'string' || !(RECIPE_TAG_MODES as readonly string[]).includes(raw)) {
    throw validationError(
      `Tag 筛选模式不合法：${String(raw)}。允许：${RECIPE_TAG_MODES.join('、')}`,
    )
  }
  return raw as RecipeTagMode
}

/** 校验 selected_tags：必须是字符串数组 */
export function assertSelectedTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw validationError('selected_tags 必须是字符串数组')
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw validationError('selected_tags 中的每一项都必须是字符串')
    }
    const trimmed = item.trim()
    if (trimmed.length === 0) {
      throw validationError('selected_tags 中不能包含空白名称')
    }
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result
}

/* ------------------------------------------------------------
 * 读写
 * ------------------------------------------------------------ */

/**
 * 读取菜谱列表设置。
 *
 * ⚠️ 纯读操作：表为空或行不存在时返回默认值，**不写入数据库**。
 * ⚠️ 任何字段缺失 / 非法 / JSON 损坏 → 该字段回退默认值，**不抛错**。
 */
export function getRecipeListSettings(): RecipeListSettings {
  const row = db
    .select({
      recipe_sort_field: appSettings.recipe_sort_field,
      recipe_sort_order: appSettings.recipe_sort_order,
      recipe_tag_mode: appSettings.recipe_tag_mode,
      recipe_selected_tags: appSettings.recipe_selected_tags,
    })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .get()

  if (!row) {
    // 整行不存在（旧库 / 从未保存过设置）
    return {
      ...DEFAULT_RECIPE_LIST_SETTINGS,
      selected_tags: [],
    }
  }

  return {
    sort_field: safeSortField(row.recipe_sort_field),
    sort_order: safeSortOrder(row.recipe_sort_order),
    tag_mode: safeTagMode(row.recipe_tag_mode),
    selected_tags: safeSelectedTags(row.recipe_selected_tags),
  }
}

/** 部分更新输入 */
export interface RecipeListSettingsInput {
  sort_field?: unknown
  sort_order?: unknown
  tag_mode?: unknown
  selected_tags?: unknown
}

/**
 * 更新菜谱列表设置（部分更新）。
 *
 * ⚠️ 只更新传入的字段；未传入的字段保留当前值（或默认值）。
 * ⚠️ **不触碰** 临期设置等其他列 —— 通过 UPSERT 时补齐既有列实现。
 *
 * @throws ServiceError VALIDATION_ERROR
 */
export function updateRecipeListSettings(
  input: RecipeListSettingsInput,
): RecipeListSettings {
  const current = getRecipeListSettings()

  const next: RecipeListSettings = {
    sort_field: input.sort_field !== undefined ? assertSortField(input.sort_field) : current.sort_field,
    sort_order: input.sort_order !== undefined ? assertSortOrder(input.sort_order) : current.sort_order,
    tag_mode: input.tag_mode !== undefined ? assertTagMode(input.tag_mode) : current.tag_mode,
    selected_tags:
      input.selected_tags !== undefined ? assertSelectedTags(input.selected_tags) : current.selected_tags,
  }

  const timestamp = nowIso()
  const existing = db.select().from(appSettings).where(eq(appSettings.id, SETTINGS_ROW_ID)).get()

  const row = {
    id: SETTINGS_ROW_ID,
    // ⚠️ 复用既有列：行不存在时要给出合法值，否则 NOT NULL 约束会失败
    expiry_warning_mode: existing?.expiry_warning_mode ?? 'days',
    expiry_warning_threshold: existing?.expiry_warning_threshold ?? 3,
    allow_expired_for_recipe: existing?.allow_expired_for_recipe ?? 0,
    recipe_sort_field: next.sort_field,
    recipe_sort_order: next.sort_order,
    recipe_tag_mode: next.tag_mode,
    recipe_selected_tags: JSON.stringify(next.selected_tags),
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  }

  if (existing) {
    db.update(appSettings).set(row).where(eq(appSettings.id, SETTINGS_ROW_ID)).run()
  } else {
    db.insert(appSettings).values(row).run()
  }

  return next
}
