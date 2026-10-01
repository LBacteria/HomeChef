/**
 * Service 层业务错误。
 *
 * 按 DATABASE_DESIGN.md 第 9.4 节的错误码命名，
 * 但**不在本阶段设计 Fastify HTTP error handler**——
 * 这里只是 Service 层可区分的业务错误，将来接 API 时再映射到 HTTP 状态码。
 *
 * 设计原则（本阶段）：简单、可区分、不提前做复杂错误体系。
 */

/** 业务错误码（对应 DATABASE_DESIGN.md 第 9.4 节） */
export type ServiceErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_DATE_RANGE'
  | 'INGREDIENT_NOT_FOUND'
  | 'INGREDIENT_EXISTS'
  | 'DUPLICATE_NAME'
  | 'INSUFFICIENT_STOCK'

/**
 * Service 业务错误。
 *
 * 所有 Service 层可预期的失败都抛出这个类型，
 * 调用方可以通过 code 区分具体原因。
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode

  constructor(code: ServiceErrorCode, message: string) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

/** 输入不合法（字段缺失、类型错误、数量非法、单位非法等） */
export function validationError(message: string): ServiceError {
  return new ServiceError('VALIDATION_ERROR', message)
}

/** 过期日期早于购买日期 */
export function invalidDateRangeError(message: string): ServiceError {
  return new ServiceError('INVALID_DATE_RANGE', message)
}

/** 食材不存在 */
export function notFoundError(message: string): ServiceError {
  return new ServiceError('INGREDIENT_NOT_FOUND', message)
}

/** 该食材已存在（按 name_normalized 判断） */
export function alreadyExistsError(message: string): ServiceError {
  return new ServiceError('INGREDIENT_EXISTS', message)
}

/** 库存不足（DATABASE_DESIGN.md 第 9.4 节，HTTP 409） */
export function insufficientStockError(message: string): ServiceError {
  return new ServiceError('INSUFFICIENT_STOCK', message)
}

/**
 * 名称重复（DATABASE_DESIGN.md 第 9.4 节，HTTP 409）。
 *
 * 用于**跨表**重名冲突：
 * 一个 normalized 字符串不能同时作为标准名和别名存在（第 6.5 / 6.6 节）。
 */
export function duplicateNameError(message: string): ServiceError {
  return new ServiceError('DUPLICATE_NAME', message)
}
