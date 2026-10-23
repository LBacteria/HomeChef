import { createApp } from './app.js'

/**
 * 命令行 / 开发期入口。
 *
 * 全部路由注册在 app.ts 的 `createApp()` 里；本文件只负责监听。
 * 桌面客户端（desktop/）不走这里：它在 listen 之前还要挂静态资源，
 * 端口也由自己决定。
 */
const app = createApp()

// 默认端口 3001（3000 已被本机其他程序占用）。
// 仍可用 PORT 环境变量覆盖（测试等场景）。
const port = Number(process.env.PORT ?? 3001)

try {
  await app.listen({ port, host: '127.0.0.1' })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
