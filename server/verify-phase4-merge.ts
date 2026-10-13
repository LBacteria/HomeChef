/**
 * v0.1.1 Phase 4 验证：同批次库存自动合并
 *
 * 覆盖设计阶段的 18 个 Case + 字段保留 + 原子性。
 *
 * 同批次键：definition_id / purchase_date / storage_method / unit / expiry_date
 * ⚠️ expiry_date 使用 NULL-safe 相等
 * ⚠️ 不比较 expiry_date_source
 *
 * 使用独立临时库与动态端口，不触碰正式库。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

// 动态端口 + 预检，避免连到残留实例的旧库
const PORT = 31000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v011-p4-${Date.now()}.db`)

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

/** 直接查库（用于确认 ID 与真实行数） */
const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')
function rows(definitionId: number) {
  return raw
    .prepare(
      'select id, definition_id, quantity, unit, purchase_date, production_date, expiry_date, expiry_date_source, storage_method, note from standard_ingredient where definition_id = ? order by id',
    )
    .all(definitionId) as Array<Record<string, unknown>>
}
function allRows() {
  return raw
    .prepare('select id, definition_id, quantity, unit, purchase_date, expiry_date, storage_method from standard_ingredient order by id')
    .all() as Array<Record<string, unknown>>
}
function rowById(id: number) {
  return raw.prepare('select * from standard_ingredient where id = ?').get(id) as
    | Record<string, unknown>
    | undefined
}

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
try {
  await fetch(`${BASE}/health`)
  console.log(`[FAIL] 端口 ${PORT} 已被占用`)
  await server.stop()
  process.exit(1)
} catch { /* 空闲，正确 */ }

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
  /* ---------- 准备定义 ---------- */
  console.log('===== 准备 =====')
  // 番茄：有保质期 7 天（expiry = purchase + 7）
  const tomato = await req('POST', '/api/definitions', {
    name: '番茄', units: ['个', '克', '千克'], aliases: ['西红柿'], estimated_shelf_life_days: 7,
  })
  // 土豆：有保质期 30 天
  const potato = await req('POST', '/api/definitions', {
    name: '土豆', units: ['个', '克', '千克'], estimated_shelf_life_days: 30,
  })
  // 无保质期：expiry 恒为 NULL（用于 NULL 测试）
  const noShelf = await req('POST', '/api/definitions', {
    name: '无保质期食材', units: ['克'], estimated_shelf_life_days: null,
  })
  // 同名不同 definition（用于 Case 11）
  const tomato2 = await req('POST', '/api/definitions', {
    name: '番茄酱', units: ['克'], estimated_shelf_life_days: 7,
  })

  ok('准备定义', [tomato, potato, noShelf, tomato2].every((r) => r.status === 201))
  const T = tomato.body.id, P = potato.body.id, N = noShelf.body.id, T2 = tomato2.body.id
  console.log(`  番茄=${T} 土豆=${P} 无保质期=${N} 番茄酱=${T2}`)

  /* ---------- Case 1：五项全同 → 合并 ---------- */
  console.log('\n===== Case 1：创建五项全同 → 合并 =====')
  const c1a = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 500, unit: '克', purchase_date: '2026-09-30', storage_method: '常温',
  })
  ok('首次创建', c1a.status === 201)
  const c1Id = c1a.body.id
  const c1Expiry = c1a.body.expiry_date
  console.log(`  记录 id=${c1Id} qty=${c1a.body.quantity} expiry=${c1Expiry}`)

  const c1b = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 300, unit: '克', purchase_date: '2026-09-30', storage_method: '常温',
  })
  ok('第二次创建返回 201', c1b.status === 201, `${c1b.status}`)
  ok('返回的是**已有记录 ID**', c1b.body.id === c1Id, `${c1b.body.id} == ${c1Id}`)
  ok('数量合并为 800', c1b.body.quantity === 800, `${c1b.body.quantity}`)
  const c1rows = rows(T)
  ok('数据库中只有 1 条', c1rows.length === 1, `${c1rows.length} 条`)
  ok('库里数量也是 800', c1rows[0].quantity === 800, `${c1rows[0].quantity}`)

  /* ---------- Case 2：definition 不同 → 不合并 ---------- */
  console.log('\n===== Case 2：definition_id 不同 → 不合并 =====')
  const before2 = allRows().length
  await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 500, unit: '克', purchase_date: '2026-09-30', storage_method: '常温',
  })
  ok('不同 definition 未合并', allRows().length === before2 + 1, `${before2} → ${allRows().length}`)

  /* ---------- Case 3：purchase_date 不同 → 不合并 ---------- */
  console.log('\n===== Case 3：purchase_date 不同 → 不合并 =====')
  const before3 = allRows().length
  await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-10-01', storage_method: '常温',
  })
  ok('不同入库日期未合并', allRows().length === before3 + 1, `${before3} → ${allRows().length}`)

  /* ---------- Case 4：storage_method 不同 → 不合并 ---------- */
  console.log('\n===== Case 4：storage_method 不同 → 不合并 =====')
  const before4 = allRows().length
  await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-09-30', storage_method: '冷藏',
  })
  ok('不同储存方式未合并', allRows().length === before4 + 1, `${before4} → ${allRows().length}`)

  /* ---------- Case 5：unit 不同 → 不合并 ---------- */
  console.log('\n===== Case 5：unit 不同 → 不合并 =====')
  const before5 = allRows().length
  await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 2, unit: '个', purchase_date: '2026-09-30', storage_method: '常温',
  })
  ok('不同单位未合并', allRows().length === before5 + 1, `${before5} → ${allRows().length}`)

  /* ---------- Case 6：expiry_date 不同 → 不合并 ---------- */
  console.log('\n===== Case 6：expiry_date 不同 → 不合并 =====')
  const before6 = allRows().length
  await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '克', purchase_date: '2026-09-30', storage_method: '常温',
    expiry_date: '2026-10-20',
  })
  ok('不同到期日期未合并', allRows().length === before6 + 1, `${before6} → ${allRows().length}`)

  /* ---------- Case 7：NULL + NULL → 合并（关键！） ---------- */
  console.log('\n===== Case 7：NULL expiry + NULL expiry → 合并（NULL-safe 关键验证）=====')
  const n1 = await req('POST', '/api/ingredients', {
    definition_id: N, quantity: 100, unit: '克', purchase_date: '2026-09-30',
  })
  ok('无保质期定义 → expiry 为 NULL', n1.body.expiry_date === null, `${n1.body.expiry_date}`)
  const n1Id = n1.body.id

  const n2 = await req('POST', '/api/ingredients', {
    definition_id: N, quantity: 200, unit: '克', purchase_date: '2026-09-30',
  })
  ok('NULL + NULL → 合并（ID 不变）', n2.body.id === n1Id, `${n2.body.id} == ${n1Id}`)
  ok('数量合并为 300', n2.body.quantity === 300, `${n2.body.quantity}`)
  ok('数据库中只有 1 条', rows(N).length === 1, `${rows(N).length} 条`)

  /* ---------- Case 8：NULL + 非 NULL → 不合并 ---------- */
  console.log('\n===== Case 8：NULL + 非 NULL → 不合并 =====')
  const before8 = rows(N).length
  await req('POST', '/api/ingredients', {
    definition_id: N, quantity: 50, unit: '克', purchase_date: '2026-09-30', expiry_date: '2026-12-31',
  })
  ok('NULL 与非 NULL 未合并', rows(N).length === before8 + 1, `${before8} → ${rows(N).length}`)

  /* ---------- Case 9：source 不同但 expiry 相同 → 合并 ---------- */
  console.log('\n===== Case 9：expiry_date_source 不同但 expiry 相同 → 合并 =====')
  //
  // 更严谨的构造：先建 manual 记录，再让 estimated 的创建去匹配它。
  // 这样能真正证明「不同 source、相同 expiry」被判为同批次。
  //
  // 番茄保质期 7 天：purchase 2026-10-02 → estimated = 2026-10-09
  //
  // 1) 手动填 2026-10-09 → source = manual，独立创建
  const s1 = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 100, unit: '个', purchase_date: '2026-10-02', expiry_date: '2026-11-09',
  })
  ok('第一条为 manual', s1.body.expiry_date_source === 'manual', `${s1.body.expiry_date_source}`)
  const s1Id = s1.body.id
  const s1Expiry = s1.body.expiry_date
  console.log(`  manual 记录 id=${s1Id} expiry=${s1Expiry}`)

  // 2) 不提供 expiry，由保质期估算出**同一个日期** → source = estimated
  //    土豆保质期 30 天：purchase 2026-10-02 → estimated = 2026-11-01
  //    这里用土豆构造：手动 2026-11-01 已是上面的 s1？
  //    改用同一 definition（土豆30天）：
  const s1b = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 100, unit: '个', purchase_date: '2026-10-02', expiry_date: '2026-11-01',
  })
  const s1bId = s1b.body.id
  const s1bExpiry = s1b.body.expiry_date
  ok('构造 manual 记录（土豆 + 手动 2026-11-01）', s1b.body.expiry_date_source === 'manual', `${s1b.body.expiry_date_source}`)

  // 3) 不提供 expiry → 土豆 estimated = purchase(2026-10-02) + 30 = 2026-11-01，与 s1b 相同
  //
  //    ⚠️ 关键：这条 POST 未提供 expiry，本应算出 source='estimated'。
  //       但它命中了上面 manual 记录（同批次），因此**返回的是那条已有记录**，
  //       source 保持 'manual' —— 这正是「不比较 source」的正确体现。
  const s2 = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 50, unit: '个', purchase_date: '2026-10-02',
  })
  console.log(`  第二条 POST（未提供 expiry）返回：expiry=${s2.body.expiry_date} source=${s2.body.expiry_date_source}`)

  // 证明「未提供 expiry 时会算出 estimated」——用一条不冲突的记录单独验证
  const s3 = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 1, unit: '个', purchase_date: '2026-06-06',
  })
  ok('未提供 expiry 时确实算出 estimated', s3.body.expiry_date_source === 'estimated',
    `${s3.body.expiry_date_source} @ ${s3.body.expiry_date}`)

  ok('两条 expiry 相同', s2.body.expiry_date === s1bExpiry, `${s1bExpiry} == ${s2.body.expiry_date}`)
  ok('source 不同（manual vs estimated）但 expiry 相同 → 合并', s2.body.id === s1bId, `${s2.body.id} == ${s1bId}`)
  ok('合并后保留已有记录的 source=manual', s2.body.expiry_date_source === 'manual', `${s2.body.expiry_date_source}`)
  ok('数量合并为 150', s2.body.quantity === 150, `${s2.body.quantity}`)
  ok('已有记录仍只有 1 条', rows(P).filter((r) => r.id === s1bId).length === 1)

  /* ---------- Case 10：zero quantity 复活 ---------- */
  console.log('\n===== Case 10：zero quantity 参与匹配并复活 =====')
  const z = await req('POST', '/api/ingredients', {
    definition_id: T2, quantity: 100, unit: '克', purchase_date: '2026-09-30',
  })
  const zId = z.body.id
  await req('POST', `/api/ingredients/${zId}/consume`, { amount: 100 })
  const zRow = rowById(zId)
  ok('已消耗到 0', zRow?.quantity === 0, `${zRow?.quantity}`)

  const z2 = await req('POST', '/api/ingredients', {
    definition_id: T2, quantity: 300, unit: '克', purchase_date: '2026-09-30',
  })
  ok('zero 记录被匹配（ID 不变）', z2.body.id === zId, `${z2.body.id} == ${zId}`)
  ok('数量复活为 300', z2.body.quantity === 300, `${z2.body.quantity}`)
  ok('数据库中只有 1 条', rows(T2).length === 1, `${rows(T2).length} 条`)

  // 复活后重新出现在列表
  const listAfterRevive = await req('GET', '/api/ingredients')
  ok('复活后重新出现在库存列表', listAfterRevive.body.some((s: any) => s.id === zId))

  /* ---------- Case 11：名称相同但 definition 不同 → 不合并 ---------- */
  console.log('\n===== Case 11：名称相同但 definition_id 不同 → 不合并 =====')
  const d1 = await req('POST', '/api/definitions', { name: '同名食材', units: ['克'], estimated_shelf_life_days: 5 })
  const d2 = await req('POST', '/api/definitions', { name: '同名食材2', units: ['克'], estimated_shelf_life_days: 5 })
  const m1 = await req('POST', '/api/ingredients', {
    definition_id: d1.body.id, quantity: 10, unit: '克', purchase_date: '2026-09-30',
  })
  const m2 = await req('POST', '/api/ingredients', {
    definition_id: d2.body.id, quantity: 20, unit: '克', purchase_date: '2026-09-30',
  })
  ok('不同 definition 各自建记录', m1.body.id !== m2.body.id)
  ok('两条记录都在', rows(d1.body.id).length === 1 && rows(d2.body.id).length === 1)

  /* ---------- Case 12：编辑产生同批次 → 保留当前编辑记录 ID ---------- */
  console.log('\n===== Case 12：编辑产生同批次 → 保留当前编辑记录 ID =====')
  // A：番茄 300 克 / 2026-10-05 / 常温 / 手动 expiry 2026-11-01
  const A = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 300, unit: '克', purchase_date: '2026-10-05', storage_method: '常温',
    expiry_date: '2026-11-01', note: '当前编辑', production_date: '2026-10-03',
  })
  const AId = A.body.id
  // B：同批次
  const B = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 500, unit: '克', purchase_date: '2026-10-05', storage_method: '常温',
    expiry_date: '2026-11-01', note: '旧记录',
  })
  const BId = B.body.id
  console.log(`  A id=${AId} (note=当前编辑, prod=2026-10-03)`)
  console.log(`  B id=${BId} (note=旧记录)`)

  // ⚠️ 注意：A 与 B 本来就同批次，所以 B 创建时就已与 A 合并了？
  // 这里 B 的创建会命中 A → 合并。因此需要重新构造场景：
  // 用一个不同批次创建 B，然后编辑 A 使其与 B 同批次。
  console.log('  （重新构造：先让两者不同批次，再通过编辑使 A 变成与 B 同批次）')

  // 清理并重建场景
  await req('DELETE', `/api/ingredients/${AId}`)

  // A'：番茄 300 克 / 2026-10-05 / 常温 / manual 2026-11-01
  const A2 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 300, unit: '克', purchase_date: '2026-10-05', storage_method: '常温',
    expiry_date: '2026-11-01', note: '当前编辑', production_date: '2026-10-03',
  })
  const A2Id = A2.body.id
  // B'：不同 expiry → 不合并，独立存在
  const B2 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 500, unit: '克', purchase_date: '2026-10-05', storage_method: '常温',
    expiry_date: '2026-12-01', note: '旧记录',
  })
  const B2Id = B2.body.id
  ok('A 与 B 初始不同批次（两条独立）', A2Id !== B2Id && rows(T).filter((r) => r.id === A2Id || r.id === B2Id).length === 2)

  // 编辑 A'，把 expiry 改成与 B' 相同 → 应合并，保留 A' 的 ID
  const merged = await req('PATCH', `/api/ingredients/${A2Id}`, { expiry_date: '2026-12-01' })
  ok('PATCH 成功', merged.status === 200, `${merged.status}`)
  ok('**保留当前编辑记录 A 的 ID**', merged.body.id === A2Id, `${merged.body.id} == ${A2Id}`)
  ok('数量 = A(300) + B(500) = 800', merged.body.quantity === 800, `${merged.body.quantity}`)
  ok('目标记录 B 已被删除', rowById(B2Id) === undefined)
  ok('A 仍然存在', rowById(A2Id) !== undefined)

  // 字段保留：A 的 note / production_date
  const aRow = rowById(A2Id)!
  ok('保留 A.note = "当前编辑"', aRow.note === '当前编辑', `${aRow.note}`)
  ok('保留 A.production_date = 2026-10-03', aRow.production_date === '2026-10-03', `${aRow.production_date}`)
  ok('A 的 expiry 为编辑后的值', aRow.expiry_date === '2026-12-01', `${aRow.expiry_date}`)

  /* ---------- Case 13：编辑不冲突 → 正常 UPDATE ---------- */
  console.log('\n===== Case 13：编辑不冲突 → 正常 UPDATE =====')
  const solo = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 10, unit: '个', purchase_date: '2026-07-01',
  })
  const soloId = solo.body.id
  const soloEdit = await req('PATCH', `/api/ingredients/${soloId}`, { quantity: 25 })
  ok('正常更新成功', soloEdit.status === 200 && soloEdit.body.quantity === 25)
  ok('ID 不变', soloEdit.body.id === soloId)
  ok('记录仍存在', rowById(soloId) !== undefined)

  /* ---------- Case 14：Phase 3.1 definition_id 回归 ---------- */
  console.log('\n===== Case 14：Phase 3.1 PATCH definition_id 回归 =====')
  const chg = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 5, unit: '个', purchase_date: '2026-06-01',
  })
  const chgId = chg.body.id
  const chgAfter = await req('PATCH', `/api/ingredients/${chgId}`, { definition_id: P })
  ok('PATCH definition_id 成功', chgAfter.status === 200, `${chgAfter.status}`)
  ok('definition_id 已改', chgAfter.body.definition_id === P, `${chgAfter.body.definition_id}`)
  ok('ID 不变', chgAfter.body.id === chgId)

  /* ---------- Case 15：换 definition 不重算 expiry ---------- */
  console.log('\n===== Case 15：换 definition 不重算 expiry =====')
  const rc = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: '2026-05-01',
  })
  const rcId = rc.body.id
  const rcBefore = rowById(rcId)!
  const rcAfter = await req('PATCH', `/api/ingredients/${rcId}`, { definition_id: P })
  ok('expiry_date 未重算（番茄7天→土豆30天）',
    rcAfter.body.expiry_date === rcBefore.expiry_date,
    `${rcBefore.expiry_date} → ${rcAfter.body.expiry_date}`)
  ok('expiry_date_source 未变', rcAfter.body.expiry_date_source === rcBefore.expiry_date_source)

  /* ---------- Case 16：日期规则回归 ---------- */
  console.log('\n===== Case 16：日期规则回归 =====')
  const badDate = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: '2026-10-05', production_date: '2026-10-10',
  })
  ok('production > purchase 被拒绝', badDate.status === 400, `${badDate.status}`)
  const badManual = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 1, unit: '个', purchase_date: '2026-10-05', expiry_date: '2026-10-01',
  })
  ok('manual expiry < purchase 被拒绝', badManual.status === 400, `${badManual.status}`)

  /* ---------- Case 17：zero quantity UI 行为回归 ---------- */
  console.log('\n===== Case 17：zero quantity UI 行为回归 =====')
  const zq = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 3, unit: '千克', purchase_date: '2026-03-03',
  })
  await req('POST', `/api/ingredients/${zq.body.id}/consume`, { amount: 3 })
  const listZ = await req('GET', '/api/ingredients')
  ok('0 数量不出现在列表', !listZ.body.some((s: any) => s.id === zq.body.id))
  ok('0 数量记录仍可 GET', (await req('GET', `/api/ingredients/${zq.body.id}`)).status === 200)

  /* ---------- Case 18：消耗 / 删除 / 列表回归 ---------- */
  console.log('\n===== Case 18：消耗 / 删除 / 列表回归 =====')
  const rg = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 100, unit: '千克', purchase_date: '2026-02-02',
  })
  const rgConsume = await req('POST', `/api/ingredients/${rg.body.id}/consume`, { amount: 30 })
  ok('消耗正常', rgConsume.status === 200 && rgConsume.body.quantity === 70)
  const rgOver = await req('POST', `/api/ingredients/${rg.body.id}/consume`, { amount: 999 })
  ok('库存不足被拒绝', rgOver.status === 409)
  const rgDel = await req('DELETE', `/api/ingredients/${rg.body.id}`)
  ok('删除正常', rgDel.status === 204)
  ok('删除后不存在', rowById(rg.body.id) === undefined)
  const finalList = await req('GET', '/api/ingredients')
  ok('列表正常', finalList.status === 200 && Array.isArray(finalList.body))

  /* ---------- 附加：事务原子性 ---------- */
  console.log('\n===== 附加：事务原子性（合并失败不留半成品）=====')
  // 制造一个会导致 PATCH 失败的同批次场景：合法校验失败应在事务外
  // 这里验证：请求失败后 A 与 B 都保持原状
  const at1 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 11, unit: '克', purchase_date: '2026-01-10', expiry_date: '2026-02-01',
  })
  const at2 = await req('POST', '/api/ingredients', {
    definition_id: T, quantity: 22, unit: '克', purchase_date: '2026-01-10', expiry_date: '2026-03-01',
  })
  const at1Before = rowById(at1.body.id)!
  const at2Before = rowById(at2.body.id)!

  // 用非法 unit 触发失败（事务内不应有任何写入）
  const atFail = await req('PATCH', `/api/ingredients/${at1.body.id}`, {
    expiry_date: '2026-03-01', unit: '斤',
  })
  ok('非法 unit 导致失败', atFail.status === 400, `${atFail.status}`)
  const at1After = rowById(at1.body.id)!
  const at2After = rowById(at2.body.id)!
  ok('A 完全未变', JSON.stringify(at1Before) === JSON.stringify(at1After))
  ok('B 完全未变', JSON.stringify(at2Before) === JSON.stringify(at2After))
  ok('B 未被误删', at2After !== undefined)

  /* ---------- 附加：合并数量遵循 quantity 规则 ---------- */
  console.log('\n===== 附加：合并数量遵循现有 quantity 规则 =====')
  const q1 = await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 0.1, unit: '千克', purchase_date: '2026-04-04',
  })
  const qId = q1.body.id
  await req('POST', '/api/ingredients', {
    definition_id: P, quantity: 0.2, unit: '千克', purchase_date: '2026-04-04',
  })
  const qRow = rowById(qId)!
  ok('0.1 + 0.2 = 0.3（舍入后无浮点噪声）', qRow.quantity === 0.3, `${qRow.quantity}`)
  ok('总记录仍为 1 条', rows(P).filter((r) => r.id === qId).length === 1)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
