/**
 * v0.1.2 Final Review —— 跨 Batch 数据安全与一致性审查（只读）
 *
 * 覆盖：
 *   1. GET 请求（列表/搜索/排序/设置读取）不产生任何数据库写入
 *   2. 三个 Batch 的查询组合不修改任何业务表
 *   3. 排序不改变库存与定义
 *   4. 只有 PATCH /api/settings 会写 app_settings
 *   5. 食材库排序与库存排序相互独立（互不影响结果集）
 *   6. Phase 4 merge 规则未被破坏（含 NULL-safe）
 *   7. API schema 与 Service 校验一致（非法值 400）
 *
 * 只读性质：独立临时库；不修改项目任何文件。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 47000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v012-final-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

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

function shift(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 全部业务表的完整快照 */
function snapshot() {
  return {
    definitions: raw.prepare('select * from ingredient_definition order by id').all(),
    aliases: raw.prepare('select * from ingredient_alias order by id').all(),
    units: raw.prepare('select * from ingredient_definition_unit order by id').all(),
    stocks: raw.prepare('select * from standard_ingredient order by id').all(),
    settings: raw.prepare('select * from app_settings order by id').all(),
    seedHistory: raw.prepare('select * from seed_history order by id').all(),
    seedMap: raw.prepare('select * from seed_ingredient_map order by id').all(),
  }
}

function totalChanges(): number {
  return (raw.prepare('select total_changes() c').get() as any).c
}

try {
  /* ============================================================
   * 准备数据
   * ============================================================ */
  console.log('===== 准备 =====')
  const d1 = await req('POST', '/api/definitions', { name: 'Zebra食材', units: ['克'], estimated_shelf_life_days: 10 })
  const d2 = await req('POST', '/api/definitions', { name: 'Apple食材', units: ['个'], estimated_shelf_life_days: null })
  const d3 = await req('POST', '/api/definitions', { name: 'Mango食材', units: ['克'], estimated_shelf_life_days: 30, aliases: ['芒果别名'] })

  // 库存：覆盖 expired / expiring / normal / no_expiry
  const s1 = await req('POST', '/api/ingredients', { definition_id: d1.body.id, quantity: 100, unit: '克', purchase_date: shift(-30), expiry_date: shift(-5) })
  const s2 = await req('POST', '/api/ingredients', { definition_id: d2.body.id, quantity: 2, unit: '个', purchase_date: shift(-10), expiry_date: shift(2) })
  const s3 = await req('POST', '/api/ingredients', { definition_id: d3.body.id, quantity: 300, unit: '克', purchase_date: shift(-20), expiry_date: shift(20) })
  const s4 = await req('POST', '/api/ingredients', { definition_id: d2.body.id, quantity: 5, unit: '个', purchase_date: shift(-1) })
  info('定义', `${d1.body.id},${d2.body.id},${d3.body.id}`)
  info('库存', `${s1.body.id},${s2.body.id},${s3.body.id},${s4.body.id}`)

  /* ============================================================
   * 一、GET 请求零写入
   * ============================================================ */
  console.log('\n===== 一、GET 请求零写入 =====')

  const before = snapshot()
  const changesBefore = totalChanges()

  // 覆盖三个 Batch 的所有只读端点与排序组合
  const readRequests: string[] = []
  for (const s of ['default', 'expiry', 'purchase_date', 'name', 'quantity']) {
    for (const o of ['asc', 'desc']) {
      readRequests.push(`/api/ingredients?sort=${s}&order=${o}`)
      readRequests.push(`/api/ingredients?sort=${s}&order=${o}&includeZero=true`)
    }
  }
  readRequests.push('/api/ingredients')
  for (const s of ['name']) {
    for (const o of ['asc', 'desc']) {
      readRequests.push(`/api/definitions?sort=${s}&order=${o}`)
      readRequests.push(`/api/definitions?search=食材&sort=${s}&order=${o}`)
    }
  }
  readRequests.push('/api/definitions')
  readRequests.push('/api/definitions?search=Apple')
  readRequests.push('/api/definitions?search=芒果别名')
  readRequests.push('/api/settings')
  readRequests.push(`/api/ingredients/${s1.body.id}`)
  readRequests.push(`/api/definitions/${d1.body.id}`)
  readRequests.push(`/api/definitions/${d3.body.id}/aliases`)
  readRequests.push(`/api/definitions/${d3.body.id}/units`)

  for (const p of readRequests) {
    const r = await req('GET', p)
    if (r.status !== 200) info(`非 200：${p}`, `${r.status}`)
  }
  info('已执行只读请求数', `${readRequests.length}`)

  const changesAfter = totalChanges()
  const after = snapshot()

  ok('所有 GET 请求期间 SQLite total_changes 增量为 0',
    changesAfter === changesBefore, `${changesBefore} → ${changesAfter}`)

  ok('ingredient_definition 未变', JSON.stringify(before.definitions) === JSON.stringify(after.definitions))
  ok('ingredient_alias 未变', JSON.stringify(before.aliases) === JSON.stringify(after.aliases))
  ok('ingredient_definition_unit 未变', JSON.stringify(before.units) === JSON.stringify(after.units))
  ok('standard_ingredient 未变', JSON.stringify(before.stocks) === JSON.stringify(after.stocks))
  ok('app_settings 未变（GET 不写设置）',
    JSON.stringify(before.settings) === JSON.stringify(after.settings))
  ok('seed_history 未变', JSON.stringify(before.seedHistory) === JSON.stringify(after.seedHistory))
  ok('seed_ingredient_map 未变', JSON.stringify(before.seedMap) === JSON.stringify(after.seedMap))

  /* ============================================================
   * 二、只有 PATCH 设置才写 app_settings
   * ============================================================ */
  console.log('\n===== 二、只有 PATCH 设置才写入 =====')

  const settingsBeforePatch = (raw.prepare('select count(*) c from app_settings').get() as any).c
  info('PATCH 前 app_settings 行数', `${settingsBeforePatch}`)

  const patchRes = await req('PATCH', '/api/settings', { expiry_warning_threshold: 7 })
  ok('PATCH /api/settings → 200', patchRes.status === 200, `${patchRes.status}`)

  const settingsAfterPatch = (raw.prepare('select count(*) c from app_settings').get() as any).c
  ok('PATCH 后 app_settings 有 1 行（单行表）', settingsAfterPatch === 1, `${settingsAfterPatch}`)

  const row = raw.prepare('select * from app_settings').get() as any
  ok('阈值已写入', row.expiry_warning_threshold === 7, `${row.expiry_warning_threshold}`)
  ok('单行约束 id=1', row.id === 1)

  // 再次 PATCH 应 UPDATE 而非 INSERT
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 9 })
  const afterSecondPatch = (raw.prepare('select count(*) c from app_settings').get() as any).c
  ok('第二次 PATCH 仍只有 1 行（UPDATE 而非 INSERT）', afterSecondPatch === 1, `${afterSecondPatch}`)

  // GET 不改变设置
  const settingsValueBefore = JSON.stringify(raw.prepare('select * from app_settings').get())
  await req('GET', '/api/settings')
  await req('GET', '/api/settings')
  const settingsValueAfter = JSON.stringify(raw.prepare('select * from app_settings').get())
  ok('多次 GET 不改变设置内容', settingsValueBefore === settingsValueAfter)

  /* ============================================================
   * 三、两个排序功能相互独立
   * ============================================================ */
  console.log('\n===== 三、两个排序功能独立 =====')

  const stocksBefore = JSON.stringify(raw.prepare('select * from standard_ingredient order by id').all())
  const defsBefore = JSON.stringify(raw.prepare('select * from ingredient_definition order by id').all())

  // 食材库排序反复调用
  await req('GET', '/api/definitions?sort=name&order=desc')
  await req('GET', '/api/definitions?sort=name&order=asc')
  const stocksAfterDefSort = JSON.stringify(raw.prepare('select * from standard_ingredient order by id').all())
  ok('食材库排序不影响库存表', stocksBefore === stocksAfterDefSort)

  // 库存排序反复调用
  await req('GET', '/api/ingredients?sort=expiry&order=desc')
  await req('GET', '/api/ingredients?sort=name&order=asc')
  const defsAfterStockSort = JSON.stringify(raw.prepare('select * from ingredient_definition order by id').all())
  ok('库存排序不影响定义表', defsBefore === defsAfterStockSort)

  // 白名单互斥
  ok('食材库拒绝库存字段 sort=expiry',
    (await req('GET', '/api/definitions?sort=expiry')).status === 400)
  ok('食材库拒绝 sort=purchase_date',
    (await req('GET', '/api/definitions?sort=purchase_date')).status === 400)
  ok('食材库拒绝 sort=quantity',
    (await req('GET', '/api/definitions?sort=quantity')).status === 400)
  ok('库存拒绝未知 sort', (await req('GET', '/api/ingredients?sort=zzz')).status === 400)

  // 食材库排序不使用库存数据：改库存数量后，食材库顺序应不变
  const defOrderBefore = (await req('GET', '/api/definitions?sort=name&order=asc')).body.map((d: any) => d.id)
  await req('POST', `/api/ingredients/${s3.body.id}/consume`, { amount: 1 })
  const defOrderAfter = (await req('GET', '/api/definitions?sort=name&order=asc')).body.map((d: any) => d.id)
  ok('改变库存数量不影响食材库排序', JSON.stringify(defOrderBefore) === JSON.stringify(defOrderAfter))

  /* ============================================================
   * 四、Phase 4 未被破坏
   * ============================================================ */
  console.log('\n===== 四、Phase 4 merge 规则 =====')

  const mDef = await req('POST', '/api/definitions', { name: 'Merge审查', units: ['克'], estimated_shelf_life_days: null })

  // 五字段相同 → 合并
  const mA = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 10, unit: '克', purchase_date: shift(-500) })
  const mB = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 20, unit: '克', purchase_date: shift(-500) })
  ok('五项相同 → 合并（ID 保留）', mA.body.id === mB.body.id && mB.body.quantity === 30,
    `id=${mB.body.id} qty=${mB.body.quantity}`)

  // unit 不同 → 不合并
  const mC = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 5, unit: '个', purchase_date: shift(-500) })
  ok('unit 不同 → 不合并', mC.body.id !== mA.body.id)

  // storage_method 不同 → 不合并
  const mD = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 5, unit: '克', purchase_date: shift(-501) })
  const mE = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 5, unit: '克', purchase_date: shift(-501), storage_method: '冷冻' })
  ok('storage_method 不同 → 不合并', mD.body.id !== mE.body.id)

  // NULL-safe：两条 expiry 均 NULL → 合并
  const nDef = await req('POST', '/api/definitions', { name: 'Null审查', units: ['克'], estimated_shelf_life_days: null })
  const nA = await req('POST', '/api/ingredients', { definition_id: nDef.body.id, quantity: 1, unit: '克', purchase_date: shift(-600) })
  const nB = await req('POST', '/api/ingredients', { definition_id: nDef.body.id, quantity: 2, unit: '克', purchase_date: shift(-600) })
  ok('NULL + NULL expiry → 合并（NULL-safe）', nA.body.id === nB.body.id && nB.body.quantity === 3,
    `qty=${nB.body.quantity}`)
  ok('  确认 expiry 均为 NULL', nA.body.expiry_date === null && nB.body.expiry_date === null)

  // NULL vs 非 NULL → 不合并
  const nC = await req('POST', '/api/ingredients', { definition_id: nDef.body.id, quantity: 3, unit: '克', purchase_date: shift(-600), expiry_date: shift(30) })
  ok('NULL vs 非 NULL → 不合并', nC.body.id !== nA.body.id)

  // Phase 3.1：PATCH definition_id
  const swap = await req('PATCH', `/api/ingredients/${nC.body.id}`, { definition_id: mDef.body.id, unit: '克' })
  ok('Phase 3.1 PATCH definition_id 仍工作', swap.status === 200 && swap.body.definition_id === mDef.body.id)

  // 换 definition 不重算 expiry
  const expBefore = swap.body.expiry_date
  const swap2 = await req('PATCH', `/api/ingredients/${nC.body.id}`, { definition_id: nDef.body.id })
  ok('换 definition 不重算 expiry', swap2.body.expiry_date === expBefore,
    `${expBefore} → ${swap2.body.expiry_date}`)

  /* ============================================================
   * 五、percentage 规则（Batch 1）
   * ============================================================ */
  console.log('\n===== 五、percentage 折算天数规则 =====')

  await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 15 })
  const pDef = await req('POST', '/api/definitions', { name: 'Pct审查', units: ['个'], estimated_shelf_life_days: null })

  async function statusOf(id: number) {
    return (await req('GET', '/api/ingredients?includeZero=true')).body.find((r: any) => r.id === id)
  }

  // 用 production 精确控制 total：start = production
  const pCases = [
    { total: 10, rem: 2, expect: 'expiring', ceil: 2, round: 2 },
    { total: 10, rem: 3, expect: 'normal', ceil: 2, round: 2 },
    { total: 7, rem: 2, expect: 'expiring', ceil: 2, round: 1 },
    { total: 7, rem: 1, expect: 'expiring', ceil: 2, round: 1 },
    { total: 3, rem: 1, expect: 'expiring', ceil: 1, round: 0 },
    { total: 3, rem: 2, expect: 'normal', ceil: 1, round: 0 },
  ]
  for (const c of pCases) {
    const startOffset = c.rem - c.total
    const r = await req('POST', '/api/ingredients', {
      definition_id: pDef.body.id, quantity: 1, unit: '个',
      production_date: shift(startOffset),
      purchase_date: shift(startOffset + 1),
      expiry_date: shift(c.rem),
    })
    const row = await statusOf(r.body.id)
    const distinguishable = c.ceil !== c.round
    ok(`total=${c.total} rem=${c.rem} → ${c.expect}${distinguishable ? '（ceil/round 可区分）' : ''}`,
      row.expiry_status === c.expect, `${row.expiry_status}`)
  }

  // 证明不依赖 remaining_percentage
  const pProof = await req('POST', '/api/ingredients', {
    definition_id: pDef.body.id, quantity: 1, unit: '个',
    production_date: shift(-8), purchase_date: shift(-7), expiry_date: shift(2),
  })
  const pProofRow = await statusOf(pProof.body.id)
  ok('remaining_percentage > threshold 但仍 expiring（证明用折算天数）',
    pProofRow.remaining_percentage > 15 && pProofRow.expiry_status === 'expiring',
    `${pProofRow.remaining_percentage}% / ${pProofRow.expiry_status}`)

  // 过期优先
  const pExpired = await req('POST', '/api/ingredients', {
    definition_id: pDef.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-100), expiry_date: shift(-1),
  })
  ok('过期优先于临期', (await statusOf(pExpired.body.id)).expiry_status === 'expired')

  // days 模式未被改变
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })
  const dCase = await req('POST', '/api/ingredients', {
    definition_id: pDef.body.id, quantity: 1, unit: '个', purchase_date: shift(-50), expiry_date: shift(3),
  })
  ok('days 模式未被改变（剩 3 <= 3 → expiring）',
    (await statusOf(dCase.body.id)).expiry_status === 'expiring')

  /* ============================================================
   * 六、非法设置输入
   * ============================================================ */
  console.log('\n===== 六、设置 API 校验 =====')
  ok('非法 mode → 400', (await req('PATCH', '/api/settings', { expiry_warning_mode: 'weeks' })).status === 400)
  ok('负阈值 → 400', (await req('PATCH', '/api/settings', { expiry_warning_threshold: -1 })).status === 400)
  ok('percentage 超 100 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 101 })).status === 400)
  ok('days 小数阈值 → 400',
    (await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 2.5 })).status === 400)
  ok('未知字段 → 400', (await req('PATCH', '/api/settings', { nope: 1 })).status === 400)
  ok('空 body → 400', (await req('PATCH', '/api/settings', {})).status === 400)
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  /* ============================================================
   * 七、迁移完整性
   * ============================================================ */
  console.log('\n===== 七、迁移与表结构 =====')
  const tables = (raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name").all() as Array<{ name: string }>).map((r) => r.name)
  info('业务表', tables.join(', '))
  // ⚠️ v0.1.3 新增 category 表 → 7 → 8
  ok('业务表 = 8 张（v0.1.2 的 7 张 + v0.1.3 的 category）', tables.length === 8, `${tables.length}`)
  ok('含 app_settings', tables.includes('app_settings'))
  ok('含 category（v0.1.3）', tables.includes('category'))
  ok('含 4 张原有表', ['ingredient_definition', 'ingredient_alias', 'ingredient_definition_unit', 'standard_ingredient'].every((t) => tables.includes(t)))

  // app_settings 结构正确
  const settingsCols = (raw.prepare('pragma table_info(app_settings)').all() as Array<{ name: string }>).map((c) => c.name)
  info('app_settings 列', settingsCols.join(', '))
  ok('app_settings 无重复列', settingsCols.length === new Set(settingsCols).size)
  ok('app_settings 只有 1 行', (raw.prepare('select count(*) c from app_settings').get() as any).c === 1)

  // 迁移顺序说明：
  // ⚠️ 本审查脚本直接 exec 每个 .sql 文件建表，**未经过 drizzle 迁移器**，
  //    因此这里没有 __drizzle_migrations 表 —— 这是审查环境的事实，不是产品问题。
  //    迁移文件的顺序与完整性由「批次二审查」中的 migrate 流程与下方文件清单验证。
  const migrationFiles = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()
  info('迁移文件（按字典序）', migrationFiles.join(' → '))
  // ⚠️ v0.1.3 新增 0005_category.sql → 5 → 6
  ok('迁移文件为 0000~0005 共 6 个', migrationFiles.length === 6, `${migrationFiles.length}`)
  ok('迁移前缀连续', migrationFiles.every((f, i) => f.startsWith(`000${i}_`)),
    migrationFiles.map((f) => f.slice(0, 4)).join(','))

  const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta', '_journal.json'), 'utf8'))
  const tags = journal.entries.map((e: any) => e.tag)
  info('journal 登记', tags.join(', '))
  ok('journal 登记数与文件数一致', tags.length === migrationFiles.length, `${tags.length} vs ${migrationFiles.length}`)
  ok('journal idx 连续', journal.entries.every((e: any, i: number) => e.idx === i))

  /* ============================================================
   * 八、库存排序完整行为
   * ============================================================ */
  console.log('\n===== 八、库存排序行为 =====')
  for (const s of ['default', 'expiry', 'purchase_date', 'name', 'quantity']) {
    const a = await req('GET', `/api/ingredients?sort=${s}&order=asc`)
    const d = await req('GET', `/api/ingredients?sort=${s}&order=desc`)
    ok(`sort=${s} asc/desc 均 200`, a.status === 200 && d.status === 200)
  }
  const defSort = (await req('GET', '/api/ingredients?sort=default')).body
  const statusOrder = { expired: 0, expiring: 1, normal: 2, no_expiry: 3 } as Record<string, number>
  let monotonic = true
  for (let i = 1; i < defSort.length; i++) {
    if (statusOrder[defSort[i - 1].expiry_status] > statusOrder[defSort[i].expiry_status]) { monotonic = false; break }
  }
  ok('默认排序状态分组单调', monotonic)

  // 稳定 tie-breaker
  const s1ids = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  const s2ids = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  ok('重复请求顺序一致（稳定）', JSON.stringify(s1ids) === JSON.stringify(s2ids))

  /* ============================================================
   * 九、食材库排序完整行为
   * ============================================================ */
  console.log('\n===== 九、食材库排序行为 =====')
  const dAsc = (await req('GET', '/api/definitions?sort=name&order=asc')).body
  const dDesc = (await req('GET', '/api/definitions?sort=name&order=desc')).body
  ok('A→Z 有序', dAsc.every((d: any, i: number) => i === 0 || dAsc[i - 1].name.localeCompare(d.name, 'zh-Hans-CN', { numeric: true }) <= 0),
    dAsc.map((d: any) => d.name).join(' < '))
  ok('Z→A 是反向', JSON.stringify(dDesc.map((d: any) => d.id)) === JSON.stringify([...dAsc.map((d: any) => d.id)].reverse()))
  const dDefault = (await req('GET', '/api/definitions')).body
  ok('默认 A→Z', JSON.stringify(dDefault.map((d: any) => d.id)) === JSON.stringify(dAsc.map((d: any) => d.id)))

  // 搜索 + 排序
  const sAsc = (await req('GET', '/api/definitions?search=食材&sort=name&order=asc')).body
  const sDesc = (await req('GET', '/api/definitions?search=食材&sort=name&order=desc')).body
  ok('搜索 + 排序命中一致',
    JSON.stringify([...sAsc.map((d: any) => d.id)].sort()) === JSON.stringify([...sDesc.map((d: any) => d.id)].sort()))

  // 别名不参与排序
  const mango = dAsc.find((d: any) => d.name === 'Mango食材')
  ok('别名不参与排序（Mango 按名称排在 M 位置）',
    dAsc.findIndex((d: any) => d.name === 'Mango食材') < dAsc.findIndex((d: any) => d.name === 'Zebra食材'))
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 审查结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
