/**
 * v0.2.4 验证：库存**批量删除**（服务层，隔离临时库）
 *
 * 覆盖：
 *   - 只删库存记录，不碰 ingredient_definition / 菜谱；
 *   - 重复 id 去重；
 *   - 任何一个 id 不存在 → **整批不删**；
 *   - 非法 id / 空数组 / 超过上限 → VALIDATION_ERROR；
 *   - 分块路径（>400 条）仍然原子；
 *   - 单条删除保持可用。
 *
 * ⚠️ 全程隔离临时库；绝不触碰 server/data。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-bulk-delete.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from './src/db/safe-db-path.js'

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
const runRoot = join(baseRoot, `hc-v024-bulk-${randomUUID()}`)
const dbPath = resolve(runRoot, `bulk-${Date.now()}.db`)
const realDb = resolve(serverRoot, 'data', 'homechef.db')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
}
if (resolve(dbPath).toLowerCase() === realDb.toLowerCase()) abort('测试库等于真实库')
if (!resolve(dbPath).startsWith(resolve(runRoot))) abort('测试库不在本次运行目录内')

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(serverRoot, 'drizzle')
const seed = new Database(dbPath)
seed.pragma('foreign_keys = ON')
for (const file of readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) seed.exec(t)
  }
}

const now = new Date().toISOString()
const cat = seed.prepare("select id from category where name = '蔬菜'").get() as { id: number }

seed
  .prepare(
    'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
  )
  .run(1, '番茄', '番茄', cat.id, now, now)
seed
  .prepare(
    'insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)',
  )
  .run(1, '番茄菜', '番茄菜', now, now)
seed
  .prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  .run(1, 1, 2, '个', 0, 'lk-1-0', now, now)

const insertStock = (id: number) =>
  seed
    .prepare(
      'insert into standard_ingredient (id, definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)',
    )
    .run(id, 1, 10, '个', '2026-01-01', null, null, '常温', now, now)

for (const id of [1, 2, 3, 4, 5]) insertStock(id)
seed.close()

// ⚠️ 必须在导入 db 模块**之前**设置库路径
process.env.HOME_CHEF_DB_PATH = dbPath
delete process.env.HOME_CHEF_ALLOW_REAL_DB

const { sqlite } = await import('./src/db/index.js')
const { deleteStock, deleteStocks, MAX_BULK_STOCK_DELETE } = await import(
  './src/services/standardIngredientService.js'
)

const stockCount = () =>
  (sqlite.prepare('select count(*) as c from standard_ingredient').get() as { c: number }).c
const defCount = () =>
  (sqlite.prepare('select count(*) as c from ingredient_definition').get() as { c: number }).c
const recipeCount = () =>
  (sqlite.prepare('select count(*) as c from recipe').get() as { c: number }).c

try {
  console.log('\n[A] 基本批量删除')

  const beforeDefs = defCount()
  const beforeRecipes = recipeCount()
  ok('A0 前置：5 条库存', stockCount() === 5, String(stockCount()))

  const r1 = deleteStocks([1, 2])
  ok(
    'A1 删除 2 条，返回去重后的 id',
    JSON.stringify(r1.deleted_ids) === JSON.stringify([1, 2]) && stockCount() === 3,
    JSON.stringify(r1),
  )
  ok(
    'A2 食材定义与菜谱未被删除',
    defCount() === beforeDefs && recipeCount() === beforeRecipes,
  )

  const r2 = deleteStocks([3, 3, 3])
  ok(
    'A3 重复 id 去重后只删一次',
    JSON.stringify(r2.deleted_ids) === JSON.stringify([3]) && stockCount() === 2,
    JSON.stringify(r2),
  )

  console.log('\n[B] 校验与原子性')

  let missingErr: any = null
  try {
    deleteStocks([4, 999999])
  } catch (e) {
    missingErr = e
  }
  ok(
    'B1 含不存在的 id → INGREDIENT_NOT_FOUND',
    missingErr !== null && missingErr.code === 'INGREDIENT_NOT_FOUND',
    String(missingErr?.code ?? missingErr),
  )
  ok(
    'B2 整批不删（4 仍然存在）',
    (sqlite.prepare('select count(*) as c from standard_ingredient where id = 4').get() as {
      c: number
    }).c === 1 && stockCount() === 2,
  )

  const invalidCases: Array<[string, unknown]> = [
    ['空数组', []],
    ['非整数', [4, 1.5]],
    ['非正数', [0]],
    ['非数字', [4, 'x']],
  ]
  for (const [label, ids] of invalidCases) {
    let err: any = null
    try {
      deleteStocks(ids as number[])
    } catch (e) {
      err = e
    }
    ok(`B3 非法输入（${label}）→ VALIDATION_ERROR`, err?.code === 'VALIDATION_ERROR', String(err?.code))
  }
  ok(
    'B4 非法输入后库存数量不变',
    stockCount() === 2,
    String(stockCount()),
  )

  const tooMany = Array.from({ length: MAX_BULK_STOCK_DELETE + 1 }, (_, i) => i + 1)
  let overErr: any = null
  try {
    deleteStocks(tooMany)
  } catch (e) {
    overErr = e
  }
  ok('B5 超过单次上限 → VALIDATION_ERROR', overErr?.code === 'VALIDATION_ERROR')

  console.log('\n[C] 分块路径（>400 条）与单条删除')

  const bulk = new Database(dbPath)
  bulk.pragma('foreign_keys = ON')
  const stmt = bulk.prepare(
    'insert into standard_ingredient (id, definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)',
  )
  const ids: number[] = []
  const tx = bulk.transaction(() => {
    for (let i = 0; i < 450; i++) {
      const id = 1000 + i
      stmt.run(id, 1, 1, '个', '2026-01-01', null, null, '常温', now, now)
      ids.push(id)
    }
  })
  tx()
  bulk.close()

  const before = stockCount()
  const r3 = deleteStocks(ids)
  ok(
    'C1 一次删除 450 条（跨分块）成功',
    r3.deleted_ids.length === 450 && stockCount() === before - 450,
    `${r3.deleted_ids.length}/${before}→${stockCount()}`,
  )

  const remaining = (
    sqlite.prepare('select id from standard_ingredient order by id').all() as Array<{ id: number }>
  ).map((r) => r.id)
  ok('C2 剩余库存符合预期', JSON.stringify(remaining) === JSON.stringify([4, 5]), JSON.stringify(remaining))

  deleteStock(4)
  ok('C3 单条删除仍然可用', stockCount() === 1, String(stockCount()))
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    sqlite.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-bulk-')) {
      console.error(`[WARN] 拒绝清理：目录名前缀不符 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(`[WARN] 清理失败需人工处理 —— ${resolve(runRoot)}：${String(e?.message ?? e)}`)
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
