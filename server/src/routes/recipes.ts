import type { FastifyInstance } from 'fastify'

import {
  createRecipe,
  createTag,
  deleteRecipe,
  deleteTag,
  getRecipeById,
  listRecipes,
  listTags,
  saveRecipeFull,
} from '../services/recipeService.js'
import type { RecipeInput } from '../services/recipeService.js'
import {
  getRecipeListSettings,
  updateRecipeListSettings,
} from '../services/recipeListSettingsService.js'
import { errorBody, parsePositiveIntId } from './http.js'

/**
 * 菜谱 API（v0.2.0 Phase 3）。
 *
 * 批次 1：GET /api/recipes、GET /api/recipes/:id、GET /api/tags
 * 批次 2：POST / PATCH / DELETE /api/recipes、PATCH /api/recipes/:id/full、
 *         POST / DELETE /api/tags
 *
 * ⚠️ 搜索 / 筛选 / 排序 / 列表设置属于**批次 3**，此处不实现。
 *
 * 与现有路由风格一致：
 *   - Fastify JSON Schema 做入口校验
 *   - 业务规则在 Service 层
 *   - `additionalProperties: false`，未知参数一律拒绝
 */

interface IdParams {
  id: string
}

/** 单条食材的 JSON Schema */
const ingredientItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['definition_id'],
  properties: {
    definition_id: { type: 'integer', minimum: 1 },
    // ⚠️ 数量/单位/备注均可为 null —— 三者相互独立，
    //    不因食材是调味品就强制清空或强制填写
    quantity: { type: ['number', 'null'], minimum: 0 },
    unit: { type: ['string', 'null'] },
    note: { type: ['string', 'null'] },
  },
} as const

/** 菜谱写入体（新建与统一保存共用） */
const recipeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'ingredients'],
  properties: {
    name: { type: 'string', minLength: 1 },
    note: { type: ['string', 'null'] },
    // ⚠️ minItems: 1 —— 菜谱至少需要一个食材
    ingredients: { type: 'array', minItems: 1, items: ingredientItemSchema },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
} as const

/** Tag 创建体 */
const tagBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: { name: { type: 'string', minLength: 1 } },
} as const

/** 空 query（不接受任何参数） */
const emptyQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/**
 * 菜谱列表查询参数（v0.2.0 批次 3）。
 *
 * ⚠️ 排序字段与方向用 **enum 白名单**在入口处拦截非法值，
 *    Service 层还会再校验一次（双重保险）。
 * ⚠️ `tags` 支持两种写法：
 *    - 重复参数：`?tags=家常菜&tags=快手`
 *    - 逗号分隔：`?tags=家常菜,快手`
 *    Fastify 默认把重复参数收集为数组，单值时是字符串 —— 两者都接受。
 */
const recipeListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search: { type: 'string' },
    tags: {
      anyOf: [
        { type: 'string' },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    tag_mode: { type: 'string', enum: ['and', 'or'] },
    sort: { type: 'string', enum: ['updated_at', 'created_at', 'name'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
  },
} as const

/** 列表设置更新体 */
const recipeListSettingsBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    sort_field: { type: 'string', enum: ['updated_at', 'created_at', 'name'] },
    sort_order: { type: 'string', enum: ['asc', 'desc'] },
    tag_mode: { type: 'string', enum: ['and', 'or'] },
    selected_tags: { type: 'array', items: { type: 'string' } },
  },
} as const

interface RecipeListQueryParams {
  search?: string
  tags?: string | string[]
  tag_mode?: 'and' | 'or'
  sort?: 'updated_at' | 'created_at' | 'name'
  order?: 'asc' | 'desc'
}

/** 把 tags 的两种写法统一成字符串数组 */
function normalizeTagsParam(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const list = Array.isArray(raw) ? raw : [raw]
  // 支持 `?tags=a,b` 逗号分隔写法
  return list
    .flatMap((item) => item.split(','))
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function registerRecipeRoutes(app: FastifyInstance): void {
  /**
   * GET /api/recipes
   * 列出菜谱（含 Tag 与食材数量），支持搜索、Tag 筛选与排序。
   *
   * query 参数（全部可选）：
   *   search    搜索词，**只匹配菜谱名称**（大小写不敏感；⚠️ Tag 名称不参与搜索）
   *   tags      选中的 Tag 名称，可重复或逗号分隔
   *   tag_mode  'and'（默认）| 'or'
   *   sort      'updated_at'（默认）| 'created_at' | 'name'
   *   order     'asc' | 'desc'（默认）
   *
   * ⚠️ 全部参数可选；**不接受任何参数时行为与批次 1 一致**（默认排序）。
   */
  app.get<{ Querystring: RecipeListQueryParams }>(
    '/api/recipes',
    { schema: { querystring: recipeListQuerySchema } },
    async (request, reply) => {
      const q = request.query
      return reply.code(200).send(
        listRecipes({
          search: q.search,
          tagNames: normalizeTagsParam(q.tags),
          tagMode: q.tag_mode,
          sortField: q.sort,
          sortOrder: q.order,
        }),
      )
    },
  )

  /**
   * GET /api/recipes/:id
   * 菜谱详情（含食材明细与 Tag）。200 / 400 / 404
   */
  app.get<{ Params: IdParams }>('/api/recipes/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    return reply.code(200).send(getRecipeById(id))
  })

  /**
   * GET /api/tags
   * 列出全部 Tag（供「复用已有 Tag」）。
   */
  app.get(
    '/api/tags',
    { schema: { querystring: emptyQuerySchema } },
    async (_request, reply) => {
      return reply.code(200).send(listTags())
    },
  )

  /* ============================================================
   * 批次 2：菜谱写入
   * ============================================================ */

  /**
   * POST /api/recipes
   * 新建菜谱（含食材与 Tag，单事务）。201 / 400 / 409
   */
  app.post<{ Body: RecipeInput }>(
    '/api/recipes',
    { schema: { body: recipeBodySchema } },
    async (request, reply) => {
      const id = createRecipe(request.body)
      return reply.code(201).send(getRecipeById(id))
    },
  )

  /**
   * PATCH /api/recipes/:id/full
   * **统一保存**：菜谱基本信息 + 食材关联 + Tag 关联，同一事务。
   * 200 / 400 / 404 / 409
   */
  app.patch<{ Params: IdParams; Body: RecipeInput }>(
    '/api/recipes/:id/full',
    { schema: { body: recipeBodySchema } },
    async (request, reply) => {
      const id = parsePositiveIntId(request.params.id)
      if (id === null) {
        return reply
          .code(400)
          .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
      }

      saveRecipeFull(id, request.body)
      return reply.code(200).send(getRecipeById(id))
    },
  )

  /**
   * DELETE /api/recipes/:id
   * 删除菜谱及其关联（**保留**食材定义与 Tag）。204 / 400 / 404
   */
  app.delete<{ Params: IdParams }>('/api/recipes/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    deleteRecipe(id)
    return reply.code(204).send()
  })

  /* ============================================================
   * 批次 2：Tag 写入
   * ============================================================ */

  /**
   * POST /api/tags
   * 新建 Tag。201 / 400 / 409
   */
  app.post<{ Body: { name: string } }>(
    '/api/tags',
    { schema: { body: tagBodySchema } },
    async (request, reply) => {
      const id = createTag(request.body.name)
      return reply.code(201).send({ id })
    },
  )

  /**
   * DELETE /api/tags/:id
   * 删除 Tag 及其菜谱关联（**保留**菜谱）。204 / 400 / 404
   */
  app.delete<{ Params: IdParams }>('/api/tags/:id', async (request, reply) => {
    const id = parsePositiveIntId(request.params.id)
    if (id === null) {
      return reply
        .code(400)
        .send(errorBody('VALIDATION_ERROR', `非法 ID：${request.params.id}。ID 必须是正整数`))
    }

    deleteTag(id)
    return reply.code(204).send()
  })

  /* ============================================================
   * 批次 3：菜谱列表设置
   * ============================================================ */

  /**
   * GET /api/recipe-list-settings
   * 读取菜谱列表设置（排序字段/方向、Tag 模式、选中的 Tag）。
   *
   * ⚠️ 永不返回 500：字段缺失、值非法或 JSON 损坏时回退默认值。
   */
  app.get(
    '/api/recipe-list-settings',
    { schema: { querystring: emptyQuerySchema } },
    async (_request, reply) => {
      return reply.code(200).send(getRecipeListSettings())
    },
  )

  /**
   * PATCH /api/recipe-list-settings
   * 更新菜谱列表设置（部分更新）。200 / 400
   */
  app.patch<{ Body: Record<string, unknown> }>(
    '/api/recipe-list-settings',
    { schema: { body: recipeListSettingsBodySchema } },
    async (request, reply) => {
      return reply.code(200).send(updateRecipeListSettings(request.body))
    },
  )
}
