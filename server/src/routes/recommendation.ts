import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'

import { db } from '../db/index.js'
import { recommendationRequest } from '../db/schema.js'
import { createSessionWithDishesTx } from '../services/cookingService.js'
import {
  assertRecipesExist,
  assertSnapshotFresh,
  multiplierFor,
  recommendMealPlans,
  validatePeople,
} from '../services/recommendationService.js'
import {
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
 *     带**快照校验**（菜谱/库存/设置变了就 409）和
 *     **持久化幂等**（v0.2.4：回执入库、同事务写入、不随时间淘汰）。
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
 * 持久化幂等（v0.2.4）
 * ============================================================
 *
 * ⚠️ v0.2.3 及更早：进程内 `Map` + 10 分钟 TTL + 200 条上限。
 *    局限是硬伤：进程重启、多实例、TTL 过期、条目被淘汰 → 同一
 *    `request_id` 会被当成新请求，**再建一个会话**。
 *
 * v0.2.4 改成 SQLite 表 `recommendation_request`：
 *   - `request_id` 主键 → 同一 key 只有一条回执，唯一约束兜底并发；
 *   - 回执与「创建会话 + 菜品」在**同一个 `BEGIN IMMEDIATE` 事务**内写入；
 *   - **不做时间淘汰**（不设 TTL / 条数上限）：家庭本地量级，
 *     可靠性优先；进程重启后同 key 依旧原样重放；
 *   - `session_id` 外键 `ON DELETE CASCADE`：用户主动删除该会话后，
 *     这条去重记录随之删除 —— 去重保证到此结束（预期语义）。
 *
 * ⚠️ 不导出任何「清表」函数：这条表是持久业务数据，
 *    不能给路由层一个能误清真实库的入口；测试请在隔离库里自行清理。
 */

/** 影响「建什么会话」的规范化载荷哈希（people + snapshot + 排序后的菜） */
function hashPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** apply 的稳定响应字段（回执里存的就这一份，重放时原样返回） */
interface ApplyPlanResponse {
  session_id: number
  dish_count: number
  people: number
  expected_multiplier: number
  snapshot_id: string
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

      const payloadHash = hashPayload({
        people,
        snapshot_id,
        dishes: [...dishes]
          .sort((a, b) => a.recipe_id - b.recipe_id)
          .map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      })

      /**
       * 一个 `BEGIN IMMEDIATE` 事务内完成：
       *   ① 查回执（命中 → 同载荷原样重放 / 异载荷 409）
       *   ② 菜谱存在性 + 快照一致性
       *   ③ 创建会话与菜品
       *   ④ 写回执
       * 任一失败 → 整体回滚，绝不留下「建了会话却没有回执」的半套状态。
       *
       * ⚠️ `IMMEDIATE` 一开始就拿写锁：并发请求被串行化，
       *    后到者在锁释放后能读到先到者的回执，因此不会重复建会话。
       * ⚠️ **不在事务内吞唯一约束异常**：万一真的冲突，让它上抛，
       *    把刚建好的会话与菜品一起回滚；吞掉再返回 winner 会提交孤立重复会话。
       */
      const outcome = db.transaction(
        (tx) => {
          const existing = tx
            .select()
            .from(recommendationRequest)
            .where(eq(recommendationRequest.request_id, request_id))
            .get()

          if (existing !== undefined) {
            if (existing.payload_hash !== payloadHash) {
              throw idempotencyConflictError(
                '同一个 request_id 被用于不同的请求内容，已拒绝。请换一个新的 request_id 重试。',
              )
            }
            return {
              replayed: true as const,
              response: JSON.parse(existing.response_json) as ApplyPlanResponse,
            }
          }

          // ⚠️ 校验收在事务内：与建会话读到的是同一份状态
          assertRecipesExist(dishes.map((d) => d.recipe_id))
          assertSnapshotFresh({
            people,
            snapshot_id,
            dishes: dishes.map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
          })

          const detail = createSessionWithDishesTx(
            tx,
            dishes.map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
          )

          const response: ApplyPlanResponse = {
            session_id: detail.id,
            dish_count: detail.dishes.length,
            people,
            expected_multiplier: multiplierFor(people),
            snapshot_id,
          }

          /**
           * ⚠️ 这里**不做**唯一约束兜底：一旦冲突就让它抛出去，
           *    整个事务（含刚建好的会话与菜品）一起回滚。
           *    `BEGIN IMMEDIATE` 已把并发串行化，后到者在本事务内就能读到先到者的回执；
           *    在事务里吞异常再返回 winner，会把**重复创建但未回滚**的会话提交掉。
           */
          tx.insert(recommendationRequest)
            .values({
              request_id,
              payload_hash: payloadHash,
              session_id: detail.id,
              response_json: JSON.stringify(response),
              created_at: new Date().toISOString(),
            })
            .run()

          return { replayed: false as const, response }
        },
        { behavior: 'immediate' },
      )

      return reply
        .code(200)
        .send(
          outcome.replayed ? { ...outcome.response, idempotent_replay: true } : outcome.response,
        )
    },
  )
}
