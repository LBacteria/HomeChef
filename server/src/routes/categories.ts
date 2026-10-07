import type { FastifyInstance } from 'fastify'

import {
  createCategory,
  deleteCategory,
  listCategories,
} from '../services/categoryService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 食材分类 API（v0.1.3）。
 *
 * 风格与现有路由一致：Fastify JSON Schema 做入口校验，
 * 业务规则在 Service 层**再次**保证。
 *
 * ⚠️ additionalProperties: false —— 未知字段一律拒绝。
 */

interface IdParams {
  id: string
}

/** 创建分类请求体 */
const createCategorySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
  },
} as const

export function registerCategoryRoutes(app: FastifyInstance): void {
  /**
   * GET /api/categories
   * 列出全部分类（内置 + 用户自定义，按 sort_order）。
   *
   * ⚠️ 与其他列表接口保持一致：不接受任何 query 参数
   *    （additionalProperties: false，未知参数一律 400）。
   */
  app.get(
    '/api/categories',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (_request, reply) => {
      return reply.code(200).send(listCategories())
    },
  )

  /**
   * POST /api/categories
   * 新建分类。201 / 400（空名称）/ 409（重名）
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/categories',
    { schema: { body: createCategorySchema } },
    async (request, reply) => {
      const created = createCategory(request.body.name as string)
      return reply.code(201).send(created)
    },
  )

  /**
   * DELETE /api/categories/:id
   * 删除分类。204 / 400 / 404 / 409(CATEGORY_IN_USE)
   *
   * ⚠️ 仍有 definition 引用时拒绝删除，绝不级联删除食材。
   */
  app.delete<{ Params: IdParams }>('/api/categories/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    deleteCategory(id)
    return reply.code(204).send()
  })
}
