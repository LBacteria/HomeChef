/**
 * v0.2.4 测试库存 CLI（**默认 dry-run，零写入**）
 *
 * 用法（在 server/ 下）：
 *   npx tsx seed/v024-content/run-stock.ts --db <隔离库绝对路径>
 *   npx tsx seed/v024-content/run-stock.ts --db <隔离库绝对路径> --apply
 *
 * ⚠️ 拒绝真实库；真实库请由 Sol 调用 `planStock` + `applyStock`（同一事务）。
 */

import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from '../../src/db/safe-db-path.js'
import { applyStock, formatStockPlan, planStock } from './stock.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const dbArg = arg('--db')
if (dbArg === undefined) {
  console.error('缺少 --db <隔离库绝对路径>')
  process.exit(2)
}
const dbPath = resolve(dbArg)

try {
  assertSafeDbPath(dbPath, resolve(process.cwd()))
} catch (e: any) {
  console.error(`拒绝执行：${String(e?.message ?? e)}`)
  process.exit(2)
}

const apply = process.argv.includes('--apply')

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

try {
  const plan = planStock(db)
  console.log(formatStockPlan(plan))
  if (apply) {
    const result = db.transaction(() => applyStock(db, plan))()
    console.log(
      `\n已执行：拉长期限 ${result.updated_expiry} 条，新增批次 ${result.inserted_batches} 条`,
    )
  } else {
    console.log('\n（dry-run：未写入任何数据）')
  }
} finally {
  db.close()
}
