/**
 * v0.2.4 规模验证：导入 ~1200 条后，列表 / 推荐 / 标签筛选的耗时与覆盖
 *
 * 只做**证据采集 + 关键不变量**，不预先改候选上限：
 *   - `/api/recipes` 返回条数与耗时；
 *   - 标签筛选耗时与条数；
 *   - `/api/recommendation/meal-plans` 耗时、方案数、主菜是否互异；
 *   - 主菜/配菜在候选 40 截断后的实际覆盖（打印，作为后续是否调参的证据）；
 *   - 两次调用确定性、只读（全库摘要不变）。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-content-scale.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath, startServer, waitForReady } from './harness/server-lifecycle.js'
import { generateContent } from './seed/v024-content/recipes.js'
import { importContentV024 } from './seed/v024-content/importer.js'
import { applyStock, planStock } from './seed/v024-content/stock.js'

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
const info = (label: string) => console.log(`  · ${label}`)

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-scale-${randomUUID()}`)
const dbPath = resolve(runRoot, `scale-${Date.now()}.db`)
const PORT = 65200 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const realData = resolve(serverRoot, 'data')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) abort('测试库不在运行目录内')

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(serverRoot, 'drizzle')
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
for (const file of readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

const content = generateContent()
const stats = db.transaction(() => importContentV024(db, content, { dryRun: false }))()
info(`导入：菜谱 ${stats.inserted_recipes}、定义 ${stats.inserted_definitions}`)

// 备足测试库存，让推荐走真实的有库存路径（而不是全部缺料）
const stockResult = db.transaction(() => applyStock(db, planStock(db)))()
info(`库存：拉长期限 ${stockResult.updated_expiry} 条、新增批次 ${stockResult.inserted_batches} 条`)

const recipeCount = (db.prepare('select count(*) as c from recipe').get() as { c: number }).c

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')
const digest = (): string => {
  const tables = [
    'recipe',
    'recipe_ingredient',
    'recipe_step',
    'recipe_tag',
    'recipe_tag_link',
    'standard_ingredient',
    'ingredient_definition',
    'cooking_session',
    'app_settings',
  ]
  return tables
    .map((t) => `${t}:${JSON.stringify(raw.prepare(`select * from "${t}" order by rowid`).all())}`)
    .join('|')
}

interface Res {
  status: number
  body: any
}
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
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

let server: ReturnType<typeof startServer> | null = null

try {
  server = startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })

  console.log('\n[A] 菜谱列表（1200+）')

  const t0 = Date.now()
  const list = await req('GET', '/api/recipes')
  const listMs = Date.now() - t0
  ok('A1 列表 200', list.status === 200, String(list.status))
  ok('A2 返回条数与库内一致', Array.isArray(list.body) && list.body.length === recipeCount,
    `${Array.isArray(list.body) ? list.body.length : 'n/a'}/${recipeCount}`)
  info(`/api/recipes 耗时 ${listMs}ms（${recipeCount} 条）`)

  const t1 = Date.now()
  const filtered = await req('GET', `/api/recipes?tags=${encodeURIComponent('川菜')}&tag_mode=and`)
  const filterMs = Date.now() - t1
  ok('A3 标签筛选 200 且非空', filtered.status === 200 && Array.isArray(filtered.body) && filtered.body.length > 0,
    `${filtered.status}`)
  info(`标签筛选（川菜）耗时 ${filterMs}ms，命中 ${Array.isArray(filtered.body) ? filtered.body.length : 0} 条`)

  console.log('\n[B] 推荐（候选 40 截断下的覆盖证据）')

  const digestBefore = digest()
  const t2 = Date.now()
  const plans1 = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const recMs = Date.now() - t2
  ok('B1 推荐 200 且有方案', plans1.status === 200 && (plans1.body?.plans ?? []).length > 0,
    `${plans1.status} ${JSON.stringify(plans1.body?.notes ?? [])}`)
  const plans: any[] = plans1.body?.plans ?? []
  info(`meal-plans 耗时 ${recMs}ms：方案 ${plans.length} 套，候选 ${plans1.body?.considered_recipe_count}，组合 ${plans1.body?.combinations_evaluated}`)

  const mains = plans.map((p) => p.main_dish_recipe_id)
  ok('B2 主菜互不相同', new Set(mains).size === mains.length, JSON.stringify(mains))

  const sideCoverage = plans.map((p) => (p.dishes ?? []).filter((d: any) => d.role_in_meal === 'side').length)
  info(`每套方案配菜数量：${JSON.stringify(sideCoverage)}`)
  ok('B3 至少有一套方案带配菜', sideCoverage.some((n: number) => n > 0))

  const roleSets = plans.map((p) => (p.summary?.dish_roles ?? []).join('/'))
  info(`每套方案菜品类型：${JSON.stringify(roleSets)}`)

  const digestAfter = digest()
  const plans2 = await req('POST', '/api/recommendation/meal-plans', { people: 2 })

  ok('B4 同输入两次调用结果一致（确定性）',
    JSON.stringify(plans2.body?.plans) === JSON.stringify(plans1.body?.plans))
  ok('B5 推荐只读（全库摘要不变）', digestBefore === digestAfter && digestAfter === digest())

  info(`阈值参考（不作硬断言）：列表 ${listMs}ms、筛选 ${filterMs}ms、推荐 ${recMs}ms`)
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    await server?.stop()
  } catch {
    /* 忽略 */
  }
  try {
    raw.close()
    db.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === realData.toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-scale-')) {
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
