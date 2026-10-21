/**
 * v0.2.4 验证（第一阶段 B）：推荐 apply 的**持久化幂等**
 *
 * 语义（Lumi 最终审查）：
 *   - `recommendation_request` 表：`request_id` 主键 + `payload_hash` + `session_id`
 *     + `response_json`（首次稳定响应）+ `created_at`；**无 TTL、无条数上限**。
 *   - 一个 `BEGIN IMMEDIATE` 事务内：查回执 → 同载荷重放 / 异载荷 409
 *     → 校验菜谱与快照 → 建会话与菜品 → 写回执；任一失败整体回滚。
 *   - 跨进程（两个服务实例共享同一隔离库）只允许创建**一个**会话。
 *   - 进程**真正重启**后同 key 仍能重放。
 *
 * ⚠️ 全程隔离临时库；绝不触碰 server/data；绝不设置 HOME_CHEF_ALLOW_REAL_DB。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-idempotency.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath, startServer, waitForReady } from './harness/server-lifecycle.js'

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
const runRoot = join(baseRoot, `hc-v024-idem-${randomUUID()}`)
const dbPath = resolve(runRoot, `v024-idem-${Date.now()}.db`)
const realDb = resolve(serverRoot, 'data', 'homechef.db')

const PORT_A = 64000 + Math.floor(Math.random() * 300)
const PORT_B = PORT_A + 400
const PORT_C = PORT_A + 800

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
}
if (resolve(dbPath).toLowerCase() === realDb.toLowerCase()) abort('测试库路径等于真实库')
if (!resolve(dbPath).startsWith(resolve(runRoot))) abort('测试库不在本次运行目录内')

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(serverRoot, 'drizzle')
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrations) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) setup.exec(t)
  }
}

const now = new Date().toISOString()
const catRows = setup.prepare('select id, name from category').all() as Array<{
  id: number
  name: string
}>
const catId = new Map(catRows.map((c) => [c.name, c.id]))
function requireCat(name: string): number {
  const id = catId.get(name)
  if (id === undefined) throw new Error(`测试数据依赖的分类不存在：${name}`)
  return id
}

const DEF_TOMATO = 1
const DEF_EGG = 2
for (const [id, name, cat] of [
  [DEF_TOMATO, '番茄', requireCat('蔬菜')],
  [DEF_EGG, '鸡蛋', requireCat('蛋类')],
] as Array<[number, string, number]>) {
  setup
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(id, name, name, cat, now, now)
}

function insertRecipe(id: number, name: string, lines: Array<[number, number, string]>) {
  setup
    .prepare('insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)')
    .run(id, name, name, now, now)
  let order = 0
  for (const [defId, qty, unit] of lines) {
    setup
      .prepare(
        'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
      )
      .run(id, defId, qty, unit, order, `lk-${id}-${order}`, now, now)
    order++
  }
}

insertRecipe(1, '番茄炒蛋', [
  [DEF_TOMATO, 2, '个'],
  [DEF_EGG, 3, '个'],
])
insertRecipe(2, '番茄汤', [[DEF_TOMATO, 3, '个']])
/**
 * 供 E 段「事后加菜」使用：**没有任何配料** → 不会进入推荐候选池，
 * 因此不会撞 UNIQUE(session_id, recipe_id)，也不会改变方案快照。
 */
insertRecipe(4, '空菜谱（不进推荐）', [])

setup
  .prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  )
  .run(DEF_TOMATO, 20, '个', '2026-01-01', null, null, '常温', now, now)
setup
  .prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  )
  .run(DEF_EGG, 20, '个', '2026-01-01', null, null, '常温', now, now)

setup.close()

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')
raw.pragma('busy_timeout = 5000')

const sessionCount = () =>
  (raw.prepare('select count(*) as c from cooking_session').get() as { c: number }).c

interface Res {
  status: number
  body: any
}
async function req(base: string, method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
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

type Handle = ReturnType<typeof startServer>
let serverA: Handle | null = null
let serverB: Handle | null = null
let serverC: Handle | null = null

async function boot(port: number): Promise<Handle> {
  const h = startServer({ cwd: serverRoot, port, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `http://127.0.0.1:${port}/health`, timeoutMs: 30_000, handle: h })
  return h
}

const baseOf = (port: number) => `http://127.0.0.1:${port}`

/**
 * 前置条件失败必须立刻中断 —— 否则后续断言会拿到 undefined，
 * 把"没跑起来"伪装成一堆看似正常的检查。
 */
function mustApplyOk(label: string, res: Res): number {
  const sessionId = res.body?.session_id
  if (res.status !== 200 || typeof sessionId !== 'number') {
    throw new Error(`${label} 前置失败：HTTP ${res.status} ${JSON.stringify(res.body)}`)
  }
  return sessionId
}

try {
  serverA = await boot(PORT_A)
  serverB = await boot(PORT_B)

  /* ---------- 取一份真实快照 ---------- */
  const rec = await req(baseOf(PORT_A), 'POST', '/api/recommendation/meal-plans', { people: 2 })
  if (rec.status !== 200 || !Array.isArray(rec.body?.plans) || rec.body.plans.length === 0) {
    throw new Error(`无法取得推荐方案：${rec.status} ${JSON.stringify(rec.body)}`)
  }
  const plan = rec.body.plans[0]
  const snapshotId: string = plan.snapshot_id
  const dishes = plan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings }))
  ok('0 取得可用的方案快照', typeof snapshotId === 'string' && dishes.length > 0)

  const applyBody = (requestId: string, payloadHashPayload = dishes) => ({
    people: 2,
    dishes: payloadHashPayload,
    snapshot_id: snapshotId,
    request_id: requestId,
  })

  console.log('\n[A] 基本重放与冲突')

  const key1 = `k-${randomUUID()}`
  const a1 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key1))
  const s1 = mustApplyOk('A1 首次 apply', a1)
  ok('A1 首次 apply 200', a1.status === 200, `${a1.status} ${JSON.stringify(a1.body)}`)
  ok('A2 首次响应没有 idempotent_replay 标记', a1.body?.idempotent_replay === undefined)
  ok('A3 只创建一个会话', sessionCount() === 1)

  const a2 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key1))
  ok(
    'A4 同 key 同载荷重放：同 session_id + idempotent_replay=true',
    a2.status === 200 && a2.body?.session_id === s1 && a2.body?.idempotent_replay === true,
    JSON.stringify(a2.body),
  )
  ok('A5 重放没有多建会话', sessionCount() === 1)

  const otherDishes = dishes.length > 1 ? [dishes[0]] : [{ recipe_id: 2, servings: 1 }]
  const a3 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key1, otherDishes))
  ok(
    'A6 同 key 异载荷 → 409 IDEMPOTENCY_CONFLICT',
    // ⚠️ 错误响应形状是 `{ error: { code, message } }`，不是顶层 code
    a3.status === 409 && a3.body?.error?.code === 'IDEMPOTENCY_CONFLICT',
    `${a3.status} ${JSON.stringify(a3.body)}`,
  )

  console.log('\n[B] 跨进程并发（两个实例共享同一隔离库）')

  const key2 = `k-${randomUUID()}`
  const before = sessionCount()
  const [b1, b2] = await Promise.all([
    req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key2)),
    req(baseOf(PORT_B), 'POST', '/api/recommendation/apply', applyBody(key2)),
  ])
  const bSid1 = mustApplyOk('B1 实例 A 并发请求', b1)
  const bSid2 = mustApplyOk('B1 实例 B 并发请求', b2)
  ok('B1 两个实例都返回 200', b1.status === 200 && b2.status === 200, `${b1.status}/${b2.status}`)
  ok('B2 两个实例拿到同一个 session_id', bSid1 === bSid2, `${bSid1} vs ${bSid2}`)
  ok('B3 只新增一个会话', sessionCount() === before + 1, `before=${before} after=${sessionCount()}`)
  ok(
    'B4 至少一个响应带 idempotent_replay=true',
    b1.body?.idempotent_replay === true || b2.body?.idempotent_replay === true,
    `${b1.body?.idempotent_replay}/${b2.body?.idempotent_replay}`,
  )

  console.log('\n[C] 事务失败不留回执')

  const key3 = `k-${randomUUID()}`
  const bad = await req(
    baseOf(PORT_A),
    'POST',
    '/api/recommendation/apply',
    applyBody(key3, [{ recipe_id: 9999, servings: 1 }]),
  )
  ok('C1 引用不存在的菜谱 → 404', bad.status === 404, `${bad.status} ${JSON.stringify(bad.body)}`)
  ok(
    'C2 失败事务没有留下回执行',
    (raw
      .prepare('select count(*) as c from recommendation_request where request_id = ?')
      .get(key3) as { c: number }).c === 0,
  )
  const retrySameKey = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key3))
  ok(
    'C3 同一个 key 之后仍可用（失败没有被当成"已存在"）',
    retrySameKey.status === 200,
    `${retrySameKey.status} ${JSON.stringify(retrySameKey.body)}`,
  )

  console.log('\n[D] 快照变化后仍按回执重放')

  const key4 = `k-${randomUUID()}`
  const d1 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key4))
  const dSid = mustApplyOk('D1 首次 apply', d1)
  ok('D1 首次成功', d1.status === 200)

  /**
   * 改变非调味品库存 → 快照必然失效；
   * 但同 key 必须依旧按**回执**重放（不能因为快照过期就 409）。
   * 之后把库存**精确恢复**，后续用例才能继续用同一份快照。
   */
  const tomatoQtyBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ?')
    .get(DEF_TOMATO) as { quantity: number }).quantity
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ?')
    .run(tomatoQtyBefore - 1, new Date().toISOString(), DEF_TOMATO)
  const d2 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key4))
  ok(
    'D2 快照过期但同 key 重放：仍返回原会话，不 409',
    d2.status === 200 && d2.body?.session_id === dSid && d2.body?.idempotent_replay === true,
    `${d2.status} ${JSON.stringify(d2.body)}`,
  )
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ?')
    .run(tomatoQtyBefore, new Date().toISOString(), DEF_TOMATO)
  const dRestored = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(`k-${randomUUID()}`))
  ok(
    'D3 库存精确恢复后，旧快照对新 key 重新有效',
    dRestored.status === 200,
    `${dRestored.status} ${JSON.stringify(dRestored.body)}`,
  )
  mustApplyOk('D3 恢复后新 key', dRestored)

  console.log('\n[E] 响应快照稳定（不用后续会话状态重建）')

  const key5 = `k-${randomUUID()}`
  const e1 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key5))
  const eSid = mustApplyOk('E1 首次 apply', e1)
  ok('E1 首次成功', e1.status === 200)
  /**
   * 事后给会话加一道**方案外**的菜（recipe 4，无配料、不进推荐池）：
   * 若重放是"用当前会话重建响应"，dish_count 会变大。
   * ⚠️ 不能插方案里已有的 recipe（会撞 UNIQUE(session_id, recipe_id)）。
   */
  raw
    .prepare(
      'insert into cooking_session_dish (session_id, recipe_id, status, servings, confirmed_revision, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    )
    .run(eSid, 4, 'pending', 1, 0, 9, now, now)
  const e2 = await req(baseOf(PORT_A), 'POST', '/api/recommendation/apply', applyBody(key5))
  ok(
    'E2 重放返回首次的 dish_count（response_json 原样返回）',
    e2.status === 200 && e2.body?.dish_count === e1.body?.dish_count,
    `${e1.body?.dish_count} vs ${e2.body?.dish_count}`,
  )

  console.log('\n[F] 进程重启后仍能重放')

  await serverA.stop()
  serverA = null
  serverC = await boot(PORT_C)
  const f1 = await req(baseOf(PORT_C), 'POST', '/api/recommendation/apply', applyBody(key1))
  ok(
    'F1 重启后同 key 重放：同 session_id + replay 标记',
    f1.status === 200 && f1.body?.session_id === s1 && f1.body?.idempotent_replay === true,
    `${f1.status} ${JSON.stringify(f1.body)}`,
  )

  console.log('\n[G] 没有 TTL / 没有条数上限')

  // ① 造 250 条其它回执（旧实现的 200 条上限会驱逐）
  const insertStub = raw.prepare(
    'insert into recommendation_request (request_id, payload_hash, session_id, response_json, created_at) values (?,?,?,?,?)',
  )
  for (let i = 0; i < 250; i++) {
    insertStub.run(`stub-${i}`, 'x'.repeat(64), s1, JSON.stringify({ session_id: s1 }), now)
  }
  const g1 = await req(baseOf(PORT_C), 'POST', '/api/recommendation/apply', applyBody(key1))
  ok(
    'G1 超过旧 200 条上限后，旧 key 仍然重放（不驱逐）',
    g1.status === 200 && g1.body?.session_id === s1 && g1.body?.idempotent_replay === true,
    `${g1.status} ${JSON.stringify(g1.body)}`,
  )

  // ② 一条"很旧"的回执（旧实现的 10 分钟 TTL 会过期）
  const keyOld = `k-${randomUUID()}`
  const g2 = await req(baseOf(PORT_C), 'POST', '/api/recommendation/apply', applyBody(keyOld))
  ok('G2 创建一条用于 TTL 检查的回执', g2.status === 200)
  raw
    .prepare('update recommendation_request set created_at = ? where request_id = ?')
    .run('2020-01-01T00:00:00.000Z', keyOld)
  const g3 = await req(baseOf(PORT_C), 'POST', '/api/recommendation/apply', applyBody(keyOld))
  ok(
    'G3 created_at 很旧也不影响去重（没有 TTL）',
    g3.status === 200 && g3.body?.session_id === g2.body?.session_id && g3.body?.idempotent_replay === true,
    `${g3.status} ${JSON.stringify(g3.body)}`,
  )

  // ③ 回执的载荷哈希确实入库
  const row = raw
    .prepare('select payload_hash, response_json from recommendation_request where request_id = ?')
    .get(key1) as { payload_hash: string; response_json: string } | undefined
  ok(
    'G4 回执保存了载荷哈希与首次响应 JSON',
    row !== undefined && row.payload_hash.length === 64 && JSON.parse(row.response_json).session_id === s1,
  )

  console.log('\n[H] 删除会话后去重保证结束（预期语义）')

  raw.prepare('delete from cooking_session where id = ?').run(s1)
  ok(
    'H1 回执随会话级联删除（文档已写明该保证到此结束）',
    (raw
      .prepare('select count(*) as c from recommendation_request where request_id = ?')
      .get(key1) as { c: number }).c === 0,
  )
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  for (const h of [serverA, serverB, serverC]) {
    try {
      await h?.stop()
    } catch (e: any) {
      console.error(`[WARN] stop: ${String(e?.message ?? e)}`)
    }
  }
  try {
    raw.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-idem-')) {
      console.error(`[WARN] 拒绝清理：目录名前缀不符 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(`[WARN] 清理失败需人工处理 —— ${resolve(runRoot)}；原因：${String(e?.message ?? e)}`)
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
