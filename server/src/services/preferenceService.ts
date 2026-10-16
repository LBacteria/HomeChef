/**
 * v0.2.3 单菜偏好（点赞 / 点踩）—— Service 层。
 *
 * 规则：
 *   - **只针对单道菜谱**，不支持整餐评价；
 *   - 取值只有 `like` / `dislike`；**取消偏好 = 删除该行**（不留占位记录）；
 *   - 影响**推荐软评分**（点赞软加权、点踩软降权），**绝不排除**任何菜谱；
 *   - **不改变**菜谱列表的排序（列表排序仍由既有设置决定）。
 *
 * ⚠️ 本模块只读写 `recipe_preference`，不触碰库存与烹饪数据。
 */

import { asc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { RECIPE_PREFERENCE_VALUES, recipe, recipePreference } from '../db/schema.js'
import type { RecipePreferenceValue } from '../db/schema.js'
import { recipeNotFoundError, validationError } from './errors.js'

/** 一条偏好记录 */
export interface RecipePreferenceItem {
  recipe_id: number
  value: RecipePreferenceValue
  created_at: string
  updated_at: string
}

/**
 * 列出全部偏好（按 recipe_id 升序）。
 *
 * 供推荐与前端一次性取回，避免逐菜谱查询。
 */
export function listPreferences(): RecipePreferenceItem[] {
  return db
    .select({
      recipe_id: recipePreference.recipe_id,
      value: recipePreference.value,
      created_at: recipePreference.created_at,
      updated_at: recipePreference.updated_at,
    })
    .from(recipePreference)
    .orderBy(asc(recipePreference.recipe_id))
    .all() as RecipePreferenceItem[]
}

/** recipe_id → 偏好（推荐打分用） */
export function getPreferenceMap(): Map<number, RecipePreferenceValue> {
  const map = new Map<number, RecipePreferenceValue>()
  for (const row of listPreferences()) map.set(row.recipe_id, row.value)
  return map
}

/** 校验偏好取值：'like' / 'dislike' / null（null = 取消） */
function assertPreferenceValue(raw: unknown): RecipePreferenceValue | null {
  if (raw === null) return null
  if (typeof raw !== 'string' || !(RECIPE_PREFERENCE_VALUES as readonly string[]).includes(raw)) {
    throw validationError(
      `偏好取值不合法：${String(raw)}。允许：${RECIPE_PREFERENCE_VALUES.join('、')} 或 null（取消）`,
    )
  }
  return raw as RecipePreferenceValue
}

/**
 * 设置 / 取消单道菜谱的偏好。
 *
 * - `value = 'like' | 'dislike'` → 写入（已存在则更新，同一菜谱始终最多一行）
 * - `value = null`               → **删除该行**（取消偏好）
 *
 * @returns 更新后的记录；取消时返回 `null`
 * @throws ServiceError VALIDATION_ERROR / RECIPE_NOT_FOUND
 */
export function setPreference(recipeId: number, value: unknown): RecipePreferenceItem | null {
  const exists = db.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, recipeId)).get()
  if (!exists) {
    throw recipeNotFoundError(`菜谱不存在：id=${recipeId}`)
  }

  const safeValue = assertPreferenceValue(value)

  if (safeValue === null) {
    db.delete(recipePreference).where(eq(recipePreference.recipe_id, recipeId)).run()
    return null
  }

  const now = new Date().toISOString()
  db.insert(recipePreference)
    .values({ recipe_id: recipeId, value: safeValue, created_at: now, updated_at: now })
    .onConflictDoUpdate({
      target: recipePreference.recipe_id,
      set: { value: safeValue, updated_at: now },
    })
    .run()

  const row = db
    .select({
      recipe_id: recipePreference.recipe_id,
      value: recipePreference.value,
      created_at: recipePreference.created_at,
      updated_at: recipePreference.updated_at,
    })
    .from(recipePreference)
    .where(eq(recipePreference.recipe_id, recipeId))
    .get()

  return (row as RecipePreferenceItem | undefined) ?? null
}
