import type { ServiceError, ServiceErrorCode } from '../services/errors.js'

/**
 * HTTP 层共用工具：错误映射与 ID 解析。
 *
 * 这里只做 HTTP 与 Service 之间的"翻译"，
 * 不包含任何业务规则（业务规则全部在 Service 层）。
 */

/**
 * ServiceError 错误码 → HTTP 状态码。
 *
 * 对应 DATABASE_DESIGN.md 第 9.4 节与 ARCHITECTURE.md 第 9 节的错误码表。
 */
const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  VALIDATION_ERROR: 400,
  INVALID_DATE_RANGE: 400,
  INGREDIENT_NOT_FOUND: 404,
  INGREDIENT_EXISTS: 409,
  DUPLICATE_NAME: 409,
  INSUFFICIENT_STOCK: 409,
  DEFINITION_NOT_FOUND: 404,
  HAS_STOCK: 409,
  UNIT_IN_USE: 409,
  UNIT_NOT_ALLOWED: 400,
  CATEGORY_IN_USE: 409,
  CATEGORY_TRANSITION_NOT_ALLOWED: 409,
  // v0.2.0 Phase 3 菜谱模块
  RECIPE_NOT_FOUND: 404,
  TAG_NOT_FOUND: 404,
  HAS_RECIPE: 409,
  // v0.2.1 烹饪闭环
  SESSION_NOT_FOUND: 404,
  SESSION_STATE_INVALID: 409,
  DISH_NOT_FOUND: 404,
  REVISION_STALE: 409,
}

/** 统一错误响应体（ARCHITECTURE.md 第 9.2 节） */
export interface ErrorResponseBody {
  error: {
    code: string
    message: string
  }
}

/** 把 ServiceError 映射为 HTTP 状态码；未知错误 → 500 */
export function statusForServiceError(error: ServiceError): number {
  return STATUS_BY_CODE[error.code] ?? 500
}

/** 构造统一错误响应体 */
export function errorBody(code: string, message: string): ErrorResponseBody {
  return { error: { code, message } }
}

/**
 * 解析路径参数中的 ID。
 *
 * 要求：必须是正整数。
 * - 非数字、小数、负数、0、超范围 → 返回 null（由调用方返回 400）
 *
 * 这样非法 ID 不会进入数据库查询。
 *
 * @returns 合法则返回正整数，否则返回 null
 */
export function parsePositiveIntId(raw: string): number | null {
  // 只接受纯数字字符串，避免 '1.5'、'1e3'、' 1 '、'+1' 等被 Number() 宽松接受
  if (!/^\d+$/.test(raw)) {
    return null
  }

  const value = Number(raw)

  if (!Number.isSafeInteger(value) || value <= 0) {
    return null
  }

  return value
}
