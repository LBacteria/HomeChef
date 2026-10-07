import Fastify from 'fastify'

import { registerErrorHandler } from './routes/errorHandler.js'
import { registerDefinitionRoutes } from './routes/definitions.js'
import { registerIngredientRoutes } from './routes/ingredients.js'
import { registerSettingsRoutes } from './routes/settings.js'
import { registerCategoryRoutes } from './routes/categories.js'

// 后端应用入口。
//
// 分层见 ARCHITECTURE.md 第 2 节：
//   routes/    接口层：路由与入口校验
//   services/  业务层：归一化、唯一性检查、库存校验
const app = Fastify({
  logger: true,

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

// 默认端口 3001（3000 已被本机其他程序占用）。
// 仍可用 PORT 环境变量覆盖（测试等场景）。
const port = Number(process.env.PORT ?? 3001)

try {
  await app.listen({ port, host: '127.0.0.1' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
