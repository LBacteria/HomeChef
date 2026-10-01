import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as schema from './schema.js'

/**
 * 数据库连接。
 *
 * 数据库文件位置：server/data/homechef.db
 * 见 ARCHITECTURE.md 第 7 节 —— server/data/ 存放 SQLite 文件，不进 Git。
 */

const currentDir = dirname(fileURLToPath(import.meta.url))

// src/db/ → 上溯两级到 server/，再进入 data/
// 编译后为 dist/db/ → 同样上溯两级到 server/
const serverRoot = resolve(currentDir, '..', '..')

// 默认 server/data/homechef.db。
// 允许用 HOME_CHEF_DB_PATH 覆盖，仅用于测试隔离，不改变默认行为。
const databasePath = process.env.HOME_CHEF_DB_PATH
  ? resolve(process.env.HOME_CHEF_DB_PATH)
  : resolve(serverRoot, 'data', 'homechef.db')

// 确保 data/ 目录存在（该目录本身不入 Git，但运行时需要存在）
const dataDir = dirname(databasePath)
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}

const sqlite = new Database(databasePath)

// ⚠️ 关键：SQLite 的 PRAGMA foreign_keys 默认是 OFF。
// 不开启则 ON DELETE CASCADE 不会生效，会留下孤儿别名。
// 见 DATABASE_DESIGN.md 第 13.1 节。
sqlite.pragma('foreign_keys = ON')

// WAL 模式：本地单进程应用下读写更稳，减少写锁等待。
sqlite.pragma('journal_mode = WAL')

export const db = drizzle(sqlite, { schema })

export { databasePath, sqlite }
