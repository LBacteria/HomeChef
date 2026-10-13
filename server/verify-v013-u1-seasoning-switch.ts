/**
 * v0.1.3 U1 专项测试：调味品 → 调味品 的 definition 切换
 *
 * 裁决（甲）：
 *   调味品 → 调味品进行 definition_id 切换时，**跳过** allowed-units 校验。
 *
 * 原因：调味品库存的 unit 是 B2 sentinel（恒为「个」），不代表真实单位；
 *      而调味品 definition 合法地允许 allowed_units = []。
 *      若照常校验，sentinel 必然不在空列表中，导致调味品永远无法换 definition。
 *
 * 覆盖：
 *   1. 调味品 → 调味品，目标 allowed_units = []      → 200
 *   2. 调味品 → 调味品，目标 allowed_units 有内容    → 200
 *   3. 普通 → 普通：原有 unit 校验**未被绕过**
 *   4. 跨类切换仍为 409
 *   5. 所有失败场景的原子性（deepEqual）
 *
 * 只读性质：独立临时库；不修改任何产品代码。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

import {
  startServer, waitForReady, ServerStartupError, resolveTsxHooks,
} from './harness/server-lifecycle.js'

const PORT = 54000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v013-u1-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = stmt.trim(); if (t) setup.exec(t)
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
 *    现在 `proc.pid` 就是真实服务进程，停止即刻生效。
 *    详见 harness/server-lifecycle.ts。
 */
const server = startServer({
  cwd: process.cwd(),
  port: PORT,
  dbPath,
  // 保留输出（有上限），启动失败时能打印 stderr 而不是完全不可见
  stdio: 'pipe',
})

// 预检端口必须空闲：否则会连到旧实例的旧数据库并产生误判
try { await fetch(`${BASE}/health`); console.log(`[FAIL] 端口 ${PORT} 已占用`); await server.stop(); process.exit(1) } catch { /* 未占用，继续 */ }

// 绝对超时：服务**提前退出**或超过 30s 未就绪都会抛错，绝不无限等待
try {
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })
} catch (e) {
  console.log('[FAIL] 服务未就绪：' + (e instanceof Error ? e.message : String(e)))
  if (e instanceof ServerStartupError && e.detail.length > 0) console.log(e.detail)
  await server.stop()
  process.exit(1)
}
console.log(`server ${BASE}\n`)

/* ============================================================
 * Seed 子进程（本地 helper，**不修改共享 harness**）
 *
 * ⚠️ 原写法 `spawn('npx', ['tsx', 'seed/seed.ts'], { shell: true })` 的问题：
 *    ① 进程链为 `cmd.exe → npx → tsx → node` 四层，父进程**拿不到真实退出码**；
 *    ② 只监听 `close`，seed 失败被静默忽略 → 后续验证对着空库跑出**误报**；
 *    ③ 无超时，seed 挂起则整个脚本永久挂起；
 *    ④ `finally` 只杀服务，seed 链可能逃逸成孤儿。
 *
 * 现在：进程树只有 1 层（tsx loader 在**同一进程**内运行，不派生子进程），
 *       显式检查 `code` 与 `signalCode`，带 60s 超时，失败即中止后续验证。
 * ============================================================ */
const SEED_TIMEOUT_MS = 60_000

/** 当前存活的 seed 子进程（供 finally 兜底清理） */
let seedChild: ChildProcess | null = null

/** 终止 seed 并**等待其真正退出**（不凭父进程结束推断） */
async function killSeed(): Promise<void> {
  const child = seedChild
  if (child === null) return
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* 可能已退出 */ }
    await new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) return res()
      const t = setTimeout(res, 5_000)
      child.once('exit', () => { clearTimeout(t); res() })
    })
  }
  seedChild = null
}

/** 运行 seed：成功返回；失败 / 超时 / 启动错误均抛错（抛出时 seed 已确认退出） */
async function runSeed(): Promise<void> {
  const { preflight, loader } = resolveTsxHooks()
  const child = spawn(
    process.execPath,
    ['--require', preflight, '--import', pathToFileURL(loader).href, 'seed/seed.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME_CHEF_DB_PATH: dbPath },
      // 保留原有语义：seed 输出不参与本脚本的断言
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  seedChild = child

  const outcome = await new Promise<
    | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
    | { kind: 'timeout' }
    | { kind: 'error'; err: Error }
  >((res) => {
    const timer = setTimeout(() => res({ kind: 'timeout' }), SEED_TIMEOUT_MS)
    child.on('error', (err: Error) => { clearTimeout(timer); res({ kind: 'error', err }) })
    child.on('exit', (code, signal) => { clearTimeout(timer); res({ kind: 'exit', code, signal }) })
  })

  if (outcome.kind === 'error') {
    await killSeed()
    throw new Error(`seed 启动失败：${outcome.err.message}`)
  }
  if (outcome.kind === 'timeout') {
    await killSeed()
    throw new Error(`seed 超时（${SEED_TIMEOUT_MS}ms）未结束，已强制终止`)
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    await killSeed()
    throw new Error(`seed 非正常退出：code=${outcome.code} signal=${String(outcome.signal)}`)
  }
  seedChild = null
}

function shift(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function stockRow(id: number): any {
  return raw.prepare('select * from standard_ingredient where id = ?').get(id)
}

try {
  /* ============================================================
   * 准备
   * ============================================================ */
  console.log('===== 准备 =====')
  try {
    await runSeed()
  } catch (e) {
    console.log(`[FAIL] seed 未成功完成：${e instanceof Error ? e.message : String(e)}`)
    console.log('[ABORT] 因 seed 未能正常完成，后续验证已中止（避免产生误报）')
    await killSeed()
    await server.stop()
    raw.close()
    process.exit(1)
  }

  const cats = (await req('GET', '/api/categories')).body
  const SEASONING = cats.find((c: any) => c.name === '调味品').id
  const VEG = cats.find((c: any) => c.name === '蔬菜').id
  info('调味品 catId', `${SEASONING}`)
  info('蔬菜 catId', `${VEG}`)

  /* ============================================================
   * 1. 调味品 → 调味品，目标 allowed_units = []
   * ============================================================ */
  console.log('\n===== 1. 调味品 → 调味品（目标 allowed_units = []）=====')

  const seasonA = await req('POST', '/api/definitions', {
    name: 'U1调味品A', units: [], category_id: SEASONING,
  })
  const seasonB = await req('POST', '/api/definitions', {
    name: 'U1调味品B', units: [], category_id: SEASONING,
  })
  ok('创建调味品 A（0 unit）→ 201', seasonA.status === 201, `${seasonA.status}`)
  ok('创建调味品 B（0 unit）→ 201', seasonB.status === 201, `${seasonB.status}`)
  ok('  A 的 allowed_units 为空',
    (await req('GET', `/api/definitions/${seasonA.body.id}/units`)).body.length === 0)
  ok('  B 的 allowed_units 为空',
    (await req('GET', `/api/definitions/${seasonB.body.id}/units`)).body.length === 0)

  const inv1 = await req('POST', '/api/ingredients', {
    definition_id: seasonA.body.id, note: 'U1备注',
  })
  ok('创建调味品库存 → 201', inv1.status === 201, `${inv1.status}`)

  const before1 = stockRow(inv1.body.id)
  ok('  sentinel quantity = 0', before1.quantity === 0, `${before1.quantity}`)
  ok('  sentinel unit = 个', before1.unit === '个', `${before1.unit}`)
  ok('  sentinel purchase_date = today', before1.purchase_date === shift(0), `${before1.purchase_date}`)
  ok('  sentinel storage_method = 常温', before1.storage_method === '常温', `${before1.storage_method}`)
  ok('  expiry_date = NULL', before1.expiry_date === null)
  ok('  expiry_date_source = NULL', before1.expiry_date_source === null)

  // ---- 切换 ----
  const sw1 = await req('PATCH', `/api/ingredients/${inv1.body.id}`, {
    definition_id: seasonB.body.id,
  })
  ok('调味品 → 调味品（目标 0 unit）→ 200', sw1.status === 200,
    `${sw1.status}` + (sw1.body?.error ? ` / ${sw1.body.error.code}` : ''))

  const after1 = stockRow(inv1.body.id)
  ok('  definition_id 已改变', after1.definition_id === seasonB.body.id,
    `${after1.definition_id} vs ${seasonB.body.id}`)

  const api1 = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === inv1.body.id)
  ok('  category 仍是调味品', api1?.category_id === SEASONING, `${api1?.category_id}`)
  ok('  is_seasoning = true', api1?.is_seasoning === true, `${api1?.is_seasoning}`)

  ok('  quantity 仍为 0', after1.quantity === 0, `${after1.quantity}`)
  ok('  unit 仍为 个', after1.unit === '个', `${after1.unit}`)
  ok('  purchase_date 仍为 today', after1.purchase_date === shift(0), `${after1.purchase_date}`)
  ok('  storage_method 仍为 常温', after1.storage_method === '常温', `${after1.storage_method}`)
  ok('  expiry_date 仍为 NULL', after1.expiry_date === null, `${after1.expiry_date}`)
  ok('  expiry_date_source 仍为 NULL', after1.expiry_date_source === null, `${after1.expiry_date_source}`)
  ok('  note 保留', after1.note === 'U1备注', `${after1.note}`)
  ok('  expiry invariant 成立（同 NULL 性）',
    (after1.expiry_date === null) === (after1.expiry_date_source === null))

  ok('  仍在列表中可见（quantity=0 不被普通规则隐藏）', api1 !== undefined)
  ok('  expiry_status = no_expiry', api1?.expiry_status === 'no_expiry', `${api1?.expiry_status}`)

  // definition 的 allowed_units 未被偷偷修改
  const bUnits = (await req('GET', `/api/definitions/${seasonB.body.id}/units`)).body
  ok('  目标调味品的 allowed_units 仍为空（未被自动添加）', bUnits.length === 0, `${bUnits.length}`)

  /* ============================================================
   * 2. 调味品 → 调味品，目标 allowed_units 有内容
   * ============================================================ */
  console.log('\n===== 2. 调味品 → 调味品（目标 allowed_units 有内容）=====')

  const seasonC = await req('POST', '/api/definitions', {
    name: 'U1调味品C', units: ['瓶', '个'], category_id: SEASONING,
  })
  ok('创建调味品 C（units: 瓶,个）→ 201', seasonC.status === 201, `${seasonC.status}`)

  const inv2 = await req('POST', '/api/ingredients', { definition_id: seasonA.body.id })
  const before2 = stockRow(inv2.body.id)

  const sw2 = await req('PATCH', `/api/ingredients/${inv2.body.id}`, {
    definition_id: seasonC.body.id,
  })
  ok('调味品 → 调味品（目标有 unit）→ 200', sw2.status === 200, `${sw2.status}`)

  const after2 = stockRow(inv2.body.id)
  ok('  definition_id 已改变', after2.definition_id === seasonC.body.id)
  ok('  quantity 仍为 0', after2.quantity === 0, `${after2.quantity}`)
  ok('  unit 仍为 sentinel 个', after2.unit === '个', `${after2.unit}`)
  ok('  expiry 仍为 NULL', after2.expiry_date === null)
  ok('  expiry_date_source 仍为 NULL', after2.expiry_date_source === null)

  const api2 = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === inv2.body.id)
  ok('  is_seasoning = true', api2?.is_seasoning === true)
  ok('  category 仍是调味品', api2?.category_id === SEASONING)

  info('切换前 quantity/unit', `${before2.quantity}/${before2.unit}`)

  /* ============================================================
   * 3. 普通 → 普通：原有 unit 校验未被绕过
   * ============================================================ */
  console.log('\n===== 3. 普通 → 普通（unit 校验未被绕过）=====')

  const normalA = await req('POST', '/api/definitions', {
    name: 'U1普通A', units: ['个', '克'], category_id: VEG,
  })
  const gramOnly = await req('POST', '/api/definitions', {
    name: 'U1仅克', units: ['克'], category_id: VEG,
  })
  ok('创建普通 A（个,克）→ 201', normalA.status === 201)
  ok('创建仅克普通 → 201', gramOnly.status === 201)

  // 合法：个 → 个
  const invOk = await req('POST', '/api/ingredients', {
    definition_id: normalA.body.id, quantity: 5, unit: '个', purchase_date: shift(-1), expiry_date: shift(30),
  })
  const normalBAgain = await req('POST', '/api/definitions', {
    name: 'U1普通B', units: ['个', '克'], category_id: VEG,
  })
  const beforeOk = stockRow(invOk.body.id)
  const swOk = await req('PATCH', `/api/ingredients/${invOk.body.id}`, {
    definition_id: normalBAgain.body.id,
  })
  ok('普通 → 普通（unit 合法）→ 200', swOk.status === 200, `${swOk.status}`)
  const afterOk = stockRow(invOk.body.id)
  ok('  definition_id 已改变', afterOk.definition_id === normalBAgain.body.id)
  ok('  expiry 未被重算（换 definition 不触发重算）',
    afterOk.expiry_date === beforeOk.expiry_date,
    `${beforeOk.expiry_date} → ${afterOk.expiry_date}`)
  ok('  expiry_date_source 未变', afterOk.expiry_date_source === beforeOk.expiry_date_source)

  // 非法：个 → 仅克 的普通食材
  const invBad = await req('POST', '/api/ingredients', {
    definition_id: normalA.body.id, quantity: 3, unit: '个', purchase_date: shift(-1),
  })
  const beforeBad = stockRow(invBad.body.id)
  const swBad = await req('PATCH', `/api/ingredients/${invBad.body.id}`, {
    definition_id: gramOnly.body.id,
  })
  ok('普通 → 普通（unit 不被允许）→ 400', swBad.status === 400, `${swBad.status}`)
  ok('  错误码 UNIT_NOT_ALLOWED（普通校验未被绕过）',
    swBad.body?.error?.code === 'UNIT_NOT_ALLOWED', swBad.body?.error?.code)
  const afterBad = stockRow(invBad.body.id)
  ok('  原子性：deepEqual(before, after)', JSON.stringify(beforeBad) === JSON.stringify(afterBad))
  ok('  definition_id 未变', afterBad.definition_id === normalA.body.id)
  ok('  quantity 未变', afterBad.quantity === beforeBad.quantity)
  ok('  unit 未变', afterBad.unit === beforeBad.unit)
  ok('  updated_at 未变', afterBad.updated_at === beforeBad.updated_at)

  // 用户显式传入非法 unit 枚举 → 仍被 assertValidUnit 拦截
  const swBadEnum = await req('PATCH', `/api/ingredients/${invBad.body.id}`, { unit: '斤' })
  ok('显式传入非法 unit 枚举 → 400', swBadEnum.status === 400, `${swBadEnum.status}`)

  /* ============================================================
   * 4. 跨类切换仍为 409
   * ============================================================ */
  console.log('\n===== 4. 跨类切换仍为 409 =====')

  const normalInv = await req('POST', '/api/ingredients', {
    definition_id: normalA.body.id, quantity: 8, unit: '个', purchase_date: shift(-2),
    note: '跨类备注', storage_method: '冷藏', expiry_date: shift(15),
  })
  const beforeCross = stockRow(normalInv.body.id)

  const cross1 = await req('PATCH', `/api/ingredients/${normalInv.body.id}`, {
    definition_id: seasonA.body.id,
  })
  ok('普通 → 调味品 → 409', cross1.status === 409, `${cross1.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    cross1.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', cross1.body?.error?.code)

  const afterCross = stockRow(normalInv.body.id)
  ok('  原子性：deepEqual(before, after)', JSON.stringify(beforeCross) === JSON.stringify(afterCross))
  ok('  definition_id 未变', afterCross.definition_id === normalA.body.id)
  ok('  quantity 未变', afterCross.quantity === beforeCross.quantity)
  ok('  unit 未变', afterCross.unit === beforeCross.unit)
  ok('  purchase_date 未变', afterCross.purchase_date === beforeCross.purchase_date)
  ok('  production_date 未变', afterCross.production_date === beforeCross.production_date)
  ok('  expiry_date 未变', afterCross.expiry_date === beforeCross.expiry_date)
  ok('  expiry_date_source 未变', afterCross.expiry_date_source === beforeCross.expiry_date_source)
  ok('  storage_method 未变', afterCross.storage_method === beforeCross.storage_method)
  ok('  note 未变', afterCross.note === beforeCross.note)
  ok('  updated_at 未变', afterCross.updated_at === beforeCross.updated_at)

  // 反向
  const seasonInv = await req('POST', '/api/ingredients', { definition_id: seasonA.body.id })
  const beforeCross2 = stockRow(seasonInv.body.id)
  const cross2 = await req('PATCH', `/api/ingredients/${seasonInv.body.id}`, {
    definition_id: normalA.body.id,
  })
  ok('调味品 → 普通 → 409', cross2.status === 409, `${cross2.status}`)
  const afterCross2 = stockRow(seasonInv.body.id)
  ok('  原子性：deepEqual(before, after)',
    JSON.stringify(beforeCross2) === JSON.stringify(afterCross2))
  ok('  updated_at 未变', afterCross2.updated_at === beforeCross2.updated_at)

  /* ============================================================
   * 5. 未改变 definition 的 PATCH 不受影响
   * ============================================================ */
  console.log('\n===== 5. 未换 definition 的 PATCH 不受影响 =====')

  const noChange = await req('PATCH', `/api/ingredients/${normalInv.body.id}`, { quantity: 12 })
  ok('只改 quantity（不换 definition）→ 200', noChange.status === 200, `${noChange.status}`)
  ok('  quantity 已更新', stockRow(normalInv.body.id).quantity === 12)

  const seasonNote = await req('PATCH', `/api/ingredients/${seasonInv.body.id}`, { note: '改备注' })
  ok('调味品只改 note → 200', seasonNote.status === 200, `${seasonNote.status}`)
  ok('  sentinel 未被改动', stockRow(seasonInv.body.id).quantity === 0)
  ok('  note 已更新', stockRow(seasonInv.body.id).note === '改备注')

  /* ============================================================
   * 全库完整性
   * ============================================================ */
  console.log('\n===== 全库完整性 =====')
  const dangling = (raw.prepare(`
    select count(*) c from standard_ingredient s
    left join ingredient_definition d on d.id = s.definition_id
    where d.id is null
  `).get() as any).c
  ok('无悬空 definition_id', dangling === 0, `${dangling}`)

  const expiryInv = (raw.prepare(`
    select count(*) c from standard_ingredient
    where (expiry_date is null) != (expiry_date_source is null)
  `).get() as any).c
  ok('全库 expiry invariant 成立', expiryInv === 0, `${expiryInv}`)

  const badEnum = (raw.prepare(`
    select count(*) c from standard_ingredient
    where unit not in ('个','克','千克','毫升','升','包','袋','瓶','盒','罐')
  `).get() as any).c
  ok('无非法 unit 枚举值', badEnum === 0, `${badEnum}`)

  const seasonSentinel = (raw.prepare(`
    select count(*) c from standard_ingredient s
    join ingredient_definition d on d.id = s.definition_id
    join category c on c.id = d.category_id
    where c.name = '调味品' and (s.quantity != 0 or s.expiry_date is not null)
  `).get() as any).c
  ok('所有调味品库存均符合 sentinel（quantity=0 且 expiry NULL）', seasonSentinel === 0, `${seasonSentinel}`)
} finally {
  // 兜底：父脚本异常时 seed 可能仍存活，先确认其退出
  await killSeed()
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== U1 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
