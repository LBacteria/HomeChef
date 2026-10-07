import {
  type ConsumeInventoryInput,
  type CreateInventoryInput,
  type InventoryRecord,
  type SortField,
  type SortOrder,
  type UpdateInventoryInput,
} from '../types/api'
import { request } from './definitions'

/**
 * 库存记录 API。
 *
 * ⚠️ 所有 :id 都是 **inventory record ID**（standard_ingredient.id），
 *    不是 definition ID。
 */

export interface ListInventoryOptions {
  /** 是否包含 0 数量记录（调试用） */
  includeZero?: boolean
  /** 排序字段（后端白名单） */
  sort?: SortField
  /** 排序方向（后端白名单） */
  order?: SortOrder
}

/**
 * 库存列表。
 *
 * 默认由后端隐藏 quantity = 0 的记录。
 *
 * ⚠️ 排序由**后端**执行：仅传参，不在前端重排。
 */
export function listInventory(options: ListInventoryOptions = {}): Promise<InventoryRecord[]> {
  const params = new URLSearchParams()
  if (options.includeZero) params.set('includeZero', 'true')
  if (options.sort) params.set('sort', options.sort)
  if (options.order) params.set('order', options.order)

  const query = params.toString()
  return request<InventoryRecord[]>(`/ingredients${query ? `?${query}` : ''}`)
}

/** 获取单条库存记录（0 数量也能查到） */
export function getInventory(id: number): Promise<InventoryRecord> {
  return request<InventoryRecord>(`/ingredients/${id}`)
}

/**
 * 创建库存记录。
 *
 * ⚠️ 同一 definition 可以创建多条记录，不会因"重复食材"被拒绝。
 * ⚠️ expiry_date 不传时由后端自动估算（estimated）。
 */
export function createInventory(data: CreateInventoryInput): Promise<InventoryRecord> {
  return request<InventoryRecord>('/ingredients', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

/**
 * 更新库存记录。
 *
 * ⚠️ expiry_date 的处理由调用方决定是否出现在 payload 中：
 *   - 传 { expiry_date: null }  → 用户主动清空（后端清空 source，不重算）
 *   - 不传该字段                 → 后端按当前 source 决定是否重算
 *     （例如只改 production_date 时，estimated 会重算、manual 保持）
 */
export function updateInventory(
  id: number,
  data: UpdateInventoryInput,
): Promise<InventoryRecord> {
  return request<InventoryRecord>(`/ingredients/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

/** 删除**库存记录**（不是 definition） */
export function deleteInventory(id: number): Promise<void> {
  return request<void>(`/ingredients/${id}`, { method: 'DELETE' })
}

/**
 * 消耗库存。
 *
 * ⚠️ :id 是具体库存记录 ID。不跨记录寻找、不 FIFO、不换单位。
 *    库存不足时后端返回 409 INSUFFICIENT_STOCK。
 */
export function consumeInventory(
  id: number,
  data: ConsumeInventoryInput,
): Promise<InventoryRecord> {
  return request<InventoryRecord>(`/ingredients/${id}/consume`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}
