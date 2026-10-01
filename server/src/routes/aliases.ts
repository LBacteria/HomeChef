import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  createAlias,
  deleteAlias,
  listAliases,
  updateAlias,
} from '../services/aliasService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 食材别名 API（v0.1）
 *
 * 端点：
 *   GET    /api/ingredients/:id/aliases
 *   POST   /api/ingredients/:id/aliases
 *   PATCH  /api/ingredients/:id/aliases/:aliasId
 *   DELETE /api/ingredients/:id/aliases/:aliasId
 *
 * 职责边界（ARCHITECTURE.md 第 2.2 节）：
 * - 本层只做：解析 params/body、基础格式校验、调用 Service、转 HTTP 响应
 * - 本层**不做**：归一化、跨表唯一性检查 —— 全部由 Service 负责
 */

interface IngredientIdParams {
  id: string
}

interface AliasIdParams {
  id: string
  aliasId: string
}

/**
 * 创建别名请求体。
 *
 * 只做基础格式校验（必须是字符串、非空）。
 * "normalize 后不能为空"（如纯空格）由 Service 判断，
 * 因为那需要归一化逻辑。
 */
const createAliasBodySchema = {
  type: 'object',
  required: ['alias'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1 },
  },
} as const

/** 修改别名请求体 */
const updateAliasBodySchema = {
  type: 'object',
  required: ['alias'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1 },
  },
} as const

/** 解析 ID，非法则返回 400 响应 */
function badIdReply(reply: FastifyReply, raw: string) {
  return reply.code(400).send(errorBody('VALIDATION_ERROR', `非法 ID：${raw}。ID 必须是正整数`))
}

export function registerAliasRoutes(app: FastifyInstance): void {
  /**
   * GET /api/ingredients/:id/aliases
   * 获取某标准食材的全部别名。200 / 400 / 404
   */
  app.get<{ Params: IngredientIdParams }>(
    '/api/ingredients/:id/aliases',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return badIdReply(reply, request.params.id)
      }

      const aliases = listAliases(id)
      return reply.code(200).send(aliases)
    },
  )

  /**
   * POST /api/ingredients/:id/aliases
   * 创建别名。201 / 400 / 404 / 409
   */
  app.post<{ Params: IngredientIdParams; Body: { alias: string } }>(
    '/api/ingredients/:id/aliases',
    { schema: { body: createAliasBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return badIdReply(reply, request.params.id)
      }

      const created = createAlias(id, request.body.alias)
      return reply.code(201).send(created)
    },
  )

  /**
   * PATCH /api/ingredients/:id/aliases/:aliasId
   * 修改别名。200 / 400 / 404 / 409
   */
  app.patch<{ Params: AliasIdParams; Body: { alias: string } }>(
    '/api/ingredients/:id/aliases/:aliasId',
    { schema: { body: updateAliasBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return badIdReply(reply, request.params.id)
      }

      const aliasId = parsePositiveIntId(request.params.aliasId)

      if (aliasId === null) {
        return badIdReply(reply, request.params.aliasId)
      }

      const updated = updateAlias(aliasId, request.body.alias, id)
      return reply.code(200).send(updated)
    },
  )

  /**
   * DELETE /api/ingredients/:id/aliases/:aliasId
   * 删除别名。204（无 body）/ 400 / 404
   */
  app.delete<{ Params: AliasIdParams }>(
    '/api/ingredients/:id/aliases/:aliasId',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return badIdReply(reply, request.params.id)
      }

      const aliasId = parsePositiveIntId(request.params.aliasId)

      if (aliasId === null) {
        return badIdReply(reply, request.params.aliasId)
      }

      deleteAlias(aliasId, id)

      // 204 不返回 body
      return reply.code(204).send()
    },
  )
}
