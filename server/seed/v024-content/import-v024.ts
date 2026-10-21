/**
 * v0.2.4 内容包 CLI（**默认 dry-run，零写入**）
 *
 * 用法（在 server/ 下）：
 *   npx tsx seed/v024-content/import-v024.ts --db <隔离库绝对路径>
 *   npx tsx seed/v024-content/import-v024.ts --db <隔离库绝对路径> --apply
 *   npx tsx seed/v024-content/import-v024.ts --db <...> --out seed/v024-content/content.json
 *
 * ⚠️ 拒绝真实库（`assertSafeDbPath`）；真实库请由 Sol 直接调用
 *    `importContentV024` 并在受保护事务里执行。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from '../../src/db/safe-db-path.js'
import { importContentV024, formatStats } from './importer.js'
import { generateContent } from './recipes.js'
import type { GeneratedContent } from './recipes.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string): boolean => process.argv.includes(name)

const serverRoot = resolve(process.cwd())
const dbArg = arg('--db')
if (dbArg === undefined) {
  console.error('缺少 --db <隔离库绝对路径>')
  process.exit(2)
}
const dbPath = resolve(dbArg)

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  console.error(`拒绝执行：${String(e?.message ?? e)}`)
  process.exit(2)
}

const apply = has('--apply')
if (!/\.db$/i.test(dbPath)) {
  console.error('拒绝执行：目标必须是 .db 文件')
  process.exit(2)
}

let content: GeneratedContent
const contentPath = arg('--content')
if (contentPath !== undefined) {
  content = JSON.parse(readFileSync(resolve(contentPath), 'utf8')) as GeneratedContent
} else {
  content = generateContent()
}

const outPath = arg('--out')
if (outPath !== undefined) {
  writeFileSync(resolve(outPath), JSON.stringify(content, null, 2), 'utf8')
  console.log(`已写出内容包：${resolve(outPath)}（${content.recipes.length} 条）`)
}

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

try {
  const stats = apply
    ? db.transaction(() => importContentV024(db, content, { dryRun: false }))()
    : importContentV024(db, content, { dryRun: true })
  console.log(formatStats(stats))
} finally {
  db.close()
}
