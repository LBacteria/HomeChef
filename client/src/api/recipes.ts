import { request } from './definitions'
import type {
  RecipeDetail,
  RecipeInput,
  RecipeListQuery,
  RecipePreferenceItem,
  RecipePreferenceState,
  RecipePreferenceValue,
  RecipeSummary,
} from '../types/api'

/**
 * 菜谱 API（v0.2.0 Phase 3）。
 *
 * ⚠️ 复用公共请求封装 `request<T>()`（见 api/definitions.ts），
 *    不重复实现 fetch / 错误解析。
 *
 * ⚠️ 后端查询参数使用 `additionalProperties: false`，
 *    **不得发送任何未定义的参数**，否则返回 400。
 */

/**
 * 构造列表查询字符串。
 *
 * 规则：
 *   - 只发送**有值**的参数（空字符串 / 空数组 / undefined 一律不发）
 *   - `tags` 用**重复参数**（`tags=a&tags=b`），**绝不拼逗号** ——
 *     因为 Tag 名称本身可能包含逗号
 *   - 参数顺序固定，便于阅读与缓存
 */
export function buildRecipeListQuery(query: RecipeListQuery = {}): string {
  const params = new URLSearchParams()

  const search = query.search?.trim()
  if (search) {
    params.append('search', search)
  }

  for (const tag of query.tags ?? []) {
    const trimmed = tag.trim()
    if (trimmed) {
      // ⚠️ 重复参数，不是逗号分隔
      params.append('tags', trimmed)
    }
  }

  if (query.tagMode) {
    params.append('tag_mode', query.tagMode)
  }
  if (query.sortField) {
    params.append('sort', query.sortField)
  }
  if (query.sortOrder) {
    params.append('order', query.sortOrder)
  }

  const qs = params.toString()
  return qs.length > 0 ? `?${qs}` : ''
}

/**
 * 列出菜谱（支持搜索 / Tag 筛选 / 排序）。
 *
 * ⚠️ 搜索、筛选、排序**全部由后端执行**，前端不做任何本地过滤。
 */
export function listRecipes(query: RecipeListQuery = {}): Promise<RecipeSummary[]> {
  return request<RecipeSummary[]>(`/recipes${buildRecipeListQuery(query)}`)
}

/** 菜谱详情（含食材明细与 Tag） */
export function getRecipe(id: number): Promise<RecipeDetail> {
  return request<RecipeDetail>(`/recipes/${id}`)
}

/**
 * 新建菜谱（含食材与 Tag，后端单事务）。
 *
 * ⚠️ 后端的 `tags` 会自动创建不存在的 Tag、复用已存在的。
 *
 * @returns 新建菜谱的完整详情
 */
export function createRecipe(input: RecipeInput): Promise<RecipeDetail> {
  return request<RecipeDetail>('/recipes', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/**
 * **统一保存**菜谱：基本信息 + 食材关联 + Tag 关联（后端同一事务）。
 *
 * ⚠️ 采用「全删后重建」，因此返回详情中的食材记录 `id` 会变化。
 *
 * @returns 保存后的完整详情
 */
export function saveRecipeFull(id: number, input: RecipeInput): Promise<RecipeDetail> {
  return request<RecipeDetail>(`/recipes/${id}/full`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

/**
 * 删除菜谱。
 *
 * ⚠️ 只删除菜谱及其关联（食材关联、Tag 关联），
 *    **不会删除**任何食材定义，**也不会删除** Tag 本身。
 *
 * @returns 后端返回 204，无响应体
 */
export function deleteRecipe(id: number): Promise<void> {
  return request<void>(`/recipes/${id}`, { method: 'DELETE' })
}

/* ============================================================
 * v0.2.3：单菜偏好（点赞 / 点踩）
 * ============================================================ */

/**
 * 列出全部单菜偏好（按 recipe_id 升序）。
 *
 * ⚠️ 单独接口，**不改变** `GET /api/recipes` 的返回结构与排序。
 */
export function listPreferences(): Promise<RecipePreferenceItem[]> {
  return request<RecipePreferenceItem[]>('/recipe-preferences')
}

/**
 * 设置 / 取消单道菜谱的偏好。
 *
 * @param value `'like' | 'dislike'` 写入；**`null` = 取消**（后端删除该行）
 *
 * ⚠️ 只影响**推荐软评分**（点赞软加权、点踩软降权），**绝不排除**菜谱。
 * ⚠️ 后端返回的是**实际落库结果**：调用方必须以它为准更新界面，
 *    不得「先改按钮、失败后再装作没发生过」。
 */
export function setPreference(
  recipeId: number,
  value: RecipePreferenceValue | null,
): Promise<RecipePreferenceState> {
  return request<RecipePreferenceState>(`/recipes/${recipeId}/preference`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  })
}
