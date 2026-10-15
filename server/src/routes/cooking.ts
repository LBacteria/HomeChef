import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  abandonSession,
  addDish,
  createSession,
  deleteSessions,
  deleteSkipConfirmation,
  findStaleDishes,
  getSessionById,
  listSessions,
  listSkips,
  removeDish,
  saveSkipConfirmations,
  updateDishProgress,
  updateDishServings,
  updateSessionName,
} from '../services/cookingService.js'
import type { SkipConfirmation } from '../services/cookingService.js'
import { previewSettlement, settleSession } from '../services/settlementService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 烹饪会话 API（v0.2.1 B2）。
 *
 * 与既有路由风格一致：
 *   - Fastify JSON Schema 做入口校验
 *   - 业务规则在 Service 层
 *   - `additionalProperties: false`，未知参数一律拒绝
 *
 * ❌ 不实现结算与库存扣减（B3）、前端（B4）。
 */

interface IdParams {
  id: string
}

interface DishParams {
  id: string
  dishId: string
}

/** 空 body */
const emptyBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/** 空 query */
const emptyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/** 添加菜品 */
const addDishBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recipe_id'],
  properties: {
    recipe_id: { type: 'integer', minimum: 1 },
    // ⚠️ 份数必须 > 0；不传时默认 1
    servings: { type: 'number', exclusiveMinimum: 0 },
  },
} as const

/** 修改份数 */
const servingsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['servings'],
  properties: {
    servings: { type: 'number', exclusiveMinimum: 0 },
  },
} as const

/** 更新进度 */
const progressBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    status: { type: 'string', enum: ['pending', 'done'] },
    // ⚠️ 允许 null 表示「重置为未开始」
    current_step_no: { type: ['integer', 'null'], minimum: 1 },
  },
} as const

/** 保存跳过确认 */
const skipsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['confirmations'],
  properties: {
    confirmations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['dish_id', 'line_key', 'reason'],
        properties: {
          dish_id: { type: 'integer', minimum: 1 },
          line_key: { type: 'string', minLength: 1 },
          reason: {
            type: 'string',
            enum: ['null_quantity', 'unit_mismatch', 'user_choice'],
          },
        },
      },
    },
  },
} as const

/** 批量删除烹饪记录（v0.2.1.1） */
const deleteSessionsBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['session_ids'],
  properties: {
    // ⚠️ 至少一个；元素必须是正整数（Service 层还会再校验一次并去重）
    session_ids: {
      type: 'array',
      minItems: 1,
      items: { type: 'integer', minimum: 1 },
    },
  },
} as const

/** 修改烹饪记录名称（v0.2.1.1） */
const renameSessionBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    /**
     * ⚠️ `null` = **恢复默认名称**，明确区别于「空白输入」。
     * ⚠️ 空串由 `minLength: 1` 直接拒绝；纯空白由 Service 层 trim 后拒绝。
     * ⚠️ `maxLength` 必须与 Service 的 `COOKING_SESSION_NAME_MAX_LENGTH`
     *    以及前端输入框的 `maxLength` 保持一致。
     */
    name: { type: ['string', 'null'], minLength: 1, maxLength: 60 },
  },
} as const

/** 解析路径参数中的 ID；非法则发送 400 响应 */
function badId(reply: FastifyReply, raw: string): FastifyReply {
  return reply
    .code(400)
    .send(errorBody('VALIDATION_ERROR', `非法 ID：${raw}。ID 必须是正整数`))
}

export function registerCookingRoutes(app: FastifyInstance): void {
  /* ============================================================
   * 会话
   * ============================================================ */

  /**
   * GET /api/cooking/sessions
   * 列出全部烹饪会话。
   */
  app.get(
    '/api/cooking/sessions',
    { schema: { querystring: emptyQuerySchema } },
    async (_request, reply) => {
      return reply.code(200).send(listSessions())
    },
  )

  /**
   * POST /api/cooking/sessions/batch-delete
   * **批量删除**烹饪记录（单条选中也走这同一条路径）。200 / 400 / 404
   *
   * ⚠️ 语义是「清理历史记录」，**不是撤销烹饪**：
   *    不回补库存、不再次扣减、不修改任何库存数量。
   * ⚠️ **全有或全无**：任一 id 不存在 → 404，且整批不删除任何行。
   */
  app.post<{ Body: { session_ids: number[] } }>(
    '/api/cooking/sessions/batch-delete',
    { schema: { body: deleteSessionsBodySchema } },
    async (request, reply) => {
      return reply.code(200).send(deleteSessions(request.body.session_ids))
    },
  )

  /**
   * POST /api/cooking/sessions
   * 创建烹饪会话（状态 active）。201
   */
  app.post(
    '/api/cooking/sessions',
    { schema: { body: emptyBodySchema } },
    async (_request, reply) => {
      return reply.code(201).send(createSession())
    },
  )

  /**
   * GET /api/cooking/sessions/:id
   * 会话详情（含菜品行）。200 / 400 / 404
   */
  app.get<{ Params: IdParams }>('/api/cooking/sessions/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badId(reply, request.params.id)

    return reply.code(200).send(getSessionById(id))
  })

  /**
   * POST /api/cooking/sessions/:id/abandon
   * 放弃会话（终态，不扣库存）。200 / 400 / 404 / 409
   */
  app.post<{ Params: IdParams }>(
    '/api/cooking/sessions/:id/abandon',
    { schema: { body: emptyBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      return reply.code(200).send(abandonSession(id))
    },
  )

  /**
   * PATCH /api/cooking/sessions/:id/name
   * 设置或清除烹饪记录的自定义名称（v0.2.1.1）。200 / 400 / 404
   *
   *   `{ name: "..." }` → 保存自定义名称（后端 trim 后写入）
   *   `{ name: null }`  → **恢复默认名称**（列写回 NULL）
   *
   * ⚠️ 只改名称，**不改 `started_at`**，因此不改变列表排序。
   * ⚠️ 终态（已结算 / 已放弃）**同样允许**改名 —— 这是给历史记录贴标签，
   *    不是业务状态变更。
   */
  app.patch<{ Params: IdParams; Body: { name: string | null } }>(
    '/api/cooking/sessions/:id/name',
    { schema: { body: renameSessionBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      return reply.code(200).send(updateSessionName(id, request.body.name))
    },
  )

  /* ============================================================
   * 菜品
   * ============================================================ */

  /**
   * POST /api/cooking/sessions/:id/dishes
   * 添加菜品（重复添加同一菜谱 → **合并份数**）。201 / 400 / 404 / 409
   */
  app.post<{ Params: IdParams; Body: { recipe_id: number; servings?: number } }>(
    '/api/cooking/sessions/:id/dishes',
    { schema: { body: addDishBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      const servings = request.body.servings ?? 1
      return reply.code(201).send(addDish(id, request.body.recipe_id, servings))
    },
  )

  /**
   * PATCH /api/cooking/sessions/:id/dishes/:dishId/servings
   * 修改份数（会使该会话既有跳过确认失效）。200 / 400 / 404 / 409
   */
  app.patch<{ Params: DishParams; Body: { servings: number } }>(
    '/api/cooking/sessions/:id/dishes/:dishId/servings',
    { schema: { body: servingsBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)
      const dishId = parsePositiveIntId(request.params.dishId)
      if (dishId === null) return badId(reply, request.params.dishId)

      return reply.code(200).send(updateDishServings(id, dishId, request.body.servings))
    },
  )

  /**
   * PATCH /api/cooking/sessions/:id/dishes/:dishId/progress
   * 更新菜品完成状态与步骤进度。200 / 400 / 404 / 409
   */
  app.patch<{
    Params: DishParams
    Body: { status?: 'pending' | 'done'; current_step_no?: number | null }
  }>(
    '/api/cooking/sessions/:id/dishes/:dishId/progress',
    { schema: { body: progressBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)
      const dishId = parsePositiveIntId(request.params.dishId)
      if (dishId === null) return badId(reply, request.params.dishId)

      return reply
        .code(200)
        .send(
          updateDishProgress(id, dishId, request.body.status, request.body.current_step_no),
        )
    },
  )

  /**
   * DELETE /api/cooking/sessions/:id/dishes/:dishId
   * 移除菜品。200 / 400 / 404 / 409
   */
  app.delete<{ Params: DishParams }>(
    '/api/cooking/sessions/:id/dishes/:dishId',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)
      const dishId = parsePositiveIntId(request.params.dishId)
      if (dishId === null) return badId(reply, request.params.dishId)

      return reply.code(200).send(removeDish(id, dishId))
    },
  )

  /* ============================================================
   * 跳过确认
   * ============================================================ */

  /**
   * GET /api/cooking/sessions/:id/skips
   * 列出该会话的跳过确认。200 / 400 / 404
   */
  app.get<{ Params: IdParams }>('/api/cooking/sessions/:id/skips', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badId(reply, request.params.id)

    return reply.code(200).send(listSkips(id))
  })

  /**
   * POST /api/cooking/sessions/:id/skips
   * 保存跳过确认（幂等 upsert，并重算 confirmed_revision）。200 / 400 / 404 / 409
   */
  app.post<{ Params: IdParams; Body: { confirmations: SkipConfirmation[] } }>(
    '/api/cooking/sessions/:id/skips',
    { schema: { body: skipsBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      return reply.code(200).send(saveSkipConfirmations(id, request.body.confirmations))
    },
  )

  /**
   * DELETE /api/cooking/sessions/:id/skips/:lineKey
   * 删除一条跳过确认并重算。200 / 400 / 404 / 409
   */
  app.delete<{ Params: { id: string; dishId: string; lineKey: string } }>(
    '/api/cooking/sessions/:id/dishes/:dishId/skips/:lineKey',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)
      const dishId = parsePositiveIntId(request.params.dishId)
      if (dishId === null) return badId(reply, request.params.dishId)

      return reply.code(200).send(deleteSkipConfirmation(id, dishId, request.params.lineKey))
    },
  )

  /**
   * GET /api/cooking/sessions/:id/settle-readiness
   * 检查会话是否已就绪（供 B3 结算前预检）。
   *
   * ⚠️ 本阶段**只读**，不执行任何结算或库存扣减。
   */
  app.get<{ Params: IdParams }>(
    '/api/cooking/sessions/:id/settle-readiness',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      const stale = findStaleDishes(id)
      return reply.code(200).send({ ready: stale.length === 0, stale })
    },
  )

  /* ============================================================
   * 结算（v0.2.1 B3）
   * ============================================================ */

  /**
   * GET /api/cooking/sessions/:id/settle/preview
   * 结算预览（**只读，无任何副作用**）。
   *
   * 基于当前库存重新计算每项需求、是否需要确认、可用量是否充足。
   * 200 / 400 / 404
   */
  app.get<{ Params: IdParams }>(
    '/api/cooking/sessions/:id/settle/preview',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      return reply.code(200).send(previewSettlement(id))
    },
  )

  /**
   * POST /api/cooking/sessions/:id/settle
   * **执行结算**：扣减库存 + 写入结算凭证，单事务原子完成。
   *
   * 200 / 400 / 404 / 409
   *   - 404 会话不存在
   *   - 409 终态 / 重复结算 / 确认不完整 / 库存不足
   */
  app.post<{ Params: IdParams }>(
    '/api/cooking/sessions/:id/settle',
    { schema: { body: emptyBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badId(reply, request.params.id)

      return reply.code(200).send(settleSession(id))
    },
  )
}
