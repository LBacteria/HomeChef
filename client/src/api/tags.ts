import { request } from './definitions'
import type {
  CreateTagInput,
  RecipeTagCategoryCode,
  RecipeTagItem,
  TagCategoryDict,
  UpdateTagInput,
} from '../types/api'

/**
 * 菜谱 Tag API（v0.2.0 Phase 3；v0.2.3 增补分类、改名与字典）。
 *
 * ⚠️ 复用公共请求封装 `request<T>()`，不重复实现 fetch / 错误解析。
 * ⚠️ **分类字典必须来自后端**（`getTagCategories`），前端不另写中文字典。
 */

/** 列出全部 Tag（按 id 升序；含分类 / 是否系统预设 / 关联菜谱数） */
export function listTags(): Promise<RecipeTagItem[]> {
  return request<RecipeTagItem[]>('/tags')
}

/**
 * 五大分类字典（code + 后端中文别名 + 未分类标题）。
 *
 * ⚠️ 界面渲染分类分组**只认这份字典**，避免与后端漂移。
 */
export function getTagCategories(): Promise<TagCategoryDict> {
  return request<TagCategoryDict>('/tag-categories')
}

/**
 * 新建 Tag。
 *
 * ⚠️ 同名 Tag 后端返回 409 DUPLICATE_NAME（名称跨分类全局唯一）。
 * ⚠️ 统一保存菜谱时后端也会**自动创建**不存在的 Tag，
 *    因此本接口主要用于「提前单独创建」。
 *
 * @returns 新 Tag 的 id
 */
export function createTag(
  name: string,
  category?: RecipeTagCategoryCode | null,
): Promise<{ id: number }> {
  const body: CreateTagInput = { name }
  if (category !== undefined) body.category = category
  return request<{ id: number }>('/tags', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * 修改 Tag（重命名 / 改分类，部分更新）。
 *
 * ⚠️ 系统预设与自定义 Tag **同等可改**。
 * ⚠️ 菜谱关联按 tag_id 保存，改名**不会**断开关联；但已保存的
 *    「筛选条件」存的是**名称**，改名后调用方必须同步筛选状态。
 */
export function updateTag(id: number, input: UpdateTagInput): Promise<void> {
  return request<void>(`/tags/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

/**
 * 删除 Tag。
 *
 * ⚠️ 只删除 Tag 及其菜谱关联，**保留菜谱本身**。
 * ⚠️ 删除后，列表设置里残留的该 Tag 名称将不再命中任何菜谱，
 *    调用方必须同步清理筛选状态，否则会得到空列表。
 */
export function deleteTag(id: number): Promise<void> {
  return request<void>(`/tags/${id}`, { method: 'DELETE' })
}
