/**
 * Phase 5 审查：边界问题主动排查
 *
 * 只读性质（使用独立临时库 + 动态端口）。
 * 目的：主动寻找潜在缺陷，不修改任何业务代码。
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 33000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `p5-edge-${Date.now()}.db`)

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

try {
  const tomato = await req('POST', '/api/definitions', {
    name: '番茄', units: ['个', '克', '千克'], estimated_shelf_life_days: 7,
  })
  const noShelf = await req('POST', '/api/definitions', { name: '无保质期', units: ['克'], estimated_shelf_life_days: null })
  const T = tomato.body.id, N = noShelf.body.id

  console.log('=== 边界 1：合并数量与 consume 的交互 ===')
  const a = await req('POST', '/api/ingredients', { definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-05-05' })
  await req('POST', '/api/ingredients', { definition_id: T, quantity: 50, unit: '克', purchase_date: '2026-05-05' })
  const aRow = raw.prepare('select quantity from standard_ingredient where id = ?').get(a.body.id) as { quantity: number }
  ok('合并后数量 150', aRow.quantity === 150, `${aRow.quantity}`)
  const cons = await req('POST', `/api/ingredients/${a.body.id}/consume`, { amount: 150 })
  ok('可消耗整个合并量到 0', cons.status === 200 && cons.body.quantity === 0, `${cons.body?.quantity}`)

  console.log('')
  console.log('=== 边界 2：quantity=0 记录被删除 definition 时的行为 ===')
  // zero 记录应被视为"存在库存记录"，阻止删除 definition
  const zeroDel = await req('DELETE', `/api/definitions/${T}`)
  ok('有 quantity=0 记录时 definition 不可删（HAS_STOCK）', zeroDel.status === 409, `${zeroDel.status}`)
  ok('错误码 HAS_STOCK', zeroDel.body?.error?.code === 'HAS_STOCK', zeroDel.body?.error?.code)

  console.log('')
  console.log('=== 边界 3：合并后 consume 跨记录（不应跨记录） ===')
  const b1 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 10, unit: '个', purchase_date: '2026-05-06' })
  const b2 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 20, unit: '个', purchase_date: '2026-05-07' })
  ok('不同批次两条独立', b1.body.id !== b2.body.id)
  const over = await req('POST', `/api/ingredients/${b1.body.id}/consume`, { amount: 15 })
  ok('消耗不跨记录（不足则拒绝）', over.status === 409, `${over.status}`)

  console.log('')
  console.log('=== 边界 4：decimal 合并精度 ===')
  const d1 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 0.1, unit: '千克', purchase_date: '2026-05-08' })
  await req('POST', '/api/ingredients', { definition_id: T, quantity: 0.2, unit: '千克', purchase_date: '2026-05-08' })
  await req('POST', '/api/ingredients', { definition_id: T, quantity: 0.3, unit: '千克', purchase_date: '2026-05-08' })
  const dRow = raw.prepare('select quantity from standard_ingredient where id = ?').get(d1.body.id) as { quantity: number }
  ok('0.1+0.2+0.3 = 0.6', dRow.quantity === 0.6, `${dRow.quantity}`)

  console.log('')
  console.log('=== 边界 5：连续多次合并的累积精度 ===')
  const e1 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 0.1, unit: '千克', purchase_date: '2026-05-09' })
  for (let i = 0; i < 10; i++) {
    await req('POST', '/api/ingredients', { definition_id: T, quantity: 0.1, unit: '千克', purchase_date: '2026-05-09' })
  }
  const eRow = raw.prepare('select quantity from standard_ingredient where id = ?').get(e1.body.id) as { quantity: number }
  ok('0.1 × 11 = 1.1（无浮点噪声）', eRow.quantity === 1.1, `${eRow.quantity}`)

  console.log('')
  console.log('=== 边界 6：expiry 变化后是否脱离原批次 ===')
  const f1 = await req('POST', '/api/ingredients', { definition_id: N, quantity: 10, unit: '克', purchase_date: '2026-05-10' })
  const f2 = await req('POST', '/api/ingredients', {
    definition_id: N, quantity: 20, unit: '克', purchase_date: '2026-05-10', expiry_date: '2026-06-01',
  })
  ok('NULL 与非 NULL 不同批次', f1.body.id !== f2.body.id, `${f1.body.id} vs ${f2.body.id}`)
  // 给 f2 一个相同的数量再入库，应合并到 f2
  const f3 = await req('POST', '/api/ingredients', {
    definition_id: N, quantity: 5, unit: '克', purchase_date: '2026-05-10', expiry_date: '2026-06-01',
  })
  ok('相同 expiry 合并到 f2', f3.body.id === f2.body.id, `${f3.body.id} == ${f2.body.id}`)
  ok('f2 数量 25', f3.body.quantity === 25, `${f3.body.quantity}`)

  console.log('')
  console.log('=== 边界 7：编辑使记录脱离批次（不应误合并） ===')
  const g1 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 7, unit: '克', purchase_date: '2026-05-11' })
  const g2 = await req('POST', '/api/ingredients', { definition_id: T, quantity: 9, unit: '克', purchase_date: '2026-05-11', expiry_date: '2026-07-01' })
  ok('初始不同批次', g1.body.id !== g2.body.id)
  // 编辑 g1 的 unit → 变成不同 unit，仍不合并
  const g1u = await req('PATCH', `/api/ingredients/${g1.body.id}`, { unit: '千克', quantity: 0.007 })
  ok('改 unit 后仍不合并', g1u.status === 200 && g1u.body.id === g1.body.id, `${g1u.body?.id}`)
  ok('g2 未被删除', raw.prepare('select id from standard_ingredient where id = ?').get(g2.body.id) !== undefined)

  console.log('')
  console.log('=== 边界 8：definition delete 后 inventory 不被级联删除 ===')
  const hDef = await req('POST', '/api/definitions', { name: '临时定义', units: ['克'], estimated_shelf_life_days: 5 })
  const hInv = await req('POST', '/api/ingredients', { definition_id: hDef.body.id, quantity: 3, unit: '克', purchase_date: '2026-05-12' })
  const hDel = await req('DELETE', `/api/definitions/${hDef.body.id}`)
  ok('有库存时定义删除被拒绝', hDel.status === 409, `${hDel.status}`)
  ok('库存记录未被删', raw.prepare('select id from standard_ingredient where id = ?').get(hInv.body.id) !== undefined)

  console.log('')
  console.log('=== 边界 9：库存列表与 0 数量 ===')
  const list = await req('GET', '/api/ingredients')
  const zeroCount = list.body.filter((s: any) => s.quantity === 0).length
  ok('列表中无 0 数量记录', zeroCount === 0, `${zeroCount}`)
  const withZero = await req('GET', '/api/ingredients?includeZero=true')
  info('includeZero=true 返回条数', `${withZero.body.length}`)

  console.log('')
  console.log('=== 边界 10：PATCH 空 body / 未知字段 ===')
  ok('空 body → 400', (await req('PATCH', `/api/ingredients/${b1.body.id}`, {})).status === 400)
  ok('未知字段 → 400', (await req('PATCH', `/api/ingredients/${b1.body.id}`, { nope: 1 })).status === 400)

  console.log('')
  console.log('=== 边界 11：合并时 production_date 保留 A 的值（创建路径） ===')
  //
  // ⚠️ 重要：production_date 不同时，estimated expiry 通常也不同
  //    （expiry = production_date + shelf_life），因此**不会**被判为同批次。
  //    要构造「production_date 不同但 expiry 相同」，必须使用**手动 expiry**。
  const i1 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-05-13',
    production_date: '2026-05-01', expiry_date: '2026-08-01',
  })
  const i2 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-05-13',
    production_date: '2026-05-02', expiry_date: '2026-08-01',
  })
  ok('手动 expiry 相同 → 创建时合并（production_date 不参与键）', i2.body.id === i1.body.id,
    `${i2.body.id} == ${i1.body.id}`)
  const iRow = raw.prepare('select production_date, quantity from standard_ingredient where id = ?').get(i1.body.id) as { production_date: string; quantity: number }
  ok('保留 A 的 production_date (2026-05-01)', iRow.production_date === '2026-05-01', `${iRow.production_date}`)
  ok('数量合并为 200', iRow.quantity === 200, `${iRow.quantity}`)

  console.log('')
  console.log('=== 边界 11b：（对照）production_date 不同 → estimated expiry 也不同 → 不合并 ===')
  const j1 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-05-14', production_date: '2026-05-01',
  })
  const j2 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-05-14', production_date: '2026-05-02',
  })
  info('j1 expiry', `${j1.body.expiry_date}`)
  info('j2 expiry', `${j2.body.expiry_date}`)
  ok('estimated expiry 不同 → 正确地不合并', j1.body.id !== j2.body.id, `${j1.body.id} vs ${j2.body.id}`)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
