/**
 * v0.2.3 内容包**端到端验收**：导入的菜谱必须真的能用
 *
 * 链路（全部走真实 Fastify 路由 + 真实 Service）：
 *   1. 隔离库建到 0012 → `importRecipeContent` 导入真实 `content.json`；
 *   2. 只给**目标菜谱**的配料补库存（库存只存在于测试 fixture，**不是内容包带来的**）；
 *   3. `POST /api/recommendation/meal-plans` → 目标菜谱必须出现在方案里；
 *   4. `POST /api/recommendation/apply`（snapshot_id → 建会话）→ 逐道 PATCH `done`；
 *   5. `GET .../settle/preview` → 用后端给的 **`confirm_reason`** 逐条确认；
 *   6. `POST .../settle` → 200，且**确实发生了按量扣减**。
 *
 * 这一步同时证明导入器生成的非空 `line_key` 在烹饪链路里真的可用
 * （缺少 `line_key` 时确认/结算无法逐条定位）。
 *
 * 运行：`cd server && node --import tsx seed/v023-content/verify-content-e2e.ts`
 * 隔离：`HOME_CHEF_TEST_DB_DIR` 指向系统 tmp；**绝不接触** `server/data`。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'

import { assertSafeDbPath } from '../../src/db/safe-db-path.js'
import { startServer, waitForReady, ServerStartupError, type ServerHandle } from '../../harness/server-lifecycle.js'
import { importRecipeContent } from './importer.js'

let pass = 0
let fail = 0
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++
    console.log(`  [PASS] ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  } else {
    fail++
    console.log(`  [FAIL] ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  }
}

const serverRoot = process.cwd()
const contentPath = resolve(serverRoot, 'seed/v023-content/content.json')
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-content-e2e-${randomUUID()}`)
const dbPath = resolve(runRoot, 'content-e2e.db')
const PORT = 36000 + Math.floor(Math.random() * 1500)
const BASE = `http://127.0.0.1:${PORT}`

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e) {
  console.error(`ABORT: assertSafeDbPath 拒绝：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) {
  console.error('ABORT: 测试库不在本次运行目录内')
  process.exit(1)
}
mkdirSync(runRoot, { recursive: true })
process.on('exit', () => {
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) return
    if (!resolvedRun.startsWith(resolve(baseRoot))) return
    if (!basename(resolvedRun).startsWith('hc-content-e2e-')) return
    rmSync(resolvedRun, { recursive: true, force: true })
  } catch {
    /* 交给系统回收 */
  }
})

/* ---------- 建库 + 导入真实内容包 ---------- */
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const drizzleDir = resolve(serverRoot, 'drizzle')
for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim()
    if (trimmed !== '') db.exec(trimmed)
  }
}
const imported = importRecipeContent(db, { contentPath, dryRun: false })
const extraPath = resolve(serverRoot, 'seed/v023-content/content-extra.json')
const importedExtra = importRecipeContent(db, { contentPath: extraPath, dryRun: false })
console.log(
  `\n导入：定义 +${imported.definitions_added}（复用 ${imported.definitions_reused}）｜菜谱 +${imported.recipes_added}｜配料 +${imported.ingredients_added}｜步骤 +${imported.steps_added}`,
)
console.log(
  `增量包：定义 +${importedExtra.definitions_added}（跳过 ${importedExtra.definitions_skipped.length}）｜别名 +${importedExtra.aliases_added}｜单位 +${importedExtra.units_added}`,
)

/* ---------- 选目标菜谱：配料行最少的那道（便于精确补库存） ---------- */
interface Line {
  recipe_id: number
  definition_id: number
  quantity: number | null
  unit: string | null
  line_key: string | null
}
const target = db
  .prepare(
    `select r.id as recipe_id, r.name as recipe_name, count(ri.id) as lines
     from recipe r join recipe_ingredient ri on ri.recipe_id = r.id
     where r.id > 1
     group by r.id order by lines asc, r.id asc limit 1`,
  )
  .get() as { recipe_id: number; recipe_name: string; lines: number }
console.log(`目标菜谱：${target.recipe_name}（id=${target.recipe_id}，${target.lines} 条配料）`)

const now = new Date().toISOString()
const lines = db
  .prepare(
    'select recipe_id, definition_id, quantity, unit, line_key from recipe_ingredient where recipe_id = ? order by sort_order',
  )
  .all(target.recipe_id) as Line[]
ok(
  '导入的配料行都有非空 line_key（烹饪链路逐条定位的前提）',
  lines.length > 0 && lines.every((l) => l.line_key !== null && l.line_key.length > 10),
  `lines=${lines.length}`,
)

/* ---------- 只库存目标菜谱的配料（测试 fixture，不是内容包写入） ---------- */
let stocked = 0
for (const line of lines) {
  if (line.unit === null) continue
  const qty = Math.max((line.quantity ?? 10) * 20, 50)
  db.prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  ).run(line.definition_id, qty, line.unit, '2026-01-01', null, null, '常温', now, now)
  stocked++
}
console.log(`测试补库存：${stocked} 条（仅为目标菜谱配料）`)
db.close()

/* ---------- HTTP 助手 ---------- */
async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

let server: ServerHandle | null = null
try {
  server = await startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30000, handle: server })

  console.log('\n===== 1) 推荐里必须出现导入的菜谱 =====')
  const plans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('meal-plans 200 且有方案', plans.status === 200 && plans.body.plans.length > 0, `plans=${plans.body?.plans?.length}`)

  let chosen: any = null
  for (const plan of plans.body.plans) {
    if (plan.dishes.some((d: any) => d.recipe_id === target.recipe_id)) {
      chosen = plan
      break
    }
  }
  ok(
    '目标菜谱出现在推荐方案中',
    chosen !== null,
    chosen === null ? `方案菜谱=${JSON.stringify(plans.body.plans.map((p: any) => p.dishes.map((d: any) => d.recipe_name)))}` : `level=${chosen.level}`,
  )
  if (chosen === null) throw new Error('目标菜谱未进入推荐方案，无法继续端到端')

  console.log('\n===== 2) apply → 建会话 → 逐道 done =====')
  const applied = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: chosen.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: chosen.snapshot_id,
    request_id: `e2e-${randomUUID()}`,
  })
  ok('apply 200 且返回 session_id', applied.status === 200 && typeof applied.body?.session_id === 'number', `${applied.status}/${JSON.stringify(applied.body)}`)
  const sessionId = applied.body.session_id as number

  const detail = await req('GET', `/api/cooking/sessions/${sessionId}`)
  ok(
    '会话里包含目标菜谱',
    detail.body.dishes.some((d: any) => d.recipe_id === target.recipe_id),
    JSON.stringify(detail.body.dishes.map((d: any) => d.recipe_name)),
  )
  let lastStatus = ''
  for (const d of detail.body.dishes) {
    const p = await req('PATCH', `/api/cooking/sessions/${sessionId}/dishes/${d.id}/progress`, {
      status: 'done',
    })
    lastStatus = p.body?.status ?? ''
  }
  ok('全部菜品完成后进入待结算', lastStatus === 'awaiting_settlement', lastStatus)

  console.log('\n===== 3) 预览 → 按 confirm_reason 逐条确认 =====')
  const pv = await req('GET', `/api/cooking/sessions/${sessionId}/settle/preview`)
  ok('预览 200', pv.status === 200, String(pv.status))
  const pending = (pv.body.items as any[]).filter(
    (i) => i.required_reason !== null && !i.confirmed && i.line_key !== null,
  )
  console.log(
    `  预览共 ${pv.body.items.length} 项；需确认 ${pending.length} 项：` +
      JSON.stringify(pending.map((i) => [i.definition_name, i.required_reason, i.confirm_reason])),
  )
  if (pending.length > 0) {
    const confirmed = await req('POST', `/api/cooking/sessions/${sessionId}/skips`, {
      confirmations: pending.map((i) => ({
        dish_id: i.dish_id,
        line_key: i.line_key as string,
        reason: (i.confirm_reason ?? i.required_reason) as string,
      })),
    })
    ok('按后端给的 confirm_reason 确认全部必需项 → 200', confirmed.status === 200, `${confirmed.status}/${JSON.stringify(confirmed.body)}`)
  } else {
    ok('无需确认（全部项可直接扣减）', true)
  }

  const pv2 = await req('GET', `/api/cooking/sessions/${sessionId}/settle/preview`)
  ok(
    '确认后：无待确认且库存充足',
    pv2.body.needing_confirmation === 0 && pv2.body.stock_sufficient === true,
    `nc=${pv2.body.needing_confirmation} stock=${pv2.body.stock_sufficient}`,
  )

  console.log('\n===== 4) 结算：真实扣减 =====')
  const settled = await req('POST', `/api/cooking/sessions/${sessionId}/settle`, {})
  ok('settle 200', settled.status === 200, `${settled.status}/${JSON.stringify(settled.body?.error ?? null)}`)
  const items = (settled.body?.items ?? []) as any[]
  const deducted = items.filter((i) => (i.consumed_quantity ?? 0) > 0)
  ok(
    '结算确实按量扣减了导入菜谱的配料',
    deducted.length > 0,
    JSON.stringify(deducted.slice(0, 3).map((i) => [i.definition_name, i.required_quantity, i.consumed_quantity, i.outcome])),
  )
  ok(
    '所有结果项都带 outcome（含被跳过的项如实记录）',
    items.length > 0 && items.every((i) => typeof i.outcome === 'string'),
    JSON.stringify([...new Set(items.map((i) => i.outcome))]),
  )
  const sessionAfter = await req('GET', `/api/cooking/sessions/${sessionId}`)
  ok('会话进入已结算终态', sessionAfter.body?.status === 'settled', String(sessionAfter.body?.status))
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${e instanceof ServerStartupError ? '服务启动失败' : '异常'}：${e?.message ?? String(e)}`)
} finally {
  if (server !== null) await server.stop()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
