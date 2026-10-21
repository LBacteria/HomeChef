import type { FastifyInstance } from 'fastify'

import {
  MAX_BULK_STOCK_DELETE,
  consumeStock,
  createStock,
  deleteStock,
  deleteStocks,
  getStockById,
  listStock,
  listStockWithQuantity,
  updateStock,
} from '../services/standardIngredientService.js'
import { errorBody, parsePositiveIntId } from './http.js'
import { todayDateString } from '../services/dates.js'
import { evaluateExpiryStatus } from '../services/expiryStatusService.js'
import { getSettings } from '../services/settingsService.js'
import {
  SORT_FIELDS,
  SORT_ORDERS,
  buildSortableList,
  isValidSortField,
  isValidSortOrder,
  sortStock,
} from '../services/stockSortService.js'
import { listDefinitions } from '../services/definitionService.js'
import { isSeasoningCategory } from '../services/categoryService.js'

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

/**
 * 创建库存请求体。
 *
 * ⚠️ v0.1.3：quantity / unit 不再强制 required —— 调味品库存不需要它们
 *    （Service 会用哨兵值填充）。普通食材仍由 **Service 层**强制要求，
 *    确保「普通食材必须有数量与单位」的规则不被削弱。
 */
const createStockSchema = {
  type: 'object',
  required: ['definition_id'],
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
   *
   * 排序（v0.1.2）：
   *   ?sort=default|expiry|purchase_date|name|quantity
   *   ?order=asc|desc
   *
   * ⚠️ sort / order 均为**白名单**，非法值一律 400。
   *    绝不把用户输入拼进 ORDER BY。
   */
  app.get<{
    Querystring: {
      includeZero?: string
      sort?: string
      order?: string
      category_id?: string
    }
  }>(
    '/api/ingredients',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            includeZero: { type: 'string' },
            sort: { type: 'string', enum: [...SORT_FIELDS] },
            order: { type: 'string', enum: [...SORT_ORDERS] },
            // v0.1.3：按分类筛选（缺省 = 全部）
            category_id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const includeZero = request.query.includeZero === 'true'
      let rows = includeZero ? listStock() : listStockWithQuantity()

      // v0.1.3：分类筛选（与排序并行工作）
      const rawCategoryId = request.query.category_id
      if (rawCategoryId !== undefined && rawCategoryId !== '') {
        const categoryId = parsePositiveIntId(rawCategoryId)
        if (categoryId === null) {
          return reply
            .code(400)
            .send(
              errorBody('VALIDATION_ERROR', `非法分类 ID：${rawCategoryId}。必须是正整数`),
            )
        }
        const allowedDefIds = new Set(
          listDefinitions()
            .filter((d) => d.category_id === categoryId)
            .map((d) => d.id),
        )
        rows = rows.filter((r) => allowedDefIds.has(r.definition_id))
      }

      const settings = getSettings()
      const rule = {
        mode: settings.expiry_warning_mode,
        threshold: settings.expiry_warning_threshold,
      }
      const today = todayDateString()

      // 名称映射：排序需要食材默认名称（不用 alias）
      const allDefs = listDefinitions()
      const nameMap = new Map<number, string>()
      const definitionById = new Map<number, (typeof allDefs)[number]>()
      for (const def of allDefs) {
        nameMap.set(def.id, def.name)
        definitionById.set(def.id, def)
      }

      const sortable = buildSortableList(rows, rule, today, (id) => nameMap.get(id) ?? '')

      const field = request.query.sort ?? 'default'
      const order = request.query.order ?? 'asc'

      // Service 层再次校验（不只依赖 schema）
      if (!isValidSortField(field) || !isValidSortOrder(order)) {
        return reply
          .code(400)
          .send(
            errorBody(
              'VALIDATION_ERROR',
              `非法排序参数：sort=${String(field)}，order=${String(order)}。` +
                `允许的 sort：${SORT_FIELDS.join('、')}；允许的 order：${SORT_ORDERS.join('、')}`,
            ),
          )
      }

      const sorted = sortStock(sortable, field, order)

      // 附加**动态计算**的临期状态（不存库）。
      // 兼容性：只是增加字段，不改变原有字段与结构。
      //
      // v0.1.3：附加 category_id 与 is_seasoning，
      //         便于前端对调味品做特殊显示（"有"，不显示数量/日期）。
      const enriched = sorted.map((item) => {
        const evaluation = evaluateExpiryStatus(
          {
            expiry_date: item.row.expiry_date,
            purchase_date: item.row.purchase_date,
            production_date: item.row.production_date,
          },
          rule,
          today,
        )
        const def = definitionById.get(item.row.definition_id)
        const seasoning = isSeasoningCategory(def?.category_id ?? null)

        return {
          ...item.row,
          definition_name: item.name,
          category_id: def?.category_id ?? null,
          is_seasoning: seasoning,
          expiry_status: evaluation.status,
          days_remaining: evaluation.days_remaining,
          remaining_percentage: evaluation.remaining_percentage,
        }
      })

      return reply.code(200).send(enriched)
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
   * POST /api/ingredients/bulk-delete
   * 批量删除**库存记录**（不是 definition）。200 / 400 / 404
   *
   * body: `{ ids: number[] }`（1–2000 条；重复 id 自动去重）
   *
   * ⚠️ 任何一个 id 不存在 → **整批不删**（服务层同一事务内先全量校验）。
   * ⚠️ 不影响 ingredient_definition / 别名 / 允许单位 / 菜谱 / 历史。
   */
  app.post<{ Body: { ids: number[] } }>(
    '/api/ingredients/bulk-delete',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['ids'],
          properties: {
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BULK_STOCK_DELETE,
              items: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = deleteStocks(request.body.ids)
      return reply.code(200).send(result)
    },
  )

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
