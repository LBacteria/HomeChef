/**
 * v0.1.2 批次二验证：percentage 折算天数规则 + 库存排序
 *
 * 覆盖：
 *   - percentage 新规则：expiring_days = ceil(total × threshold / 100)
 *   - 排序：default / expiry / purchase_date / name / quantity（双向）
 *   - 稳定 tie-breaker（id ASC）
 *   - 非法 sort / order → 400
 *   - 回归：创建/编辑/删除/消耗/Phase 4 合并/Phase 3 搜索/Phase 3.1/批次一设置
 *
 * 使用独立临时库与动态端口。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 37000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v012-sort-${Date.now()}.db`)

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

try {
  /* ============================================================
   * 一、percentage 新规则（折算天数 + ceil）
   * ============================================================ */
  console.log('===== 一、percentage 折算天数规则 =====')

  const defA = await req('POST', '/api/definitions', { name: '测试食材A', units: ['个'], estimated_shelf_life_days: 30 })

  async function statusOf(id: number) {
    const res = await req('GET', '/api/ingredients?includeZero=true')
    return res.body.find((r: any) => r.id === id)
  }

  // threshold = 15%
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 15 })

  console.log('\n--- 题目给出的三个示例 ---')

  // 示例 1：总 10 天（purchase=today-0, expiry=today+10），15% → ceil(1.5) = 2 天
  //   剩余 2 天 → 应 expiring；剩余 3 天 → 应 normal
  const e10_2 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个', purchase_date: shift(0), expiry_date: shift(2),
  })
  const r10_2 = await statusOf(e10_2.body.id)
  // 注意：此记录 total = 2 天（purchase=today, expiry=today+2）
  // 为精确控制 total，用 production_date 拉开起点
  console.log('  （用 production_date 精确控制 total_duration）')

  // 精确构造 A：total = 10 天，remaining = 2 天
  //   production = today-8, expiry = today+2 → total = 10, remaining = 2
  //   15% → ceil(10 × 0.15) = ceil(1.5) = 2 → 剩余 2 <= 2 → expiring
  const case1 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-7), production_date: shift(-8), expiry_date: shift(2),
  })
  const c1 = await statusOf(case1.body.id)
  console.log(`  案例1: total=10, remaining=2, expiring_days=ceil(1.5)=2`)
  ok('total=10 / 剩 2 天 / 15% → expiring', c1.expiry_status === 'expiring',
    `${c1.expiry_status} (剩 ${c1.days_remaining} 天)`)

  // 精确构造 B：total = 10 天，remaining = 3 天 → 3 > 2 → normal
  const case2 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-6), production_date: shift(-7), expiry_date: shift(3),
  })
  const c2 = await statusOf(case2.body.id)
  console.log(`  案例2: total=10, remaining=3, expiring_days=2`)
  ok('total=10 / 剩 3 天 / 15% → normal（3 > 2）', c2.expiry_status === 'normal',
    `${c2.expiry_status} (剩 ${c2.days_remaining} 天)`)

  console.log('\n--- 关键：验证 ceil 而非 round ---')
  // total = 7 天，15% → 7 × 0.15 = 1.05 → ceil = 2；round 也是 1... 实际 round(1.05)=1
  //   剩余 2 天：ceil→expiring，round→normal。可区分！
  const case3 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-4), production_date: shift(-5), expiry_date: shift(2),
  })
  const c3 = await statusOf(case3.body.id)
  console.log(`  案例3: total=7, 15% → 1.05 → ceil=2（round 会得 1）, remaining=2`)
  ok('total=7 / 剩 2 天 → expiring（证明用了 ceil 而非 round）', c3.expiry_status === 'expiring',
    `${c3.expiry_status}`)

  // total = 3 天，15% → 0.45 → ceil = 1
  //   构造：production = today-2, expiry = today+1 → total = 3, remaining = 1
  //   1 <= 1 → expiring
  const case4 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-1), production_date: shift(-2), expiry_date: shift(1),
  })
  const c4 = await statusOf(case4.body.id)
  console.log(`  案例4: total=3, 15% → 0.45 → ceil=1, remaining=${c4.days_remaining}`)
  ok('total=3 / 剩 1 天 → expiring', c4.expiry_status === 'expiring',
    `${c4.expiry_status} (剩 ${c4.days_remaining} 天)`)

  // total = 3 天，剩余 2 天 → 2 > 1 → normal
  //   构造：production = today-1, expiry = today+2 → total = 3, remaining = 2
  const case5 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(0), production_date: shift(-1), expiry_date: shift(2),
  })
  const c5 = await statusOf(case5.body.id)
  ok('total=3 / 剩 2 天 → normal（2 > 1）', c5.expiry_status === 'normal',
    `${c5.expiry_status} (剩 ${c5.days_remaining} 天)`)

  console.log('\n--- percentage 边界 ---')
  // threshold = 0 → expiring_days = 0 → 只有剩余 0 天才 expiring
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 0 })
  const p0a = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-9), production_date: shift(-10), expiry_date: shift(0),
  })
  const p0ar = await statusOf(p0a.body.id)
  ok('percentage=0：今天到期 → expiring', p0ar.expiry_status === 'expiring', `${p0ar.expiry_status}`)

  const p0b = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-8), production_date: shift(-9), expiry_date: shift(1),
  })
  const p0br = await statusOf(p0b.body.id)
  ok('percentage=0：剩余 1 天 → normal', p0br.expiry_status === 'normal', `${p0br.expiry_status}`)

  // threshold = 100 → expiring_days = total → 所有未过期都是 expiring
  await req('PATCH', '/api/settings', { expiry_warning_threshold: 100 })
  const p100 = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-1), production_date: shift(-2), expiry_date: shift(8),
  })
  const p100r = await statusOf(p100.body.id)
  ok('percentage=100：未过期全部 expiring（剩 8 = total 10）',
    p100r.expiry_status === 'expiring', `${p100r.expiry_status}`)

  // 已过期优先
  const pexp = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个',
    purchase_date: shift(-20), production_date: shift(-25), expiry_date: shift(-1),
  })
  const pexpr = await statusOf(pexp.body.id)
  ok('已过期优先于 percentage 判定', pexpr.expiry_status === 'expired', `${pexpr.expiry_status}`)

  // days 模式不受影响
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })
  const dmode = await req('POST', '/api/ingredients', {
    definition_id: defA.body.id, quantity: 1, unit: '个', purchase_date: shift(0), expiry_date: shift(3),
  })
  const dmr = await statusOf(dmode.body.id)
  ok('days 模式规则不变（剩 3 <= 3）', dmr.expiry_status === 'expiring', `${dmr.expiry_status}`)

  /* ============================================================
   * 二、排序
   * ============================================================ */
  console.log('\n\n===== 二、排序 =====')

  // 用独立定义与唯一日期，避免 Phase 4 合并
  const sTomato = await req('POST', '/api/definitions', { name: 'B番茄', units: ['克'], estimated_shelf_life_days: null })
  const sEgg = await req('POST', '/api/definitions', { name: 'A鸡蛋', units: ['克'], estimated_shelf_life_days: null })
  const sMilk = await req('POST', '/api/definitions', { name: 'C牛奶', units: ['克'], estimated_shelf_life_days: null })

  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  // A: 已过期 5 天
  const sA = await req('POST', '/api/ingredients', {
    definition_id: sTomato.body.id, quantity: 100, unit: '克', purchase_date: shift(-30), expiry_date: shift(-5),
  })
  // B: 临期 1 天
  const sB = await req('POST', '/api/ingredients', {
    definition_id: sEgg.body.id, quantity: 200, unit: '克', purchase_date: shift(-20), expiry_date: shift(1),
  })
  // C: 临期 3 天
  const sC = await req('POST', '/api/ingredients', {
    definition_id: sMilk.body.id, quantity: 300, unit: '克', purchase_date: shift(-18), expiry_date: shift(3),
  })
  // D: 正常 10 天
  const sD = await req('POST', '/api/ingredients', {
    definition_id: sTomato.body.id, quantity: 400, unit: '克', purchase_date: shift(-15), expiry_date: shift(10),
  })
  // E: 正常 30 天
  const sE = await req('POST', '/api/ingredients', {
    definition_id: sEgg.body.id, quantity: 500, unit: '克', purchase_date: shift(-10), expiry_date: shift(30),
  })
  // F: 无 expiry（定义 estimated_shelf_life_days = null）
  const sF = await req('POST', '/api/ingredients', {
    definition_id: sMilk.body.id, quantity: 600, unit: '克', purchase_date: shift(-5),
  })

  const ids = { A: sA.body.id, B: sB.body.id, C: sC.body.id, D: sD.body.id, E: sE.body.id, F: sF.body.id }
  console.log(`  记录：A=${ids.A} B=${ids.B} C=${ids.C} D=${ids.D} E=${ids.E} F=${ids.F}`)

  function label(id: number): string {
    for (const [k, v] of Object.entries(ids)) if (v === id) return k
    return `#${id}`
  }

  console.log('\n--- 默认排序 ---')
  const defSort = await req('GET', '/api/ingredients?sort=default')
  const defOrder = defSort.body.map((r: any) => label(r.id))
  console.log(`  实际顺序：${defOrder.join(' → ')}`)
  const expected = ['A', 'B', 'C', 'D', 'E', 'F']
  // 期望：A(过期) → B(临期1) → C(临期3) → D(正常10) → E(正常30) → F(无保质期)
  const filtered = defOrder.filter((x: string) => expected.includes(x))
  ok('默认排序：过期 → 临期 → 正常 → 无保质期',
    JSON.stringify(filtered) === JSON.stringify(expected),
    `实际 ${filtered.join(',')}`)

  // 状态顺序验证
  const statuses = defSort.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => r.expiry_status)
  ok('  状态序列 = expired,expiring,expiring,normal,normal,no_expiry',
    JSON.stringify(statuses) === JSON.stringify(['expired', 'expiring', 'expiring', 'normal', 'normal', 'no_expiry']),
    statuses.join(','))

  console.log('\n--- 保质期剩余时间 ---')
  const expAsc = await req('GET', '/api/ingredients?sort=expiry&order=asc')
  const expAscOrder = expAsc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  asc:  ${expAscOrder.join(' → ')}`)
  ok('expiry asc：短 → 长，无 expiry 在最后',
    JSON.stringify(expAscOrder) === JSON.stringify(['A', 'B', 'C', 'D', 'E', 'F']),
    expAscOrder.join(','))

  const expDesc = await req('GET', '/api/ingredients?sort=expiry&order=desc')
  const expDescOrder = expDesc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  desc: ${expDescOrder.join(' → ')}`)
  ok('expiry desc：长 → 短，无 expiry 仍在最后',
    JSON.stringify(expDescOrder) === JSON.stringify(['E', 'D', 'C', 'B', 'A', 'F']),
    expDescOrder.join(','))

  // 确认无 expiry 未被当成 0 天
  const fIndexAsc = expAscOrder.indexOf('F')
  ok('  无 expiry 未排在 asc 的最前（未被当作 0 天）', fIndexAsc === 5, `位置 ${fIndexAsc}`)

  console.log('\n--- 入库日期 ---')
  // purchase_date: A(-30) B(-20) C(-18) D(-15) E(-10) F(-5)
  const pdAsc = await req('GET', '/api/ingredients?sort=purchase_date&order=asc')
  const pdAscOrder = pdAsc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  asc（旧→新）: ${pdAscOrder.join(' → ')}`)
  ok('purchase_date asc = A,B,C,D,E,F', JSON.stringify(pdAscOrder) === JSON.stringify(expected), pdAscOrder.join(','))

  const pdDesc = await req('GET', '/api/ingredients?sort=purchase_date&order=desc')
  const pdDescOrder = pdDesc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  desc（新→旧）: ${pdDescOrder.join(' → ')}`)
  ok('purchase_date desc = F,E,D,C,B,A',
    JSON.stringify(pdDescOrder) === JSON.stringify([...expected].reverse()), pdDescOrder.join(','))

  console.log('\n--- 食材名称 ---')
  // 名称：A鸡蛋(鸡蛋) B番茄(番茄) C牛奶(牛奶) D番茄 E鸡蛋 F牛奶
  // asc: 鸡蛋(B,E) → 牛奶(C,F) → 番茄... 中文按 Unicode：番(U+756A) 牛(U+725B) 鸡(U+9E21)
  // 实际 Unicode 顺序：牛(725B) < 番(756A) < 鸡(9E21)
  const nmAsc = await req('GET', '/api/ingredients?sort=name&order=asc')
  const nmAscOrder = nmAsc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  asc:  ${nmAscOrder.join(' → ')}`)
  const nmAscNames = nmAsc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => r.definition_name)
  console.log(`  对应名称：${nmAscNames.join(',')}`)
  // 验证名称是升序
  let nameAscOk = true
  for (let i = 1; i < nmAscNames.length; i++) {
    if (nmAscNames[i - 1].localeCompare(nmAscNames[i], 'zh-Hans-CN') > 0) { nameAscOk = false; break }
  }
  ok('name asc 按名称升序', nameAscOk, nmAscNames.join(' → '))

  const nmDescNames = (await req('GET', '/api/ingredients?sort=name&order=desc')).body
    .filter((r: any) => expected.includes(label(r.id))).map((r: any) => r.definition_name)
  let nameDescOk = true
  for (let i = 1; i < nmDescNames.length; i++) {
    if (nmDescNames[i - 1].localeCompare(nmDescNames[i], 'zh-Hans-CN') < 0) { nameDescOk = false; break }
  }
  ok('name desc 按名称降序', nameDescOk, nmDescNames.join(' → '))
  ok('  desc 是 asc 的反向',
    JSON.stringify(nmDescNames) === JSON.stringify([...nmAscNames].reverse()))

  console.log('\n--- 数量（数值比较）---')
  // quantity: A=100 B=200 C=300 D=400 E=500 F=600
  const qAsc = await req('GET', '/api/ingredients?sort=quantity&order=asc')
  const qAscOrder = qAsc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  asc（少→多）: ${qAscOrder.join(' → ')}`)
  ok('quantity asc = A,B,C,D,E,F', JSON.stringify(qAscOrder) === JSON.stringify(expected), qAscOrder.join(','))

  const qDesc = await req('GET', '/api/ingredients?sort=quantity&order=desc')
  const qDescOrder = qDesc.body.filter((r: any) => expected.includes(label(r.id))).map((r: any) => label(r.id))
  console.log(`  desc（多→少）: ${qDescOrder.join(' → ')}`)
  ok('quantity desc = F,E,D,C,B,A',
    JSON.stringify(qDescOrder) === JSON.stringify([...expected].reverse()), qDescOrder.join(','))

  // 关键：数值 vs 字符串比较（10 vs 2）
  const numDef = await req('POST', '/api/definitions', { name: '数值测试', units: ['克'], estimated_shelf_life_days: null })
  const n2 = await req('POST', '/api/ingredients', { definition_id: numDef.body.id, quantity: 2, unit: '克', purchase_date: shift(-100) })
  const n10 = await req('POST', '/api/ingredients', { definition_id: numDef.body.id, quantity: 10, unit: '克', purchase_date: shift(-101) })
  const numAsc = await req('GET', '/api/ingredients?sort=quantity&order=asc')
  const idx2 = numAsc.body.findIndex((r: any) => r.id === n2.body.id)
  const idx10 = numAsc.body.findIndex((r: any) => r.id === n10.body.id)
  ok('数值比较：2 排在 10 前面（非字符串比较）', idx2 < idx10, `2@${idx2}, 10@${idx10}`)

  console.log('\n--- 稳定排序（tie-breaker）---')
  //
  // ⚠️ 必须让这些记录的**同批次键不同**，否则会被 Phase 4 自动合并成一条。
  //    这里用不同的 purchase_date 使它们各自独立，
  //    但排序键（quantity）完全相同，从而验证 tie-breaker。
  const tieDef = await req('POST', '/api/definitions', { name: '稳定测试', units: ['克'], estimated_shelf_life_days: null })
  const tieIds: number[] = []
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/api/ingredients', {
      definition_id: tieDef.body.id, quantity: 111, unit: '克',
      purchase_date: shift(-200 - i), // 不同日期 → 不会被合并
    })
    tieIds.push(r.body.id)
  }
  ok('3 条记录各自独立（未被合并）', new Set(tieIds).size === 3, tieIds.join(','))

  const tieRes = await req('GET', '/api/ingredients?sort=quantity&order=asc')
  const tieOrder = tieRes.body.filter((r: any) => tieIds.includes(r.id)).map((r: any) => r.id)
  ok('相同排序键按 id ASC 稳定',
    JSON.stringify(tieOrder) === JSON.stringify([...tieIds].sort((a, b) => a - b)),
    `实际 [${tieOrder.join(',')}] 期望 [${[...tieIds].sort((a, b) => a - b).join(',')}]`)

  // 多次请求顺序一致
  const repeat1 = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  const repeat2 = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  ok('重复请求顺序一致（稳定）', JSON.stringify(repeat1) === JSON.stringify(repeat2))

  console.log('\n--- 非法排序参数 ---')
  ok('非法 sort → 400', (await req('GET', '/api/ingredients?sort=evil')).status === 400)
  ok('SQL 注入尝试 → 400',
    (await req('GET', "/api/ingredients?sort=id;DROP TABLE standard_ingredient;--")).status === 400)
  ok('非法 order → 400', (await req('GET', '/api/ingredients?sort=expiry&order=random')).status === 400)
  ok('额外未知参数 → 400', (await req('GET', '/api/ingredients?nope=1')).status === 400)
  ok('合法 sort 无 order → 200', (await req('GET', '/api/ingredients?sort=name')).status === 200)
  ok('默认无参数 → 200', (await req('GET', '/api/ingredients')).status === 200)

  /* ============================================================
   * 三、排序不修改数据
   * ============================================================ */
  console.log('\n\n===== 三、排序不修改任何数据 =====')

  const before = raw.prepare('select id, quantity, expiry_date, purchase_date, definition_id from standard_ingredient order by id').all()
  for (const s of ['default', 'expiry', 'purchase_date', 'name', 'quantity']) {
    for (const o of ['asc', 'desc']) {
      await req('GET', `/api/ingredients?sort=${s}&order=${o}`)
    }
  }
  const after = raw.prepare('select id, quantity, expiry_date, purchase_date, definition_id from standard_ingredient order by id').all()
  ok('10 次不同排序后，数据库完全未变',
    JSON.stringify(before) === JSON.stringify(after), `${(before as any[]).length} 条记录`)

  /* ============================================================
   * 四、回归
   * ============================================================ */
  console.log('\n\n===== 四、回归 =====')

  const regDef = await req('POST', '/api/definitions', { name: '回归食材', units: ['克', '个'], estimated_shelf_life_days: 20 })

  const c = await req('POST', '/api/ingredients', { definition_id: regDef.body.id, quantity: 10, unit: '克', purchase_date: shift(-300) })
  ok('创建库存', c.status === 201)

  const e = await req('PATCH', `/api/ingredients/${c.body.id}`, { quantity: 20 })
  ok('编辑库存', e.status === 200 && e.body.quantity === 20)

  const cons = await req('POST', `/api/ingredients/${c.body.id}/consume`, { amount: 5 })
  ok('消耗库存', cons.status === 200 && cons.body.quantity === 15)

  // Phase 4 合并
  const mA = await req('POST', '/api/ingredients', { definition_id: regDef.body.id, quantity: 1, unit: '个', purchase_date: shift(-301) })
  const mB = await req('POST', '/api/ingredients', { definition_id: regDef.body.id, quantity: 2, unit: '个', purchase_date: shift(-301) })
  ok('Phase 4 自动合并', mA.body.id === mB.body.id && mB.body.quantity === 3, `${mB.body.quantity}`)

  // Phase 3 搜索
  const search = await req('GET', '/api/definitions?search=回归')
  ok('Phase 3 搜索', search.status === 200 && search.body.some((d: any) => d.id === regDef.body.id))

  // Phase 3.1 换 definition
  const swap = await req('PATCH', `/api/ingredients/${c.body.id}`, { definition_id: regDef.body.id, unit: '克' })
  ok('Phase 3.1 PATCH definition_id', swap.status === 200, `${swap.status}`)

  // 删除
  const del = await req('DELETE', `/api/ingredients/${mB.body.id}`)
  ok('删除库存', del.status === 204)

  // 批次一：设置
  const st = await req('GET', '/api/settings')
  ok('批次一：GET /api/settings', st.status === 200 && typeof st.body.expiry_warning_mode === 'string')

  const stUpd = await req('PATCH', '/api/settings', { expiry_warning_threshold: 7 })
  ok('批次一：PATCH /api/settings', stUpd.status === 200 && stUpd.body.expiry_warning_threshold === 7)

  // 列表仍隐藏 0 数量
  const listFinal = await req('GET', '/api/ingredients')
  ok('列表仍隐藏 0 数量', !listFinal.body.some((r: any) => r.quantity === 0))

  // 新字段存在
  ok('返回含 expiry_status', listFinal.body.every((r: any) => typeof r.expiry_status === 'string'))
  ok('返回含 definition_name', listFinal.body.every((r: any) => typeof r.definition_name === 'string'))
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
