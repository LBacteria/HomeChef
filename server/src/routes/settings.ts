import type { FastifyInstance } from 'fastify'

import { getSettings, updateSettings } from '../services/settingsService.js'

/**
 * 应用设置 API。
 *
 * 风格与现有路由一致：Fastify JSON Schema 做入口校验，
 * 业务规则在 Service 层**再次**保证。
 *
 * ⚠️ additionalProperties: false —— 未知字段一律拒绝。
 * ⚠️ 默认值由 Service 决定，前端不得自行决定默认值。
 */

/** 更新设置请求体：所有字段可选（部分更新） */
const updateSettingsSchema = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    expiry_warning_mode: { type: 'string', enum: ['days', 'percentage'] },
    expiry_warning_threshold: { type: 'number', minimum: 0 },
    allow_expired_for_recipe: { type: 'boolean' },
  },
} as const

export function registerSettingsRoutes(app: FastifyInstance): void {
  /**
   * GET /api/settings
   * 读取应用设置。表为空时返回默认值。
   */
  app.get('/api/settings', async (_request, reply) => {
    return reply.code(200).send(getSettings())
  })

  /**
   * PATCH /api/settings
   * 部分更新设置。200 / 400
   *
   * ⚠️ 模式与阈值的组合校验（days 必须整数、percentage 必须 0–100）
   *    在 Service 层按**最终合并值**执行，因此「只改 mode」也会被正确校验。
   */
  app.patch<{ Body: Record<string, unknown> }>(
    '/api/settings',
    { schema: { body: updateSettingsSchema } },
    async (request, reply) => {
      const body = request.body
      const updated = updateSettings({
        ...('expiry_warning_mode' in body
          ? { expiry_warning_mode: body.expiry_warning_mode as 'days' | 'percentage' }
          : {}),
        ...('expiry_warning_threshold' in body
          ? { expiry_warning_threshold: body.expiry_warning_threshold as number }
          : {}),
        ...('allow_expired_for_recipe' in body
          ? { allow_expired_for_recipe: body.allow_expired_for_recipe as boolean }
          : {}),
      })
      return reply.code(200).send(updated)
    },
  )
}
