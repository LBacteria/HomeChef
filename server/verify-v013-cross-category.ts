/**
 * v0.1.3 跨类切换专项测试：调味品 ↔ 普通食材
 *
 * 目的：覆盖「PATCH /api/ingredients/:id 更换 definition 导致分类跨越
 *      seasoning ↔ 普通食材边界」时的实际行为。
 *
 * ⚠️ 本测试**只观测现有实现的行为**，不发明新规则。
 *    若某个方向的行为未被既定规则定义，测试会以 [OBSERVE] 明确记录，
 *    而不是断言一个我编造的预期。
 *
 * 只读性质：独立临时库；不修改任何产品代码。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 50000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `v013-cross-${Date.now()}.db`)

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
const observe = (label: string, detail = '') => console.log(`  [OBSERVE] ${label}${detail ? ` —— ${detail}` : ''}`)

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

/** 读取库存原始行（绕过 API，看数据库真实内容） */
function stockRow(id: number): any {
  return raw.prepare('select * from standard_ingredient where id = ?').get(id)
}

/**
 * 通过 API 读取库存（含动态计算的 seasoning / expiry 字段）。
 *
 * ⚠️ 重要：`is_seasoning` / `category_id` / `expiry_status` 这几个
 *    **动态计算字段只在列表接口 `GET /api/ingredients` 返回**，
 *    单条接口 `GET /api/ingredients/:id` 不返回（该接口返回裸行）。
 *
 *    而列表接口会隐藏 quantity <= 0 的**普通**库存，
 *    因此当记录不在列表中时，本函数回退到单条接口 ——
 *    此时拿不到 is_seasoning，函数返回 { inList: false, ... }。
 *
 *    调用方必须区分「不在列表」与「is_seasoning 为 false」。
 */
async function stockViaApi(id: number): Promise<any> {
  const inList = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === id)
  if (inList) return inList
  const single = await req('GET', `/api/ingredients/${id}`)
  return single.body
}

/** 该记录是否出现在「普通库存列表」中（列表接口会隐藏普通 quantity<=0） */
async function isVisibleInList(id: number): Promise<boolean> {
  return (await req('GET', '/api/ingredients')).body.some((r: any) => r.id === id)
}

function categoryName(categoryId: number | null): string | null {
  if (categoryId === null) return null
  const r = raw.prepare('select name from category where id = ?').get(categoryId) as any
  return r?.name ?? null
}

try {
  /* ============================================================
   * 准备：seed + 分类 id
   * ============================================================ */
  console.log('===== 准备 =====')
  await new Promise<void>((res) => {
    const p = spawn('npx', ['tsx', 'seed/seed.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, HOME_CHEF_DB_PATH: dbPath },
      shell: true,
      stdio: 'ignore',
    })
    p.on('close', () => res())
  })

  const cats = (await req('GET', '/api/categories')).body
  const catId = new Map<string, number>()
  for (const c of cats) catId.set(c.name, c.id)
  const SEASONING = catId.get('调味品')!
  const VEG = catId.get('蔬菜')!
  info('调味品 catId', `${SEASONING}`)
  info('蔬菜 catId', `${VEG}`)

  /* ============================================================
   * 三、调味品 → 普通食材
   * ============================================================ */
  console.log('\n===== 三、Seasoning → Normal =====')

  // 测试专用调味品 definition（0 unit）
  const seasonDef = await req('POST', '/api/definitions', {
    name: '跨类测试调味品', units: [], category_id: SEASONING, aliases: ['跨类酱油'],
  })
  ok('创建调味品 definition → 201', seasonDef.status === 201, `${seasonDef.status}`)
  ok('  允许单位为空', (await req('GET', `/api/definitions/${seasonDef.body.id}/units`)).body.length === 0)

  // 普通食材 definition（个 / 克）
  const normalDef = await req('POST', '/api/definitions', {
    name: '跨类测试普通食材', units: ['个', '克'], category_id: VEG,
  })
  ok('创建普通食材 definition → 201', normalDef.status === 201, `${normalDef.status}`)

  // 调味品库存（B2 sentinel）
  const sInv = await req('POST', '/api/ingredients', {
    definition_id: seasonDef.body.id, note: '跨类备注',
  })
  ok('创建调味品库存 → 201', sInv.status === 201, `${sInv.status}`)

  const before = stockRow(sInv.body.id)
  ok('  sentinel quantity = 0', before.quantity === 0, `${before.quantity}`)
  ok('  sentinel unit = 个', before.unit === '个', `${before.unit}`)
  ok('  sentinel purchase_date = today', before.purchase_date === shift(0), `${before.purchase_date}`)
  ok('  sentinel storage_method = 常温', before.storage_method === '常温', `${before.storage_method}`)
  ok('  expiry_date = NULL', before.expiry_date === null)
  ok('  note 保留', before.note === '跨类备注')

  const apiBefore = await stockViaApi(sInv.body.id)
  ok('  切换前 is_seasoning = true', apiBefore?.is_seasoning === true, `${apiBefore?.is_seasoning}`)
  ok('  切换前 expiry_status = no_expiry', apiBefore?.expiry_status === 'no_expiry')

  // ---- 执行切换（v0.1.3 正式规则：跨类切换必须被拒绝）----
  console.log('\n--- PATCH definition_id → 普通食材（预期 409 拒绝）---')
  const switched = await req('PATCH', `/api/ingredients/${sInv.body.id}`, {
    definition_id: normalDef.body.id,
  })
  ok('跨类切换被拒绝 → 409', switched.status === 409, `${switched.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    switched.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', switched.body?.error?.code)
  info('  错误信息', switched.body?.error?.message)

  // 1. definition_id 必须不变
  const afterRow = stockRow(sInv.body.id)
  ok('definition_id 未变（仍是调味品）', afterRow.definition_id === seasonDef.body.id,
    `${afterRow.definition_id} vs ${seasonDef.body.id}`)

  // 2. category 必须仍是调味品
  const afterDef = (await req('GET', `/api/definitions/${afterRow.definition_id}`)).body
  ok('category 仍为「调味品」', categoryName(afterDef.category_id) === '调味品',
    `${categoryName(afterDef.category_id)}`)

  // 3. seasoning 行为保持
  const visibleAfter = await isVisibleInList(sInv.body.id)
  ok('仍以调味品身份出现在列表中（quantity=0 不被隐藏）', visibleAfter === true,
    visibleAfter ? '仍在列表' : '被隐藏了')

  const apiAfter = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === sInv.body.id)
  ok('  is_seasoning 仍为 true', apiAfter?.is_seasoning === true, `${apiAfter?.is_seasoning}`)
  ok('  category_id 仍为调味品 id', apiAfter?.category_id === SEASONING, `${apiAfter?.category_id}`)

  // 4. 逐字段原子性
  ok('原子性：逐字段完全未变', JSON.stringify(before) === JSON.stringify(afterRow))
  ok('  sentinel quantity 仍为 0', afterRow.quantity === 0, `${afterRow.quantity}`)
  ok('  sentinel unit 仍为 个', afterRow.unit === '个', `${afterRow.unit}`)
  ok('  purchase_date 未变', afterRow.purchase_date === before.purchase_date)
  ok('  storage_method 未变', afterRow.storage_method === before.storage_method)
  ok('  note 未变', afterRow.note === before.note)
  ok('  updated_at 未变（无半更新）', afterRow.updated_at === before.updated_at,
    `${before.updated_at} → ${afterRow.updated_at}`)
  ok('  未出现「quantity=0 + 普通食材」的错误状态', afterRow.definition_id !== normalDef.body.id)

  /* ============================================================
   * 九、事务原子性（失败场景）
   *
   * ⚠️ 注意：跨类切换现在会被 CATEGORY_TRANSITION_NOT_ALLOWED 优先拦截，
   *    因此要验证「unit 不合法」的原子性，必须使用**同类切换**。
   * ============================================================ */
  console.log('\n===== 九、事务原子性 =====')

  // 同类（普通 → 普通）但目标食材不允许当前 unit
  const gramOnlyDef = await req('POST', '/api/definitions', {
    name: '仅克单位食材', units: ['克'], category_id: VEG,
  })
  ok('创建仅「克」单位的普通食材 → 201', gramOnlyDef.status === 201, `${gramOnlyDef.status}`)

  const normalInvForFail = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id, quantity: 4, unit: '个', purchase_date: shift(-2),
  })
  ok('创建普通库存（unit=个）→ 201', normalInvForFail.status === 201, `${normalInvForFail.status}`)

  const atomicBefore = stockRow(normalInvForFail.body.id)
  info('失败前快照', `def=${atomicBefore.definition_id} unit=${atomicBefore.unit} qty=${atomicBefore.quantity}`)

  const failPatch = await req('PATCH', `/api/ingredients/${normalInvForFail.body.id}`, {
    definition_id: gramOnlyDef.body.id,
  })
  ok('同类切换到不允许当前 unit 的食材 → 被拒绝', failPatch.status === 400, `${failPatch.status}`)
  ok('  错误码 UNIT_NOT_ALLOWED（既有校验优先级未被破坏）',
    failPatch.body?.error?.code === 'UNIT_NOT_ALLOWED', failPatch.body?.error?.code)
  info('错误信息', failPatch.body?.error?.message)

  const atomicAfter = stockRow(normalInvForFail.body.id)
  ok('原子性：逐字段完全未变',
    JSON.stringify(atomicBefore) === JSON.stringify(atomicAfter),
    JSON.stringify(atomicBefore) === JSON.stringify(atomicAfter) ? '' : '发生了变更！')

  ok('  原 definition_id 不变', atomicAfter.definition_id === normalDef.body.id)
  ok('  quantity 不变', atomicAfter.quantity === atomicBefore.quantity)
  ok('  unit 不变', atomicAfter.unit === atomicBefore.unit)
  ok('  日期不变', atomicAfter.purchase_date === atomicBefore.purchase_date)
  ok('  expiry 不变', atomicAfter.expiry_date === atomicBefore.expiry_date)
  ok('  无半更新状态', atomicAfter.updated_at === atomicBefore.updated_at,
    `${atomicBefore.updated_at} → ${atomicAfter.updated_at}`)

  console.log('\n--- 跨类失败的原子性（调味品侧）---')
  const seasonDef2 = await req('POST', '/api/definitions', {
    name: '跨类测试调味品2', units: [], category_id: SEASONING,
  })
  const sInv2 = await req('POST', '/api/ingredients', { definition_id: seasonDef2.body.id })
  ok('创建第二个调味品库存 → 201', sInv2.status === 201, `${sInv2.status}`)

  const sAtomicBefore = stockRow(sInv2.body.id)
  const sFail = await req('PATCH', `/api/ingredients/${sInv2.body.id}`, {
    definition_id: normalDef.body.id,
  })
  ok('调味品 → 普通食材 → 409', sFail.status === 409, `${sFail.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    sFail.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', sFail.body?.error?.code)

  const sAtomicAfter = stockRow(sInv2.body.id)
  ok('  原子性：逐字段完全未变', JSON.stringify(sAtomicBefore) === JSON.stringify(sAtomicAfter))
  ok('  无半更新（updated_at 未变）', sAtomicAfter.updated_at === sAtomicBefore.updated_at)

  const stillSeasoning = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === sInv2.body.id)
  ok('  category 仍为调味品（is_seasoning = true）', stillSeasoning?.is_seasoning === true)

  /* ============================================================
   * 六 / 七、普通食材 → 调味品
   * ============================================================ */
  console.log('\n===== 六、Normal → Seasoning =====')

  const normalInv = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id,
    quantity: 3, unit: '个',
    purchase_date: shift(0),
    storage_method: '常温',
    expiry_date: shift(30),
  })
  ok('创建普通库存（quantity=3, unit=个）→ 201', normalInv.status === 201, `${normalInv.status}`)

  const nBefore = stockRow(normalInv.body.id)
  info('切换前', `qty=${nBefore.quantity} unit=${nBefore.unit} expiry=${nBefore.expiry_date} source=${nBefore.expiry_date_source}`)
  ok('  切换前 is_seasoning = false', (await stockViaApi(normalInv.body.id))?.is_seasoning === false)

  console.log('\n--- PATCH definition_id → 调味品（预期 409 拒绝）---')
  const toSeasoning = await req('PATCH', `/api/ingredients/${normalInv.body.id}`, {
    definition_id: seasonDef.body.id,
  })

  ok('普通 → 调味品被拒绝 → 409', toSeasoning.status === 409, `${toSeasoning.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    toSeasoning.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', toSeasoning.body?.error?.code)
  info('  错误信息', toSeasoning.body?.error?.message)

  const nAfter = stockRow(normalInv.body.id)

  console.log('')
  console.log('  --- 逐字段原子性 ---')
  ok('deepEqual(before, after) 成立', JSON.stringify(nBefore) === JSON.stringify(nAfter))
  ok('  definition_id 不变', nAfter.definition_id === normalDef.body.id,
    `${nAfter.definition_id} vs ${normalDef.body.id}`)
  ok('  quantity 不变', nAfter.quantity === nBefore.quantity, `${nBefore.quantity} → ${nAfter.quantity}`)
  ok('  unit 不变', nAfter.unit === nBefore.unit)
  ok('  purchase_date 不变', nAfter.purchase_date === nBefore.purchase_date)
  ok('  production_date 不变', nAfter.production_date === nBefore.production_date)
  ok('  expiry_date 不变', nAfter.expiry_date === nBefore.expiry_date)
  ok('  expiry_date_source 不变', nAfter.expiry_date_source === nBefore.expiry_date_source)
  ok('  storage_method 不变', nAfter.storage_method === nBefore.storage_method)
  ok('  note 不变', nAfter.note === nBefore.note)
  ok('  updated_at 不变（无半更新）', nAfter.updated_at === nBefore.updated_at,
    `${nBefore.updated_at} → ${nAfter.updated_at}`)

  // 仍是普通食材
  const stillNormal = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === normalInv.body.id)
  ok('  仍表现为普通食材（is_seasoning = false）', stillNormal?.is_seasoning === false,
    `${stillNormal?.is_seasoning}`)
  ok('  数量语义未被改写为 sentinel', stillNormal?.quantity === 3, `${stillNormal?.quantity}`)

  /* ============================================================
   * 六、同类切换不能被误伤
   * ============================================================ */
  console.log('\n===== 六、同类切换必须仍然允许 =====')

  console.log('\n--- 普通食材 → 普通食材 ---')
  const otherVegDef = await req('POST', '/api/definitions', {
    name: '另一个普通食材', units: ['个', '克'], category_id: VEG,
  })
  ok('创建另一个普通食材 → 201', otherVegDef.status === 201, `${otherVegDef.status}`)

  const sameClassInv = await req('POST', '/api/ingredients', {
    definition_id: normalDef.body.id, quantity: 7, unit: '个',
    purchase_date: shift(-3), expiry_date: shift(20), note: '同类切换备注',
  })
  ok('创建待切换的普通库存 → 201', sameClassInv.status === 201, `${sameClassInv.status}`)

  const sameBefore = stockRow(sameClassInv.body.id)
  const sameSwitch = await req('PATCH', `/api/ingredients/${sameClassInv.body.id}`, {
    definition_id: otherVegDef.body.id,
  })
  ok('普通 → 普通 仍允许 → 200', sameSwitch.status === 200, `${sameSwitch.status}`)

  const sameAfter = stockRow(sameClassInv.body.id)
  ok('  definition_id 已变更', sameAfter.definition_id === otherVegDef.body.id,
    `${sameAfter.definition_id} vs ${otherVegDef.body.id}`)
  ok('  quantity 保留', sameAfter.quantity === 7, `${sameAfter.quantity}`)
  ok('  unit 保留', sameAfter.unit === '个')
  ok('  note 保留', sameAfter.note === '同类切换备注')

  // 关键：definition_id 改变本身不自动重算 expiry
  ok('  expiry_date 未被重算（不因换 definition 而改变）',
    sameAfter.expiry_date === sameBefore.expiry_date,
    `${sameBefore.expiry_date} → ${sameAfter.expiry_date}`)
  ok('  expiry_date_source 未被重算', sameAfter.expiry_date_source === sameBefore.expiry_date_source,
    `${sameBefore.expiry_date_source} → ${sameAfter.expiry_date_source}`)

  const sameApi = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === sameClassInv.body.id)
  ok('  is_seasoning 仍为 false', sameApi?.is_seasoning === false)

  console.log('\n--- 调味品 → 调味品 ---')
  const otherSeasonDef = await req('POST', '/api/definitions', {
    name: '另一个调味品', units: [], category_id: SEASONING,
  })
  ok('创建另一个调味品 → 201', otherSeasonDef.status === 201, `${otherSeasonDef.status}`)

  // ⚠️ 用一个**全新的**调味品作为切换源：
  //    调味品的 createStock 是「已存在则返回已有记录」，
  //    若复用前面用过的 definition，拿到的会是旧记录（note 等字段非本次所设）。
  const seasonFresh = await req('POST', '/api/definitions', {
    name: '同类切换源调味品', units: [], category_id: SEASONING,
  })
  ok('创建同类切换源调味品 → 201', seasonFresh.status === 201, `${seasonFresh.status}`)

  const sKeepInv = await req('POST', '/api/ingredients', {
    definition_id: seasonFresh.body.id, note: '调味品同类切换',
  })
  ok('创建待切换的调味品库存 → 201', sKeepInv.status === 201, `${sKeepInv.status}`)

  const sKeepBefore = stockRow(sKeepInv.body.id)
  const sKeepSwitch = await req('PATCH', `/api/ingredients/${sKeepInv.body.id}`, {
    definition_id: otherSeasonDef.body.id,
  })

  // v0.1.3 U1 裁决（甲）：
  //   调味品 → 调味品时**跳过** allowed-units 校验
  //   （sentinel unit「个」不代表真实单位，调味品 allowed_units 合法为 []）
  //   因此这里应当成功返回 200。
  observe('调味品 → 调味品（目标 allowed_units = []）', `${sKeepSwitch.status}` +
    (sKeepSwitch.body?.error ? ` / ${sKeepSwitch.body.error.code}` : ''))

  const sKeepAfter = stockRow(sKeepInv.body.id)
  ok('调味品 → 调味品 仍允许 → 200', sKeepSwitch.status === 200, `${sKeepSwitch.status}`)

  // ⚠️ 切换可能触发 Phase 4 合并，导致源记录 ID 消失。
  //    因此在断言字段之前，必须先确认源记录仍然存在；
  //    若已被合并，则改为验证**最终数据正确性**（见下方 merged 分支）。
  const sourceSurvived = sKeepAfter !== undefined

  if (sourceSurvived) {
    ok('  definition_id 已变更', sKeepAfter.definition_id === otherSeasonDef.body.id,
      `${sKeepAfter.definition_id} vs ${otherSeasonDef.body.id}`)
    ok('  sentinel quantity 保持 0', sKeepAfter.quantity === 0, `${sKeepAfter.quantity}`)
    ok('  sentinel unit 保持 个', sKeepAfter.unit === '个', `${sKeepAfter.unit}`)
    ok('  note 保留', sKeepAfter.note === '调味品同类切换', `${sKeepAfter.note}`)
    ok('  expiry 仍为 NULL', sKeepAfter.expiry_date === null)
    ok('  expiry_date_source 仍为 NULL', sKeepAfter.expiry_date_source === null)
  } else {
    info('  源记录已因 Phase 4 合并而消失，字段断言改在下方 merged 分支验证')
  }

  // 对照：给目标调味品加上「个」之后，同类切换同样可行
  console.log('\n--- 对照：给目标调味品加上 unit「个」---')
  const addUnitToOther = await req('POST', `/api/definitions/${otherSeasonDef.body.id}/units`, {
    unit: '个',
  })
  ok('给调味品加 unit「个」→ 201', addUnitToOther.status === 201, `${addUnitToOther.status}`)

  const seasonFresh2 = await req('POST', '/api/definitions', {
    name: '同类切换源调味品2', units: [], category_id: SEASONING,
  })
  const sKeepInv2 = await req('POST', '/api/ingredients', { definition_id: seasonFresh2.body.id })
  const sKeepSwitch2 = await req('PATCH', `/api/ingredients/${sKeepInv2.body.id}`, {
    definition_id: otherSeasonDef.body.id,
  })
  ok('调味品 → 调味品（目标已含 unit 个）→ 200', sKeepSwitch2.status === 200, `${sKeepSwitch2.status}`)
  if (sKeepSwitch2.status === 200) {
    const r2 = stockRow(sKeepInv2.body.id)
    ok('  同类切换在该条件下可行', r2.definition_id === otherSeasonDef.body.id,
      `${r2.definition_id}`)
    ok('  sentinel quantity 保持 0', r2.quantity === 0)
  }

  const sKeepApi = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === sKeepInv.body.id)

  // ⚠️ 重要发现：调味品 → 调味品切换会触发 **Phase 4 同批次合并**
  //
  //    调味品库存的五字段（definition_id / purchase_date / storage_method /
  //    unit / expiry_date）在切换后可能与**已存在的目标调味品库存**完全一致，
  //    从而被合并 → 源记录的 ID 消失。
  //
  //    这是 Phase 4 的既有行为（本任务明令不得修改），不是 U1 引入的缺陷。
  //    这里记录事实，并验证数据最终状态是否正确。
  const sKeepRow = stockRow(sKeepInv.body.id)
  const merged = sKeepRow === undefined
  observe('切换是否触发 Phase 4 合并', merged ? '是（源记录 ID 已消失）' : '否')

  if (merged) {
    // 源记录被合并 → 目标 definition 下应存在一条库存
    const targetStock = raw.prepare(
      'select * from standard_ingredient where definition_id = ? order by id',
    ).all(otherSeasonDef.body.id) as any[]
    ok('  合并后目标 definition 下存在库存记录', targetStock.length >= 1, `${targetStock.length} 条`)
    if (targetStock.length > 0) {
      const t = targetStock[0]
      ok('  合并后 quantity = 0（sentinel 保持）', t.quantity === 0, `${t.quantity}`)
      ok('  合并后 unit = 个', t.unit === '个', `${t.unit}`)
      ok('  合并后 expiry = NULL', t.expiry_date === null)
      ok('  合并后 expiry_source = NULL', t.expiry_date_source === null)
      const tApi = (await req('GET', '/api/ingredients')).body.find((r: any) => r.id === t.id)
      ok('  合并后记录在列表中可见', tApi !== undefined)
      ok('  合并后 is_seasoning = true', tApi?.is_seasoning === true, `${tApi?.is_seasoning}`)
    }
  } else {
    ok('  调味品库存仍在列表中可见', sKeepApi !== undefined)
    ok('  is_seasoning 仍为 true', sKeepApi?.is_seasoning === true, `${sKeepApi?.is_seasoning}`)
  }

  /* ============================================================
   * 全库完整性扫描
   * ============================================================ */
  console.log('\n--- 全库完整性扫描 ---')
  const danglingDef = (raw.prepare(`
    select count(*) c from standard_ingredient s
    left join ingredient_definition d on d.id = s.definition_id
    where d.id is null
  `).get() as any).c
  ok('无悬空 definition_id', danglingDef === 0, `${danglingDef}`)

  const danglingCat = (raw.prepare(`
    select count(*) c from ingredient_definition d
    left join category c on c.id = d.category_id
    where d.category_id is not null and c.id is null
  `).get() as any).c
  ok('无悬空 category_id', danglingCat === 0, `${danglingCat}`)

  const badUnit = (raw.prepare(`
    select count(*) c from standard_ingredient s
    left join ingredient_definition_unit u
      on u.definition_id = s.definition_id and u.unit = s.unit
    where u.id is null
  `).get() as any).c
  info('unit 不在所属定义允许列表内的库存记录数', `${badUnit}`)
  observe('存量记录中「unit 不属于当前 definition」的数量', `${badUnit}` +
    (badUnit > 0 ? '（这些记录在创建时合法，因 definition 变更/单位移除而变为不匹配）' : ''))

  const expiryInvariantViolations = (raw.prepare(`
    select count(*) c from standard_ingredient
    where (expiry_date is null) != (expiry_date_source is null)
  `).get() as any).c
  ok('全库 expiry invariant 成立（expiry/source 同 NULL 性）', expiryInvariantViolations === 0,
    `${expiryInvariantViolations}`)

  const invalidUnitEnum = (raw.prepare(`
    select count(*) c from standard_ingredient
    where unit not in ('个','克','千克','毫升','升','包','袋','瓶','盒','罐')
  `).get() as any).c
  ok('无非法 unit 枚举值', invalidUnitEnum === 0, `${invalidUnitEnum}`)
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== 跨类切换结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
