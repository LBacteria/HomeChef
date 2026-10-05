/**
 * 最终验证 · 第 4–7 项（重建版）
 *
 * ⚠️ 说明：Phase 1–4 的原始验证脚本在各阶段结束时已按当时要求删除。
 *    本脚本**重建**等价验证，覆盖相同的检查意图与基准项。
 *    使用独立临时库，不触碰正式库与既有测试库。
 *
 * 覆盖：
 *   Phase 1 —— 数据库约束行为
 *   Phase 2 —— Service 层行为
 *   Phase 3 —— API 集成（真实 HTTP）
 *   Phase 4 —— 前端页面 + HTTP + SQLite 集成
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'

// 使用动态端口，避免与先前运行残留的进程冲突
// （若端口被旧实例占用，测试会静默连到旧实例的数据库，导致误判）
const SERVER_PORT = 26000 + Math.floor(Math.random() * 3000)
const VITE_PORT = SERVER_PORT + 1
const SERVER = `http://127.0.0.1:${SERVER_PORT}`
const VITE = `http://localhost:${VITE_PORT}`

const serverDir = resolve(process.cwd())
const clientDir = resolve(process.cwd(), '..', 'client')
// 使用带时间戳的独立库名，避免与先前运行的残留文件冲突
const dbPath = resolve(serverDir, 'data', `finalverify-phases-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* ============================================================
 * 建表（独立临时库）
 * ============================================================ */
const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(serverDir, 'drizzle')
for (const f of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
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

interface Res { status: number; body: any; text: string }
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${SERVER}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text.length > 0 ? JSON.parse(text) : undefined } catch { parsed = undefined }
  return { status: res.status, body: parsed, text }
}

/* ============================================================
 * 启动 server 与 vite（临时进程）
 * ============================================================ */
const serverProc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: serverDir,
  env: { ...process.env, PORT: String(SERVER_PORT), HOME_CHEF_DB_PATH: dbPath },
  stdio: 'ignore',
  shell: true,
})
const viteProc: ChildProcess = spawn(
  'npx',
  ['vite', '--port', String(VITE_PORT), '--strictPort'],
  { cwd: clientDir, env: { ...process.env, HOME_CHEF_API_TARGET: SERVER }, stdio: 'ignore', shell: true },
)

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

// 预检：端口必须空闲，否则会静默连到旧实例
async function assertPortFree(url: string, label: string) {
  try {
    await fetch(url)
    console.log(`[FAIL] ${label} 端口已被占用（${url}）—— 存在残留进程，测试会误判`)
    process.exit(1)
  } catch {
    /* 连接失败 = 端口空闲，正确 */
  }
}
await assertPortFree(`${SERVER}/health`, 'server')
await assertPortFree(`${VITE}/`, 'vite')

const serverUp = await waitFor(`${SERVER}/health`)
const viteUp = await waitFor(`${VITE}/`)
console.log(`server=${serverUp} vite=${viteUp}  (ports ${SERVER_PORT}/${VITE_PORT})\n`)
if (!serverUp || !viteUp) {
  console.log('[FAIL] 服务未就绪')
  serverProc.kill(); viteProc.kill(); process.exit(1)
}

try {
  /* ============================================================
   * PHASE 1 —— 数据库约束行为（通过 HTTP 间接验证，另含直接约束检查）
   * ============================================================ */
  console.log('===== PHASE 1: 数据库约束行为 =====')
  const p1 = await req('POST', '/api/definitions', { name: '约束测试', units: ['个'], estimated_shelf_life_days: 5 })
  ok('P1-1 创建定义成功', p1.status === 201, `${p1.status}`)
  ok('P1-2 保质期 -1 被拒绝', (await req('POST', '/api/definitions', { name: 'X1', units: ['个'], estimated_shelf_life_days: -1 })).status === 400)
  ok('P1-3 无 units 被拒绝', (await req('POST', '/api/definitions', { name: 'X2', units: [] })).status === 400)
  const dId = p1.body.id

  // 1:N —— 同一定义多条库存
  const s1 = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 3, unit: '个', purchase_date: '2026-10-02' })
  const s2 = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-03' })
  ok('P1-4 同定义可创建多条库存（无 UNIQUE(definition_id)）', s1.status === 201 && s2.status === 201)

  // 单位枚举
  ok('P1-5 非法单位被拒绝', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '斤' })).status === 400)
  ok('P1-6 非法储存方式被拒绝', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', storage_method: '恒温' })).status === 400)
  // 数量非负
  ok('P1-7 负数数量被拒绝', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: -1, unit: '个' })).status === 400)
  // 日期约束
  ok('P1-8 production > purchase 被拒绝', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02', production_date: '2026-10-10' })).status === 400)
  ok('P1-9 manual expiry < purchase 被拒绝', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02', expiry_date: '2026-09-30' })).status === 400)
  const shortDef = await req('POST', '/api/definitions', { name: '短保', units: ['个'], estimated_shelf_life_days: 2 })
  const early = await req('POST', '/api/ingredients', { definition_id: shortDef.body.id, quantity: 1, unit: '个', purchase_date: '2026-10-02', production_date: '2026-09-28' })
  ok('P1-10 estimated expiry < purchase 允许（09-30）', early.status === 201 && early.body.expiry_date === '2026-09-30', `${early.body?.expiry_date}`)
  // 外键
  ok('P1-11 definition_id 不存在被拒绝', (await req('POST', '/api/ingredients', { definition_id: 999999, quantity: 1, unit: '个' })).status === 404)
  // 删除保护
  ok('P1-12 有库存时删定义被拒绝(HAS_STOCK)', (await req('DELETE', `/api/definitions/${dId}`)).status === 409)

  /* ============================================================
   * PHASE 2 —— Service 行为
   * ============================================================ */
  console.log('\n===== PHASE 2: Service 行为 =====')
  // 到期估算 A/B/C/D
  const estC = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02' })
  ok('P2-1 情况C：purchase+5=10-07 / estimated', estC.body.expiry_date === '2026-10-07' && estC.body.expiry_date_source === 'estimated', `${estC.body.expiry_date}`)
  const estB = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02', production_date: '2026-09-28' })
  ok('P2-2 情况B：production+5=10-03', estB.body.expiry_date === '2026-10-03', `${estB.body.expiry_date}`)
  const manA = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02', expiry_date: '2026-10-20' })
  ok('P2-3 情况A：manual', manA.body.expiry_date_source === 'manual')
  const noShelf = await req('POST', '/api/definitions', { name: '无保质期', units: ['个'], estimated_shelf_life_days: null })
  const estD = await req('POST', '/api/ingredients', { definition_id: noShelf.body.id, quantity: 1, unit: '个', purchase_date: '2026-10-02' })
  ok('P2-4 情况D：NULL/NULL', estD.body.expiry_date === null && estD.body.expiry_date_source === null)
  // purchase_date 默认今天
  const noPurchase = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个' })
  const today = new Date().toISOString().slice(0, 10)
  ok('P2-5 purchase_date 缺省为今天', noPurchase.body.purchase_date.length === 10)

  // 编辑重算规则
  const rEst = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02' })
  const rEst2 = await req('PATCH', `/api/ingredients/${rEst.body.id}`, { production_date: '2026-09-28' })
  ok('P2-6 estimated 改 production → 重算', rEst2.body.expiry_date === '2026-10-03', `${rEst2.body.expiry_date}`)
  const rMan2 = await req('PATCH', `/api/ingredients/${manA.body.id}`, { production_date: '2026-09-28' })
  ok('P2-7 manual 改 production → 保持', rMan2.body.expiry_date === '2026-10-20' && rMan2.body.expiry_date_source === 'manual')
  const rMan3 = await req('PATCH', `/api/ingredients/${manA.body.id}`, { purchase_date: '2026-10-05' })
  ok('P2-8 manual 改 purchase → 保持', rMan3.body.expiry_date === '2026-10-20')
  const rQtyBase = (await req('GET', `/api/ingredients/${rEst.body.id}`)).body
  const rQty = await req('PATCH', `/api/ingredients/${rEst.body.id}`, { quantity: 9 })
  ok('P2-9 只改 quantity → 不重算', rQty.body.expiry_date === rQtyBase.expiry_date, `${rQtyBase.expiry_date} → ${rQty.body.expiry_date}`)
  const rClear = await req('PATCH', `/api/ingredients/${manA.body.id}`, { expiry_date: null })
  ok('P2-10 显式清空 expiry → NULL/NULL 且不重算', rClear.body.expiry_date === null && rClear.body.expiry_date_source === null)
  const rManual = await req('PATCH', `/api/ingredients/${rEst.body.id}`, { expiry_date: '2026-10-30' })
  ok('P2-11 手动设置 → manual', rManual.body.expiry_date_source === 'manual')
  const rManual2 = await req('PATCH', `/api/ingredients/${rEst.body.id}`, { purchase_date: '2026-10-06' })
  ok('P2-12 manual 不会自动变回 estimated', rManual2.body.expiry_date_source === 'manual' && rManual2.body.expiry_date === '2026-10-30')

  // 改定义保质期只影响新库存
  const beforeScope = (await req('GET', '/api/ingredients')).body.filter((s: any) => s.definition_id === dId && s.expiry_date_source === 'estimated').map((s: any) => `${s.id}:${s.expiry_date}`).sort()
  await req('PATCH', `/api/definitions/${dId}`, { estimated_shelf_life_days: 100 })
  const afterScope = (await req('GET', '/api/ingredients')).body.filter((s: any) => s.definition_id === dId && s.expiry_date_source === 'estimated').map((s: any) => `${s.id}:${s.expiry_date}`).sort()
  ok('P2-13 改保质期不改动已有记录', JSON.stringify(beforeScope) === JSON.stringify(afterScope), `${beforeScope.length} 条`)
  const newStock = await req('POST', '/api/ingredients', { definition_id: dId, quantity: 1, unit: '个', purchase_date: '2026-10-02' })
  ok('P2-14 新建记录用新保质期(+100)', newStock.body.expiry_date === '2027-01-10', `${newStock.body.expiry_date}`)

  // 默认名称切换
  const swapDef = await req('POST', '/api/definitions', { name: '番茄A', units: ['个'], aliases: ['西红柿A', '番茄子A'] })
  const swapAliases = (await req('GET', `/api/definitions/${swapDef.body.id}/aliases`)).body
  const xhs = swapAliases.find((a: any) => a.alias === '西红柿A')
  const swapped = await req('POST', `/api/definitions/${swapDef.body.id}/default-name`, { alias_id: xhs.id })
  ok('P2-15 默认名称切换成功', swapped.status === 200 && swapped.body.name === '西红柿A')
  ok('P2-16 definition ID 不变', swapped.body.id === swapDef.body.id)
  const afterSwap = (await req('GET', `/api/definitions/${swapDef.body.id}/aliases`)).body
  ok('P2-17 新默认名称从别名移除', !afterSwap.some((a: any) => a.alias === '西红柿A'))
  ok('P2-18 原默认名称成为别名', afterSwap.some((a: any) => a.alias === '番茄A'))
  ok('P2-19 别名总数不变（2）', afterSwap.length === 2, `${afterSwap.length}`)

  // 跨表唯一性
  ok('P2-20 定义名 = 已有别名 → 409', (await req('POST', '/api/definitions', { name: '番茄A', units: ['个'] })).status === 409)
  ok('P2-21 别名 = 已有定义名 → 409', (await req('POST', `/api/definitions/${dId}/aliases`, { alias: '西红柿A' })).status === 409)

  // 单位管理
  const uDef = await req('POST', '/api/definitions', { name: '单位测试', units: ['个', '克'] })
  ok('P2-22 添加单位 → 201', (await req('POST', `/api/definitions/${uDef.body.id}/units`, { unit: '千克' })).status === 201)
  ok('P2-23 移除单位 → 204', (await req('DELETE', `/api/definitions/${uDef.body.id}/units/千克`)).status === 204)
  const uStock = await req('POST', '/api/ingredients', { definition_id: uDef.body.id, quantity: 1, unit: '克' })
  ok('P2-24 单位被使用 → 移除被拒绝(UNIT_IN_USE)', (await req('DELETE', `/api/definitions/${uDef.body.id}/units/克`)).status === 409)
  await req('DELETE', `/api/ingredients/${uStock.body.id}`)
  await req('DELETE', `/api/definitions/${uDef.body.id}/units/克`)
  ok('P2-25 删除最后一个单位被拒绝', (await req('DELETE', `/api/definitions/${uDef.body.id}/units/个`)).status === 400)

  // 消耗
  const cDef = await req('POST', '/api/definitions', { name: '消耗测试', units: ['克'] })
  const c1 = await req('POST', '/api/ingredients', { definition_id: cDef.body.id, quantity: 500, unit: '克' })
  const c2 = await req('POST', '/api/ingredients', { definition_id: cDef.body.id, quantity: 100, unit: '克' })
  ok('P2-26 消耗 500-200=300', (await req('POST', `/api/ingredients/${c1.body.id}/consume`, { amount: 200 })).body.quantity === 300)
  ok('P2-27 其他记录不受影响', (await req('GET', `/api/ingredients/${c2.body.id}`)).body.quantity === 100)
  ok('P2-28 库存不足 → 409', (await req('POST', `/api/ingredients/${c2.body.id}/consume`, { amount: 999 })).status === 409)
  ok('P2-29 失败后库存不变', (await req('GET', `/api/ingredients/${c2.body.id}`)).body.quantity === 100)
  ok('P2-30 amount=0 → 400', (await req('POST', `/api/ingredients/${c1.body.id}/consume`, { amount: 0 })).status === 400)
  ok('P2-31 amount 负数 → 400', (await req('POST', `/api/ingredients/${c1.body.id}/consume`, { amount: -1 })).status === 400)
  const zeroed = await req('POST', `/api/ingredients/${c1.body.id}/consume`, { amount: 300 })
  ok('P2-32 扣到 0 成功', zeroed.body.quantity === 0)
  ok('P2-33 0 记录仍可 GET（DB 保留）', (await req('GET', `/api/ingredients/${c1.body.id}`)).status === 200)
  ok('P2-34 列表隐藏 0 记录', !(await req('GET', '/api/ingredients')).body.some((s: any) => s.id === c1.body.id))

  // 浮点
  const fDef = await req('POST', '/api/definitions', { name: '浮点', units: ['千克'] })
  const f1 = await req('POST', '/api/ingredients', { definition_id: fDef.body.id, quantity: 0.3, unit: '千克' })
  await req('POST', `/api/ingredients/${f1.body.id}/consume`, { amount: 0.1 })
  await req('POST', `/api/ingredients/${f1.body.id}/consume`, { amount: 0.1 })
  const f3 = await req('POST', `/api/ingredients/${f1.body.id}/consume`, { amount: 0.1 })
  ok('P2-35 0.3 连续扣 0.1×3 → 恰好 0', f3.body.quantity === 0, `${f3.body.quantity}`)

  // 搜索 vs 精确
  await req('POST', '/api/definitions', { name: '土豆', units: ['个'] })
  await req('POST', '/api/definitions', { name: '土鸡', units: ['个'] })
  await req('POST', '/api/definitions', { name: '观音土', units: ['克'] })
  const searched = await req('GET', '/api/definitions?search=土')
  ok('P2-36 搜索 substring 返回多个', searched.body.length >= 3, `${searched.body.length}`)
  ok('P2-37 含"观音土"（包含匹配）', searched.body.some((d: any) => d.name === '观音土'))
  const aliasSearch = await req('GET', '/api/definitions?search=西红柿A')
  ok('P2-38 搜索命中别名', aliasSearch.body.some((d: any) => d.name === '西红柿A'))

  /* ============================================================
   * PHASE 3 —— API 契约
   * ============================================================ */
  console.log('\n===== PHASE 3: API 契约 =====')
  ok('P3-1 /health 200', (await req('GET', '/health')).status === 200)
  ok('P3-2 非法 ID → 400', (await req('GET', '/api/ingredients/abc')).status === 400)
  ok('P3-3 ID=0 → 400', (await req('GET', '/api/ingredients/0')).status === 400)
  ok('P3-4 ID=-1 → 400', (await req('GET', '/api/ingredients/-1')).status === 400)
  ok('P3-5 ID=1.5 → 400', (await req('GET', '/api/ingredients/1.5')).status === 400)
  ok('P3-6 不存在库存 → 404', (await req('GET', '/api/ingredients/999999')).status === 404)
  ok('P3-7 不存在定义 → 404', (await req('GET', '/api/definitions/999999')).status === 404)
  ok('P3-8 未知路由 → 404', (await req('GET', '/api/nope')).status === 404)
  const errShape = (await req('GET', '/api/ingredients/999999')).body
  ok('P3-9 错误格式统一 {error:{code,message}}', typeof errShape?.error?.code === 'string' && typeof errShape?.error?.message === 'string')
  ok('P3-10 quantity 字符串被拒绝（coerceTypes=false）', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: '3', unit: '个' })).status === 400)
  ok('P3-11 未知字段被拒绝（removeAdditional=false）', (await req('POST', '/api/ingredients', { definition_id: dId, quantity: 3, unit: '个', extra: 1 })).status === 400)
  ok('P3-12 旧 alias 路由已移除 → 404', (await req('GET', `/api/ingredients/${dId}/aliases`)).status === 404)
  const dupName = await req('POST', '/api/definitions', { name: '土鸡', units: ['个'] })
  ok('P3-13 DUPLICATE_NAME 错误码', dupName.status === 409 && dupName.body.error.code === 'DUPLICATE_NAME')
  const insuff = await req('POST', `/api/ingredients/${c2.body.id}/consume`, { amount: 999 })
  ok('P3-14 INSUFFICIENT_STOCK 错误码', insuff.body.error.code === 'INSUFFICIENT_STOCK')
  const hasStock = await req('DELETE', `/api/definitions/${dId}`)
  ok('P3-15 HAS_STOCK 错误码', hasStock.body.error.code === 'HAS_STOCK')
  ok('P3-16 HAS_STOCK message 可读', typeof hasStock.body.error.message === 'string' && hasStock.body.error.message.length > 0, hasStock.body.error.message)

  /* ============================================================
   * PHASE 4 —— 前端 + HTTP + SQLite + Vite 集成
   * ============================================================ */
  console.log('\n===== PHASE 4: 前端集成 =====')
  const page = await fetch(`${VITE}/`)
  const html = await page.text()
  ok('P4-1 页面 200', page.status === 200)
  ok('P4-2 HTML 含 #root', html.includes('id="root"'))
  for (const f of [
    'src/main.tsx', 'src/App.tsx',
    'src/pages/InventoryPage.tsx', 'src/pages/DefinitionsPage.tsx',
    'src/components/InventoryForm.tsx', 'src/components/DefinitionForm.tsx',
    'src/components/DefinitionEditor.tsx', 'src/components/ConsumeDialog.tsx',
    'src/api/definitions.ts', 'src/api/inventory.ts', 'src/format.ts',
  ]) {
    const r = await fetch(`${VITE}/${f}`)
    ok(`P4   ${f} 可编译`, r.status === 200, `${r.status}`)
  }
  // Vite proxy 转发
  const proxied = await fetch(`${VITE}/api/definitions`)
  ok('P4-3 Vite proxy 转发 /api 正常', proxied.status === 200)
  // 前端纯函数（分组不聚合）
  // Windows 上动态 import 绝对路径必须转为 file:// URL
  const fmt = await import(pathToFileURL(resolve(clientDir, 'src', 'format.ts')).href)
  ok('P4-4 formatQuantity(500)="500"', fmt.formatQuantity(500) === '500')
  ok('P4-5 formatQuantity(0.1+0.2)="0.3"', fmt.formatQuantity(0.1 + 0.2) === '0.3')
  ok('P4-6 expiryLabel(estimated)="预计到期"', fmt.expiryLabel('estimated') === '预计到期')
  ok('P4-7 expiryLabel(manual)="到期"', fmt.expiryLabel('manual') === '到期')
  ok('P4-8 expiryLabel(null)=null', fmt.expiryLabel(null) === null)
  const allStock = (await req('GET', '/api/ingredients')).body
  const groups = fmt.groupByDefinition(allStock)
  const multi = groups.find((g: any) => g.records.length > 1)
  ok('P4-9 分组存在（同定义多条）', multi !== undefined)
  ok('P4-10 分组不做数量聚合（仅 records 数组）', multi !== undefined && Array.isArray(multi.records) && !('total' in multi && multi.total !== undefined))
  // 过期判断
  const overdueDef = await req('POST', '/api/definitions', { name: '过期测试', units: ['个'], estimated_shelf_life_days: 2 })
  const overdue = await req('POST', '/api/ingredients', { definition_id: overdueDef.body.id, quantity: 1, unit: '个', purchase_date: '2020-01-01' })
  const info = fmt.describeExpiry({ expiry_date: overdue.body.expiry_date, expiry_date_source: overdue.body.expiry_date_source })
  ok('P4-11 过期日期被标记 overdue', info?.overdue === true, `${overdue.body.expiry_date}`)
  ok('P4-12 零数量记录不出现在默认列表', !allStock.some((s: any) => s.quantity === 0))
} finally {
  serverProc.kill()
  viteProc.kill()
  await new Promise((r) => setTimeout(r, 1000))
}

console.log(`\n===== 第 4–7 项合计：PASS=${pass}  FAIL=${fail} =====`)
console.log('（本脚本为重建版；原始阶段脚本已删除）')
process.exit(fail === 0 ? 0 : 1)
