/**
 * v0.1.4 验证：食材分类变更（PATCH /api/definitions/:id 支持 category_id）
 *
 * 覆盖用户确认的规则：
 *   1. 普通食材之间允许改分类，**即使已有库存**
 *   2. 跨「普通食材 ↔ 调味品」边界时，只要存在**任何**库存（含 quantity = 0）→ 409
 *   3. 完全没有库存记录时，允许跨类转换
 *   4. 校验在 Service 层 + 事务内完成
 *   5. 改分类**不重算**任何库存的到期日期
 *   6. 分类必须存在（不存在 → 404）
 *   7. 不改动其他既有规则（名称唯一、数据库约束等）
 *
 * 使用独立临时库与动态端口。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 57000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `v014-cat-${Date.now()}.db`)

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

const proc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOME_CHEF_DB_PATH: dbPath },
  stdio: 'ignore', shell: true,
})

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

try { await fetch(`${BASE}/health`); console.log(`[FAIL] 端口 ${PORT} 已占用`); process.exit(1) } catch { /* */ }
if (!(await waitFor(`${BASE}/health`))) {
  console.log('[FAIL] 服务未就绪'); proc.kill(); process.exit(1)
}
console.log(`server ${BASE}\n`)

function shift(days: number): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function catIdOf(defId: number): number | null {
  const r = raw.prepare('select category_id from ingredient_definition where id = ?').get(defId) as any
  return r?.category_id ?? null
}

try {
  const cats = (await req('GET', '/api/categories')).body
  const SEASONING = cats.find((c: any) => c.name === '调味品').id
  const VEG = cats.find((c: any) => c.name === '蔬菜').id
  const FRUIT = cats.find((c: any) => c.name === '水果').id
  info('调味品', `${SEASONING}`); info('蔬菜', `${VEG}`); info('水果', `${FRUIT}`)

  /* ============================================================
   * 一、Schema：category_id 被接受
   * ============================================================ */
  console.log('===== 一、API schema =====')

  const d1 = await req('POST', '/api/definitions', {
    name: 'v014测试食材', units: ['个', '克'], category_id: VEG,
  })
  ok('创建带分类的普通食材 → 201', d1.status === 201, `${d1.status}`)
  ok('  category_id 正确', d1.body?.category_id === VEG, `${d1.body?.category_id}`)

  // 普通 → 普通（无库存）
  const toFruit = await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: FRUIT })
  ok('PATCH category_id → 200（不再 400）', toFruit.status === 200, `${toFruit.status}`)
  ok('  分类已变更', toFruit.body?.category_id === FRUIT, `${toFruit.body?.category_id}`)

  ok('未提供 category_id 时不改动分类',
    (await req('PATCH', `/api/definitions/${d1.body.id}`, { name: 'v014测试食材' })).body?.category_id === FRUIT)
  ok('category_id = null → 清空分类', (await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: null })).body?.category_id === null)
  await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: VEG })

  ok('未知字段仍被拒绝 → 400',
    (await req('PATCH', `/api/definitions/${d1.body.id}`, { nope: 1 })).status === 400)
  ok('不存在的分类 → 404',
    (await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: 999999 })).status === 404)
  ok('分类 id 非整数 → 400',
    (await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: 'x' })).status === 400)

  /* ============================================================
   * 二、普通 → 普通：即使有库存也允许（规则 1）
   * ============================================================ */
  console.log('\n===== 二、普通 → 普通（有库存也允许）=====')

  const sotck = await req('POST', '/api/ingredients', {
    definition_id: d1.body.id, quantity: 5, unit: '个',
    purchase_date: shift(-3), expiry_date: shift(20),
  })
  ok('创建普通库存 → 201', sotck.status === 201, `${sotck.status}`)

  const stockBefore = raw.prepare('select * from standard_ingredient where id = ?').get(sotck.body.id) as any

  const vegToFruit = await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: FRUIT })
  ok('普通 → 普通（已有库存）→ 200', vegToFruit.status === 200, `${vegToFruit.status}`)
  ok('  分类已变更', catIdOf(d1.body.id) === FRUIT)

  const stockAfter = raw.prepare('select * from standard_ingredient where id = ?').get(sotck.body.id) as any
  ok('  库存记录未被改动', JSON.stringify(stockBefore) === JSON.stringify(stockAfter))
  ok('  到期日期**未重算**（规则 5）',
    stockAfter.expiry_date === stockBefore.expiry_date,
    `${stockBefore.expiry_date} → ${stockAfter.expiry_date}`)
  ok('  expiry_date_source 未变', stockAfter.expiry_date_source === stockBefore.expiry_date_source)

  /* ============================================================
   * 三、跨类：有库存 → 409（规则 2）
   * ============================================================ */
  console.log('\n===== 三、跨类切换（有库存 → 409）=====')

  const cross1 = await req('PATCH', `/api/definitions/${d1.body.id}`, { category_id: SEASONING })
  ok('普通 → 调味品（有正数量库存）→ 409', cross1.status === 409, `${cross1.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    cross1.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', cross1.body?.error?.code)
  ok('  分类未变', catIdOf(d1.body.id) === FRUIT)

  // ★ 关键：quantity = 0 的库存同样算「存在库存」
  console.log('\n--- quantity = 0 也必须阻止跨类 ---')
  const d2 = await req('POST', '/api/definitions', {
    name: 'v014零库存食材', units: ['个'], category_id: VEG,
  })
  const zeroStock = await req('POST', '/api/ingredients', {
    definition_id: d2.body.id, quantity: 1, unit: '个', purchase_date: shift(-2),
  })
  await req('POST', `/api/ingredients/${zeroStock.body.id}/consume`, { amount: 1 })
  const zeroRow = raw.prepare('select quantity from standard_ingredient where id = ?').get(zeroStock.body.id) as any
  ok('已构造 quantity = 0 的库存记录', zeroRow.quantity === 0, `${zeroRow.quantity}`)

  const cross2 = await req('PATCH', `/api/definitions/${d2.body.id}`, { category_id: SEASONING })
  ok('普通 → 调味品（库存为 0）→ 409', cross2.status === 409, `${cross2.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    cross2.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', cross2.body?.error?.code)
  info('  错误信息', cross2.body?.error?.message)
  ok('  分类未变', catIdOf(d2.body.id) === VEG)
  ok('  0 数量库存记录仍在', raw.prepare('select id from standard_ingredient where id = ?').get(zeroStock.body.id) !== undefined)

  /* ============================================================
   * 四、跨类：无库存 → 允许（规则 3）
   * ============================================================ */
  console.log('\n===== 四、跨类切换（无库存 → 允许）=====')

  const d3 = await req('POST', '/api/definitions', {
    name: 'v014无库存普通食材', units: ['个'], category_id: VEG,
  })
  ok('创建无库存普通食材 → 201', d3.status === 201)
  ok('  确实没有库存记录',
    (raw.prepare('select count(*) c from standard_ingredient where definition_id = ?').get(d3.body.id) as any).c === 0)

  const toSeasoning = await req('PATCH', `/api/definitions/${d3.body.id}`, { category_id: SEASONING })
  ok('普通 → 调味品（无库存）→ 200', toSeasoning.status === 200, `${toSeasoning.status}`)
  ok('  分类已变为调味品', catIdOf(d3.body.id) === SEASONING)

  // 反向：调味品（无库存）→ 普通
  //
  // ⚠️ v0.1.4 E1 规则：调味品合法地允许 0 个允许单位，
  //    但普通食材必须至少 1 个单位。
  //    因此「0 单位的调味品 → 普通食材」应当被拒绝（400 VALIDATION_ERROR），
  //    而不是放行后留下一个「普通食材 + 0 单位」的非法状态。
  const d4 = await req('POST', '/api/definitions', {
    name: 'v014无库存调味品', units: [], category_id: SEASONING,
  })
  ok('创建无库存调味品（0 unit）→ 201', d4.status === 201, `${d4.status}`)
  ok('  确实没有允许单位',
    (await req('GET', `/api/definitions/${d4.body.id}/units`)).body.length === 0)
  ok('  确实没有库存记录',
    (raw.prepare('select count(*) c from standard_ingredient where definition_id = ?').get(d4.body.id) as any).c === 0)

  const beforeD4 = raw.prepare('select * from ingredient_definition where id = ?').get(d4.body.id) as any

  const backToNormal = await req('PATCH', `/api/definitions/${d4.body.id}`, { category_id: VEG })
  ok('调味品 → 普通（0 单位）→ 400', backToNormal.status === 400, `${backToNormal.status}`)
  ok('  错误码 VALIDATION_ERROR',
    backToNormal.body?.error?.code === 'VALIDATION_ERROR', backToNormal.body?.error?.code)
  info('  错误信息', backToNormal.body?.error?.message)
  ok('  分类仍然是调味品（无部分更新）', catIdOf(d4.body.id) === SEASONING, `${catIdOf(d4.body.id)}`)
  ok('  逐字段未变（原子性）',
    JSON.stringify(beforeD4) === JSON.stringify(raw.prepare('select * from ingredient_definition where id = ?').get(d4.body.id)))

  // ---- 给该调味品添加一个**真实**允许单位后，再试一次 ----
  //
  // ⚠️ 这里添加的是真实单位（个），不是 UI 展示文本「无」。
  const addUnit = await req('POST', `/api/definitions/${d4.body.id}/units`, { unit: '个' })
  ok('为调味品添加真实单位「个」→ 201', addUnit.status === 201, `${addUnit.status}`)
  const unitsAfterAdd = (await req('GET', `/api/definitions/${d4.body.id}/units`)).body
  ok('  允许单位现在有 1 个', unitsAfterAdd.length === 1, `${unitsAfterAdd.length}`)

  const retry = await req('PATCH', `/api/definitions/${d4.body.id}`, { category_id: VEG })
  ok('调味品 → 普通（已有 1 单位）→ 200', retry.status === 200, `${retry.status}`)
  ok('  分类已变为普通食材', catIdOf(d4.body.id) === VEG, `${catIdOf(d4.body.id)}`)
  ok('  单位未被自动改动（仍有 1 个）',
    (await req('GET', `/api/definitions/${d4.body.id}/units`)).body.length === 1)

  // 有库存的调味品 → 普通：409
  const d5 = await req('POST', '/api/definitions', {
    name: 'v014有库存调味品', units: [], category_id: SEASONING,
  })
  const sInv = await req('POST', '/api/ingredients', { definition_id: d5.body.id })
  ok('创建调味品库存 → 201', sInv.status === 201, `${sInv.status}`)
  const s2n = await req('PATCH', `/api/definitions/${d5.body.id}`, { category_id: VEG })
  ok('调味品 → 普通（有库存）→ 409', s2n.status === 409, `${s2n.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    s2n.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', s2n.body?.error?.code)
  ok('  调味品语义未被破坏', (() => {
    const row = raw.prepare('select quantity, unit, expiry_date from standard_ingredient where id = ?').get(sInv.body.id) as any
    return row.quantity === 0 && row.unit === '个' && row.expiry_date === null
  })())

  /* ============================================================
   * 五、同侧改分类不触碰库存（规则 5）
   * ============================================================ */
  console.log('\n===== 五、改分类不重算到期日期 =====')

  const d6 = await req('POST', '/api/definitions', {
    name: 'v014保质期食材', units: ['克'], category_id: VEG,
    estimated_shelf_life_days: 30,
  })
  const estStock = await req('POST', '/api/ingredients', {
    definition_id: d6.body.id, quantity: 100, unit: '克',
    purchase_date: shift(-5), storage_method: '冷藏',
  })
  const estBefore = raw.prepare('select * from standard_ingredient where id = ?').get(estStock.body.id) as any
  info('改分类前', `expiry=${estBefore.expiry_date} source=${estBefore.expiry_date_source}`)

  const changeCat = await req('PATCH', `/api/definitions/${d6.body.id}`, { category_id: FRUIT })
  ok('改分类 → 200', changeCat.status === 200, `${changeCat.status}`)

  const estAfter = raw.prepare('select * from standard_ingredient where id = ?').get(estStock.body.id) as any
  ok('  库存记录逐字段未变', JSON.stringify(estBefore) === JSON.stringify(estAfter))
  ok('  到期日期未重算', estAfter.expiry_date === estBefore.expiry_date,
    `${estBefore.expiry_date} → ${estAfter.expiry_date}`)
  ok('  来源未变', estAfter.expiry_date_source === estBefore.expiry_date_source)

  // 同时改名称 + 有效期 + 分类
  const multi = await req('PATCH', `/api/definitions/${d6.body.id}`, {
    name: 'v014保质期食材改名', estimated_shelf_life_days: 60, category_id: VEG,
  })
  ok('同时改 名称+有效期+分类 → 200', multi.status === 200, `${multi.status}`)
  ok('  三项都已生效',
    multi.body?.name === 'v014保质期食材改名' &&
    multi.body?.estimated_shelf_life_days === 60 &&
    multi.body?.category_id === VEG)
  const estAfter2 = raw.prepare('select * from standard_ingredient where id = ?').get(estStock.body.id) as any
  ok('  改保质期后库存到期日期仍未变', estAfter2.expiry_date === estBefore.expiry_date,
    `${estBefore.expiry_date} → ${estAfter2.expiry_date}`)

  /* ============================================================
   * 六、既有规则未被破坏（规则 7）
   * ============================================================ */
  console.log('\n===== 六、既有规则回归 =====')

  ok('名称重名仍被拒绝 → 409', (await req('POST', '/api/definitions', {
    name: 'v014测试食材', units: ['个'], category_id: VEG,
  })).status === 409)

  const d7 = await req('POST', '/api/definitions', { name: 'v014唯一单位', units: ['个'], category_id: VEG })
  ok('普通食材删除最后一个单位 → 400',
    (await req('DELETE', `/api/definitions/${d7.body.id}/units/个`)).status === 400)

  const d8 = await req('POST', '/api/definitions', { name: 'v014调味品0单位', units: [], category_id: SEASONING })
  ok('调味品允许 0 单位', (await req('GET', `/api/definitions/${d8.body.id}/units`)).body.length === 0)

  ok('别名唯一性仍生效',
    (await req('POST', '/api/definitions', { name: 'v014别名冲突', units: ['个'], aliases: ['v014别名'], category_id: VEG })).status === 201 &&
    (await req('POST', '/api/definitions', { name: 'v014别名冲突2', units: ['个'], aliases: ['v014别名'], category_id: VEG })).status === 409)

  ok('分类仍被引用时不能删除 → 409',
    (await req('DELETE', `/api/categories/${SEASONING}`)).status === 409)

  ok('DELETE /api/categories 不存在的 id → 404',
    (await req('DELETE', '/api/categories/999999')).status === 404)

  // 库存跨类切换规则未受影响（v0.1.3 规则）
  const invCross = await req('PATCH', `/api/ingredients/${sotck.body.id}`, {
    definition_id: d5.body.id,
  })
  ok('库存 definition_id 跨类切换 → 409（v0.1.3 规则未变）',
    invCross.status === 409, `${invCross.status}`)

  /* ============================================================
   * 七、事务性：失败时不留半更新
   * ============================================================ */
  console.log('\n===== 七、失败时的原子性 =====')

  const before = raw.prepare('select * from ingredient_definition where id = ?').get(d1.body.id) as any
  const failPatch = await req('PATCH', `/api/definitions/${d1.body.id}`, {
    name: 'v014不应生效的名字', category_id: SEASONING,
  })
  ok('同时改名称 + 非法跨类 → 409', failPatch.status === 409, `${failPatch.status}`)
  const after = raw.prepare('select * from ingredient_definition where id = ?').get(d1.body.id) as any
  ok('  原子性：definition 逐字段未变', JSON.stringify(before) === JSON.stringify(after))
  ok('  名称未被改成半成品', after.name === before.name, `${after.name}`)
  ok('  分类未变', after.category_id === before.category_id)

  // 不存在的分类
  const before2 = raw.prepare('select * from ingredient_definition where id = ?').get(d1.body.id) as any
  const badCat = await req('PATCH', `/api/definitions/${d1.body.id}`, {
    name: 'v014另一个名字', category_id: 999999,
  })
  ok('改名称 + 不存在的分类 → 404', badCat.status === 404, `${badCat.status}`)
  const after2 = raw.prepare('select * from ingredient_definition where id = ?').get(d1.body.id) as any
  ok('  原子性：未变', JSON.stringify(before2) === JSON.stringify(after2))

  /* ============================================================
   * 八、数据完整性
   * ============================================================ */
  console.log('\n===== 八、数据完整性 =====')

  const dangling = (raw.prepare(`
    select count(*) c from ingredient_definition d
    left join category c on c.id = d.category_id
    where d.category_id is not null and c.id is null
  `).get() as any).c
  ok('无悬空 category_id', dangling === 0, `${dangling}`)

  const expiryInv = (raw.prepare(`
    select count(*) c from standard_ingredient
    where (expiry_date is null) != (expiry_date_source is null)
  `).get() as any).c
  ok('全库 expiry invariant 成立', expiryInv === 0, `${expiryInv}`)
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== v0.1.4 分类变更结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
