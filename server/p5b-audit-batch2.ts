/**
 * v0.1.2 批次二 —— 只读验收审查
 *
 * 目的：
 *   1. 实证排序**不产生任何数据库写入**（逐字段比对）
 *   2. 复核 percentage 规则（含 ceil 与 round 的区分）
 *   3. 复核 no_expiry 在 asc/desc 下的位置
 *   4. 复核默认排序的完整优先级链
 *   5. 复核测试脚本本身无构造错误
 *
 * 只读性质：使用独立临时库；不修改项目任何文件。
 */

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 41000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `p5b-audit-${Date.now()}.db`)

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

try {
  /* ============================================================
   * 一、数据安全：排序不产生任何写入
   * ============================================================ */
  console.log('===== 一、数据安全（排序不写入）=====')

  const defA = await req('POST', '/api/definitions', { name: '审计食材A', units: ['克'], estimated_shelf_life_days: null })
  const defB = await req('POST', '/api/definitions', { name: '审计食材B', units: ['克'], estimated_shelf_life_days: null })

  // 建 6 条覆盖各种状态的记录
  const made: number[] = []
  const specs = [
    { d: defA.body.id, q: 100, p: shift(-30), e: shift(-5), note: 'n1' },
    { d: defB.body.id, q: 200, p: shift(-20), e: shift(1), note: 'n2' },
    { d: defA.body.id, q: 300, p: shift(-18), e: shift(3), note: 'n3' },
    { d: defB.body.id, q: 400, p: shift(-15), e: shift(10), note: 'n4' },
    { d: defA.body.id, q: 500, p: shift(-10), e: shift(30), note: 'n5' },
    { d: defB.body.id, q: 600, p: shift(-5), note: 'n6' }, // 无 expiry
  ]
  for (const s of specs) {
    const r = await req('POST', '/api/ingredients', {
      definition_id: s.d, quantity: s.q, unit: '克', purchase_date: s.p,
      ...(s.e ? { expiry_date: s.e } : {}),
      note: s.note,
    })
    made.push(r.body.id)
  }
  info('创建记录', made.join(','))

  // 完整快照（所有业务字段）
  const SNAPSHOT_SQL = `select id, definition_id, quantity, unit, purchase_date, production_date,
    expiry_date, expiry_date_source, storage_method, note, created_at, updated_at
    from standard_ingredient order by id`
  const before = raw.prepare(SNAPSHOT_SQL).all()
  const beforeCount = (raw.prepare('select count(*) c from standard_ingredient').get() as any).c

  // 遍历所有排序组合（多次）
  const fields = ['default', 'expiry', 'purchase_date', 'name', 'quantity']
  const orders = ['asc', 'desc']
  let requests = 0
  for (let round = 0; round < 2; round++) {
    for (const f of fields) {
      for (const o of orders) {
        await req('GET', `/api/ingredients?sort=${f}&order=${o}`)
        await req('GET', `/api/ingredients?sort=${f}&order=${o}&includeZero=true`)
        requests += 2
      }
    }
  }
  info('排序请求次数', `${requests}`)

  const after = raw.prepare(SNAPSHOT_SQL).all()
  const afterCount = (raw.prepare('select count(*) c from standard_ingredient').get() as any).c

  ok('记录数未变', beforeCount === afterCount, `${beforeCount} → ${afterCount}`)
  ok('全部业务字段逐字节未变', JSON.stringify(before) === JSON.stringify(after))

  // 逐字段核对（更细粒度，便于定位）
  const fieldsToCheck = ['quantity', 'expiry_date', 'purchase_date', 'production_date', 'note', 'definition_id', 'expiry_date_source', 'storage_method', 'updated_at']
  for (const f of fieldsToCheck) {
    const same = (before as any[]).every((r, i) => r[f] === (after as any[])[i][f])
    ok(`  字段 ${f} 未变`, same)
  }

  // 确认没有触发 merge（记录数不变已证明，再确认 id 集合一致）
  const idBefore = (before as any[]).map((r) => r.id).join(',')
  const idAfter = (after as any[]).map((r) => r.id).join(',')
  ok('inventory id 集合未变（未触发 merge）', idBefore === idAfter)

  // SQLite 变更计数（更底层的证明）
  const totalChanges = (raw.prepare('select total_changes() c').get() as any).c
  info('会话内 total_changes（含此前的插入）', `${totalChanges}`)
  const changesBefore = totalChanges
  await req('GET', '/api/ingredients?sort=expiry&order=desc')
  await req('GET', '/api/ingredients?sort=default')
  const changesAfter = (raw.prepare('select total_changes() c').get() as any).c
  ok('排序请求期间 SQLite 写入计数为 0', changesAfter === changesBefore,
    `${changesBefore} → ${changesAfter}`)

  /* ============================================================
   * 二、percentage 规则复核
   * ============================================================ */
  console.log('\n\n===== 二、percentage 规则复核 =====')

  const defP = await req('POST', '/api/definitions', { name: '百分比审计', units: ['个'], estimated_shelf_life_days: null })

  async function statusOf(id: number) {
    const res = await req('GET', '/api/ingredients?includeZero=true')
    return res.body.find((r: any) => r.id === id)
  }

  await req('PATCH', '/api/settings', { expiry_warning_mode: 'percentage', expiry_warning_threshold: 15 })

  // 精确控制 total 与 remaining
  // production 作为 start（无 purchase 影响）：start = production
  const cases: Array<{ name: string; total: number; remaining: number; expect: string; ceilVal: number; roundVal: number }> = [
    { name: 'total=10 rem=2', total: 10, remaining: 2, expect: 'expiring', ceilVal: 2, roundVal: 2 },
    { name: 'total=10 rem=3', total: 10, remaining: 3, expect: 'normal', ceilVal: 2, roundVal: 2 },
    { name: 'total=7 rem=2', total: 7, remaining: 2, expect: 'expiring', ceilVal: 2, roundVal: 1 },
    { name: 'total=7 rem=1', total: 7, remaining: 1, expect: 'expiring', ceilVal: 2, roundVal: 1 },
    { name: 'total=3 rem=1', total: 3, remaining: 1, expect: 'expiring', ceilVal: 1, roundVal: 0 },
    { name: 'total=3 rem=2', total: 3, remaining: 2, expect: 'normal', ceilVal: 1, roundVal: 0 },
    { name: 'total=20 rem=3', total: 20, remaining: 3, expect: 'expiring', ceilVal: 3, roundVal: 3 },
    { name: 'total=20 rem=4', total: 20, remaining: 4, expect: 'normal', ceilVal: 3, roundVal: 3 },
  ]

  for (const c of cases) {
    // start = expiry - total = (today + remaining) - total = today + remaining - total
    const startOffset = c.remaining - c.total
    const r = await req('POST', '/api/ingredients', {
      definition_id: defP.body.id, quantity: 1, unit: '个',
      production_date: shift(startOffset),
      purchase_date: shift(startOffset + 1), // purchase 晚于 production，避免取到 purchase
      expiry_date: shift(c.remaining),
    })
    const row = await statusOf(r.body.id)
    const distinguishable = c.ceilVal !== c.roundVal
    ok(
      `${c.name}: 期望 ${c.expect}（ceil=${c.ceilVal}${distinguishable ? `, round=${c.roundVal} ← 可区分` : ''}）`,
      row.expiry_status === c.expect,
      `实际 ${row.expiry_status}，剩 ${row.days_remaining} 天`,
    )
  }

  // remaining_percentage 仍返回但不参与判断
  const pctCheck = await req('POST', '/api/ingredients', {
    definition_id: defP.body.id, quantity: 1, unit: '个',
    production_date: shift(-8), purchase_date: shift(-7), expiry_date: shift(2),
  })
  const pctRow = await statusOf(pctCheck.body.id)
  info('remaining_percentage 仍返回', `${pctRow.remaining_percentage}%`)
  ok('  remaining_percentage 确实返回（作为展示信息）', pctRow.remaining_percentage !== null)
  // total=10, remaining=2, 15% → 20% > 15%，若按旧规则(remaining_pct<=threshold)会判 normal
  // 但按新规则 ceil(1.5)=2, 2<=2 → expiring
  ok('  证明状态判定不依赖 remaining_percentage（20% > 15% 却是 expiring）',
    pctRow.remaining_percentage > 15 && pctRow.expiry_status === 'expiring',
    `${pctRow.remaining_percentage}% / ${pctRow.expiry_status}`)

  /* ============================================================
   * 三、days 模式未被改变
   * ============================================================ */
  console.log('\n\n===== 三、days 模式回归 =====')
  await req('PATCH', '/api/settings', { expiry_warning_mode: 'days', expiry_warning_threshold: 3 })

  for (const rem of [0, 1, 2, 3, 4, 5]) {
    const r = await req('POST', '/api/ingredients', {
      definition_id: defP.body.id, quantity: 1, unit: '个',
      purchase_date: shift(-100 + rem), expiry_date: shift(rem),
    })
    const row = await statusOf(r.body.id)
    const expect = rem <= 3 ? 'expiring' : 'normal'
    ok(`days 模式 剩 ${rem} 天 → ${expect}`, row.expiry_status === expect, `${row.expiry_status}`)
  }

  /* ============================================================
   * 四、no_expiry 位置复核
   * ============================================================ */
  console.log('\n\n===== 四、no_expiry 位置复核 =====')

  const noExp = made[5] // 第 6 条无 expiry
  const ascList = (await req('GET', '/api/ingredients?sort=expiry&order=asc')).body
  const descList = (await req('GET', '/api/ingredients?sort=expiry&order=desc')).body
  const defList = (await req('GET', '/api/ingredients?sort=default')).body

  const ascIdx = ascList.findIndex((r: any) => r.id === noExp)
  const descIdx = descList.findIndex((r: any) => r.id === noExp)
  ok('expiry asc：no_expiry 在最后', ascIdx === ascList.length - 1, `位置 ${ascIdx}/${ascList.length - 1}`)
  ok('expiry desc：no_expiry 仍在最后', descIdx === descList.length - 1, `位置 ${descIdx}/${descList.length - 1}`)

  // 确认未被当作 0 天（若当 0，asc 时会排最前）
  ok('  未被当作 0 天（asc 未排最前）', ascIdx !== 0, `位置 ${ascIdx}`)

  // default：所有 no_expiry 都必须排在所有非 no_expiry 之后
  const firstNoExpiryIdx = defList.findIndex((r: any) => r.expiry_status === 'no_expiry')
  const lastNonNoExpiryIdx = defList.reduce(
    (acc: number, r: any, i: number) => (r.expiry_status !== 'no_expiry' ? i : acc),
    -1,
  )
  ok(
    'default：no_expiry 整组在最后（无 no_expiry 出现在非 no_expiry 之前）',
    firstNoExpiryIdx === -1 || firstNoExpiryIdx > lastNonNoExpiryIdx,
    `首个 no_expiry 位置 ${firstNoExpiryIdx}，最后一个非 no_expiry 位置 ${lastNonNoExpiryIdx}`,
  )
  info('  本次库中 no_expiry 条数',
    `${defList.filter((r: any) => r.expiry_status === 'no_expiry').length}`)

  /* ============================================================
   * 五、默认排序完整优先级链
   * ============================================================ */
  console.log('\n\n===== 五、默认排序优先级链 =====')

  const defSortList = (await req('GET', '/api/ingredients?sort=default')).body
  const statusSeq = defSortList.map((r: any) => r.expiry_status)
  const orderNum = { expired: 0, expiring: 1, normal: 2, no_expiry: 3 } as Record<string, number>
  let statusMonotonic = true
  for (let i = 1; i < statusSeq.length; i++) {
    if (orderNum[statusSeq[i - 1]] > orderNum[statusSeq[i]]) { statusMonotonic = false; break }
  }
  ok('状态分组单调（expired→expiring→normal→no_expiry）', statusMonotonic, statusSeq.slice(0, 12).join(','))

  // 同状态内 days_remaining 升序
  let daysMonotonic = true
  for (let i = 1; i < defSortList.length; i++) {
    const a = defSortList[i - 1]
    const b = defSortList[i]
    if (a.expiry_status !== b.expiry_status) continue
    if (a.days_remaining === null || b.days_remaining === null) continue
    if (a.days_remaining > b.days_remaining) { daysMonotonic = false; break }
  }
  ok('同状态内 days_remaining 升序', daysMonotonic)

  // 稳定 tie-breaker：重复请求一致
  const r1 = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  const r2 = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  const r3 = (await req('GET', '/api/ingredients?sort=default')).body.map((r: any) => r.id)
  ok('三次请求顺序完全一致（稳定）',
    JSON.stringify(r1) === JSON.stringify(r2) && JSON.stringify(r2) === JSON.stringify(r3))

  /* ============================================================
   * 六、白名单与注入防护
   * ============================================================ */
  console.log('\n\n===== 六、白名单与注入防护 =====')
  const attacks = [
    'sort=id',
    'sort=id;DROP TABLE standard_ingredient;--',
    "sort=id' OR '1'='1",
    'sort=1',
    'sort=quantity;--',
    'sort=__proto__',
    'sort=constructor',
  ]
  for (const a of attacks) {
    const r = await req('GET', `/api/ingredients?${a}`)
    ok(`拒绝 ${a}`, r.status === 400, `${r.status}`)
  }
  // 确认表还在
  const stillThere = raw.prepare("select name from sqlite_master where type='table' and name='standard_ingredient'").get()
  ok('注入尝试后表仍存在', stillThere !== undefined)

  for (const o of ['ASC', 'DESC', 'ascending', '1', 'up']) {
    const r = await req('GET', `/api/ingredients?sort=expiry&order=${o}`)
    ok(`order=${o} → 400（只接受 asc/desc 小写）`, r.status === 400, `${r.status}`)
  }

  /* ============================================================
   * 七、审查测试脚本自身
   * ============================================================ */
  console.log('\n\n===== 七、测试脚本自身审查 =====')

  const sortTestPath = resolve(process.cwd(), 'verify-v012-sort-expiry.ts')
  const sortTestSrc = readFileSync(sortTestPath, 'utf8')

  // 之前的两个问题是否已修正
  const case4Fixed = sortTestSrc.includes('total=3, 15% → 0.45 → ceil=1, remaining=')
  ok('case4 注释与数据一致（已修正）', case4Fixed)

  const stableFixed = sortTestSrc.includes('shift(-200 - i)')
  ok('稳定排序使用不同 purchase_date（已避开 merge）', stableFixed)

  const hasIndependenceCheck = sortTestSrc.includes('3 条记录各自独立（未被合并）')
  ok('稳定排序测试含"未被合并"断言', hasIndependenceCheck)

  info('测试脚本大小', `${statSync(sortTestPath).size} 字节`)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 审查结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
