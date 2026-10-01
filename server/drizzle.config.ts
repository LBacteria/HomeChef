import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit 配置（migration 生成与执行）
 *
 * - schema：server/src/db/schema.ts
 * - 输出目录：server/drizzle/          （migration SQL 文件，进入 Git）
 * - 数据库文件：server/data/homechef.db （本地运行数据，不进 Git）
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: './data/homechef.db',
  },
})
