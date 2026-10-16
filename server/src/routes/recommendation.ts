import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

import { createSessionWithDishes } from '../services/cookingService.js'
import {
  assertRecipesExist,
  assertSnapshotFresh,
  multiplierFor,
  recommendMealPlans,
  validatePeople,
} from '../services/recommendationService.js'
import {
  IDEMPOTENCY_MAX_ENTRIES,
  IDEMPOTENCY_TTL_MS,
  MAX_PEOPLE,
  MAX_SERVINGS_MULTIPLIER,
  MIN_PEOPLE,
} from '../services/recommendationConfig.js'
import { idempotencyConflictError, validationError } from '../services/errors.js'

/**
 * v0.2.2 整餐推荐 API。
 *
 * 与既有路由风格一致：Fastify JSON Schema 入口校验（项目已关闭
 * coerceTypes / removeAdditional）、Service 层再校验一次、
 * `additionalProperties: false`。
 *
 * ⚠️ 推荐接口是**纯读**接口，绝不写库。
 * ⚠️ `apply` 是唯一写入口：**原子**创建会话 + 全部菜品、**不预扣库存**、
 *     带**快照校验**（菜谱/库存/设置变了就 409）和**有界幂等**。
 */

/** 生成整餐推荐 */
const mealPlansBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['people'],
  properties: {
    people: { type: 'integer', minimum: MIN_PEOPLE, maximum: MAX_PEOPLE },
    /** v0.2.3：按 Tag 名称筛选参与推荐的菜谱（空数组 = 不筛选） */
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
    /** v0.2.3：Tag 筛选模式，'and'（默认）| 'or' */
    tag_mode: { type: 'string', enum: ['and', 'or'] },
  },
} as const

/** 把一套推荐方案落到烹饪会话 */
const applyPlanBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['people', 'dishes', 'snapshot_id', 'request_id'],
  properties: {
    people: { type: 'integer', minimum: MIN_PEOPLE, maximum: MAX_PEOPLE },
    /**
     * 客户端生成的一次性幂等键。
     * 网络结果不明时，**用同一个 request_id 重试**是安全的。
     */
    request_id: { type: 'string', minLength: 8, maxLength: 128 },
    /** 用户确认时的快照指纹（来自 meal-plans 的 plan.snapshot_id） */
    snapshot_id: { type: 'string', minLength: 8, maxLength: 64 },
    dishes: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recipe_id', 'servings'],
        properties: {
          recipe_id: { type: 'integer', minimum: 1 },
          servings: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: MAX_SERVINGS_MULTIPLIER,
          },
        },
      },
    },
  },
} as const

/* ============================================================
 * 有界幂等表（进程内）
 * ============================================================
 *
 * ⚠️ 为什么放在进程内而不是数据库：
 *    需求明确「不迁库」，且这是**幂等去重**而非业务数据。
 * ⚠️ 明确局限（不得隐瞒）：
 *    1. **重启即失效** —— 进程重启后同一个 request_id 会被当成新请求，
 *       可能再创建一个会话。因此前端**不得自动重试写操作**，
 *       只允许用户在明确看到失败提示后手动重试。
 *    2. 多实例部署时各自独立，不共享。
 *    3. 条目有 TTL 与数量上限；淘汰后同样失去去重能力。
 */

interface IdempotencyEntry {
  payloadHash: string
  response: Record<string, unknown>
  expiresAt: number
}

const idempotencyStore = new Map<string, IdempotencyEntry>()

function pruneIdempotency(now: number): void {
  for (const [key, entry] of idempotencyStore) {
    if (entry.expiresAt <= now) idempotencyStore.delete(key)
  }
  // 仍然超上限 → 按插入顺序（Map 保序）淘汰最旧的
  while (idempotencyStore.size > IDEMPOTENCY_MAX_ENTRIES) {
    const oldest = idempotencyStore.keys().next()
    if (oldest.done) break
    idempotencyStore.delete(oldest.value)
  }
}

/** 仅用于测试：清空幂等表 */
export function clearIdempotencyStore(): void {
  idempotencyStore.clear()
}

function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function registerRecommendationRoutes(app: FastifyInstance): void {
  /**
   * POST /api/recommendation/meal-plans
   * 按人数生成 3–5 套整餐推荐。**只读**，不写数据库。
   *
   * body: `{ people, tags?, tag_mode? }`
   *   - `tags`     v0.2.3：按 Tag 名称筛选菜谱（AND / OR 由 `tag_mode` 决定）
   *   - `tag_mode` 'and'（默认）| 'or'
   *
   * 200 / 400
   */
  app.post<{ Body: { people: number; tags?: string[]; tag_mode?: 'and' | 'or' } }>(
    '/api/recommendation/meal-plans',
    { schema: { body: mealPlansBodySchema } },
    async (request, reply) => {
      const people = validatePeople(request.body.people)
      return reply.code(200).send(
        recommendMealPlans(people, undefined, {
          tags: request.body.tags ?? [],
          tagMode: request.body.tag_mode,
        }),
      )
    },
  )

  /**
   * POST /api/recommendation/apply
   * 把选中的整餐**原子**落到一个烹饪会话（会话 + 全部菜品同一事务）。
   *
   * 校验顺序（先便宜后昂贵，且**先查幂等再落库**）：
   *   1. 参数（路由 schema + Service）
   *   2. request_id 幂等：同 key 同 payload → 直接返回首次结果；
   *      同 key 不同 payload → **409 IDEMPOTENCY_CONFLICT**
   *   3. 菜谱存在性（404）
   *   4. **快照一致性**（服务端重算指纹）：不一致 → **409 SNAPSHOT_STALE**
   *   5. 原子创建会话 + 菜品
   *
   * ⚠️ 服务端**只信 `recipe_id` 与份数**：分数、需求量、缺口全部重算。
   * ⚠️ **不预扣库存**：扣减仍由既有结算负责。
   * ⚠️ 任一步失败整体回滚，不会留下半套会话。
   *
   * 200 / 400 / 404 / 409
   */
  app.post<{
    Body: {
      people: number
      dishes: Array<{ recipe_id: number; servings: number }>
      snapshot_id: string
      request_id: string
    }
  }>(
    '/api/recommendation/apply',
    { schema: { body: applyPlanBodySchema } },
    async (request, reply) => {
      const { people: rawPeople, dishes, snapshot_id, request_id } = request.body

      const people = validatePeople(rawPeople)

      if (!Array.isArray(dishes) || dishes.length === 0) {
        throw validationError('至少需要一道菜')
      }
      const seen = new Set<number>()
      for (const d of dishes) {
        if (seen.has(d.recipe_id)) {
          throw validationError(`同一菜谱重复出现：id=${d.recipe_id}`)
        }
        seen.add(d.recipe_id)
        if (typeof d.servings !== 'number' || !Number.isFinite(d.servings) || d.servings <= 0) {
          throw validationError(`份数必须是大于 0 的有限数字：${String(d.servings)}`)
        }
        if (d.servings > MAX_SERVINGS_MULTIPLIER) {
          throw validationError(`份数倍数过大：${d.servings}`)
        }
      }

      /* ---------- 幂等 ---------- */
      const now = Date.now()
      pruneIdempotency(now)

      const payloadHash = hashPayload({
        people,
        snapshot_id,
        dishes: [...dishes]
          .sort((a, b) => a.recipe_id - b.recipe_id)
          .map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      })

      const existing = idempotencyStore.get(request_id)
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) {
          throw idempotencyConflictError(
            '同一个 request_id 被用于不同的请求内容，已拒绝。请换一个新的 request_id 重试。',
          )
        }
        return reply
          .code(200)
          .send({ ...existing.response, idempotent_replay: true })
      }

      /* ---------- 菜谱存在性 + 快照一致性 ---------- */
      assertRecipesExist(dishes.map((d) => d.recipe_id))
      assertSnapshotFresh({
        people,
        snapshot_id,
        dishes: dishes.map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      })

      /* ---------- 原子创建 ---------- */
      const detail = createSessionWithDishes(
        dishes.map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      )

      const response = {
        session_id: detail.id,
        dish_count: detail.dishes.length,
        people,
        expected_multiplier: multiplierFor(people),
        snapshot_id,
      }

      pruneIdempotency(Date.now())
      idempotencyStore.set(request_id, {
        payloadHash,
        response,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      })

      return reply.code(200).send(response)
    },
  )
}
