import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import { db, databasePath, sqlite } from './index.js'

/**
 * 执行 migration。
 *
 * 用法：npm run db:migrate --workspace server
 *
 * migration SQL 文件位于 server/drizzle/
 * 数据库文件位于 server/data/homechef.db
 */

console.log(`数据库文件：${databasePath}`)

// 执行前确认外键约束处于开启状态。
// 见 DATABASE_DESIGN.md 第 13.1 节。
const foreignKeys = sqlite.pragma('foreign_keys', { simple: true })
console.log(`foreign_keys = ${foreignKeys}`)

if (foreignKeys !== 1) {
  console.error('错误：foreign_keys 未开启，ON DELETE CASCADE 将不生效。')
  process.exit(1)
}

migrate(db, { migrationsFolder: './drizzle' })

console.log('migration 执行完成。')

// 列出数据库中的表，便于确认结果
const tables = sqlite
  .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
  .all() as Array<{ name: string }>

console.log(`表：${tables.map((t) => t.name).join(', ')}`)

sqlite.close()
