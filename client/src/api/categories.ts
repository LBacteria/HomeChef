import type { Category } from '../types/api'
import { request } from './definitions'

/**
 * 食材分类 API（v0.1.3）。
 *
 * ⚠️ 只有一套分类数据源：食材库与库存页共用这些接口。
 */

/** 列出全部分类（内置 + 用户自定义，按 sort_order） */
export function listCategories(): Promise<Category[]> {
  return request<Category[]>('/categories')
}

/** 新建分类 */
export function createCategory(name: string): Promise<Category> {
  return request<Category>('/categories', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/**
 * 删除分类。
 *
 * ⚠️ 仍有食材引用时后端返回 409 CATEGORY_IN_USE，前端只显示后端 message。
 */
export function deleteCategory(id: number): Promise<void> {
  return request<void>(`/categories/${id}`, { method: 'DELETE' })
}

/**
 * 更新分类颜色（v0.1.4）。
 *
 * ⚠️ 只改颜色，不影响名称、顺序、与食材的关联。
 *    格式校验由后端负责（非法 #RRGGBB 返回 400）。
 */
export function updateCategoryColor(id: number, color: string): Promise<Category> {
  return request<Category>(`/categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ color }),
  })
}
