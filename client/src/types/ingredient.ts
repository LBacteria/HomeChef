/**
 * 与后端 API 对应的类型定义。
 *
 * 对应 server/src/db/schema.ts 的 standard_ingredient，
 * 以及 server/src/routes/ingredients.ts 的请求 schema。
 */

/** 单位固定枚举（对应后端 UNITS 与 CHECK 约束） */
export const UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const

export type Unit = (typeof UNITS)[number]

/** 标准食材（后端返回的完整记录） */
export interface Ingredient {
  id: number
  /** 显示用名称，保留用户输入形式 */
  name: string
  /** 归一化名称（后端生成，前端只读） */
  name_normalized: string
  /** 当前库存数量（REAL） */
  quantity: number
  unit: string
  /** YYYY-MM-DD，可为 null */
  purchase_date: string | null
  /** YYYY-MM-DD，可为 null */
  expiry_date: string | null
  note: string | null
  /** ISO 8601 时间戳 */
  created_at: string
  updated_at: string
}

/** 创建食材的请求体 */
export interface CreateIngredientInput {
  name: string
  quantity?: number
  unit: string
  purchase_date?: string | null
  expiry_date?: string | null
  note?: string | null
}

/**
 * 更新食材的请求体（所有字段可选）。
 *
 * 注意：后端 PATCH 使用 additionalProperties: false，
 * 只能发送已在 schema 中定义的字段；未发送的字段保持原值。
 */
export interface UpdateIngredientInput {
  name?: string
  quantity?: number
  unit?: string
  purchase_date?: string | null
  expiry_date?: string | null
  note?: string | null
}

/** 消耗食材的请求体 */
export interface ConsumeIngredientInput {
  amount: number
}

/** 后端统一错误响应体 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

/**
 * 前端使用的 API 错误对象。
 *
 * 保留后端返回的 code 与 message，便于针对性处理
 * （例如 INSUFFICIENT_STOCK 显示"库存不足，无法消耗。"）。
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}
