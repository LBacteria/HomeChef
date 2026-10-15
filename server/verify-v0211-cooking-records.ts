/**
 * v0.2.1.1 验证：烹饪记录的**迁移 0011（name 列）** + 改名 + 批量删除 + 时间倒序
 *
 * 覆盖：
 *   A. **路径安全**：先做共享 `assertSafeDbPath` 校验，之后才创建/删除任何文件
 *   B. **迁移保留性**：旧 schema 库插入旧记录 → 应用 0011 →
 *      记录数量 / started_at / 库存**完全不变**，且 `name` 全为 NULL（不回填）
 *   C. 全量迁移：全部 `drizzle/*.sql` 依次应用成功
 *   D. **改名**：保存 / 重新查询仍在 / trim / 恢复默认（null）/
 *      空白与超长被拒且不误写 / 非法与不存在的 ID / **改名不改变时间排序**
 *   E. **批量删除**（回归）：只删所选 + 从属记录、未选保留、
 *      库存不变、引用清除后菜谱可删、全有或全无、事务性
 *
 * ⚠️ 独立临时库 + 动态端口，绝不触碰 `server/data/homechef.db`。
 * ⚠️ 本次运行目录为 `<base>/hc-v0211-<uuid>/`，只清理这一个目录，
 *    绝不删除 `HOME_CHEF_TEST_DB_DIR` 本身。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import {
  assertSafeDbPath,
  startServer,
  waitForReady,
} from './harness/server-lifecycle.js'

/* ============================================================
 * A. 路径与安全闸 —— 必须在创建/删除任何文件**之前**
 * ============================================================ */

const PORT = 63000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()

/** 本次运行**唯一**的子目录：清理时只删它，不删 baseRoot */
const runRoot = join(baseRoot, `hc-v0211-${randomUUID()}`)
const dbPath = resolve(runRoot, `v0211-${Date.now()}.db`)

const realDb = resolve(serverRoot, 'data', 'homechef.db')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

// ① 共享安全校验（拒绝指向真实库及其 -wal/-shm；要求绝对路径）
try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝了本次测试库路径：${String(e?.message ?? e)}`)
}

// ② 额外自检：不等于真实库、且必须落在本次运行目录内
if (resolve(dbPath).toLowerCase() === realDb.toLowerCase()) {
  abort('测试库路径等于真实库')
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) {
  abort('测试库路径不在本次运行目录内')
}

// ③ 只有到这里才允许创建目录 / 删除文件
mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') =>
  console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)
const section = (t: string) => console.log(`\n===== ${t} =====`)

/* ============================================================
 * B. 建库：先只应用「0011 之前」的迁移，插入旧数据，再应用 0011
 * ============================================================ */

const drizzleDir = resolve(serverRoot, 'drizzle')
const allMigrations = readdirSync(drizzleDir)
  .filter((x) => x.endsWith('.sql'))
  .sort()

const NEW_MIGRATION = '0011_cooking_session_name.sql'
const newIdx = allMigrations.indexOf(NEW_MIGRATION)
if (newIdx < 0) abort(`找不到迁移文件 ${NEW_MIGRATION}`)
const oldMigrations = allMigrations.slice(0, newIdx)

/** better-sqlite3 的实例类型（默认导出是类，不能直接当类型用） */
type SqliteDb = InstanceType<typeof Database>

function execMigration(db: SqliteDb, file: string) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

const now = new Date().toISOString()
const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')

section('B1. 应用 0011 之前的迁移（模拟旧 schema 库）')
for (const f of oldMigrations) execMigration(setup, f)
info('已应用旧迁移', `${oldMigrations.length} 个（${oldMigrations[0]} … ${oldMigrations.at(-1)}）`)

const colsBefore = (setup.prepare('PRAGMA table_info(cooking_session)').all() as any[]).map(
  (c) => c.name as string,
)
ok('旧 schema 下 cooking_session **没有** name 列', !colsBefore.includes('name'))

/* ---------- 插入「旧记录」与基础数据 ---------- */
setup
  .prepare(
    'insert into ingredient_definition (name, name_normalized, created_at, updated_at) values (?,?,?,?)',
  )
  .run('番茄', '番茄', now, now)
setup
  .prepare(
    'insert into ingredient_definition (name, name_normalized, created_at, updated_at) values (?,?,?,?)',
  )
  .run('鸡蛋', '鸡蛋', now, now)
setup
  .prepare('insert into ingredient_definition_unit (definition_id, unit, created_at) values (?,?,?)')
  .run(1, '个', now)
setup
  .prepare('insert into ingredient_definition_unit (definition_id, unit, created_at) values (?,?,?)')
  .run(2, '个', now)
setup
  .prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?)',
  )
  .run(1, 10, '个', '2026-01-01', '常温', now, now)
setup
  .prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?)',
  )
  .run(2, 20, '个', '2026-01-01', '常温', now, now)

setup
  .prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
  .run('番茄炒蛋', '番茄炒蛋', now, now)
setup
  .prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  .run(1, 1, 2, '个', 0, 'k1', now, now)
setup
  .prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  .run(1, 2, 3, '个', 1, 'k2', now, now)
setup
  .prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
  .run('蒸蛋', '蒸蛋', now, now)
setup
  .prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  .run(2, 2, 1, '个', 0, 'k3', now, now)

/* 一条「旧记录」：settled 会话 + 一条菜品。name 列此时还不存在 */
setup
  .prepare(
    `insert into cooking_session (status, recipe_revision, started_at, created_at, updated_at)
     values ('settled', 0, '2026-01-01T00:00:00.000Z', ?, ?)`,
  )
  .run(now, now)
setup
  .prepare(
    `insert into cooking_session_dish
       (session_id, recipe_id, servings, status, confirmed_revision, sort_order, created_at, updated_at)
     values (1, 1, 1, 'done', 0, 0, ?, ?)`,
  )
  .run(now, now)

/* ---------- 迁移前快照 ---------- */
const oldSessionRows = () =>
  JSON.stringify(
    setup
      .prepare('select id, status, started_at, created_at, recipe_revision from cooking_session order by id')
      .all(),
  )
const snapSessions = oldSessionRows()
const snapCounts = JSON.stringify({
  sessions: (setup.prepare('select count(*) c from cooking_session').get() as any).c,
  dishes: (setup.prepare('select count(*) c from cooking_session_dish').get() as any).c,
  stock: (setup.prepare('select count(*) c from standard_ingredient').get() as any).c,
  recipes: (setup.prepare('select count(*) c from recipe').get() as any).c,
})
const snapStock = JSON.stringify(
  setup.prepare('select id, definition_id, quantity, unit from standard_ingredient order by id').all(),
)

section('B2. 应用迁移 0011')
execMigration(setup, NEW_MIGRATION)

const colsAfter = (setup.prepare('PRAGMA table_info(cooking_session)').all() as any[]).map(
  (c) => c.name as string,
)
ok('0011 后 cooking_session 出现 name 列', colsAfter.includes('name'))
const nameCol = (setup.prepare('PRAGMA table_info(cooking_session)').all() as any[]).find(
  (c) => c.name === 'name',
)
ok('name 列可为空（notnull = 0）', nameCol?.notnull === 0, `notnull=${nameCol?.notnull}`)

ok('旧记录数量未变', oldSessionRows() === snapSessions)
ok(
  '旧记录条数 / 菜品 / 库存 / 菜谱计数未变',
  JSON.stringify({
    sessions: (setup.prepare('select count(*) c from cooking_session').get() as any).c,
    dishes: (setup.prepare('select count(*) c from cooking_session_dish').get() as any).c,
    stock: (setup.prepare('select count(*) c from standard_ingredient').get() as any).c,
    recipes: (setup.prepare('select count(*) c from recipe').get() as any).c,
  }) === snapCounts,
)
ok(
  '库存数值未变',
  JSON.stringify(
    setup.prepare('select id, definition_id, quantity, unit from standard_ingredient order by id').all(),
  ) === snapStock,
)
const nullNames = (setup.prepare('select count(*) c from cooking_session where name is null').get() as any).c
const totalSessions = (setup.prepare('select count(*) c from cooking_session').get() as any).c
ok(
  '0011 **不回填**：全部历史行 name 均为 NULL',
  nullNames === totalSessions,
  `${nullNames}/${totalSessions}`,
)

section('B3. 全量迁移（全新库）')
const allDbPath = resolve(runRoot, `fresh-${Date.now()}.db`)
const fresh = new Database(allDbPath)
fresh.pragma('foreign_keys = ON')
let freshOk = true
try {
  for (const f of allMigrations) execMigration(fresh, f)
} catch (e: any) {
  freshOk = false
  info('全量迁移失败', String(e?.message ?? e))
}
fresh.close()
ok('全新库应用全部迁移成功', freshOk, `${allMigrations.length} 个迁移`)

setup.close()

/* ============================================================
 * 启动被测服务
 * ============================================================ */

let server: ReturnType<typeof startServer> | null = null

interface Res {
  status: number
  body: any
}
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')
const count = (sql: string, ...args: unknown[]) =>
  (raw.prepare(sql).get(...(args as any[])) as any).c as number
const nameOf = (id: number) =>
  (raw.prepare('select name from cooking_session where id = ?').get(id) as any)?.name ?? null
const stockSnapshot = () =>
  JSON.stringify(
    raw.prepare('select id, definition_id, quantity, unit from standard_ingredient order by id').all(),
  )

function dependentsOf(sessionId: number) {
  return {
    dishes: count('select count(*) c from cooking_session_dish where session_id = ?', sessionId),
    settlements: count('select count(*) c from cooking_settlement where session_id = ?', sessionId),
    skips: count('select count(*) c from cooking_session_dish_skip where session_id = ?', sessionId),
    items: count(
      `select count(*) c from cooking_settlement_item i
         join cooking_settlement s on s.id = i.settlement_id
        where s.session_id = ?`,
      sessionId,
    ),
  }
}

async function createSettledSession(recipeId: number): Promise<number> {
  const created = await req('POST', '/api/cooking/sessions', {})
  const id = created.body.id as number
  const added = await req('POST', `/api/cooking/sessions/${id}/dishes`, {
    recipe_id: recipeId,
    servings: 1,
  })
  const dishId = added.body.dishes[0].id as number
  const progressed = await req('PATCH', `/api/cooking/sessions/${id}/dishes/${dishId}/progress`, {
    status: 'done',
  })
  if (progressed.body.status !== 'awaiting_settlement') {
    throw new Error(`会话未进入待结算：${JSON.stringify(progressed.body.status)}`)
  }
  const settled = await req('POST', `/api/cooking/sessions/${id}/settle`, {})
  if (settled.status !== 200) {
    throw new Error(`结算失败：${settled.status} ${JSON.stringify(settled.body)}`)
  }
  return id
}

try {
  server = startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })

  /* ============================================================
   * D. 改名
   * ============================================================ */
  section('D. 行内改名（PATCH /api/cooking/sessions/:id/name）')
  const OLD = 1 // B 阶段插入的旧记录

  ok('旧记录初始 name 为 NULL', nameOf(OLD) === null, String(nameOf(OLD)))

  const renamed = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: '周三晚饭' })
  ok('改名返回 200', renamed.status === 200, `${renamed.status} ${JSON.stringify(renamed.body)}`)
  ok('响应体内 name 已更新', renamed.body?.name === '周三晚饭', String(renamed.body?.name))
  ok('数据库中已持久化', nameOf(OLD) === '周三晚饭', String(nameOf(OLD)))

  const listAfterRename = await req('GET', '/api/cooking/sessions')
  const oldInList = (listAfterRename.body as any[]).find((x) => x.id === OLD)
  ok('列表接口返回自定义名称', oldInList?.name === '周三晚饭', String(oldInList?.name))

  const detailAfterRename = await req('GET', `/api/cooking/sessions/${OLD}`)
  ok('详情接口返回同一名称', detailAfterRename.body?.name === '周三晚饭', String(detailAfterRename.body?.name))

  const trimmed = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: '  周五晚饭  ' })
  ok('名称两端空白被 trim', trimmed.status === 200 && nameOf(OLD) === '周五晚饭', String(nameOf(OLD)))

  const blankSpaces = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: '   ' })
  ok('纯空白被拒绝（400）', blankSpaces.status === 400, String(blankSpaces.status))
  ok('纯空白被拒后**未误写**', nameOf(OLD) === '周五晚饭', String(nameOf(OLD)))

  const emptyStr = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: '' })
  ok('空串被拒绝（400）', emptyStr.status === 400, String(emptyStr.status))
  ok('空串被拒后**未误写**', nameOf(OLD) === '周五晚饭', String(nameOf(OLD)))

  const tooLong = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: 'x'.repeat(61) })
  ok('超长（61）被拒绝（400）', tooLong.status === 400, String(tooLong.status))
  ok('超长被拒后**未误写**', nameOf(OLD) === '周五晚饭', String(nameOf(OLD)))

  const boundOk = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: 'y'.repeat(60) })
  ok('边界长度（60）被接受（200）', boundOk.status === 200, String(boundOk.status))
  ok('边界长度已写入', nameOf(OLD) === 'y'.repeat(60))

  const badIdZero = await req('PATCH', '/api/cooking/sessions/0/name', { name: 'x' })
  ok('非法 ID（0）→ 400', badIdZero.status === 400, String(badIdZero.status))

  const missingId = await req('PATCH', '/api/cooking/sessions/999999/name', { name: 'x' })
  ok('不存在的 ID → 404', missingId.status === 404, String(missingId.status))

  const extraField = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, {
    name: 'x',
    extra: 1,
  })
  ok('多余字段被拒绝（400，additionalProperties:false）', extraField.status === 400, String(extraField.status))

  const restored = await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: null })
  ok('传 null → 恢复默认（200）', restored.status === 200, String(restored.status))
  ok('恢复默认后 DB 中 name 为 NULL', nameOf(OLD) === null, String(nameOf(OLD)))
  ok('响应体 name 为 NULL', restored.body?.name === null, String(restored.body?.name))

  /* ============================================================
   * E. 时间排序 + 改名不影响排序
   * ============================================================ */
  section('E. 列表排序（烹饪时间倒序，同一时间按 id 降序）')
  const s2 = await createSettledSession(1)
  const s3 = await createSettledSession(2)

  raw
    .prepare("update cooking_session set started_at = '2026-01-02T00:00:00.000Z' where id = ?")
    .run(s2)
  // ⚠️ s3 与 s2 时间**完全相同** → 验证 id 降序的稳定次序
  raw
    .prepare("update cooking_session set started_at = '2026-01-02T00:00:00.000Z' where id = ?")
    .run(s3)

  const orderBefore = (await req('GET', '/api/cooking/sessions')).body.map((x: any) => x.id)
  ok(
    '顺序为 [S3, S2, 旧记录]（新 → 旧，同一时间 id 大者在前）',
    JSON.stringify(orderBefore) === JSON.stringify([s3, s2, OLD]),
    JSON.stringify(orderBefore),
  )

  await req('PATCH', `/api/cooking/sessions/${OLD}/name`, { name: '很久以前' })
  const orderAfter = (await req('GET', '/api/cooking/sessions')).body.map((x: any) => x.id)
  ok('改名后排序不变', JSON.stringify(orderAfter) === JSON.stringify(orderBefore), JSON.stringify(orderAfter))
  ok(
    '改名不改动 started_at',
    (raw.prepare('select started_at from cooking_session where id = ?').get(OLD) as any)
      .started_at === '2026-01-01T00:00:00.000Z',
  )

  /* ============================================================
   * F. 批量删除（回归）
   * ============================================================ */
  section('F. 非法 ID 与不存在的 ID（全有或全无）')
  const stockBefore = stockSnapshot()

  ok(
    '空数组被拒绝（400）',
    (await req('POST', '/api/cooking/sessions/batch-delete', { session_ids: [] })).status === 400,
  )
  ok(
    'id=0 被拒绝（400）',
    (await req('POST', '/api/cooking/sessions/batch-delete', { session_ids: [0] })).status === 400,
  )
  ok(
    '负数 id 被拒绝（400）',
    (await req('POST', '/api/cooking/sessions/batch-delete', { session_ids: [-1] })).status === 400,
  )
  ok(
    '字符串 id 被拒绝（400）',
    (await req('POST', '/api/cooking/sessions/batch-delete', { session_ids: ['abc'] })).status === 400,
  )

  const mixed = await req('POST', '/api/cooking/sessions/batch-delete', {
    session_ids: [s2, 999999],
  })
  ok('含不存在 id → 整批 404', mixed.status === 404, String(mixed.status))
  ok('整批拒绝后 s2 仍存在', count('select count(*) c from cooking_session where id = ?', s2) === 1)
  ok('整批拒绝后库存未变', stockSnapshot() === stockBefore)

  section('G. 批量删除所选记录及其从属记录')
  const del = await req('POST', '/api/cooking/sessions/batch-delete', { session_ids: [s2] })
  ok('返回 200', del.status === 200, String(del.status))
  ok(
    'deleted_ids 与请求一致',
    JSON.stringify(del.body?.deleted_ids) === JSON.stringify([s2]),
    JSON.stringify(del.body?.deleted_ids),
  )

  const dep = dependentsOf(s2)
  ok('s2 会话行已删除', count('select count(*) c from cooking_session where id = ?', s2) === 0)
  ok('s2 菜品行已删除', dep.dishes === 0)
  ok('s2 结算凭证已删除', dep.settlements === 0)
  ok('s2 结算明细已删除', dep.items === 0)
  ok('s2 跳过确认已删除', dep.skips === 0)

  ok('未选中的 s3 仍存在', count('select count(*) c from cooking_session where id = ?', s3) === 1)
  ok('未选中的旧记录仍存在', count('select count(*) c from cooking_session where id = ?', OLD) === 1)
  ok('s3 菜品行未被波及', dependentsOf(s3).dishes > 0)
  ok('s3 结算明细未被波及', dependentsOf(s3).items > 0)
  ok('改名过的记录名称未被删除操作清掉', nameOf(OLD) === '很久以前', String(nameOf(OLD)))

  section('H. 库存不变 + 菜谱删除关联')
  ok('删除前后库存快照一致', stockSnapshot() === stockBefore)
  ok('库存记录条数未变', count('select count(*) c from standard_ingredient') === 2)

  const delRecipe1Blocked = await req('DELETE', '/api/recipes/1')
  ok(
    '菜谱 1 仍被**未选中的**旧记录引用 → 拒绝（非 2xx）',
    delRecipe1Blocked.status >= 400,
    String(delRecipe1Blocked.status),
  )
  const delRecipe2 = await req('DELETE', '/api/recipes/2')
  ok('菜谱 2 仍被 s3 引用 → 拒绝（非 2xx）', delRecipe2.status >= 400, String(delRecipe2.status))

  section('I. 清空剩余记录 + 最终核对')
  const delRest = await req('POST', '/api/cooking/sessions/batch-delete', {
    session_ids: [s3, OLD],
  })
  ok('删除剩余记录（200）', delRest.status === 200, String(delRest.status))
  ok('列表已清空', ((await req('GET', '/api/cooking/sessions')).body as any[]).length === 0)
  ok('全部会话行已删除', count('select count(*) c from cooking_session') === 0)
  ok('全部菜品行已删除', count('select count(*) c from cooking_session_dish') === 0)
  ok('全部结算凭证已删除', count('select count(*) c from cooking_settlement') === 0)
  ok('全部结算明细已删除', count('select count(*) c from cooking_settlement_item') === 0)
  ok('最终库存快照仍与删除前一致', stockSnapshot() === stockBefore)
  ok('食材定义未被删除', count('select count(*) c from ingredient_definition') === 2)

  const delRecipe1Now = await req('DELETE', '/api/recipes/1')
  ok(
    '菜谱 1 在**全部**引用清除后可删除（2xx）',
    delRecipe1Now.status >= 200 && delRecipe1Now.status < 300,
    String(delRecipe1Now.status),
  )
  const delRecipe2Again = await req('DELETE', '/api/recipes/2')
  ok(
    '菜谱 2 在**全部**引用清除后可删除（2xx）',
    delRecipe2Again.status >= 200 && delRecipe2Again.status < 300,
    String(delRecipe2Again.status),
  )
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    await server?.stop()
  } catch (e: any) {
    console.error(`[WARN] 停止服务失败：${String(e?.message ?? e)}`)
  }
  try {
    raw.close()
  } catch {
    /* 忽略 */
  }

  /* ---------- 只清理**本次运行目录**；失败必须可诊断 ---------- */
  try {
    const resolvedRun = resolve(runRoot)
    const resolvedBase = resolve(baseRoot)
    const resolvedRealData = resolve(serverRoot, 'data')

    if (resolvedRun.toLowerCase() === resolvedRealData.toLowerCase()) {
      console.error(`[WARN] 拒绝清理：运行目录等于受保护的 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolvedBase)) {
      console.error(`[WARN] 拒绝清理：运行目录不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v0211-')) {
      console.error(`[WARN] 拒绝清理：目录名不符合本次运行前缀 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(
      `[WARN] 清理失败，需人工处理 —— 目录：${resolve(runRoot)}；原因：${String(e?.message ?? e)}`,
    )
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
