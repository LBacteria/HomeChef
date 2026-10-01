import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { ServiceError } from '../services/errors.js'
import { errorBody, statusForServiceError } from './http.js'

/**
 * 统一错误出口（ARCHITECTURE.md 第 9.2 / 9.3 节）。
 *
 * 把所有异常转换成一致的错误格式：
 *
 *   { "error": { "code": "...", "message": "..." } }
 *
 * 映射规则：
 * - ServiceError → 按 code 映射的 4xx
 * - Fastify 的 schema 校验失败 → 400 VALIDATION_ERROR
 * - 其他未捕获异常 → 500 INTERNAL_ERROR（并记录日志）
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
      // 1. Service 业务错误 → 4xx
      if (error instanceof ServiceError) {
        return reply.code(statusForServiceError(error)).send(errorBody(error.code, error.message))
      }

      // 2. Fastify 请求校验失败（schema 不匹配、JSON 解析失败等）→ 400
      if (error.validation || error.statusCode === 400) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', error.message || '请求格式不正确'))
      }

      // 3. 其余未预期错误 → 500
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
