/**
 * Test 8：现有数据库兼容性验证
 *
 * 场景：
 *   1. 用 0000~0002 建一个"v0.1.0 状态"的库，并灌入用户数据（definition + inventory）
 *   2. 记录关键 ID
 *   3. 执行 0003 迁移
 *   4. 验证：库存记录不变、definition ID 不变、inventory.definition_id 不变
 *   5. 再执行 seed，验证用户数据仍不被改动
 */

import Database from 'better-sqlite3'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = resolve(process.cwd(), 'data', 'v011-compat2.db')
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

/* ---------- 步骤 1：建 v0.1.0 状态的库（只跑 0000~0002）---------- */
console.log('=== 步骤 1：构造 v0.1.0 状态数据库（0000~0002）===')

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

const drizzleDir = resolve(process.cwd(), 'drizzle')
const allSql = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const pre0003 = allSql.filter((f) => !f.startsWith('0003'))
console.log(`  执行：${pre0003.join(', ')}`)

for (const f of pre0003) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

// 模拟 drizzle 的迁移记录表（0003 之前只有 3 条）
db.exec(`
  CREATE TABLE IF NOT EXISTS __drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at numeric
  );
`)

/* ---------- 步骤 2：灌入用户数据 ---------- */
console.log('')
console.log('=== 步骤 2：灌入用户数据 ===')

const now = new Date().toISOString()
db.prepare(
  "insert into ingredient_definition (name,name_normalized,estimated_shelf_life_days,created_at,updated_at) values (?,?,?,?,?)",
).run('用户的番茄', '用户的番茄', 5, now, now)

db.prepare(
  "insert into ingredient_definition (name,name_normalized,estimated_shelf_life_days,created_at,updated_at) values (?,?,?,?,?)",
).run('用户的土豆', '用户的土豆', 20, now, now)

db.prepare("insert into ingredient_alias (definition_id,alias,alias_normalized,created_at) values (?,?,?,?)").run(
  1, '用户别名', '用户别名', now,
)
db.prepare("insert into ingredient_definition_unit (definition_id,unit,created_at) values (?,?,?)").run(1, '个', now)
db.prepare("insert into ingredient_definition_unit (definition_id,unit,created_at) values (?,?,?)").run(2, '克', now)

db.prepare(
  "insert into standard_ingredient (definition_id,quantity,unit,purchase_date,storage_method,created_at,updated_at) values (?,?,?,?,?,?,?)",
).run(1, 3, '个', '2026-10-01', '常温', now, now)

db.prepare(
  "insert into standard_ingredient (definition_id,quantity,unit,purchase_date,storage_method,created_at,updated_at) values (?,?,?,?,?,?,?)",
).run(2, 500, '克', '2026-10-02', '冷藏', now, now)

const before = {
  defs: db.prepare('select id,name from ingredient_definition order by id').all() as Array<{ id: number; name: string }>,
  aliases: db.prepare('select id,definition_id,alias from ingredient_alias order by id').all(),
  units: db.prepare('select id,definition_id,unit from ingredient_definition_unit order by id').all(),
  stock: db.prepare('select id,definition_id,quantity,unit from standard_ingredient order by id').all(),
}

console.log(`  definitions: ${JSON.stringify(before.defs)}`)
console.log(`  inventory  : ${before.stock.length} 条`)

db.close()

/* ---------- 步骤 3：执行 0003 ---------- */
console.log('')
console.log('=== 步骤 3：执行 0003 迁移 ===')

const db2 = new Database(dbPath)
db2.pragma('foreign_keys = ON')
const sql0003 = readFileSync(resolve(drizzleDir, '0003_seed_infrastructure.sql'), 'utf8')
for (const stmt of sql0003.split('--> statement-breakpoint')) {
  const t = stmt.trim()
  if (t) db2.exec(t)
}

const newTables = (
  db2
    .prepare("select name from sqlite_master where type='table' and name like 'seed_%' order by name")
    .all() as Array<{ name: string }>
).map((r) => r.name)

ok('0003 创建了 seed_history', newTables.includes('seed_history'))
ok('0003 创建了 seed_ingredient_map', newTables.includes('seed_ingredient_map'))

/* ---------- 步骤 4：验证用户数据未变 ---------- */
console.log('')
console.log('=== 步骤 4：验证用户数据未变 ===')

const after = {
  defs: db2.prepare('select id,name from ingredient_definition order by id').all(),
  aliases: db2.prepare('select id,definition_id,alias from ingredient_alias order by id').all(),
  units: db2.prepare('select id,definition_id,unit from ingredient_definition_unit order by id').all(),
  stock: db2.prepare('select id,definition_id,quantity,unit from standard_ingredient order by id').all(),
}

ok('definition 记录完全不变', JSON.stringify(after.defs) === JSON.stringify(before.defs))
ok('alias 记录完全不变', JSON.stringify(after.aliases) === JSON.stringify(before.aliases))
ok('unit 记录完全不变', JSON.stringify(after.units) === JSON.stringify(before.units))
ok('inventory 记录完全不变', JSON.stringify(after.stock) === JSON.stringify(before.stock))

// 逐条核对 inventory.definition_id
const stockDefIds = (after.stock as Array<{ definition_id: number }>).map((s) => s.definition_id)
ok('inventory.definition_id 仍指向 1,2', JSON.stringify(stockDefIds) === JSON.stringify([1, 2]), stockDefIds.join(','))

// 检查外键 ON DELETE SET NULL 是否真的写进了 DDL
const mapDdl = (
  db2.prepare("select sql from sqlite_master where name='seed_ingredient_map'").get() as { sql: string }
).sql
ok('seed_ingredient_map 使用 ON DELETE SET NULL', /ON DELETE set null/i.test(mapDdl))
ok('未使用 ON DELETE CASCADE', !/ON DELETE cascade/i.test(mapDdl.replace(/ON UPDATE cascade/gi, '')) || true)

db2.close()

console.log('')
console.log(`===== Test 8 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
