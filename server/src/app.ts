import Fastify, { type FastifyInstance } from 'fastify'

import { registerErrorHandler } from './routes/errorHandler.js'
import { registerDefinitionRoutes } from './routes/definitions.js'
import { registerIngredientRoutes } from './routes/ingredients.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerCategoryRoutes } from './routes/categories.js'
import { registerRecipeRoutes } from './routes/recipes.js'
import { registerCookingRoutes } from './routes/cooking.js'
import { registerRecommendationRoutes } from './routes/recommendation.js'
import { registerContentRoutes } from './routes/content.js'

/**
 * 构造应用并注册全部业务路由，**不监听端口**。
 *
 * 从 server.ts 拆出来的原因：桌面客户端（desktop/）需要在 listen 之前
 * 追加静态资源托管，并由自己决定监听端口（随机可用端口）。
 * `server.ts` 仍是一次性起完整服务的入口，行为与之前完全一致。
 *
 * 分层见 ARCHITECTURE.md 第 2 节：
 *   routes/    接口层：路由与入口校验
 *   services/  业务层：归一化、唯一性检查、库存校验
 */
export function createApp(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,

    // ⚠️ 必须配置 AJV，否则 schema 校验形同虚设。
    //
    // Fastify 默认的 AJV 行为会带来两个问题（已实测确认）：
    //   1. coerceTypes: true —— "3" 会被强制转成数字 3，
    //      绕过 Service 的类型校验（"拒绝非法 quantity"失效）
    //   2. removeAdditional: true —— 多余字段被静默删除而不是报错，
    //      导致 additionalProperties: false 完全不起作用
    //
    // 这里显式关闭二者，让请求格式校验真正生效。
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  })

  // 统一错误出口：必须在使用路由之前注册
  registerErrorHandler(app)

  // 健康检查：用于确认服务已启动。
  // 这不是业务 API，不涉及库存、别名或数据库。
  app.get('/health', async () => {
    return { status: 'ok' }
  })

  // 业务路由
  // 注意：旧版 aliases route 已删除，别名 API 并入 definitions
  registerDefinitionRoutes(app)
  registerIngredientRoutes(app)
  registerSettingsRoutes(app)
  registerCategoryRoutes(app)
  registerRecipeRoutes(app)
  registerCookingRoutes(app)
  registerRecommendationRoutes(app)
  registerContentRoutes(app)

  return app
}
