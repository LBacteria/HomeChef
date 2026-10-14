import { request } from './definitions'
import type {
  CookingSessionDetail,
  CookingSessionSummary,
  CookingSkipRecord,
  SettlementPreview,
  SettlementResult,
  SkipConfirmationInput,
} from '../types/api'

/**
 * 烹饪会话 API（v0.2.1 B4）。
 *
 * ⚠️ 复用公共请求封装 `request<T>()`，不重复实现 fetch / 错误解析。
 * ⚠️ 后端**是全部业务规则的唯一权威**：
 *    - 状态流转、确认完整性、库存扣减全部由后端判定
 *    - 前端不缓存权威状态，不做本地模拟
 */

/* ============================================================
 * 会话
 * ============================================================ */

/** 列出全部烹饪会话 */
export function listSessions(): Promise<CookingSessionSummary[]> {
  return request<CookingSessionSummary[]>('/cooking/sessions')
}

/** 创建烹饪会话（后端置为 active） */
export function createSession(): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>('/cooking/sessions', {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/** 会话详情（含菜品行） */
export function getSession(id: number): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(`/cooking/sessions/${id}`)
}

/** 放弃会话（终态，不扣库存） */
export function abandonSession(id: number): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(`/cooking/sessions/${id}/abandon`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}

/* ============================================================
 * 菜品
 * ============================================================ */

/**
 * 添加菜品。
 *
 * ⚠️ 重复添加同一菜谱时后端会**合并份数**（不新增行），
 *    前端无需自行判断，直接调用即可。
 */
export function addDish(
  sessionId: number,
  recipeId: number,
  servings: number,
): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(`/cooking/sessions/${sessionId}/dishes`, {
    method: 'POST',
    body: JSON.stringify({ recipe_id: recipeId, servings }),
  })
}

/** 修改份数（后端会使该会话既有跳过确认失效） */
export function updateDishServings(
  sessionId: number,
  dishId: number,
  servings: number,
): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(
    `/cooking/sessions/${sessionId}/dishes/${dishId}/servings`,
    { method: 'PATCH', body: JSON.stringify({ servings }) },
  )
}

/**
 * 更新菜品进度。
 *
 * ⚠️ 两个参数均可选，但**至少要传一个**（后端要求 minProperties: 1）。
 *    `current_step_no` 传 `null` 表示重置为未开始。
 */
export function updateDishProgress(
  sessionId: number,
  dishId: number,
  patch: { status?: 'pending' | 'done'; current_step_no?: number | null },
): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(
    `/cooking/sessions/${sessionId}/dishes/${dishId}/progress`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  )
}

/** 移除菜品 */
export function removeDish(sessionId: number, dishId: number): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(`/cooking/sessions/${sessionId}/dishes/${dishId}`, {
    method: 'DELETE',
  })
}

/* ============================================================
 * 跳过确认
 * ============================================================ */

/** 列出该会话的跳过确认 */
export function listSkips(sessionId: number): Promise<CookingSkipRecord[]> {
  return request<CookingSkipRecord[]>(`/cooking/sessions/${sessionId}/skips`)
}

/**
 * 保存跳过确认（后端幂等 upsert，并**重算** confirmed_revision）。
 *
 * ⚠️ 前端**不得**自行认定确认已完成 —— 一律以后端返回的
 *    会话详情中的 `confirmed` / `confirmed_revision` 为准。
 */
export function saveSkips(
  sessionId: number,
  confirmations: SkipConfirmationInput[],
): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(`/cooking/sessions/${sessionId}/skips`, {
    method: 'POST',
    body: JSON.stringify({ confirmations }),
  })
}

/** 删除一条跳过确认（后端会重算） */
export function deleteSkip(
  sessionId: number,
  dishId: number,
  lineKey: string,
): Promise<CookingSessionDetail> {
  return request<CookingSessionDetail>(
    `/cooking/sessions/${sessionId}/dishes/${dishId}/skips/${encodeURIComponent(lineKey)}`,
    { method: 'DELETE' },
  )
}

/* ============================================================
 * 结算
 * ============================================================ */

/**
 * 结算预览（**只读**）。
 *
 * ⚠️ 后端基于**当前库存**重新计算，因此预览结果即真实判定，
 *    前端不自行推导 `can_consume` / `required_reason`。
 */
export function previewSettlement(sessionId: number): Promise<SettlementPreview> {
  return request<SettlementPreview>(`/cooking/sessions/${sessionId}/settle/preview`)
}

/**
 * **执行结算**（扣减库存 + 写入凭证，后端单事务）。
 *
 * ⚠️ 不得自动重试 —— 必须由用户明确点击触发。
 * ⚠️ 后端对重复结算返回 409，前端如实展示即可。
 */
export function settleSession(sessionId: number): Promise<SettlementResult> {
  return request<SettlementResult>(`/cooking/sessions/${sessionId}/settle`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}
