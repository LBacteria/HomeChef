/**
 * Service 层业务错误。
 *
 * 按 DATABASE_DESIGN.md 第 9.4 节的错误码命名，
 * 但**不在本阶段设计 Fastify HTTP error handler**——
 * 这里只是 Service 层可区分的业务错误，将来接 API 时再映射到 HTTP 状态码。
 *
 * 设计原则（本阶段）：简单、可区分、不提前做复杂错误体系。
 */

/** 业务错误码 */
export type ServiceErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_DATE_RANGE'
  | 'INGREDIENT_NOT_FOUND'
  | 'INGREDIENT_EXISTS'
  | 'DUPLICATE_NAME'
  | 'INSUFFICIENT_STOCK'
  | 'DEFINITION_NOT_FOUND'
  | 'HAS_STOCK'
  | 'UNIT_IN_USE'
  | 'UNIT_NOT_ALLOWED'
  | 'CATEGORY_IN_USE'
  | 'CATEGORY_TRANSITION_NOT_ALLOWED'

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

/** 食材定义不存在 */
export function definitionNotFoundError(message: string): ServiceError {
  return new ServiceError('DEFINITION_NOT_FOUND', message)
}

/**
 * 定义仍被库存引用，无法删除（HTTP 409）。
 *
 * 规则：只要 definition 下还有**任何**库存记录，就拒绝删除。
 * 绝不级联删除库存。
 */
export function hasStockError(message: string): ServiceError {
  return new ServiceError('HAS_STOCK', message)
}

/**
 * 允许单位正被库存使用，无法移除（HTTP 409）。
 */
export function unitInUseError(message: string): ServiceError {
  return new ServiceError('UNIT_IN_USE', message)
}

/**
 * 库存单位不在该 definition 的允许单位内（HTTP 400）。
 */
export function unitNotAllowedError(message: string): ServiceError {
  return new ServiceError('UNIT_NOT_ALLOWED', message)
}

/**
 * 分类仍被 ingredient_definition 引用，无法删除（HTTP 409）。
 *
 * 规则：只要还有**任何** definition 使用该分类，就拒绝删除。
 * 绝不级联删除食材、绝不自动移动食材、绝不把 category_id 置 NULL。
 */
export function categoryInUseError(message: string): ServiceError {
  return new ServiceError('CATEGORY_IN_USE', message)
}

/**
 * 库存不允许在「调味品」与「普通食材」之间跨类切换（HTTP 409）。
 *
 * 规则（v0.1.3 正式确定）：
 *   普通食材 → 普通食材   ✅
 *   调味品   → 调味品     ✅
 *   普通食材 → 调味品     ❌
 *   调味品   → 普通食材   ❌
 *
 * 原因：
 *   - 普通食材库存有真实 quantity / unit / dates / storage_method 语义
 *   - 调味品库存使用 B2 sentinel，业务语义是"有 / 无"
 *   - 不允许通过修改 definition_id 静默重写真实库存数据
 *   - 不允许让普通库存数量变成 sentinel，也不允许 sentinel 继承真实数量
 *
 * 失败必须是**完全原子性的 no-op**（不改任何字段，含 updated_at）。
 */
export function categoryTransitionNotAllowedError(message: string): ServiceError {
  return new ServiceError('CATEGORY_TRANSITION_NOT_ALLOWED', message)
}
