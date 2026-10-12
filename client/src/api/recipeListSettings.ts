import { request } from './definitions'
import type {
  RecipeListSettings,
  UpdateRecipeListSettingsInput,
} from '../types/api'

/**
 * 菜谱列表设置 API（v0.2.0 Phase 3）。
 *
 * 设置由**后端持久化**，重新打开应用时恢复。
 *
 * ⚠️ 复用公共请求封装 `request<T>()`，不重复实现 fetch / 错误解析。
 */

/**
 * 读取菜谱列表设置。
 *
 * ⚠️ 后端保证**永不 500**：字段缺失、值非法或 JSON 损坏时回退默认值
 *    （默认：最近修改倒序 + AND + 空 Tag 列表）。
 */
export function getRecipeListSettings(): Promise<RecipeListSettings> {
  return request<RecipeListSettings>('/recipe-list-settings')
}

/**
 * 更新菜谱列表设置（**部分更新**）。
 *
 * ⚠️ 后端 body schema 为 `minProperties: 1` ——
 *    **空对象会返回 400**，因此调用前必须确保至少有一个字段。
 *
 * @throws Error 当 input 不包含任何字段时（前端提前拦截，避免无谓请求）
 */
export function updateRecipeListSettings(
  input: UpdateRecipeListSettingsInput,
): Promise<RecipeListSettings> {
  const hasField =
    input.sort_field !== undefined ||
    input.sort_order !== undefined ||
    input.tag_mode !== undefined ||
    input.selected_tags !== undefined

  if (!hasField) {
    // 提前拦截：后端会用 400 拒绝空 body，这里给出更明确的错误
    return Promise.reject(new Error('列表设置更新至少需要提供一个字段'))
  }

  return request<RecipeListSettings>('/recipe-list-settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}
