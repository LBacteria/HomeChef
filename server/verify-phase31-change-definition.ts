/**
 * v0.1.1 Phase 3.1 验证：编辑库存时更换食材（definition_id）
 *
 * 覆盖 Case 1-6。
 * 使用独立临时库与高位端口，不触碰正式库。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

// 动态端口：避免与上一次运行残留的 server 冲突
const PORT = 29000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `v011-p31-${Date.now()}.db`)

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

const proc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOME_CHEF_DB_PATH: dbPath },
  stdio: 'ignore',
  shell: true,
})

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

if (!(await waitFor(`${BASE}/health`))) {
  console.log('[FAIL] 服务未就绪')
  proc.kill()
  process.exit(1)
}
console.log(`server ${BASE}\n`)

try {
  /* ---------- 准备 ---------- */
  console.log('===== 准备食材定义 =====')
  const tomato = await req('POST', '/api/definitions', {
    name: '番茄', units: ['个', '克', '千克'], aliases: ['西红柿'], estimated_shelf_life_days: 7,
  })
  const potato = await req('POST', '/api/definitions', {
    name: '土豆', units: ['个', '克', '千克'], aliases: ['马铃薯'], estimated_shelf_life_days: 30,
  })
  const egg = await req('POST', '/api/definitions', {
    name: '鸡蛋', units: ['个', '盒'], aliases: [], estimated_shelf_life_days: 30,
  })
  // 一个不允许「克」的定义，用于 Case 3
  const milk = await req('POST', '/api/definitions', {
    name: '牛奶', units: ['毫升', '升', '瓶'], aliases: [], estimated_shelf_life_days: 7,
  })
  ok('准备 4 个定义',
    tomato.status === 201 && potato.status === 201 && egg.status === 201 && milk.status === 201)

  const tomatoId = tomato.body.id
  const potatoId = potato.body.id
  const eggId = egg.body.id
  const milkId = milk.body.id
  console.log(`  番茄=${tomatoId} 土豆=${potatoId} 鸡蛋=${eggId} 牛奶=${milkId}`)

  /* ---------- Case 1：只修改 definition_id ---------- */
  console.log('\n===== Case 1：只修改 definition_id（番茄 3 个 → 土豆 3 个）=====')
  const c1 = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 3, unit: '个',
    purchase_date: '2026-09-30', production_date: '2026-09-28',
    storage_method: '冷藏', note: '原始备注',
  })
  ok('创建番茄库存', c1.status === 201, `${c1.status}`)
  const c1Id = c1.body.id
  const c1Before = c1.body
  console.log(`  原：def=${c1Before.definition_id} qty=${c1Before.quantity} unit=${c1Before.unit} expiry=${c1Before.expiry_date}/${c1Before.expiry_date_source}`)

  const c1u = await req('PATCH', `/api/ingredients/${c1Id}`, { definition_id: potatoId })
  ok('PATCH definition_id 成功', c1u.status === 200, `${c1.status}`)
  ok('definition_id 已改为土豆', c1u.body.definition_id === potatoId, `${c1u.body.definition_id}`)
  ok('quantity 保持 3', c1u.body.quantity === 3, `${c1u.body.quantity}`)
  ok('unit 保持 个', c1u.body.unit === '个', c1u.body.unit)
  ok('storage_method 保持 冷藏', c1u.body.storage_method === '冷藏', c1u.body.storage_method)
  ok('note 保持', c1u.body.note === '原始备注', c1u.body.note)
  ok('inventory record id 不变', c1u.body.id === c1Id)

  /* ---------- Case 5：只改 definition_id 时日期不变 ---------- */
  console.log('\n===== Case 5：只改 definition_id 时日期不变 =====')
  ok('purchase_date 不变', c1u.body.purchase_date === c1Before.purchase_date,
    `${c1Before.purchase_date} → ${c1u.body.purchase_date}`)
  ok('production_date 不变', c1u.body.production_date === c1Before.production_date,
    `${c1Before.production_date} → ${c1u.body.production_date}`)
  ok('expiry_date 不变', c1u.body.expiry_date === c1Before.expiry_date,
    `${c1Before.expiry_date} → ${c1u.body.expiry_date}`)
  ok('expiry_date_source 不变', c1u.body.expiry_date_source === c1Before.expiry_date_source,
    `${c1Before.expiry_date_source} → ${c1u.body.expiry_date_source}`)
  ok('未因土豆 shelf life(30) 重算', c1u.body.expiry_date === c1Before.expiry_date,
    `番茄7天→土豆30天，expiry 仍为 ${c1u.body.expiry_date}`)

  /* ---------- Case 2：definition_id + unit 一起修改 ---------- */
  console.log('\n===== Case 2：definition_id + unit 一起修改（番茄 500 克 → 鸡蛋 6 个）=====')
  const c2 = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 500, unit: '克', purchase_date: '2026-10-05',
  })
  ok('创建番茄 500 克', c2.status === 201)
  const c2Id = c2.body.id

  const c2u = await req('PATCH', `/api/ingredients/${c2Id}`, {
    definition_id: eggId, unit: '个', quantity: 6,
  })
  ok('PATCH 成功（最终：鸡蛋 + 个）', c2u.status === 200, `${c2u.status}`)
  ok('definition_id = 鸡蛋', c2u.body.definition_id === eggId, `${c2u.body.definition_id}`)
  ok('unit = 个', c2u.body.unit === '个', c2u.body.unit)
  ok('quantity = 6', c2u.body.quantity === 6, `${c2u.body.quantity}`)

  // 反向验证：若用「旧 definition + 新 unit」判断会误判
  // 番茄允许 个/克/千克，鸡蛋允许 个/盒 —— 两者都允许「个」，此例不足以区分
  // 用牛奶（毫升/升/瓶）验证：番茄 500 克 → 牛奶 + 克 应失败
  console.log('  反向验证（旧定义允许克，新定义不允许克）：')
  const c2b = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 500, unit: '克', purchase_date: '2026-10-05',
  })
  const c2bu = await req('PATCH', `/api/ingredients/${c2b.body.id}`, { definition_id: milkId })
  ok('番茄(克) → 牛奶 被拒绝（牛奶不允许克）', c2bu.status === 400, `${c2bu.status}`)
  ok('拒绝时错误码为 UNIT_NOT_ALLOWED',
    c2bu.body?.error?.code === 'UNIT_NOT_ALLOWED', c2bu.body?.error?.code)

  /* ---------- Case 3：新 definition 不允许旧 unit，无部分更新 ---------- */
  console.log('\n===== Case 3：新 definition 不允许旧 unit（番茄 500 克 → 牛奶）=====')
  const c3 = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 500, unit: '克', purchase_date: '2026-10-05', note: '不该被改',
  })
  const c3Id = c3.body.id
  const c3Before = c3.body

  const c3u = await req('PATCH', `/api/ingredients/${c3Id}`, { definition_id: milkId })
  ok('请求失败', c3u.status === 400, `${c3u.status}`)

  const c3After = (await req('GET', `/api/ingredients/${c3Id}`)).body
  ok('definition_id 未变（无部分更新）', c3After.definition_id === c3Before.definition_id,
    `${c3Before.definition_id} → ${c3After.definition_id}`)
  ok('unit 未变', c3After.unit === c3Before.unit, `${c3After.unit}`)
  ok('quantity 未变', c3After.quantity === c3Before.quantity)
  ok('note 未变', c3After.note === c3Before.note, `${c3After.note}`)
  console.log(`  数据库状态完整保持：def=${c3After.definition_id} unit=${c3After.unit} qty=${c3After.quantity}`)

  /* ---------- Case 4：不存在的 definition_id ---------- */
  console.log('\n===== Case 4：不存在的 definition_id =====')
  const c4 = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 2, unit: '个', purchase_date: '2026-10-05',
  })
  const c4Id = c4.body.id
  const c4Before = c4.body

  const c4u = await req('PATCH', `/api/ingredients/${c4Id}`, { definition_id: 999999 })
  ok('请求失败', c4u.status === 404, `${c4u.status}`)
  ok('错误码 DEFINITION_NOT_FOUND', c4u.body?.error?.code === 'DEFINITION_NOT_FOUND', c4u.body?.error?.code)

  const c4After = (await req('GET', `/api/ingredients/${c4Id}`)).body
  ok('原库存保持不变', c4After.definition_id === c4Before.definition_id && c4After.quantity === c4Before.quantity)

  // 非法值
  const c4b = await req('PATCH', `/api/ingredients/${c4Id}`, { definition_id: 0 })
  ok('definition_id=0 被拒绝', c4b.status === 400, `${c4b.status}`)
  const c4c = await req('PATCH', `/api/ingredients/${c4Id}`, { definition_id: -1 })
  ok('definition_id=-1 被拒绝', c4c.status === 400, `${c4c.status}`)
  const c4d = await req('PATCH', `/api/ingredients/${c4Id}`, { definition_id: 1.5 })
  ok('definition_id=1.5 被拒绝', c4d.status === 400, `${c4d.status}`)

  /* ---------- 未知字段仍被拒绝 ---------- */
  console.log('\n===== 未知字段仍被拒绝 =====')
  const unknown = await req('PATCH', `/api/ingredients/${c4Id}`, { not_a_field: 1 })
  ok('未知字段 → 400', unknown.status === 400, `${unknown.status}`)
  const unknown2 = await req('PATCH', `/api/ingredients/${c4Id}`, { definition_id: tomatoId, bogus: 'x' })
  ok('混入未知字段 → 400', unknown2.status === 400, `${unknown2.status}`)
  const emptyBody = await req('PATCH', `/api/ingredients/${c4Id}`, {})
  ok('空 body → 400（minProperties:1）', emptyBody.status === 400, `${emptyBody.status}`)

  /* ---------- Case 6：现有功能回归 ---------- */
  console.log('\n===== Case 6：现有功能回归 =====')

  const list = await req('GET', '/api/ingredients')
  ok('库存列表正常', list.status === 200 && Array.isArray(list.body), `${list.body?.length} 条`)

  const newInv = await req('POST', '/api/ingredients', {
    definition_id: potatoId, quantity: 1, unit: '千克', purchase_date: '2026-10-05',
  })
  ok('新增库存正常', newInv.status === 201 && newInv.body.definition_id === potatoId)

  const editQty = await req('PATCH', `/api/ingredients/${newInv.body.id}`, { quantity: 5 })
  ok('编辑数量正常', editQty.status === 200 && editQty.body.quantity === 5)

  const editUnit = await req('PATCH', `/api/ingredients/${newInv.body.id}`, { unit: '克' })
  ok('编辑单位正常', editUnit.status === 200 && editUnit.body.unit === '克')

  const editDate = await req('PATCH', `/api/ingredients/${newInv.body.id}`, { purchase_date: '2026-10-06' })
  ok('编辑日期正常', editDate.status === 200 && editDate.body.purchase_date === '2026-10-06')

  // estimated 重算仍工作（日期变化时）
  const recalc = await req('POST', '/api/ingredients', {
    definition_id: potatoId, quantity: 1, unit: '个', purchase_date: '2026-10-01',
  })
  const recalcAfter = await req('PATCH', `/api/ingredients/${recalc.body.id}`, { purchase_date: '2026-10-10' })
  ok('estimated expiry 跟随 purchase 重算',
    recalcAfter.body.expiry_date === '2026-11-09',
    `${recalc.body.expiry_date} → ${recalcAfter.body.expiry_date}`)

  const consume = await req('POST', `/api/ingredients/${newInv.body.id}/consume`, { amount: 2 })
  ok('消耗正常', consume.status === 200 && consume.body.quantity === 3, `${consume.body?.quantity}`)

  const over = await req('POST', `/api/ingredients/${newInv.body.id}/consume`, { amount: 999 })
  ok('库存不足被拒绝', over.status === 409 && over.body.error.code === 'INSUFFICIENT_STOCK')

  const del = await req('DELETE', `/api/ingredients/${newInv.body.id}`)
  ok('删除正常', del.status === 204)

  const search = await req('GET', '/api/definitions?search=西红柿')
  ok('definition 搜索正常', search.status === 200 && search.body.some((d: any) => d.id === tomatoId))

  // zero quantity 行为不变
  const zero = await req('POST', '/api/ingredients', {
    definition_id: eggId, quantity: 1, unit: '个', purchase_date: '2026-10-05',
  })
  await req('POST', `/api/ingredients/${zero.body.id}/consume`, { amount: 1 })
  const listNoZero = await req('GET', '/api/ingredients')
  ok('zero quantity 仍被隐藏', !listNoZero.body.some((s: any) => s.id === zero.body.id))
  ok('zero 记录仍可 GET', (await req('GET', `/api/ingredients/${zero.body.id}`)).status === 200)

  /* ---------- 换 definition 后 unit 清空场景 ---------- */
  console.log('\n===== 附加：更换 definition 时 unit 仍合法的场景 =====')
  const keepUnit = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 3, unit: '个', purchase_date: '2026-10-05',
  })
  const keepUnitAfter = await req('PATCH', `/api/ingredients/${keepUnit.body.id}`, { definition_id: potatoId })
  ok('只换 definition、unit 恰好也允许 → 成功',
    keepUnitAfter.status === 200 && keepUnitAfter.body.unit === '个' && keepUnitAfter.body.definition_id === potatoId,
    `def=${keepUnitAfter.body?.definition_id} unit=${keepUnitAfter.body?.unit}`)
} finally {
  proc.kill()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
