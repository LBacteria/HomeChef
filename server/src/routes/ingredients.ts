import type { FastifyInstance } from 'fastify'

import {
  consumeStandardIngredient,
  createStandardIngredient,
  deleteStandardIngredient,
  getStandardIngredientById,
  listStandardIngredients,
  updateStandardIngredient,
} from '../services/standardIngredientService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 标准食材 API（v0.1）
 *
 * 对应 ARCHITECTURE.md 第 8 节的 6 个端点中的 5 个
 * （consume 端点属于后续阶段，本阶段不实现）。
 *
 * 职责边界（ARCHITECTURE.md 第 2.2 节）：
 * - 本层只做：接收请求、解析 params/body、**基础请求格式校验**、调用 Service、转成 HTTP 响应
 * - 本层**不做**：名称归一化、quantity 校验、unit 校验、日期关系、唯一性检查
 *   —— 这些全部由 Service 负责，这里只负责把 Service 的错误翻译成 HTTP 状态码
 */

/** 单条食材的响应结构（直接返回 Service 的记录） */
interface IdParams {
  id: string
}

/**
 * 请求体 schema。
 *
 * 这里只做**基础格式校验**（类型、必填、ID 格式）。
 * 业务规则（单位是否在枚举内、数量是否非负、日期关系、名称唯一性）
 * 一律交给 Service，不在 schema 里重复实现。
 */
const createBodySchema = {
  type: 'object',
  required: ['name', 'unit'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    quantity: { type: 'number' },
    unit: { type: 'string', minLength: 1 },
    purchase_date: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
  },
} as const

/** PATCH：所有字段可选，但不允许空对象与未来字段 */
const updateBodySchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    quantity: { type: 'number' },
    unit: { type: 'string', minLength: 1 },
    purchase_date: { type: ['string', 'null'] },
    expiry_date: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
  },
} as const

/**
 * consume 请求体 schema。
 *
 * 只做基础格式校验：amount 必须是数字。
 * 是否 > 0、舍入后是否为 0 等业务规则由 Service 负责。
 */
const consumeBodySchema = {
  type: 'object',
  required: ['amount'],
  additionalProperties: false,
  properties: {
    amount: { type: 'number' },
  },
} as const

export function registerIngredientRoutes(app: FastifyInstance): void {
  /**
   * GET /api/ingredients
   * 查看库存列表。200
   */
  app.get('/api/ingredients', async (_request, reply) => {
    const items = listStandardIngredients()
    return reply.code(200).send(items)
  })

  /**
   * GET /api/ingredients/:id
   * 查看单个食材。200 / 400（非法 ID）/ 404（不存在）
   */
  app.get<{ Params: IdParams }>('/api/ingredients/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)

    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    const item = getStandardIngredientById(id)
    return reply.code(200).send(item)
  })

  /**
   * POST /api/ingredients
   * 添加食材（含名称解析）。201 / 400 / 409
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/ingredients',
    { schema: { body: createBodySchema } },
    async (request, reply) => {
      const body = request.body

      const created = createStandardIngredient({
        name: body.name as string,
        quantity: body.quantity as number | undefined,
        unit: body.unit as string,
        purchase_date: body.purchase_date as string | null | undefined,
        expiry_date: body.expiry_date as string | null | undefined,
        note: body.note as string | null | undefined,
      })

      return reply.code(201).send(created)
    },
  )

  /**
   * PATCH /api/ingredients/:id
   * 修改食材。200 / 400 / 404 / 409
   */
  app.patch<{ Params: IdParams; Body: Record<string, unknown> }>(
    '/api/ingredients/:id',
    { schema: { body: updateBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      const body = request.body

      // 只透传实际出现过的字段，未出现的字段由 Service 保留原值
      const updated = updateStandardIngredient(id, {
        ...('name' in body ? { name: body.name as string } : {}),
        ...('quantity' in body ? { quantity: body.quantity as number } : {}),
        ...('unit' in body ? { unit: body.unit as string } : {}),
        ...('purchase_date' in body
          ? { purchase_date: body.purchase_date as string | null }
          : {}),
        ...('expiry_date' in body ? { expiry_date: body.expiry_date as string | null } : {}),
        ...('note' in body ? { note: body.note as string | null } : {}),
      })

      return reply.code(200).send(updated)
    },
  )

  /**
   * DELETE /api/ingredients/:id
   * 删除食材。204（无 body）/ 400 / 404
   *
   * 别名由数据库 ON DELETE CASCADE 处理，Service 不模拟删除。
   */
  app.delete<{ Params: IdParams }>('/api/ingredients/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)

    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    deleteStandardIngredient(id)

    // 204 不返回 JSON body
    return reply.code(204).send()
  })

  /**
   * POST /api/ingredients/:id/consume
   * 消耗食材（扣减库存）。200 / 400 / 404 / 409
   *
   * 成功返回**更新后的 ingredient**。
   *
   * 业务规则（amount > 0、库存是否足够、舍入与钳制）全部在 Service 中，
   * 本层只做 ID 解析与基础格式校验。
   */
  app.post<{ Params: IdParams; Body: { amount: number } }>(
    '/api/ingredients/:id/consume',
    { schema: { body: consumeBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)

      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      const updated = consumeStandardIngredient(id, request.body.amount)

      return reply.code(200).send(updated)
    },
  )
}
