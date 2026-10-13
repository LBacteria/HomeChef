/**
 * HomeChef v0.1.3 专项验证：分类体系 + 调味品特殊行为
 *
 * 覆盖：
 *   A. Category 数据结构（19 个默认分类）
 *   B. Category CRUD（创建 / trim / 空名 / 重名 / 删除 / 删除保护 / 原子性）
 *   C. 229 个内置 definition 的 category_id 完整性
 *   D. 4 个特殊 seed 分类映射
 *   E. 冷冻食品语义（≠ 储存方式为冷冻）
 *   F. 调味品 definition（0 allowed unit）
 *   G. 调味品库存（B2 sentinel）
 *   H. 普通食材回归
 *   I. Category Filter（食材库 / 库存 × search / sort / category 组合）
 *   J. API Schema / 安全性
 *   K. Phase 4 回归
 *
 * 使用独立临时库与动态端口。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

import {
  startServer, waitForReady, ServerStartupError, resolveTsxHooks,
} from './harness/server-lifecycle.js'

const PORT = 48000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v013-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* ---------- 建库：走真实迁移器，保证 0005 被执行 ---------- */
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
 *    ② 只监听 `close` 却不看 code/signal，seed 失败被静默忽略 → 后续验证误报；
 *    ③ 无超时，seed 挂起则整个脚本永久挂起；
 *    ④ `finally` 只杀服务，seed 链可能逃逸成孤儿。
 *
 * ⚠️ 本脚本**依赖 seed 的标准输出**（`新建：N` 与「seed 执行完成」），
 *    因此必须保留管道捕获，且**必须用 `close` 事件**（stdio 排空后才触发）
 *    而不是 `exit` —— 否则尾部输出可能丢失，使原有断言不可靠。
 * ============================================================ */
const SEED_TIMEOUT_MS = 60_000

/** 当前存活的 seed 子进程（供 finally 兜底清理） */
let seedChild: ChildProcess | null = null

/** 失败诊断用的输出尾部（**仅在失败路径**使用，成功路径输出不受影响） */
function tailNote(s: string): string {
  const t = s.trim()
  return t.length === 0 ? '' : `；输出尾部：${t.slice(-800)}`
}

/**
 * 终止 seed 并**确认其退出**；幂等，重复调用安全。
 *
 * 返回 `true` = 已确认退出（含「本已退出」与「无进程」两种情形）；
 * 返回 `false` = **无法确认退出** —— 此时**显式报告**，绝不假定进程已消失。
 */
async function killSeed(): Promise<boolean> {
  const child = seedChild
  if (child === null) return true
  if (child.exitCode !== null || child.signalCode !== null) {
    seedChild = null
    return true
  }

  try { child.kill('SIGKILL') } catch (e) {
    console.log(`[WARN] 终止 seed 时抛错：${e instanceof Error ? e.message : String(e)}`)
  }

  const exited = await new Promise<boolean>((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res(true)
    const t = setTimeout(() => res(false), 5_000)
    child.once('exit', () => { clearTimeout(t); res(true) })
  })

  if (exited) {
    seedChild = null
    return true
  }
  // 不假定已退出：显式报告，并保留引用以便后续再次尝试
  console.log(
    `[WARN] seed 进程（PID ${String(child.pid)}）强制终止后 5s 内仍未确认退出：` +
    `exitCode=${String(child.exitCode)} signalCode=${String(child.signalCode)}`,
  )
  return false
}

type SeedOutcome =
  | { kind: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'timeout' }
  | { kind: 'error'; err: Error }

/** 运行 seed：成功返回合并后的 stdout+stderr；失败 / 超时 / 启动错误均抛错 */
async function runSeed(): Promise<string> {
  const { preflight, loader } = resolveTsxHooks()
  const child = spawn(
    process.execPath,
    ['--require', preflight, '--import', pathToFileURL(loader).href, 'seed/seed.ts'],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME_CHEF_DB_PATH: dbPath },
      // 保留原有语义：捕获 stdout + stderr（合并到同一缓冲区，顺序按到达先后）。
      // stdin 置 ignore —— 已确认 seed 不读取 stdin，避免继承输入造成意外挂起。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  seedChild = child

  let out = ''
  child.stdout?.on('data', (d) => { out += String(d) })
  child.stderr?.on('data', (d) => { out += String(d) })

  const outcome = await new Promise<SeedOutcome>((res) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (v: SeedOutcome) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      res(v)
    }
    timer = setTimeout(() => done({ kind: 'timeout' }), SEED_TIMEOUT_MS)
    child.on('error', (err: Error) => done({ kind: 'error', err }))
    // ★ 必须是 close（stdio 全部关闭后触发），否则可能丢掉尾部输出
    child.on('close', (code, signal) => done({ kind: 'close', code, signal }))
  })

  if (outcome.kind === 'error') {
    const cleaned = await killSeed()
    throw new Error(`seed 启动失败：${outcome.err.message}；已确认退出=${cleaned}`)
  }
  if (outcome.kind === 'timeout') {
    const cleaned = await killSeed()
    throw new Error(`seed 超时（${SEED_TIMEOUT_MS}ms）未结束，已强制终止；已确认退出=${cleaned}${tailNote(out)}`)
  }
  if (outcome.code !== 0 || outcome.signal !== null) {
    const cleaned = await killSeed()
    throw new Error(
      `seed 非正常退出：code=${String(outcome.code)} signal=${String(outcome.signal)}；` +
      `已确认退出=${cleaned}${tailNote(out)}`,
    )
  }
  seedChild = null
  return out
}

function shift(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

try {
  /* ============================================================
   * 先 seed，才有 229 个 definition
   * ============================================================ */
  console.log('===== 准备：执行 seed =====')
  let seedOut = ''
  try {
    seedOut = await runSeed()
  } catch (e) {
    console.log(`[FAIL] seed 未成功完成：${e instanceof Error ? e.message : String(e)}`)
    console.log('[ABORT] 因 seed 未能正常完成，后续验证已中止（避免产生误报）')
    await killSeed()
    await server.stop()
    raw.close()
    process.exit(1)
  }
  const createdMatch = seedOut.match(/新建\s*：(\d+)/)
  info('seed 新建数量', createdMatch?.[1] ?? '未解析')
  ok('seed 执行完成', seedOut.includes('seed 执行完成'))

  /* ============================================================
   * A. Category 数据结构
   * ============================================================ */
  console.log('\n===== A. Category 数据结构 =====')

  const EXPECTED_19 = [
    '蔬菜', '水果', '水产', '猪肉', '牛肉', '羊肉', '其他畜肉',
    '鸡肉', '鸭肉', '鹅肉', '其他禽肉', '蛋类', '豆制品', '乳制品',
    '主食/谷物', '干货/菌菇', '冷冻食品', '调味品', '其他/饮品',
  ]

  const catsRes = await req('GET', '/api/categories')
  ok('GET /api/categories → 200', catsRes.status === 200, `${catsRes.status}`)

  const catNames = catsRes.body.map((c: any) => c.name)
  ok('默认分类数量 = 19', catsRes.body.length === 19, `${catsRes.body.length}`)

  for (const name of EXPECTED_19) {
    ok(`  含分类「${name}」`, catNames.includes(name))
  }

  ok('分类名称无重复', catNames.length === new Set(catNames).size)
  ok('每个 category 都有 id', catsRes.body.every((c: any) => Number.isInteger(c.id) && c.id > 0))
  ok('每个 category 都有 name', catsRes.body.every((c: any) => typeof c.name === 'string' && c.name.length > 0))
  ok('每个 category 都有 name_normalized', catsRes.body.every((c: any) => typeof c.name_normalized === 'string'))
  info('分类 id 范围', `${Math.min(...catsRes.body.map((c: any) => c.id))} - ${Math.max(...catsRes.body.map((c: any) => c.id))}`)

  // migration 0005 的表结构
  const catCols = (raw.prepare('pragma table_info(category)').all() as Array<{ name: string }>).map((c) => c.name)
  info('category 列', catCols.join(', '))
  ok('category 表含 id/name/name_normalized/sort_order', ['id', 'name', 'name_normalized', 'sort_order'].every((c) => catCols.includes(c)))

  const defCols = (raw.prepare('pragma table_info(ingredient_definition)').all() as Array<{ name: string }>).map((c) => c.name)
  ok('ingredient_definition 含 category_id', defCols.includes('category_id'))

  // 外键 RESTRICT
  const fks = raw.prepare('pragma foreign_key_list(ingredient_definition)').all() as Array<any>
  const catFk = fks.find((f) => f.table === 'category')
  ok('category_id 外键指向 category', catFk !== undefined)
  ok('外键为 ON DELETE RESTRICT', catFk?.on_delete === 'RESTRICT', `${catFk?.on_delete}`)

  /* ============================================================
   * B. Category CRUD
   * ============================================================ */
  console.log('\n===== B. Category CRUD =====')

  console.log('\n--- 创建 ---')
  const created = await req('POST', '/api/categories', { name: '测试分类' })
  ok('创建分类 → 201', created.status === 201, `${created.status}`)
  ok('  返回含 id', Number.isInteger(created.body?.id))
  ok('  返回 name 正确', created.body?.name === '测试分类')

  const inDb = raw.prepare('select * from category where id = ?').get(created.body.id) as any
  ok('  数据真正写入 DB', inDb !== undefined && inDb.name === '测试分类')

  console.log('\n--- trim ---')
  const trimmed = await req('POST', '/api/categories', { name: '  去空格分类  ' })
  ok('trim 后创建成功', trimmed.status === 201, `${trimmed.status}`)
  ok('  名称已 trim', trimmed.body?.name === '去空格分类', `"${trimmed.body?.name}"`)
  const trimmedInDb = raw.prepare('select name from category where id = ?').get(trimmed.body.id) as any
  ok('  DB 中也是 trim 后的', trimmedInDb.name === '去空格分类')

  console.log('\n--- 空名称 → 400 ---')
  ok('空字符串 → 400', (await req('POST', '/api/categories', { name: '' })).status === 400)
  ok('纯空格 → 400', (await req('POST', '/api/categories', { name: '   ' })).status === 400)
  ok('缺少 name → 400', (await req('POST', '/api/categories', {})).status === 400)
  ok('name 非字符串 → 400', (await req('POST', '/api/categories', { name: 123 })).status === 400)
  ok('未知字段 → 400', (await req('POST', '/api/categories', { name: 'x', extra: 1 })).status === 400)

  console.log('\n--- 重复名称 ---')
  const dup1 = await req('POST', '/api/categories', { name: '测试分类' })
  ok('完全重名 → 409', dup1.status === 409, `${dup1.status}`)
  ok('  错误码为 DUPLICATE_NAME', dup1.body?.error?.code === 'DUPLICATE_NAME', dup1.body?.error?.code)

  const dup2 = await req('POST', '/api/categories', { name: '  测试分类  ' })
  ok('trim 后重名 → 409', dup2.status === 409, `${dup2.status}`)

  const dup3 = await req('POST', '/api/categories', { name: '调味品' })
  ok('与默认分类重名 → 409', dup3.status === 409, `${dup3.status}`)

  const dupCount = (raw.prepare("select count(*) c from category where name = '测试分类'").get() as any).c
  ok('  未产生重复分类', dupCount === 1, `${dupCount}`)

  console.log('\n--- 删除空分类 ---')
  const delEmpty = await req('DELETE', `/api/categories/${created.body.id}`)
  ok('删除空分类 → 204', delEmpty.status === 204, `${delEmpty.status}`)
  ok('  已从 DB 移除', raw.prepare('select id from category where id = ?').get(created.body.id) === undefined)

  console.log('\n--- 删除有引用分类 → 409 ---')
  const seasoningCat = catsRes.body.find((c: any) => c.name === '调味品')
  const defCountInSeasoning = (raw.prepare('select count(*) c from ingredient_definition where category_id = ?').get(seasoningCat.id) as any).c
  info('调味品分类下的 definition 数', `${defCountInSeasoning}`)

  const snapshotBefore = {
    cats: raw.prepare('select * from category order by id').all(),
    defs: raw.prepare('select id, category_id from ingredient_definition where category_id = ? order by id').all(seasoningCat.id),
  }

  const delInUse = await req('DELETE', `/api/categories/${seasoningCat.id}`)
  ok('删除有引用分类 → 409', delInUse.status === 409, `${delInUse.status}`)
  ok('  错误码为 CATEGORY_IN_USE', delInUse.body?.error?.code === 'CATEGORY_IN_USE', delInUse.body?.error?.code)
  ok('  错误信息可读（含食材数量）',
    typeof delInUse.body?.error?.message === 'string' && delInUse.body.error.message.includes('食材'),
    delInUse.body?.error?.message)

  // 原子性
  const snapshotAfter = {
    cats: raw.prepare('select * from category order by id').all(),
    defs: raw.prepare('select id, category_id from ingredient_definition where category_id = ? order by id').all(seasoningCat.id),
  }
  ok('  原子性：category 表完全未变', JSON.stringify(snapshotBefore.cats) === JSON.stringify(snapshotAfter.cats))
  ok('  原子性：definition 完全未变', JSON.stringify(snapshotBefore.defs) === JSON.stringify(snapshotAfter.defs))
  ok('  未级联删除食材', (raw.prepare('select count(*) c from ingredient_definition').get() as any).c === 229)
  ok('  未把 category_id 置 NULL',
    (raw.prepare('select count(*) c from ingredient_definition where category_id is null').get() as any).c === 0)

  console.log('\n--- 删除不存在的分类 ---')
  ok('删除不存在 id → 404', (await req('DELETE', '/api/categories/999999')).status === 404)
  ok('非法 id（abc）→ 400', (await req('DELETE', '/api/categories/abc')).status === 400)
  ok('非法 id（0）→ 400', (await req('DELETE', '/api/categories/0')).status === 400)
  ok('非法 id（-1）→ 400', (await req('DELETE', '/api/categories/-1')).status === 400)

  /* ============================================================
   * C. 229 个内置 Definition
   * ============================================================ */
  console.log('\n===== C. 229 个内置 Definition =====')

  const totalDefs = (raw.prepare('select count(*) c from ingredient_definition').get() as any).c
  ok('definition 总数 = 229', totalDefs === 229, `${totalDefs}`)

  const nullCat = (raw.prepare('select count(*) c from ingredient_definition where category_id is null').get() as any).c
  ok('无 NULL category_id', nullCat === 0, `${nullCat}`)

  const dangling = (raw.prepare(`
    select count(*) c from ingredient_definition d
    left join category c on c.id = d.category_id
    where d.category_id is not null and c.id is null
  `).get() as any).c
  ok('无悬空 category_id', dangling === 0, `${dangling}`)

  const distinctCats = (raw.prepare('select count(distinct category_id) c from ingredient_definition').get() as any).c
  info('被使用的分类数', `${distinctCats}`)

  // seed map / history 未被破坏
  const seedMapCount = (raw.prepare('select count(*) c from seed_ingredient_map').get() as any).c
  ok('seed_ingredient_map 仍为 229 条', seedMapCount === 229, `${seedMapCount}`)

  const seedHist = raw.prepare('select * from seed_history').get() as any
  ok('seed_history 存在', seedHist !== undefined)
  ok('  version = 1.0.0', seedHist?.version === '1.0.0', `${seedHist?.version}`)

  /* ============================================================
   * D. 4 个特殊 seed 分类映射
   * ============================================================ */
  console.log('\n===== D. 4 个特殊 seed 分类映射 =====')

  const catIdByName = new Map<string, number>()
  for (const c of catsRes.body) catIdByName.set(c.name, c.id)

  function categoryOfDefName(name: string): string | null {
    const r = raw.prepare(`
      select c.name as cat from ingredient_definition d
      left join category c on c.id = d.category_id
      where d.name = ?
    `).get(name) as any
    return r?.cat ?? null
  }

  const specials: Array<[string, string]> = [
    ['馄饨', '冷冻食品'],       // grain.wonton
    ['冰淇淋', '冷冻食品'],     // dairy.ice_cream
    ['腐乳', '调味品'],         // soy.fermented_tofu
    ['鱼丸', '冷冻食品'],       // seafood.seaweed_roll
  ]
  for (const [name, expectCat] of specials) {
    const actual = categoryOfDefName(name)
    ok(`${name} → ${expectCat}`, actual === expectCat, `实际 ${actual}`)
  }

  /* ============================================================
   * E. 冷冻食品语义
   * ============================================================ */
  console.log('\n===== E. 冷冻食品语义 =====')

  const frozenCatId = catIdByName.get('冷冻食品')!
  const beefCatId = catIdByName.get('牛肉')!

  // 牛肉即使 storage_method = 冷冻，category 仍是牛肉
  const beefDef = raw.prepare("select id, category_id from ingredient_definition where name = '牛腩'").get() as any
  ok('牛腩 属于「牛肉」', beefDef?.category_id === beefCatId)

  const beefStock = await req('POST', '/api/ingredients', {
    definition_id: beefDef.id, quantity: 500, unit: '克', purchase_date: shift(-1), storage_method: '冷冻',
  })
  ok('牛肉库存可设为冷冻储存', beefStock.status === 201, `${beefStock.status}`)
  ok('  storage_method = 冷冻', beefStock.body?.storage_method === '冷冻')

  const beefCatAfter = raw.prepare('select category_id from ingredient_definition where id = ?').get(beefDef.id) as any
  ok('  储存方式为冷冻 **不改变** category', beefCatAfter.category_id === beefCatId,
    `${beefCatAfter.category_id} vs ${beefCatId}`)

  // 冷冻食品分类的实际成员
  const frozenMembers = raw.prepare('select name from ingredient_definition where category_id = ? order by id').all(frozenCatId) as Array<any>
  info('冷冻食品成员', frozenMembers.map((m) => m.name).join(', '))
  ok('冷冻食品成员数 ≥ 11', frozenMembers.length >= 11, `${frozenMembers.length}`)

  /* ============================================================
   * F. 调味品 Definition
   * ============================================================ */
  console.log('\n===== F. 调味品 Definition =====')

  console.log('\n--- 普通食材仍要求至少一个 allowed unit ---')
  const noUnitNormal = await req('POST', '/api/definitions', { name: '普通无单位食材', units: [], category_id: catIdByName.get('蔬菜') })
  ok('普通食材 0 unit → 400', noUnitNormal.status === 400, `${noUnitNormal.status}`)

  const withUnit = await req('POST', '/api/definitions', {
    name: '普通有单位食材', units: ['个'], category_id: catIdByName.get('蔬菜'),
  })
  ok('普通食材 1 unit → 201', withUnit.status === 201, `${withUnit.status}`)

  // ⚠️ 另建一个**带保质期**的普通食材，用于验证临期状态确实参与计算
  //    （上面的 withUnit 未设 estimated_shelf_life_days，其库存必然 no_expiry）
  const withShelf = await req('POST', '/api/definitions', {
    name: '普通带保质期食材', units: ['个'], category_id: catIdByName.get('蔬菜'),
    estimated_shelf_life_days: 20,
  })
  ok('普通带保质期食材 → 201', withShelf.status === 201, `${withShelf.status}`)

  console.log('\n--- 调味品允许 0 unit ---')
  const seasoningDef = await req('POST', '/api/definitions', {
    name: '测试生抽',
    units: [],
    category_id: catIdByName.get('调味品'),
    aliases: ['测试酱油'],
  })
  ok('调味品 0 unit → 201', seasoningDef.status === 201, `${seasoningDef.status}`)
  ok('  返回 category_id 正确', seasoningDef.body?.category_id === catIdByName.get('调味品'))

  const sUnits = await req('GET', `/api/definitions/${seasoningDef.body.id}/units`)
  ok('  调味品 allowed_units 为空数组', Array.isArray(sUnits.body) && sUnits.body.length === 0, `${sUnits.body?.length}`)

  console.log('\n--- 不存在 type 字段 ---')
  ok('definition 无 type 字段', !defCols.includes('type'), defCols.join(','))
  ok('category 表无 type 字段', !catCols.includes('type'))

  console.log('\n--- 调味品删除 unit 兼容（可删到 0）---')
  const sDef2 = await req('POST', '/api/definitions', {
    name: '测试调味品2', units: ['瓶'], category_id: catIdByName.get('调味品'),
  })
  ok('调味品可带 unit 创建', sDef2.status === 201)
  const rmLast = await req('DELETE', `/api/definitions/${sDef2.body.id}/units/瓶`)
  ok('调味品删除最后一个 unit → 204（允许 0）', rmLast.status === 204, `${rmLast.status}`)

  // 对照：普通食材不能删到 0
  const normalDef2 = await req('POST', '/api/definitions', {
    name: '普通单单位食材', units: ['个'], category_id: catIdByName.get('蔬菜'),
  })
  const rmNormalLast = await req('DELETE', `/api/definitions/${normalDef2.body.id}/units/个`)
  ok('普通食材删除最后一个 unit → 400（必须保留）', rmNormalLast.status === 400, `${rmNormalLast.status}`)

  /* ============================================================
   * G. 调味品库存（B2 sentinel）
   * ============================================================ */
  console.log('\n===== G. 调味品库存 =====')

  console.log('\n--- 创建调味品库存（不传 quantity/unit/日期）---')
  const sInv = await req('POST', '/api/ingredients', {
    definition_id: seasoningDef.body.id,
    note: '厨房柜子',
  })
  ok('调味品库存创建 → 201', sInv.status === 201, `${sInv.status}`)

  const sRow = raw.prepare('select * from standard_ingredient where id = ?').get(sInv.body.id) as any
  ok('  sentinel quantity = 0', sRow.quantity === 0, `${sRow.quantity}`)
  ok('  sentinel unit = 个', sRow.unit === '个', `${sRow.unit}`)
  ok('  sentinel purchase_date = today', sRow.purchase_date === shift(0), `${sRow.purchase_date}`)
  ok('  sentinel storage_method = 常温', sRow.storage_method === '常温', `${sRow.storage_method}`)
  ok('  expiry_date = NULL', sRow.expiry_date === null, `${sRow.expiry_date}`)
  ok('  expiry_date_source = NULL', sRow.expiry_date_source === null)
  ok('  note 保留', sRow.note === '厨房柜子', `${sRow.note}`)

  console.log('\n--- quantity=0 的调味品仍出现在列表中 ---')
  const listWithSeasoning = await req('GET', '/api/ingredients')
  ok('默认列表能查到该调味品库存', listWithSeasoning.body.some((r: any) => r.id === sInv.body.id))

  const sInList = listWithSeasoning.body.find((r: any) => r.id === sInv.body.id)
  ok('  返回 is_seasoning = true', sInList?.is_seasoning === true, `${sInList?.is_seasoning}`)
  ok('  返回 category_id 正确', sInList?.category_id === catIdByName.get('调味品'))

  console.log('\n--- 普通 quantity=0 仍被隐藏（未被全局放宽）---')
  const normalStock = await req('POST', '/api/ingredients', {
    definition_id: withUnit.body.id, quantity: 5, unit: '个', purchase_date: shift(-100),
  })
  await req('POST', `/api/ingredients/${normalStock.body.id}/consume`, { amount: 5 })
  const zeroRow = raw.prepare('select quantity from standard_ingredient where id = ?').get(normalStock.body.id) as any
  ok('普通库存已消耗到 0', zeroRow.quantity === 0, `${zeroRow.quantity}`)
  ok('  普通 0 数量**不出现在**列表', !listWithSeasoning.body.some((r: any) => r.id === normalStock.body.id))
  ok('  普通 0 数量仍可 GET', (await req('GET', `/api/ingredients/${normalStock.body.id}`)).status === 200)

  console.log('\n--- 调味品不进入临期系统 ---')
  const sEval = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === sInv.body.id)
  ok('expiry_status = no_expiry', sEval?.expiry_status === 'no_expiry', `${sEval?.expiry_status}`)
  ok('days_remaining = null', sEval?.days_remaining === null)
  ok('remaining_percentage = null', sEval?.remaining_percentage === null)

  console.log('\n--- 重复添加调味品 ---')
  const dupSeasoning = await req('POST', '/api/ingredients', { definition_id: seasoningDef.body.id })
  ok('重复添加返回已有记录（不新增）', dupSeasoning.body?.id === sInv.body.id, `${dupSeasoning.body?.id}`)
  const seasoningRowCount = (raw.prepare('select count(*) c from standard_ingredient where definition_id = ?').get(seasoningDef.body.id) as any).c
  ok('  该调味品只有 1 条库存记录', seasoningRowCount === 1, `${seasoningRowCount}`)

  console.log('\n--- 删除调味品库存 ---')
  const delSeasoning = await req('DELETE', `/api/ingredients/${sInv.body.id}`)
  ok('删除调味品库存 → 204', delSeasoning.status === 204, `${delSeasoning.status}`)
  ok('  definition 仍存在', (await req('GET', `/api/definitions/${seasoningDef.body.id}`)).status === 200)

  /* ============================================================
   * H. 普通食材回归
   * ============================================================ */
  console.log('\n===== H. 普通食材回归 =====')

  const normal = await req('POST', '/api/ingredients', {
    definition_id: withShelf.body.id,
    quantity: 10, unit: '个',
    purchase_date: shift(-5), production_date: shift(-7),
    storage_method: '冷藏', note: '普通备注',
  })
  ok('普通库存创建成功', normal.status === 201, `${normal.status}`)
  ok('  quantity = 10', normal.body?.quantity === 10)
  ok('  unit = 个', normal.body?.unit === '个')
  ok('  purchase_date 正确', normal.body?.purchase_date === shift(-5))
  ok('  production_date 正确', normal.body?.production_date === shift(-7))
  ok('  storage_method = 冷藏', normal.body?.storage_method === '冷藏')
  ok('  note 保留', normal.body?.note === '普通备注')
  ok('  expiry_date 由保质期估算', normal.body?.expiry_date !== null, `${normal.body?.expiry_date}`)
  ok('  expiry_date_source = estimated', normal.body?.expiry_date_source === 'estimated')

  const normalEval = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === normal.body.id)
  ok('  is_seasoning = false', normalEval?.is_seasoning === false, `${normalEval?.is_seasoning}`)
  ok('  expiry_status 正常参与计算', ['normal', 'expiring', 'expired'].includes(normalEval?.expiry_status),
    `${normalEval?.expiry_status}`)
  ok('  普通库存**不**显示为「有」（quantity > 0）', normalEval?.quantity === 10)

  // 普通食材必填校验仍生效
  ok('普通食材缺少 quantity → 400',
    (await req('POST', '/api/ingredients', { definition_id: withUnit.body.id, unit: '个' })).status === 400)
  ok('普通食材缺少 unit → 400',
    (await req('POST', '/api/ingredients', { definition_id: withUnit.body.id, quantity: 1 })).status === 400)

  /* ============================================================
   * I. Category Filter
   * ============================================================ */
  console.log('\n===== I. Category Filter =====')

  const vegCatId = catIdByName.get('蔬菜')!
  const seasonCatId = catIdByName.get('调味品')!

  console.log('\n--- 食材库：8 种组合 ---')
  const noFilter = await req('GET', '/api/definitions?sort=name&order=asc')
  ok('无筛选 → 200', noFilter.status === 200, `${noFilter.body?.length} 条`)

  const onlyCat = await req('GET', `/api/definitions?sort=name&order=asc&category_id=${vegCatId}`)
  ok('只有 category', onlyCat.status === 200 && onlyCat.body.every((d: any) => d.category_id === vegCatId),
    `${onlyCat.body?.length} 条`)

  const onlySearch = await req('GET', '/api/definitions?search=番茄&sort=name&order=asc')
  ok('只有 search', onlySearch.status === 200 && onlySearch.body.length > 0, `${onlySearch.body?.length} 条`)

  const onlySort = await req('GET', '/api/definitions?sort=name&order=desc')
  ok('只有 sort', onlySort.status === 200)

  const catSearch = await req('GET', `/api/definitions?search=菜&sort=name&order=asc&category_id=${vegCatId}`)
  ok('category + search', catSearch.status === 200 && catSearch.body.every((d: any) => d.category_id === vegCatId),
    `${catSearch.body?.length} 条`)

  const catSort = await req('GET', `/api/definitions?sort=name&order=desc&category_id=${vegCatId}`)
  ok('category + sort', catSort.status === 200 && catSort.body.every((d: any) => d.category_id === vegCatId))

  const searchSort = await req('GET', '/api/definitions?search=番茄&sort=name&order=desc')
  ok('search + sort', searchSort.status === 200)

  const all3 = await req('GET', `/api/definitions?search=菜&sort=name&order=desc&category_id=${vegCatId}`)
  ok('category + search + sort', all3.status === 200 && all3.body.every((d: any) => d.category_id === vegCatId),
    `${all3.body?.length} 条`)
  // 排序仍生效
  const all3Names = all3.body.map((d: any) => d.name)
  let sortedOk = true
  for (let i = 1; i < all3Names.length; i++) {
    if (all3Names[i - 1].localeCompare(all3Names[i], 'zh-Hans-CN') < 0) { sortedOk = false; break }
  }
  ok('  三者组合时排序仍为 Z→A', sortedOk, all3Names.join(' > '))

  console.log('\n--- 食材库：category_id 非法 ---')
  ok('category_id=abc → 400', (await req('GET', '/api/definitions?category_id=abc')).status === 400)
  ok('category_id=0 → 400', (await req('GET', '/api/definitions?category_id=0')).status === 400)

  console.log('\n--- 库存：分类筛选 ---')
  const invAll = await req('GET', '/api/ingredients')
  ok('库存无筛选 → 200', invAll.status === 200, `${invAll.body?.length} 条`)

  const invVeg = await req('GET', `/api/ingredients?category_id=${vegCatId}`)
  ok('库存按「蔬菜」筛选', invVeg.status === 200 && invVeg.body.every((r: any) => r.category_id === vegCatId),
    `${invVeg.body?.length} 条`)

  const invSeason = await req('GET', `/api/ingredients?category_id=${seasonCatId}`)
  ok('库存按「调味品」筛选 → 200', invSeason.status === 200, `${invSeason.body?.length} 条`)

  // 重新加一个调味品库存以验证筛选与 quantity=0
  const sInv2 = await req('POST', '/api/ingredients', { definition_id: seasoningDef.body.id })
  const invSeason2 = await req('GET', `/api/ingredients?category_id=${seasonCatId}`)
  ok('  调味品库存出现在调味品筛选中', invSeason2.body.some((r: any) => r.id === sInv2.body.id))
  ok('  且 is_seasoning = true', invSeason2.body.find((r: any) => r.id === sInv2.body.id)?.is_seasoning === true)

  console.log('\n--- 库存：category + sort 组合 ---')
  const invCatSort = await req('GET', `/api/ingredients?category_id=${seasonCatId}&sort=name&order=asc`)
  ok('库存 category + sort → 200', invCatSort.status === 200)
  ok('  筛选结果仍限调味品', invCatSort.body.every((r: any) => r.category_id === seasonCatId))

  ok('库存 category_id=abc → 400', (await req('GET', '/api/ingredients?category_id=abc')).status === 400)

  /* ============================================================
   * J. API Schema / 安全性
   * ============================================================ */
  console.log('\n===== J. API Schema / 安全性 =====')

  ok('categories 未知 query 参数 → 400', (await req('GET', '/api/categories?nope=1')).status === 400)
  ok('definitions 未知 query → 400', (await req('GET', '/api/definitions?nope=1')).status === 400)
  ok('ingredients 未知 query → 400', (await req('GET', '/api/ingredients?nope=1')).status === 400)

  // SQL 注入尝试
  const injections = [
    "category_id=1;DROP TABLE category;--",
    "category_id=1' OR '1'='1",
    'category_id=__proto__',
    'category_id=constructor',
  ]
  for (const q of injections) {
    const r = await req('GET', `/api/definitions?${q}`)
    ok(`注入尝试被拒绝：${q}`, r.status === 400, `${r.status}`)
  }

  const categoryTableStillExists = raw.prepare("select name from sqlite_master where type='table' and name='category'").get()
  ok('注入后 category 表仍存在', categoryTableStillExists !== undefined)

  const catInject = await req('POST', '/api/categories', { name: "x'; DROP TABLE category;--" })
  ok('分类名中的 SQL 被当作普通字符串', catInject.status === 201, `${catInject.status}`)
  ok('  category 表未被破坏', raw.prepare("select name from sqlite_master where type='table' and name='category'").get() !== undefined)
  if (catInject.status === 201) {
    await req('DELETE', `/api/categories/${catInject.body.id}`)
  }

  /* ============================================================
   * K. Phase 4 回归
   * ============================================================ */
  console.log('\n===== K. Phase 4 回归 =====')

  const p4Def = await req('POST', '/api/definitions', {
    name: 'P4测试食材', units: ['克'], category_id: vegCatId, estimated_shelf_life_days: null,
  })

  // 五字段相同 → 合并
  const p4a = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 10, unit: '克', purchase_date: shift(-300),
  })
  const p4b = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 20, unit: '克', purchase_date: shift(-300),
  })
  ok('五字段相同 → 合并（ID 保留）', p4a.body.id === p4b.body.id && p4b.body.quantity === 30, `${p4b.body.quantity}`)
  ok('  NULL expiry 参与 NULL-safe 合并', p4a.body.expiry_date === null && p4b.body.expiry_date === null)

  // unit 不同 → 不合并
  const p4c = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 5, unit: '个', purchase_date: shift(-300),
  })
  ok('unit 不同 → 不合并', p4c.body.id !== p4a.body.id)

  // storage_method 不同 → 不合并
  const p4d = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 5, unit: '克', purchase_date: shift(-301),
  })
  const p4e = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 5, unit: '克', purchase_date: shift(-301), storage_method: '冷冻',
  })
  ok('storage_method 不同 → 不合并', p4d.body.id !== p4e.body.id)

  // expiry 不同 → 不合并
  const p4f = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 5, unit: '克', purchase_date: shift(-302), expiry_date: shift(30),
  })
  const p4g = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 5, unit: '克', purchase_date: shift(-302), expiry_date: shift(60),
  })
  ok('expiry 不同 → 不合并', p4f.body.id !== p4g.body.id)

  // 编辑合并（策略 B：保留当前编辑记录 ID）
  const eA = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 100, unit: '克', purchase_date: shift(-303), expiry_date: shift(10), note: '当前编辑',
  })
  const eB = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 200, unit: '克', purchase_date: shift(-303), expiry_date: shift(20), note: '目标',
  })
  ok('构造两条不同批次', eA.body.id !== eB.body.id)
  const eMerged = await req('PATCH', `/api/ingredients/${eA.body.id}`, { expiry_date: shift(20) })
  ok('编辑合并：保留当前编辑记录 ID', eMerged.body.id === eA.body.id, `${eMerged.body.id}`)
  ok('  数量 = 100 + 200 = 300', eMerged.body.quantity === 300, `${eMerged.body.quantity}`)
  ok('  目标记录已删除', raw.prepare('select id from standard_ingredient where id = ?').get(eB.body.id) === undefined)
  ok('  保留 A 的 note', (raw.prepare('select note from standard_ingredient where id = ?').get(eA.body.id) as any).note === '当前编辑')

  // 事务原子性
  const at1 = await req('POST', '/api/ingredients', {
    definition_id: p4Def.body.id, quantity: 11, unit: '克', purchase_date: shift(-304),
  })
  const atBefore = JSON.stringify(raw.prepare('select * from standard_ingredient where id = ?').get(at1.body.id))
  const atFail = await req('PATCH', `/api/ingredients/${at1.body.id}`, { unit: '斤' })
  ok('非法 unit 导致失败', atFail.status === 400)
  const atAfter = JSON.stringify(raw.prepare('select * from standard_ingredient where id = ?').get(at1.body.id))
  ok('  失败后记录完全未变（原子性）', atBefore === atAfter)

  /* ============================================================
   * 数据安全：分类操作不修改库存
   * ============================================================ */
  console.log('\n===== 数据安全 =====')
  const stocksBefore = raw.prepare('select * from standard_ingredient order by id').all()
  const defsBefore = raw.prepare('select id, category_id, name from ingredient_definition order by id').all()

  // 大量只读操作
  for (let i = 0; i < 3; i++) {
    await req('GET', '/api/categories')
    await req('GET', '/api/definitions?category_id=' + vegCatId)
    await req('GET', '/api/ingredients?category_id=' + vegCatId)
    await req('GET', '/api/definitions?search=菜&category_id=' + vegCatId + '&sort=name&order=desc')
  }

  ok('只读操作后库存表未变',
    JSON.stringify(raw.prepare('select * from standard_ingredient order by id').all()) === JSON.stringify(stocksBefore))
  ok('只读操作后 definition 表未变',
    JSON.stringify(raw.prepare('select id, category_id, name from ingredient_definition order by id').all()) === JSON.stringify(defsBefore))
} finally {
  // 兜底：父脚本异常时 seed 可能仍存活；幂等，重复调用安全
  await killSeed()
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== v0.1.3 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
