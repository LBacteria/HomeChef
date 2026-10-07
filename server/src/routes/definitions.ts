import type { FastifyInstance, FastifyReply } from 'fastify'

import {
  addAlias,
  addAllowedUnit,
  createDefinition,
  deleteAlias,
  deleteDefinition,
  getDefinitionById,
  listAllowedUnits,
  listDefinitionAliases,
  removeAllowedUnit,
  searchDefinitions,
  setDefaultName,
  updateAlias,
  updateDefinition,
} from '../services/definitionService.js'
import { UNITS } from '../db/schema.js'
import {
  DEFAULT_DEFINITION_ORDER,
  DEFAULT_DEFINITION_SORT,
  DEFINITION_SORT_FIELDS,
  DEFINITION_SORT_ORDERS,
  isValidDefinitionSortField,
  isValidDefinitionSortOrder,
  sortDefinitions,
} from '../services/definitionSortService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 食材定义（食材库）API
 *
 * 职责边界：
 *   本层只做：解析 params/body、基础格式校验、调用 Service、转 HTTP 响应
 *   本层不做：归一化、唯一性检查、删除保护、单位校验 —— 全部由 Service 负责
 */

interface IdParams {
  id: string
}

interface AliasParams {
  id: string
  aliasId: string
}

interface UnitParams {
  id: string
  unit: string
}

/**
 * 创建 definition 的请求体。
 *
 * ⚠️ v0.1.3：
 *   - 增加 category_id
 *   - units 不再强制 required、不再限制 minItems ——
 *     **调味品允许 0 个 allowed unit**
 *     普通食材仍由 **Service 层**强制要求至少一个单位
 *     （保证「普通食材必须有单位」的规则不被削弱）
 */
const createDefinitionSchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    units: {
      type: 'array',
      items: { type: 'string' },
    },
    aliases: { type: 'array', items: { type: 'string' } },
    estimated_shelf_life_days: { type: ['integer', 'null'] },
    category_id: { type: ['integer', 'null'] },
  },
} as const

/** 更新 definition 的请求体 */
const updateDefinitionSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    estimated_shelf_life_days: { type: ['integer', 'null'] },
  },
} as const

/** 别名请求体 */
const aliasBodySchema = {
  type: 'object',
  required: ['alias'],
  additionalProperties: false,
  properties: {
    alias: { type: 'string', minLength: 1 },
  },
} as const

/** 默认名称切换请求体：二选一 */
const defaultNameSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    alias_id: { type: 'integer' },
  },
} as const

/** 允许单位请求体 */
const unitBodySchema = {
  type: 'object',
  required: ['unit'],
  additionalProperties: false,
  properties: {
    unit: { type: 'string', minLength: 1 },
  },
} as const

function badIdReply(reply: FastifyReply, raw: string) {
  return reply.code(400).send(errorBody('VALIDATION_ERROR', `非法 ID：${raw}。ID 必须是正整数`))
}

export function registerDefinitionRoutes(app: FastifyInstance): void {
  /* ============================================================
   * Definition CRUD
   * ============================================================ */

  /**
   * GET /api/definitions
   * 列出全部定义，支持 ?search= 包含匹配（名称 + 别名）。
   *
   * ⚠️ search 使用 searchDefinitions()，是**包含匹配**（substring），
   *    不是精确解析。绝不用 resolveDefinitionByName。
   *
   * v0.1.2 Batch 3 增加名称排序：
   *   ?sort=name&order=asc|desc   （默认 name asc，即 A → Z）
   *
   * ⚠️ sort / order 均为**白名单**，非法值一律 400。
   *    排序在搜索之后进行，与 search 完全兼容。
   *    搜索逻辑本身未做任何改动。
   */
  app.get<{
    Querystring: { search?: string; sort?: string; order?: string; category_id?: string }
  }>(
    '/api/definitions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string' },
            sort: { type: 'string', enum: [...DEFINITION_SORT_FIELDS] },
            order: { type: 'string', enum: [...DEFINITION_SORT_ORDERS] },
            // v0.1.3：按分类筛选（缺省 = 全部）
            category_id: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const search = request.query.search
      let items = search === undefined ? searchDefinitions('') : searchDefinitions(search)

      // v0.1.3：分类筛选（与搜索、排序并行工作）
      const rawCategoryId = request.query.category_id
      if (rawCategoryId !== undefined && rawCategoryId !== '') {
        const categoryId = parsePositiveIntId(rawCategoryId)
        if (categoryId === null) {
          return reply
            .code(400)
            .send(
              errorBody(
                'VALIDATION_ERROR',
                `非法分类 ID：${rawCategoryId}。必须是正整数`,
              ),
            )
        }
        items = items.filter((d) => d.category_id === categoryId)
      }

      // Service 层再次校验（不只依赖 JSON Schema）
      const sortField = request.query.sort ?? DEFAULT_DEFINITION_SORT
      const order = request.query.order ?? DEFAULT_DEFINITION_ORDER

      if (!isValidDefinitionSortField(sortField) || !isValidDefinitionSortOrder(order)) {
        return reply
          .code(400)
          .send(
            errorBody(
              'VALIDATION_ERROR',
              `非法排序参数：sort=${String(sortField)}，order=${String(order)}。` +
                `允许的 sort：${DEFINITION_SORT_FIELDS.join('、')}；` +
                `允许的 order：${DEFINITION_SORT_ORDERS.join('、')}`,
            ),
          )
      }

      // 排序只改变展示顺序，不修改任何数据
      const sorted = sortDefinitions(items, order)

      // 附带每个定义的别名与允许单位，便于前端展示
      const enriched = sorted.map((d) => ({
        ...d,
        aliases: listDefinitionAliases(d.id),
        allowed_units: listAllowedUnits(d.id),
      }))

      return reply.code(200).send(enriched)
    },
  )

  /**
   * GET /api/definitions/:id
   * 获取单个定义（含别名与允许单位）。200 / 400 / 404
   */
  app.get<{ Params: IdParams }>('/api/definitions/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badIdReply(reply, request.params.id)

    const definition = getDefinitionById(id)
    return reply.code(200).send({
      ...definition,
      aliases: listDefinitionAliases(id),
      allowed_units: listAllowedUnits(id),
    })
  })

  /**
   * POST /api/definitions
   * 创建定义。201 / 400 / 409
   */
  app.post<{ Body: Record<string, unknown> }>(
    '/api/definitions',
    { schema: { body: createDefinitionSchema } },
    async (request, reply) => {
      const body = request.body
      const created = createDefinition({
        name: body.name as string,
        // ⚠️ units 可能缺省（调味品）→ 传空数组，由 Service 决定是否合法
        units: Array.isArray(body.units) ? (body.units as string[]) : [],
        aliases: body.aliases as string[] | undefined,
        estimated_shelf_life_days: body.estimated_shelf_life_days as number | null | undefined,
        // v0.1.3：分类（决定是否按调味品处理）
        category_id: 'category_id' in body ? (body.category_id as number | null) : null,
      })
      return reply.code(201).send(created)
    },
  )

  /**
   * PATCH /api/definitions/:id
   * 更新定义。200 / 400 / 404 / 409
   *
   * ⚠️ 修改 estimated_shelf_life_days 只影响以后新建的库存记录。
   */
  app.patch<{ Params: IdParams; Body: Record<string, unknown> }>(
    '/api/definitions/:id',
    { schema: { body: updateDefinitionSchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      const body = request.body
      const updated = updateDefinition(id, {
        ...('name' in body ? { name: body.name as string } : {}),
        ...('estimated_shelf_life_days' in body
          ? { estimated_shelf_life_days: body.estimated_shelf_life_days as number | null }
          : {}),
      })
      return reply.code(200).send(updated)
    },
  )

  /**
   * DELETE /api/definitions/:id
   * 删除定义。204 / 400 / 404 / 409(HAS_STOCK)
   */
  app.delete<{ Params: IdParams }>('/api/definitions/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badIdReply(reply, request.params.id)

    deleteDefinition(id)
    return reply.code(204).send()
  })

  /* ============================================================
   * 默认名称切换
   * ============================================================ */

  /**
   * POST /api/definitions/:id/default-name
   * 把某个别名设为默认名称。200 / 400 / 404 / 409
   *
   * 行为由 Service 保证（事务）：
   *   - 原默认名称自动成为 alias
   *   - 新默认名称从 alias 移除
   *   - definition ID 不变
   */
  app.post<{ Params: IdParams; Body: { alias_id: number } }>(
    '/api/definitions/:id/default-name',
    { schema: { body: defaultNameSchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      const updated = setDefaultName(id, request.body.alias_id)
      return reply.code(200).send({
        ...updated,
        aliases: listDefinitionAliases(id),
        allowed_units: listAllowedUnits(id),
      })
    },
  )

  /* ============================================================
   * 别名
   * ============================================================ */

  /** GET /api/definitions/:id/aliases */
  app.get<{ Params: IdParams }>('/api/definitions/:id/aliases', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badIdReply(reply, request.params.id)

    // 定义不存在时抛出 404
    getDefinitionById(id)
    return reply.code(200).send(listDefinitionAliases(id))
  })

  /** POST /api/definitions/:id/aliases → 201 */
  app.post<{ Params: IdParams; Body: { alias: string } }>(
    '/api/definitions/:id/aliases',
    { schema: { body: aliasBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      return reply.code(201).send(addAlias(id, request.body.alias))
    },
  )

  /** PATCH /api/definitions/:id/aliases/:aliasId → 200 */
  app.patch<{ Params: AliasParams; Body: { alias: string } }>(
    '/api/definitions/:id/aliases/:aliasId',
    { schema: { body: aliasBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      const aliasId = parsePositiveIntId(request.params.aliasId)
      if (aliasId === null) return badIdReply(reply, request.params.aliasId)

      // 归属校验：别名必须属于该定义
      const aliases = listDefinitionAliases(id)
      if (!aliases.some((a) => a.id === aliasId)) {
        return reply
          .code(404)
          .send(errorBody('INGREDIENT_NOT_FOUND', `别名不属于该食材：别名 id=${aliasId}`))
      }

      return reply.code(200).send(updateAlias(aliasId, request.body.alias))
    },
  )

  /** DELETE /api/definitions/:id/aliases/:aliasId → 204 */
  app.delete<{ Params: AliasParams }>(
    '/api/definitions/:id/aliases/:aliasId',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      const aliasId = parsePositiveIntId(request.params.aliasId)
      if (aliasId === null) return badIdReply(reply, request.params.aliasId)

      const aliases = listDefinitionAliases(id)
      if (!aliases.some((a) => a.id === aliasId)) {
        return reply
          .code(404)
          .send(errorBody('INGREDIENT_NOT_FOUND', `别名不属于该食材：别名 id=${aliasId}`))
      }

      deleteAlias(aliasId)
      return reply.code(204).send()
    },
  )

  /* ============================================================
   * 允许单位
   * ============================================================ */

  /** GET /api/definitions/:id/units */
  app.get<{ Params: IdParams }>('/api/definitions/:id/units', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) return badIdReply(reply, request.params.id)

    getDefinitionById(id)
    return reply.code(200).send(listAllowedUnits(id))
  })

  /** POST /api/definitions/:id/units → 201 / 409 */
  app.post<{ Params: IdParams; Body: { unit: string } }>(
    '/api/definitions/:id/units',
    { schema: { body: unitBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      return reply.code(201).send(addAllowedUnit(id, request.body.unit))
    },
  )

  /**
   * DELETE /api/definitions/:id/units/:unit → 204
   * 400（最后一个单位）/ 409（正在被库存使用）
   *
   * ⚠️ unit 是中文，需 URL 解码。
   */
  app.delete<{ Params: UnitParams }>(
    '/api/definitions/:id/units/:unit',
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) return badIdReply(reply, request.params.id)

      const unit = decodeURIComponent(request.params.unit)

      if (!UNITS.includes(unit as (typeof UNITS)[number])) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `单位不合法：${unit}。允许的单位：${UNITS.join('、')}`))
      }

      removeAllowedUnit(id, unit)
      return reply.code(204).send()
    },
  )
}
