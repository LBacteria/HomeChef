import type { FastifyInstance } from 'fastify'

import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategoryColor,
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

/**
 * 更新分类请求体（v0.1.4）。
 *
 * ⚠️ 目前只支持改 color —— 名称、顺序、与食材的关联都不受影响。
 *    pattern 在入口做一次格式校验，Service 层会**再次**校验
 *    （不只依赖 JSON Schema）。
 */
const updateCategorySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
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
   * PATCH /api/categories/:id
   * 更新分类（当前仅支持颜色）。200 / 400 / 404
   *
   * ⚠️ 只改 color，不影响名称、顺序、与食材的关联，也不影响删除。
   */
  app.patch<{ Params: IdParams; Body: Record<string, unknown> }>(
    '/api/categories/:id',
    { schema: { body: updateCategorySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      const updated = updateCategoryColor(id, request.body.color as string)
      return reply.code(200).send(updated)
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
