/**
 * v0.2.4 验证：测试库存计划（隔离临时库）
 *
 * 覆盖：
 *   - 只认「定义允许的单位」：菜谱里的非法组合（如 红枣/克）跳过并报告；
 *   - 非调味定义补足差额（不跨单位相加）；
 *   - 已有到期日 < 今天+90 → 拉长；已有更晚 → 保留；null → 补 +90；
 *   - **调味品不改日期、不造数值库存**；
 *   - 新批次储存方式按分类合理（肉→冷冻、菜/奶→冷藏），备注为测试值；
 *   - 同日第二次计划 0 补量 / 0 日期更新。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-stock-plan.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from './src/db/safe-db-path.js'
import { applyStock, planStock, storageMethodFor, MIN_EXPIRY_DAYS } from './seed/v024-content/stock.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-stock-${randomUUID()}`)
const dbPath = resolve(runRoot, `stock-${Date.now()}.db`)

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })
try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  console.error(`ABORT: ${String(e?.message ?? e)}`)
  process.exit(1)
}

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
for (const file of readdirSync(resolve(serverRoot, 'drizzle'))
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(resolve(serverRoot, 'drizzle', file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

const now = new Date().toISOString()
const today = new Date()
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysFromNow = (n: number) => {
  const d = new Date(today)
  d.setDate(d.getDate() + n)
  return iso(d)
}

try {
  const cat = (name: string) =>
    (db.prepare('select id from category where name = ?').get(name) as { id: number }).id

  const def = db.prepare(
    'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
  )
  def.run(1, '番茄', '番茄', cat('蔬菜'), now, now)
  def.run(2, '猪肉', '猪肉', cat('猪肉'), now, now)
  def.run(3, '红枣', '红枣', cat('干货/菌菇'), now, now)
  def.run(4, '盐', '盐', cat('调味品'), now, now)

  const unit = db.prepare('insert into ingredient_definition_unit (definition_id, unit, created_at) values (?,?,?)')
  unit.run(1, '克', now)
  unit.run(2, '克', now)
  unit.run(3, '个', now) // 红枣只允许「个」

  db.prepare('insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)')
    .run(1, '红枣炒肉', '红枣炒肉', now, now)
  const ri = db.prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  ri.run(1, 1, 100, '克', 0, 'lk-1-0', now, now)
  ri.run(1, 2, 200, '克', 1, 'lk-1-1', now, now)
  ri.run(1, 3, 50, '克', 2, 'lk-1-2', now, now) // 非法：红枣不允许克

  const stock = db.prepare(
    `insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, note, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
  )
  stock.run(1, 100, '克', '2026-01-01', daysFromNow(10), 'manual', '冷藏', null, now, now) // 需拉长
  stock.run(1, 50, '克', '2026-01-02', null, null, '冷藏', null, now, now) // null → +90
  stock.run(2, 200, '克', '2026-01-01', daysFromNow(200), 'manual', '冷冻', null, now, now) // 更晚 → 保留
  stock.run(4, 0, '个', '2026-01-01', daysFromNow(5), 'manual', '常温', null, now, now) // 调味品 → 不动

  console.log('\n[A] 计划正确性')

  const plan = planStock(db)
  ok(
    'A1 非法「红枣/克」被跳过并报告',
    plan.skipped_invalid_pairs.some((p) => p.definition_name === '红枣' && p.unit === '克'),
    JSON.stringify(plan.skipped_invalid_pairs),
  )
  ok(
    'A2 只为合法组合补量（番茄/猪肉）',
    plan.topups.some((t) => t.definition_name === '番茄') &&
      plan.topups.some((t) => t.definition_name === '猪肉') &&
      !plan.topups.some((t) => t.definition_name === '盐'),
  )
  ok(
    'A3 已有期限更晚的批次不被更新',
    !plan.expiry_updates.some((u) => u.definition_name === '猪肉' && u.from === daysFromNow(200)),
  )
  ok(
    'A4 调味品批次日期不被更新',
    !plan.expiry_updates.some((u) => u.definition_name === '盐'),
  )
  ok(
    'A5 null 到期日的非调味批次被补 +90 天',
    plan.expiry_updates.some((u) => u.definition_name === '番茄' && u.from === null && u.to === daysFromNow(MIN_EXPIRY_DAYS)),
  )

  console.log('\n[B] 执行与幂等')

  const result = db.transaction(() => applyStock(db, plan))()
  ok(
    'B1 执行条数与计划一致',
    result.updated_expiry === plan.expiry_updates.length &&
      result.inserted_batches === plan.topups.length,
    `${result.updated_expiry}/${plan.expiry_updates.length} ${result.inserted_batches}/${plan.topups.length}`,
  )

  const saltRow = db
    .prepare("select expiry_date from standard_ingredient where definition_id = 4")
    .get() as { expiry_date: string }
  ok('B2 调味品到期日保持原样', saltRow.expiry_date === daysFromNow(5), saltRow.expiry_date)

  const short = db
    .prepare(
      `select count(*) as c from standard_ingredient s
       join ingredient_definition d on d.id = s.definition_id
       left join category c on c.id = d.category_id
       where s.expiry_date is not null and s.expiry_date < ?
         and (c.name is null or c.name <> '调味品')`,
    )
    .get(daysFromNow(MIN_EXPIRY_DAYS)) as { c: number }
  ok('B3 非调味批次全部 ≥ 今天+90（调味品除外）', short.c === 0, String(short.c))

  const newPork = db
    .prepare("select storage_method from standard_ingredient where definition_id = 2 and note like 'v024 测试库存%' limit 1")
    .get() as { storage_method: string } | undefined
  ok('B4 新批次储存方式按分类（猪肉→冷冻）', newPork?.storage_method === '冷冻', String(newPork?.storage_method))
  ok('B5 storageMethodFor 分类映射', storageMethodFor('乳制品') === '冷藏' && storageMethodFor('主食/谷物') === '常温')

  const plan2 = planStock(db)
  ok('B6 同日第二次计划：0 补量 / 0 日期更新',
    plan2.topups.length === 0 && plan2.expiry_updates.length === 0,
    `topups=${plan2.topups.length} expiry=${plan2.expiry_updates.length}`)
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    db.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (!resolvedRun.startsWith(resolve(baseRoot)) || !basename(resolvedRun).startsWith('hc-v024-stock-')) {
      console.error(`[WARN] 拒绝清理：${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch {
    /* 忽略 */
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
