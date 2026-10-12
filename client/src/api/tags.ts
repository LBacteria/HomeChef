import { request } from './definitions'
import type { RecipeTagItem } from '../types/api'

/**
 * 菜谱 Tag API（v0.2.0 Phase 3）。
 *
 * ⚠️ 复用公共请求封装 `request<T>()`，不重复实现 fetch / 错误解析。
 */

/** 列出全部 Tag（按 id 升序） */
export function listTags(): Promise<RecipeTagItem[]> {
  return request<RecipeTagItem[]>('/tags')
}

/**
 * 新建 Tag。
 *
 * ⚠️ 同名 Tag 后端返回 409 DUPLICATE_NAME。
 * ⚠️ 统一保存菜谱时后端也会**自动创建**不存在的 Tag，
 *    因此本接口主要用于「提前单独创建 Tag」的场景。
 *
 * @returns 新 Tag 的 id
 */
export function createTag(name: string): Promise<{ id: number }> {
  return request<{ id: number }>('/tags', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/**
 * 删除 Tag。
 *
 * ⚠️ 只删除 Tag 及其菜谱关联，**保留菜谱本身**。
 * ⚠️ 删除后，列表设置里残留的该 Tag 名称将不再命中任何菜谱
 *    （前端需在加载设置时过滤掉已不存在的 Tag 名称）。
 */
export function deleteTag(id: number): Promise<void> {
  return request<void>(`/tags/${id}`, { method: 'DELETE' })
}
