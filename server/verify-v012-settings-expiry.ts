/**
 * v0.1.2 批次一验证：设置系统 + 临期状态计算
 *
 * 覆盖：
 *   - 设置：默认值 / 读取 / 更新 / 持久化 / 非法输入 / 边界值
 *   - 临期：no_expiry / normal / expiring / expired，days 与 percentage 两种模式
 *   - 题目第九节列出的 16 个边界情况
 *   - 关键断言：修改临期设置**不会修改任何库存的 expiry_date**
 *
 * 使用独立临时库与动态端口，不触碰正式库。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath, startServer, waitForReady, ServerStartupError, type ServerHandle } from './harness/server-lifecycle.js'

const PORT = 35000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`

/**
 * v0.2.3 **测试隔离修复**：
 *   默认根目录改为**系统 tmp 下的独立随机目录**（`hc-v012-<uuid>`），
 *   **不再**默认 `server/data` —— 后者是受保护区，测试产物不得落在那里。
 *   `HOME_CHEF_TEST_DB_DIR` 仍可覆盖（用于统一指定临时根）。
 */
const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v012-${randomUUID()}`)
const dbPath = resolve(runRoot, `v012-settings-${Date.now()}.db`)

/* ---------- 路径保护（必须在创建 / 写入任何文件之前） ---------- */
const realDb = resolve(serverRoot, 'data', 'homechef.db')
try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e) {
  console.error(`ABORT: assertSafeDbPath 拒绝：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
if (resolve(dbPath).toLowerCase() === realDb.toLowerCase()) {
  console.error('ABORT: 测试库路径等于真实库')
  process.exit(1)
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) {
  console.error('ABORT: 测试库不在本次运行目录内')
  process.exit(1)
}

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* 收尾：只删除**本次自己的** runRoot（三重守卫），异常路径同样生效 */
process.on('exit', () => {
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) return
    if (!resolvedRun.startsWith(resolve(baseRoot))) return
    if (!basename(resolvedRun).startsWith('hc-v012-')) return
    rmSync(resolvedRun, { recursive: true, force: true })
  } catch {
    /* 交给系统回收 */
  }
})

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) setup.exec(t)
  }
}
setup.close()

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') => console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

interface Res { status: number; body: any }
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text.length > 0 ? JSON.parse(text) : undefined } catch { parsed = undefined }
  return { status: res.status, body: parsed }
}

/*
 * ⚠️ 直接启动 Node（**不经 npx、不经 shell**）：
 *    原写法 `spawn('npx', [...], { shell: true })` 会插入 cmd.exe 外壳，
 *    `proc.kill()` 只能终止外壳，npx/tsx/node 三代子进程会逃逸成孤儿。
 *    现在 `handle.proc.pid` 就是真实服务进程，停止即刻生效。
 *    详见 harness/server-lifecycle.ts。
 *
 * 本脚本需要**重启服务**（验证设置持久化），故封装为可重复调用的启动函数。
 */
async function startServerAndWait(): Promise<ServerHandle> {
  const handle = startServer({
    cwd: process.cwd(),
    port: PORT,
    dbPath,
    // 保留输出（有上限），启动失败时能打印 stderr 而不是完全不可见
    stdio: 'pipe',
  })
  // 绝对超时：服务**提前退出**或超过 30s 未就绪都会抛错，绝不无限等待
  try {
    await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle })
  } catch (e) {
    // 就绪失败也必须停掉刚启动的进程，避免残留
    await handle.stop()
    throw e
  }
  return handle
}

// 预检端口必须空闲：否则会连到旧实例的旧数据库并产生误判
try { await fetch(`${BASE}/health`); console.log(`[FAIL] 端口 ${PORT} 已占用`); process.exit(1) } catch { /* 未占用，继续 */ }

let server: ServerHandle
try {
  server = await startServerAndWait()
} catch (e) {
  console.log('[FAIL] 服务未就绪：' + (e instanceof Error ? e.message : String(e)))
  if (e instanceof ServerStartupError && e.detail.length > 0) console.log(e.detail)
  process.exit(1)
}
console.log(`server ${BASE}\n`)

/** 以本地日历今天为基准，再使用 UTC 做纯日期加减 */
function shiftDays(days: number): string {
  const now = new Date()
  // Anchor on the local calendar day; use UTC only for date arithmetic.
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

try {
  /* ============================================================
   * 一、设置系统
   * ============================================================ */
  console.log('===== 一、设置系统 =====')

  console.log('\n--- 默认值 ---')
  const def = await req('GET', '/api/settings')
  ok('GET /api/settings 返回 200', def.status === 200, `${def.status}`)
  ok('默认 mode = days', def.body.expiry_warning_mode === 'days', `${def.body.expiry_warning_mode}`)
  ok('默认 threshold = 3', def.body.expiry_warning_threshold === 3, `${def.body.expiry_warning_threshold}`)
  ok('默认 allow_expired_for_recipe = false', def.body.allow_expired_for_recipe === false,
    `${def.body.allow_expired_for_recipe}`)
  ok('boolean 是真正的 boolean（不是 0/1）', typeof def.body.allow_expired_for_recipe === 'boolean')

  console.log('\n--- 更新 ---')
  const u1 = await req('PATCH', '/api/settings', { expiry_warning_threshold: 5 })
  ok('更新 threshold → 200', u1.status === 200, `${u1.status}`)
  ok('threshold = 5', u1.body.expiry_warning_threshold === 5, `${u1.body.expiry_warning_threshold}`)
  ok('未提供的字段保持', u1.body.expiry_warning_mode === 'days')

  const u2 = await req('PATCH', '/api/settings', { allow_expired_for_recipe: true })
  ok('更新 boolean → true', u2.body.allow_expired_for_recipe === true)

  const u3 = await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 15 })
  ok('切到 percentage 模式 → 200', u3.status === 200, `${u3.status}`)
  ok('mode = percentage', u3.body.expiry_warning_mode === 'percentage')
  ok('threshold = 15', u3.body.expiry_warning_threshold === 15)

  const back = await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })
  ok('切回 days → 200', back.status === 200)

  console.log('\n--- 非法输入 ---')
  ok('非法 mode → 400', (await req('PATCH', '/api/settings', { expiry_warning_mode: 'weeks' })).status === 400)
  ok('mode 为数字 → 400', (await req('PATCH', '/api/settings', { expiry_warning_mode: 123 })).status === 400)
  ok('threshold 为字符串 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_threshold: '3' })).status === 400)
  ok('threshold 为负数 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_threshold: -1 })).status === 400)
  ok('allow_expired 用字符串 → 400',
    (await req('PATCH', '/api/settings', { allow_expired_for_recipe: 'true' })).status === 400)
  ok('allow_expired 用 1 → 400',
    (await req('PATCH', '/api/settings', { allow_expired_for_recipe: 1 })).status === 400)
  ok('未知字段 → 400', (await req('PATCH', '/api/settings', { nope: 1 })).status === 400)
  ok('空 body → 400', (await req('PATCH', '/api/settings', {})).status === 400)
  ok('percentage 超过 100 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 101 })).status === 400)
  ok('days 模式小数阈值 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 2.5 })).status === 400)

  console.log('\n--- 边界值 ---')
  ok('threshold = 0（days）→ 200',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 0 })).status === 200)
  ok('percentage = 0 → 200',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 0 })).status === 200)
  ok('percentage = 100 → 200',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 100 })).status === 200)

  // 复位
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  /* ============================================================
   * 二、临期状态
   * ============================================================ */
  console.log('\n\n===== 二、临期状态 =====')

  const tomato = await req('POST', '/api/definitions', {
    name: '番茄', units: ['个', '克'], estimated_shelf_life_days: 10,
  })
  const noShelf = await req('POST', '/api/definitions', { name: '无保质期', units: ['克'], estimated_shelf_life_days: null })
  const T = tomato.body.id, N = noShelf.body.id

  async function statusOf(id: number): Promise<any> {
    const res = await req('GET', `/api/ingredients?includeZero=true`)
    return res.body.find((r: any) => r.id === id)
  }

  console.log('\n--- 边界 1：expiry_date = NULL ---')
  const b1 = await req('POST', '/api/ingredients', { definition_id: N, quantity: 1, unit: '克', purchase_date: shiftDays(0) })
  const b1row = await statusOf(b1.body.id)
  ok('no_expiry 状态', b1row.expiry_status === 'no_expiry', `${b1row.expiry_status}`)
  ok('days_remaining = null', b1row.days_remaining === null)

  console.log('\n--- days 模式（threshold = 3）---')
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  // 边界 2：今天正好 expiry_date
  const b2 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(0) })
  const b2row = await statusOf(b2.body.id)
  ok('边界2：今天到期 → expiring（剩余 0 <= 3）', b2row.expiry_status === 'expiring', `${b2row.expiry_status}`)
  ok('  days_remaining = 0', b2row.days_remaining === 0, `${b2row.days_remaining}`)

  // 边界 3：已过期 1 天
  const b3 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-10), expiry_date: shiftDays(-1) })
  const b3row = await statusOf(b3.body.id)
  ok('边界3：已过期 1 天 → expired', b3row.expiry_status === 'expired', `${b3row.expiry_status}`)
  ok('  days_remaining = -1', b3row.days_remaining === -1, `${b3row.days_remaining}`)

  // 边界 4：剩余正好 threshold（3 天）
  const b4 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(3) })
  const b4row = await statusOf(b4.body.id)
  ok('边界4：剩余正好 3 天 → expiring（<= 临界）', b4row.expiry_status === 'expiring', `${b4row.expiry_status}`)

  // 边界 5：剩余比 threshold 多 1 天（4 天）
  const b5 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(4) })
  const b5row = await statusOf(b5.body.id)
  ok('边界5：剩余 4 天 → normal', b5row.expiry_status === 'normal', `${b5row.expiry_status}`)

  console.log('\n--- 边界 14：threshold = 0 ---')
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 0 })
  const t0a = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(0) })
  const t0arow = await statusOf(t0a.body.id)
  ok('threshold=0：今天到期（剩余0）→ expiring', t0arow.expiry_status === 'expiring', `${t0arow.expiry_status}`)
  const t0b = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(1) })
  const t0brow = await statusOf(t0b.body.id)
  ok('threshold=0：剩余 1 天 → normal', t0brow.expiry_status === 'normal', `${t0brow.expiry_status}`)
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 3 })

  console.log('\n--- estimated vs manual ---')
  const est = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(0) })
  const estrow = await statusOf(est.body.id)
  ok('边界11：estimated 记录有 expiry', estrow.expiry_date !== null, `${estrow.expiry_date}`)
  ok('  source = estimated', estrow.expiry_date_source === 'estimated')
  info('  estimated expiry', `${estrow.expiry_date}（purchase + 10 天）`)

  const man = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-1), expiry_date: shiftDays(2) })
  const manrow = await statusOf(man.body.id)
  ok('边界12：manual 记录 source = manual', manrow.expiry_date_source === 'manual')
  ok('  manual 剩余 2 天 → expiring', manrow.expiry_status === 'expiring', `${manrow.expiry_status}`)

  console.log('\n--- 边界 9/10：production_date ---')
  const withProd = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-2), production_date: shiftDays(-5),
  })
  const withProdRow = await statusOf(withProd.body.id)
  ok('边界9：有 production_date，estimated expiry = production + 10',
    withProdRow.expiry_date === shiftDays(5), `${withProdRow.expiry_date} vs ${shiftDays(5)}`)
  info('  purchase =', shiftDays(-2))
  info('  production =', shiftDays(-5))
  info('  expiry =', withProdRow.expiry_date)

  const noProd = await req('POST', '/api/ingredients', { definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-2) })
  const noProdRow = await statusOf(noProd.body.id)
  ok('边界10：无 production_date，estimated expiry = purchase + 10',
    noProdRow.expiry_date === shiftDays(8), `${noProdRow.expiry_date} vs ${shiftDays(8)}`)

  /* ============================================================
   * percentage 模式
   * ============================================================ */
  console.log('\n\n===== percentage 模式 =====')

  // 构造：start = purchase（无 production），总时长 10 天
  // purchase = today-5，expiry = today+5 → total = 10，remaining = 5 → 50%
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 50 })
  const p50 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-5), expiry_date: shiftDays(5),
  })
  const p50row = await statusOf(p50.body.id)
  ok('边界6：percentage 正好等于 threshold(50%) → expiring',
    p50row.expiry_status === 'expiring', `${p50row.expiry_status} @ ${p50row.remaining_percentage}%`)
  ok('  remaining_percentage = 50', p50row.remaining_percentage === 50, `${p50row.remaining_percentage}`)

  // 边界 7：略高于 threshold（remaining 6/10 = 60%）
  const p60 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-4), expiry_date: shiftDays(6),
  })
  const p60row = await statusOf(p60.body.id)
  ok('边界7：60% > 50% → normal', p60row.expiry_status === 'normal',
    `${p60row.expiry_status} @ ${p60row.remaining_percentage}%`)

  // 边界 8：略低于 threshold（remaining 4/10 = 40%）
  const p40 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-6), expiry_date: shiftDays(4),
  })
  const p40row = await statusOf(p40.body.id)
  ok('边界8：40% < 50% → expiring', p40row.expiry_status === 'expiring',
    `${p40row.expiry_status} @ ${p40row.remaining_percentage}%`)

  console.log('\n--- percentage：已过期永远优先 ---')
  const pexp = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(-20), expiry_date: shiftDays(-1),
  })
  const pexpRow = await statusOf(pexp.body.id)
  ok('已过期时即使 percentage 很低也是 expired', pexpRow.expiry_status === 'expired',
    `${pexpRow.expiry_status} @ ${pexpRow.remaining_percentage}%`)

  console.log('\n--- percentage：production_date 作为起点 ---')
  // start = production = today-8，expiry = today+2 → total 10，remaining 2 → 20%
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 25 })
  const pprod = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个',
    purchase_date: shiftDays(-3), production_date: shiftDays(-8), expiry_date: shiftDays(2),
  })
  const pprodRow = await statusOf(pprod.body.id)
  info('  purchase =', shiftDays(-3), ' production =', shiftDays(-8), ' expiry =', shiftDays(2))
  ok('起点使用 production_date（20% <= 25% → expiring）',
    pprodRow.expiry_status === 'expiring', `${pprodRow.expiry_status} @ ${pprodRow.remaining_percentage}%`)
  ok('  remaining_percentage = 20', pprodRow.remaining_percentage === 20, `${pprodRow.remaining_percentage}`)

  console.log('\n--- percentage：purchase === expiry（总时长为 0）---')
  const pzero = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(0), expiry_date: shiftDays(0),
  })
  const pzeroRow = await statusOf(pzero.body.id)
  ok('边界13：purchase === expiry → 今天到期 → expiring',
    pzeroRow.expiry_status === 'expiring', `${pzeroRow.expiry_status}`)
  ok('  remaining_percentage = null（无法表达比例）',
    pzeroRow.remaining_percentage === null, `${pzeroRow.remaining_percentage}`)

  console.log('\n--- percentage > 100 的异常情况 ---')
  // start = today-1（purchase），expiry = today+50 → 总 51 天，剩余 50 天 ≈ 98%
  // 用更极端的：expiry 远大于 start + 常规 → 剩余 > 100 需要 remaining > total，不可能。
  // 真实可达 >100% 的场景：manual expiry 早于... 实际 remaining<=total 恒成立。
  // 但若 start > today（用户把 purchase 设成未来），remaining 可能 > total → >100%
  const pfut = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: shiftDays(5), expiry_date: shiftDays(10),
  })
  const pfutRow = await statusOf(pfut.body.id)
  info('  purchase 在未来 (+5)，expiry +10')
  info('  total = 5 天，remaining = 10 天 → 200%')
  ok('remaining_percentage > 100 时判为 normal（不报错）',
    pfutRow.expiry_status === 'normal',
    `${pfutRow.expiry_status} @ ${pfutRow.remaining_percentage}%`)
  ok('  percentage = 200（未被截断）', pfutRow.remaining_percentage === 200, `${pfutRow.remaining_percentage}`)

  /* ============================================================
   * 三、关键断言：改设置不改 expiry_date
   * ============================================================ */
  console.log('\n\n===== 三、改设置不影响 expiry_date（关键）=====')

  const beforeSettings = await req('GET', '/api/ingredients?includeZero=true')
  const snapshotBefore = beforeSettings.body
    .map((r: any) => `${r.id}:${r.expiry_date}:${r.expiry_date_source}`)
    .sort()

  // 反复修改设置
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 30 })
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 99 })
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 0 })
  await req('PATCH', '/api/settings', { allow_expired_for_recipe: true })

  const afterSettings = await req('GET', '/api/ingredients?includeZero=true')
  const snapshotAfter = afterSettings.body
    .map((r: any) => `${r.id}:${r.expiry_date}:${r.expiry_date_source}`)
    .sort()

  ok('所有 expiry_date / source 完全未变',
    JSON.stringify(snapshotBefore) === JSON.stringify(snapshotAfter),
    `${snapshotBefore.length} 条记录`)

  // 状态本身确实随设置变化（证明设置生效，但只影响"状态"不影响"数据"）
  const statusChanged = beforeSettings.body.some((r: any, i: number) =>
    r.expiry_status !== afterSettings.body[i].expiry_status)
  ok('临期状态确实随设置重新计算', statusChanged, statusChanged ? '状态已按新设置变化' : '（本例中状态恰好未变）')

  // 直接查库确认
  const dbRows = raw.prepare('select id, expiry_date, expiry_date_source from standard_ingredient order by id').all() as Array<any>
  const dbSnapshot = dbRows.map((r) => `${r.id}:${r.expiry_date}:${r.expiry_date_source}`).sort()
  ok('直接查库结果一致', JSON.stringify(dbSnapshot) === JSON.stringify(snapshotBefore))

  /* ============================================================
   * 四、持久化（重启后仍在）
   * ============================================================ */
  console.log('\n\n===== 四、持久化 =====')

  await req('PATCH', '/api/settings', {
    expiry_warning_mode: 'percentage', expiry_warning_threshold: 42, allow_expired_for_recipe: true,
  })

  // 幂等停止（harness 会等待进程真正退出，无需再手动 sleep）
  await server.stop()

  try {
    server = await startServerAndWait()
  } catch (e) {
    console.log('[FAIL] 重启后服务未就绪：' + (e instanceof Error ? e.message : String(e)))
    if (e instanceof ServerStartupError && e.detail.length > 0) console.log(e.detail)
  }

  {
    const afterRestart = await req('GET', '/api/settings')
    ok('重启后 mode 仍为 percentage', afterRestart.body.expiry_warning_mode === 'percentage',
      `${afterRestart.body.expiry_warning_mode}`)
    ok('重启后 threshold 仍为 42', afterRestart.body.expiry_warning_threshold === 42,
      `${afterRestart.body.expiry_warning_threshold}`)
    ok('重启后 allow_expired 仍为 true', afterRestart.body.allow_expired_for_recipe === true,
      `${afterRestart.body.allow_expired_for_recipe}`)

    const rowCount = raw.prepare('select count(*) c from app_settings').get() as any
    ok('app_settings 只有一行', rowCount.c === 1, `${rowCount.c} 行`)
  }

  /* ============================================================
   * 五、回归：现有库存功能
   * ============================================================ */
  console.log('\n\n===== 五、回归 =====')
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  const list = await req('GET', '/api/ingredients')
  ok('库存列表正常', list.status === 200 && Array.isArray(list.body))
  ok('列表仍隐藏 0 数量', !list.body.some((r: any) => r.quantity === 0))

  // ⚠️ 用唯一的 purchase_date，避免命中 Phase 4 的同批次自动合并
  const created = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 5, unit: '个', purchase_date: shiftDays(-77),
  })
  ok('新增库存正常', created.status === 201)
  ok('  新记录（未被合并）', created.body.quantity === 5, `${created.body.quantity}`)

  const consumed = await req('POST', `/api/ingredients/${created.body.id}/consume`, { amount: 2 })
  ok('消耗正常', consumed.status === 200 && consumed.body.quantity === 3,
    `${consumed.status} / qty=${consumed.body?.quantity}`)

  // 合并仍然工作
  const mergeA = await req('POST', '/api/ingredients', { definition_id: T, quantity: 10, unit: '克', purchase_date: shiftDays(-1) })
  const mergeB = await req('POST', '/api/ingredients', { definition_id: T, quantity: 20, unit: '克', purchase_date: shiftDays(-1) })
  ok('Phase 4 自动合并仍工作', mergeA.body.id === mergeB.body.id && mergeB.body.quantity === 30,
    `${mergeB.body.quantity}`)

  const search = await req('GET', '/api/definitions?search=番茄')
  ok('Phase 3 搜索仍工作', search.status === 200 && search.body.some((d: any) => d.id === T))

  const patchDef = await req('PATCH', `/api/ingredients/${mergeA.body.id}`, { definition_id: T })
  ok('Phase 3.1 PATCH definition_id 仍工作', patchDef.status === 200)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
