import type { FastifyInstance } from 'fastify'

import {
  consumeStock,
  createStock,
  deleteStock,
  getStockById,
  listStock,
  listStockWithQuantity,
  updateStock,
} from '../services/standardIngredientService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 库存记录 API
 *
 * ⚠️ 必须明确区分两个 ID：
 *   - definition_id  → ingredient_definition.id（食材身份）
 *   - :id            → standard_ingredient.id（**具体库存记录**）
 *
 * 一个 definition 可以有多条库存记录（3 个 / 1 袋 / 1 千克），
 * 它们互不影响，不自动合并，不做单位换算。
 */

interface IdParams {
  id: string
}

/** 创建库存请求体 */
const createStockSchema = {
  type: 'object',
  required: ['definition_id', 'quantity', 'unit'],
  additionalProperties: false,
  properties: {
    definition_id: { type: 'integer' },
    quantity: { type: 'number' },
    unit: { type: 'string', minLength: 1 },
    purchase_date: { type: ['string', 'null'] },
    production_date: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    storage_method: { type: 'string' },
    note: { type: ['string', 'null'] },
  },
} as const

/**
 * 更新库存请求体。
 *
 * ⚠️ expiry_date 是否**出现**在 body 中具有业务含义：
 *    出现（含 null）→ 用户明确设置/清空
 *    不出现        → 由 Service 按当前 source 决定是否重算
 *    因此 schema 不设 required，route 用 `'expiry_date' in body` 判断。
 *
 * ⚠️ definition_id 可选：提供则更换该记录所属的食材。
 *    additionalProperties 仍为 false —— 未知字段一律拒绝。
 */
const updateStockSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    definition_id: { type: 'integer' },
    quantity: { type: 'number' },
    unit: { type: 'string', minLength: 1 },
    purchase_date: { type: ['string', 'null'] },
    production_date: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    storage_method: { type: 'string' },
    note: { type: ['string', 'null'] },
  },
} as const

/** 消耗请求体 */
const consumeSchema = {
  type: 'object',
  required: ['amount'],
  additionalProperties: false,
  properties: { amount: { type: 'number' } },
} as const

export function registerIngredientRoutes(app: FastifyInstance): void {
  /**
   * GET /api/ingredients
   * 库存列表。
   *
   * 默认隐藏 quantity = 0 的记录（数据库仍保留）。
   * 支持 ?includeZero=true 显示全部（便于调试与管理）。
   */
  app.get<{ Querystring: { includeZero?: string } }>(
    '/api/ingredients',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { includeZero: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const includeZero = request.query.includeZero === 'true'
      return reply.code(200).send(includeZero ? listStock() : listStockWithQuantity())
    },
  )

  /**
   * GET /api/ingredients/:id
   * 单条库存记录（:id = standard_ingredient.id）。200 / 400 / 404
   *
   * ⚠️ 即使 quantity = 0 也能查到（数据库保留该记录）。
   */
  app.get<{ Params: IdParams }>('/api/ingredients/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }
    return reply.code(200).send(getStockById(id))
  })

  /**
   * POST /api/ingredients
   * 创建库存记录。201 / 400 / 404 / 409
   *
   * ⚠️ 同一 definition 可以创建**多条**记录，不会因"重复食材"被拒绝。
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/ingredients',
    { schema: { body: createStockSchema } },
    async (request, reply) => {
      const body = request.body
      const created = createStock({
        definition_id: body.definition_id as number,
        quantity: body.quantity as number,
        unit: body.unit as string,
        ...('purchase_date' in body
          ? { purchase_date: body.purchase_date as string | null }
          : {}),
        ...('production_date' in body
          ? { production_date: body.production_date as string | null }
          : {}),
        ...('expiry_date' in body ? { expiry_date: body.expiry_date as string | null } : {}),
        ...('storage_method' in body ? { storage_method: body.storage_method as string } : {}),
        ...('note' in body ? { note: body.note as string | null } : {}),
      })
      return reply.code(201).send(created)
    },
  )

  /**
   * PATCH /api/ingredients/:id
   * 更新库存记录。200 / 400 / 404
   *
   * 日期语义由 Service 保证，route 只负责把"字段是否出现"如实传递。
   */
  app.patch<{ Params: IdParams; Body: Record<string, unknown> }>(
    '/api/ingredients/:id',
    { schema: { body: updateStockSchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      const body = request.body
      const updated = updateStock(id, {
        ...('definition_id' in body ? { definition_id: body.definition_id as number } : {}),
        ...('quantity' in body ? { quantity: body.quantity as number } : {}),
        ...('unit' in body ? { unit: body.unit as string } : {}),
        ...('purchase_date' in body
          ? { purchase_date: body.purchase_date as string | null }
          : {}),
        ...('production_date' in body
          ? { production_date: body.production_date as string | null }
          : {}),
        ...('expiry_date' in body ? { expiry_date: body.expiry_date as string | null } : {}),
        ...('storage_method' in body ? { storage_method: body.storage_method as string } : {}),
        ...('note' in body ? { note: body.note as string | null } : {}),
      })

      return reply.code(200).send(updated)
    },
  )

  /**
   * DELETE /api/ingredients/:id
   * 删除**库存记录**（不是 definition）。204 / 400 / 404
   *
   * ⚠️ 删除库存记录不影响 ingredient_definition、别名、允许单位。
   */
  app.delete<{ Params: IdParams }>('/api/ingredients/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    deleteStock(id)
    return reply.code(204).send()
  })

  /**
   * POST /api/ingredients/:id/consume
   * 消耗库存。200 / 400 / 404 / 409(INSUFFICIENT_STOCK)
   *
   * ⚠️ :id 是**具体库存记录 ID**，不是 definition ID。
   *    不跨记录寻找，不 FIFO，不换单位。
   *    扣到 0 后记录保留（GET 默认隐藏，DB 不删）。
   */
  app.post<{ Params: IdParams; Body: { amount: number } }>(
    '/api/ingredients/:id/consume',
    { schema: { body: consumeSchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      return reply.code(200).send(consumeStock(id, request.body.amount))
    },
  )
}
