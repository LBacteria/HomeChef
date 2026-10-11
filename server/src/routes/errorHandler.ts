import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ServiceError } from '../services/errors.js'
import { errorBody, statusForServiceError } from './http.js'

/**
 * SQLite 约束错误的细分 code（better-sqlite3 的 SqliteError.code）。
 *
 * ⚠️ 这里的每个分支返回**不同的错误码与状态**，不做统一映射 ——
 *    唯一约束是"数据重复"，外键约束是"存在关联"，CHECK 是"输入不合法"，
 *    语义完全不同，混为一谈会把用户引向错误的修复方向。
 */
const SQLITE_UNIQUE = 'SQLITE_CONSTRAINT_UNIQUE'
const SQLITE_PRIMARYKEY = 'SQLITE_CONSTRAINT_PRIMARYKEY'
const SQLITE_FOREIGNKEY = 'SQLITE_CONSTRAINT_FOREIGNKEY'
const SQLITE_CHECK = 'SQLITE_CONSTRAINT_CHECK'
const SQLITE_NOTNULL = 'SQLITE_CONSTRAINT_NOTNULL'

/**
 * 统一错误出口（ARCHITECTURE.md 第 9.2 / 9.3 节）。
 *
 * 把所有异常转换成一致的错误格式：
 *
 *   { "error": { "code": "...", "message": "..." } }
 *
 * 映射规则（**按顺序**判断）：
 * 1. ServiceError → 按 code 映射的 4xx（业务规则优先）
 * 2. SQLite 唯一/主键约束 → 409 DUPLICATE_NAME
 * 3. SQLite 外键约束 → 409 CONSTRAINT_VIOLATION
 * 4. SQLite CHECK / NOT NULL → 400 VALIDATION_ERROR
 * 5. Fastify schema 校验失败 → 400 VALIDATION_ERROR
 * 6. 其余未预期错误 → 500 INTERNAL_ERROR（并记录日志）
 *
 * ⚠️ 第 2~4 条是**兜底**：正常情况下业务规则（Service 层）会先行拦截，
 *    但若预检与写入之间数据被改变（TOCTOU 竞态），或将来引入异步 DB，
 *    约束冲突就会直接抵达这里 —— 此时必须返回明确的 4xx，
 *    而不是 500，否则用户看到的是"服务器内部错误"，无从修复。
 *
 * ⚠️ 对外消息**不包含**数据库内部细节（表名、列名、SQL），避免信息泄露。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      // 1. Service 业务错误 → 4xx（优先级最高，保留既有全部行为）
      if (error instanceof ServiceError) {
        return reply.code(statusForServiceError(error)).send(errorBody(error.code, error.message))
      }

      // 2~4. SQLite 约束错误 → 按语义细分
      const sqliteCode = (error as { code?: unknown }).code
      if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_CONSTRAINT')) {
        // 记录原始错误便于排查（仅服务端日志，不外泄给客户端）
        request.log.error(error)

        if (sqliteCode === SQLITE_UNIQUE || sqliteCode === SQLITE_PRIMARYKEY) {
          return reply
            .code(409)
            .send(errorBody('DUPLICATE_NAME', '该名称或数据已存在，请检查是否重复'))
        }

        if (sqliteCode === SQLITE_FOREIGNKEY) {
          return reply
            .code(409)
            .send(errorBody('CONSTRAINT_VIOLATION', '该数据仍被其他记录引用，或引用了不存在的记录，操作被拒绝'))
        }

        if (sqliteCode === SQLITE_CHECK || sqliteCode === SQLITE_NOTNULL) {
          return reply
            .code(400)
            .send(errorBody('VALIDATION_ERROR', '提交的数据不符合字段要求，请检查后重试'))
        }

        // 其他 SQLITE_CONSTRAINT_*（如 TRIGGER / DATATYPE）→ 保守按 409 处理
        return reply
          .code(409)
          .send(errorBody('CONSTRAINT_VIOLATION', '操作违反了数据完整性约束'))
      }

      // 5. Fastify 请求校验失败（schema 不匹配、JSON 解析失败等）→ 400
      if (error.validation || error.statusCode === 400) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', error.message || '请求格式不正确'))
      }

      // 6. 其余未预期错误 → 500
      request.log.error(error)
      return reply.code(500).send(errorBody('INTERNAL_ERROR', '服务器内部错误'))
    },
  )

  // 未匹配到任何路由 → 404，同样保持统一格式
  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .send(errorBody('NOT_FOUND', `路由不存在：${request.method} ${request.url}`))
  })
}
