/**
 * v0.2.2 整餐推荐 —— **演示/体验用种子脚本**（隔离临时库专用）。
 *
 * 用途：造一个「有菜谱、有库存、含临期与过期各一项」的库，
 *       方便直接体验整餐推荐（含「可做 / 缺料」两种结果）。
 *
 * 用法（**必须传绝对路径**）：
 *   npx tsx seed/seed-v022-demo.ts C:\path\to\temp.db
 *
 * ⚠️ 安全：只写传入的绝对路径；**拒绝**写入真实库 server/data/homechef.db。
 * ⚠️ 本脚本会先跑 drizzle/ 下全部迁移建表，再写入演示数据。
 * ⚠️ 不要用它碰真实库 —— 真实库有自己的数据与迁移状态。
 */

import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSafeDbPath } from '../src/db/safe-db-path.js'
import { addDays, todayDateString } from '../src/services/dates.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

const rawPath = process.argv[2]
if (!rawPath || !isAbsolute(rawPath)) {
  console.error('用法：npx tsx seed/seed-v022-demo.ts <绝对路径的临时库>')
  process.exit(1)
}

const dbPath = resolve(rawPath)
assertSafeDbPath(dbPath, serverRoot)
if (existsSync(dbPath)) throw new Error('演示库必须是不存在的新文件，拒绝覆盖已有数据库')
const realDb = resolve(serverRoot, 'data', 'homechef.db')
if (dbPath.toLowerCase() === realDb.toLowerCase()) {
  console.error(`拒绝执行：目标指向真实库 —— ${dbPath}`)
  process.exit(1)
}
if (!existsSync(dirname(dbPath))) {
  console.error(`拒绝执行：父目录不存在 —— ${dirname(dbPath)}`)
  process.exit(1)
}

const sqlite = new Database(dbPath)
sqlite.pragma('foreign_keys = ON')

/* ---------- 1) 建表：复用既有迁移（与 migrate.ts 同一批 SQL） ---------- */
const drizzleDir = resolve(serverRoot, 'drizzle')
for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim()
    if (trimmed) sqlite.exec(trimmed)
  }
}

/* ---------- 2) 演示数据 ---------- */
const now = new Date().toISOString()
const day = (offset: number): string =>
  addDays(todayDateString(), offset)

const catRows = sqlite.prepare('select id, name from category').all() as Array<{
  id: number
  name: string
}>
const catId = new Map(catRows.map((c) => [c.name, c.id]))
function needCat(name: string): number {
  const id = catId.get(name)
  if (id === undefined) throw new Error(`缺少分类（迁移未建全？）：${name}`)
  return id
}

const definitions: Array<[number, string, string]> = [
  [1, '番茄', '蔬菜'],
  [2, '鸡蛋', '蛋类'],
  [3, '盐', '调味品'],
  [4, '土豆', '蔬菜'],
  [5, '牛奶', '乳制品'],
  [6, '猪肉', '猪肉'],
  [7, '青椒', '蔬菜'],
]

const recipes: Array<[number, string, Array<[number, number | null, string | null]>]> = [
  [1, '番茄炒蛋', [[1, 2, '个'], [2, 3, '个'], [3, 2, '克']]],
  [2, '青椒炒蛋', [[7, 2, '个'], [2, 2, '个'], [3, 2, '克']]],
  [3, '土豆炖肉', [[4, 3, '个'], [6, 300, '克'], [3, 3, '克']]],
  [4, '牛奶蒸蛋', [[2, 2, '个'], [5, 200, '毫升']]],
  [5, '醋溜土豆丝', [[4, 2, '个'], [7, 1, '个']]],
  [6, '番茄蛋汤', [[1, 1, '个'], [2, 1, '个']]],
]

/** 库存：含一项临期（鸡蛋）与一项**已过期**（牛奶），用于演示两种判定 */
const stock: Array<[number, number, string, string | null, string | null]> = [
  // definition, quantity, unit, expiry, source
  [3, 0, '个', null, null], // 调味品哨兵：数量 0 = 「家里有」
  [1, 5, '个', day(5), 'manual'],
  [2, 10, '个', day(2), 'manual'], // 临期（默认阈值 3 天）
  [4, 4, '个', null, null],
  [6, 500, '克', day(4), 'manual'],
  [7, 3, '个', null, null],
  [5, 500, '毫升', day(-3), 'manual'], // 已过期 → 不计入可用
]

sqlite.transaction(() => {
  const insDef = sqlite.prepare(
    'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
  )
  for (const [id, name, cat] of definitions) insDef.run(id, name, name, needCat(cat), now, now)

  const insRecipe = sqlite.prepare(
    'insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)',
  )
  const insLine = sqlite.prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?)',
  )
  for (const [id, name, lines] of recipes) {
    insRecipe.run(id, name, name, now, now)
    lines.forEach(([defId, qty, unit], i) => insLine.run(id, defId, qty, unit, i, now, now))
  }

  const insStock = sqlite.prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  )
  for (const [defId, qty, unit, expiry, source] of stock) {
    insStock.run(defId, qty, unit, day(-10), expiry, source, '常温', now, now)
  }
})()

const counts = {
  definition: (sqlite.prepare('select count(*) c from ingredient_definition').get() as { c: number }).c,
  recipe: (sqlite.prepare('select count(*) c from recipe').get() as { c: number }).c,
  stock: (sqlite.prepare('select count(*) c from standard_ingredient').get() as { c: number }).c,
  session: (sqlite.prepare('select count(*) c from cooking_session').get() as { c: number }).c,
}
sqlite.close()

console.log(`[seed-v022-demo] 完成：${dbPath}`)
console.log(`  食材定义 ${counts.definition} · 菜谱 ${counts.recipe} · 库存 ${counts.stock} · 会话 ${counts.session}`)
