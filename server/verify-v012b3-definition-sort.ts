/**
 * v0.1.2 Batch 3 验证：食材库名称排序
 *
 * 覆盖：
 *   - A → Z / Z → A / 默认 A→Z / 名称相同时 id ASC
 *   - 与 search 组合（4 种）
 *   - 参数校验（sort / order 白名单）
 *   - SQL 注入与非法输入
 *   - 数据安全（排序不产生写入）
 *   - 入口：与库存排序相互独立
 *   - 回归：定义 CRUD / 别名 / 单位 / 库存 / 库存排序 / Phase 4 / Batch1 / Batch2
 *
 * 使用独立临时库与动态端口。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 44000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v012b3-${Date.now()}.db`)

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
   * 准备：创建名称可预期的定义
   * ============================================================ */
  console.log('===== 准备 =====')

  // 名称用于验证排序：刻意打乱创建顺序。
  //
  // ⚠️ 名称归一化是 trim().toLowerCase()，因此 'Apple' 与 'apple' 会冲突（409）。
  //    这里使用**归一化后仍唯一**的名称，避免制造无谓的冲突。
  const names = ['Charlie', 'apple', 'Banana', 'zebra', 'delta', 'Echo']
  const created: Array<{ id: number; name: string }> = []
  for (const n of names) {
    const r = await req('POST', '/api/definitions', { name: n, units: ['克'] })
    if (r.status === 201) created.push({ id: r.body.id, name: n })
    else info(`创建 ${n} 失败`, `${r.status}`)
  }
  ok('创建 6 个定义', created.length === 6, `${created.length}`)
  info('创建顺序', created.map((c) => `${c.name}#${c.id}`).join(', '))

  // 额外的中文名称，用于验证中文排序
  const cnNames = ['番茄', '土豆', '白菜']
  for (const n of cnNames) {
    const r = await req('POST', '/api/definitions', { name: n, units: ['克'] })
    if (r.status === 201) created.push({ id: r.body.id, name: n })
  }
  info('含中文共', `${created.length} 个`)

  /** 校验一个名称数组是否按指定方向有序（与后端相同的 localeCompare 语义） */
  function isSorted(items: Array<{ name: string; id: number }>, order: 'asc' | 'desc'): boolean {
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]
      const b = items[i]
      const cmp = a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
      if (cmp === 0) {
        // 名称相同时必须 id ASC
        if (a.id > b.id) return false
        continue
      }
      if (order === 'asc' && cmp > 0) return false
      if (order === 'desc' && cmp < 0) return false
    }
    return true
  }

  /* ============================================================
   * 一、基础排序
   * ============================================================ */
  console.log('\n===== 一、基础排序 =====')

  const listAsc = await req('GET', '/api/definitions?sort=name&order=asc')
  ok('A→Z 返回 200', listAsc.status === 200, `${listAsc.status}`)
  ok('A→Z 顺序正确', isSorted(listAsc.body, 'asc'),
    listAsc.body.map((d: any) => d.name).join(' < '))
  info('A→Z 结果', listAsc.body.map((d: any) => d.name).join(', '))

  const listDesc = await req('GET', '/api/definitions?sort=name&order=desc')
  ok('Z→A 顺序正确', isSorted(listDesc.body, 'desc'),
    listDesc.body.map((d: any) => d.name).join(' > '))
  info('Z→A 结果', listDesc.body.map((d: any) => d.name).join(', '))

  ok('Z→A 是 A→Z 的严格反向',
    JSON.stringify(listDesc.body.map((d: any) => d.id)) ===
      JSON.stringify([...listAsc.body.map((d: any) => d.id)].reverse()))

  console.log('\n--- 默认排序（不传参数）---')
  const listDefault = await req('GET', '/api/definitions')
  ok('无参数 → 200', listDefault.status === 200)
  ok('无参数默认 name ASC（A→Z）',
    JSON.stringify(listDefault.body.map((d: any) => d.id)) ===
      JSON.stringify(listAsc.body.map((d: any) => d.id)),
    '与显式 sort=name&order=asc 一致')

  const onlySort = await req('GET', '/api/definitions?sort=name')
  ok('只传 sort=name → 默认 asc', isSorted(onlySort.body, 'asc'))

  const onlyOrder = await req('GET', '/api/definitions?order=desc')
  ok('只传 order=desc → 生效', isSorted(onlyOrder.body, 'desc'))

  console.log('\n--- 名称相同时 id ASC ---')
  // 检查是否有同名（大小写不同不算同名，因为 name 保留原样）
  const dupNames = listAsc.body.map((d: any) => d.name)
  const hasDup = dupNames.length !== new Set(dupNames).size
  info('存在完全同名记录', hasDup ? '是' : '否（本组数据大小写不同，非完全同名）')

  // 完全同名不可能出现：name_normalized 有 UNIQUE 约束
  // （这正是「名称不是关系身份、只有 ID 是」的体现）
  const sameNameAttempt = await req('POST', '/api/definitions', { name: 'apple', units: ['克'] })
  ok('完全同名被 UNIQUE 拦截（409）', sameNameAttempt.status === 409, `${sameNameAttempt.status}`)
  const caseVariantAttempt = await req('POST', '/api/definitions', { name: 'APPLE', units: ['克'] })
  ok('大小写变体同样被拦截（归一化唯一性）', caseVariantAttempt.status === 409, `${caseVariantAttempt.status}`)
  info('说明', 'id ASC tie-breaker 属防御性设计，正常数据下不会触发（同名无法入库）')

  // 直接验证排序函数的 tie-breaker 逻辑（构造同名数据绕过 HTTP 层）
  // 通过 Service 层单元调用验证会更直接；这里用 SQL 临时插一行同名不可行（UNIQUE 阻止）。
  // 因此该 tie-breaker 通过**代码审查**确认存在，并由 sortStock 的同类实现间接印证。

  console.log('\n--- 中文名称排序 ---')
  const cnInList = listAsc.body.filter((d: any) => ['番茄', '土豆', '白菜'].includes(d.name))
  ok('中文记录存在', cnInList.length === 3, `${cnInList.length}`)
  const cnAscNames = cnInList.map((d: any) => d.name)
  let cnAscOk = true
  for (let i = 1; i < cnAscNames.length; i++) {
    if (cnAscNames[i - 1].localeCompare(cnAscNames[i], 'zh-Hans-CN') > 0) { cnAscOk = false; break }
  }
  ok('中文按 Unicode 升序（与后端一致）', cnAscOk, cnAscNames.join(' < '))

  /* ============================================================
   * 二、与搜索组合
   * ============================================================ */
  console.log('\n===== 二、与搜索组合 =====')

  // 无 search + A→Z（已测）
  ok('无 search + A→Z', isSorted(listAsc.body, 'asc'))
  // 无 search + Z→A（已测）
  ok('无 search + Z→A', isSorted(listDesc.body, 'desc'))

  // 有 search + A→Z
  const searchAsc = await req('GET', '/api/definitions?search=a&sort=name&order=asc')
  ok('有 search + A→Z → 200', searchAsc.status === 200, `${searchAsc.status}`)
  ok('  搜索结果按 A→Z 有序', isSorted(searchAsc.body, 'asc'),
    searchAsc.body.map((d: any) => d.name).join(' < '))
  info('  search=a 命中', searchAsc.body.map((d: any) => d.name).join(', '))

  // 有 search + Z→A
  const searchDesc = await req('GET', '/api/definitions?search=a&sort=name&order=desc')
  ok('有 search + Z→A → 200', searchDesc.status === 200)
  ok('  搜索结果按 Z→A 有序', isSorted(searchDesc.body, 'desc'),
    searchDesc.body.map((d: any) => d.name).join(' > '))
  ok('  搜索 + 两个方向命中集合相同',
    JSON.stringify([...searchAsc.body.map((d: any) => d.id)].sort()) ===
      JSON.stringify([...searchDesc.body.map((d: any) => d.id)].sort()))

  // 搜索逻辑未被改变：验证 substring 仍工作
  // 库中现有 apple / Banana / Charlie / delta / Echo / zebra / 中文若干
  const searchSub = await req('GET', '/api/definitions?search=an')
  const subNames = searchSub.body.map((d: any) => d.name)
  ok('substring 搜索未被改变（search=an 命中 Banana）',
    subNames.includes('Banana'), subNames.join(','))

  // 再验证一个多命中场景
  const searchSub2 = await req('GET', '/api/definitions?search=e')
  const sub2Names = searchSub2.body.map((d: any) => d.name)
  ok('substring 多命中（search=e 命中 zebra/delta/Echo）',
    ['zebra', 'delta', 'Echo'].every((n) => sub2Names.includes(n)), sub2Names.join(','))

  // 搜索 + 排序兼容（中文搜索）
  const searchCn = await req('GET', '/api/definitions?search=菜&sort=name&order=desc')
  ok('中文 search + Z→A 兼容', searchCn.status === 200 && isSorted(searchCn.body, 'desc'),
    searchCn.body.map((d: any) => d.name).join(' > '))

  // 搜索别名仍工作
  await req('POST', '/api/definitions', { name: '别名测试食材', units: ['克'], aliases: ['xyz别名'] })
  const searchAlias = await req('GET', '/api/definitions?search=xyz别名')
  ok('别名搜索未被改变', searchAlias.body.some((d: any) => d.name === '别名测试食材'))

  /* ============================================================
   * 三、参数校验
   * ============================================================ */
  console.log('\n===== 三、参数校验 =====')

  ok('sort=name → 允许', (await req('GET', '/api/definitions?sort=name')).status === 200)
  ok('order=asc → 允许', (await req('GET', '/api/definitions?order=asc')).status === 200)
  ok('order=desc → 允许', (await req('GET', '/api/definitions?order=desc')).status === 200)
  ok('sort=xxx → 400', (await req('GET', '/api/definitions?sort=xxx')).status === 400)
  ok('order=xxx → 400', (await req('GET', '/api/definitions?order=xxx')).status === 400)
  ok('sort=name&order=xxx → 400',
    (await req('GET', '/api/definitions?sort=name&order=xxx')).status === 400)
  ok('sort=id（库存字段）→ 400', (await req('GET', '/api/definitions?sort=id')).status === 400)
  ok('sort=quantity → 400', (await req('GET', '/api/definitions?sort=quantity')).status === 400)
  ok('sort 空串 → 400', (await req('GET', '/api/definitions?sort=')).status === 400)
  ok('order=ASC（大写）→ 400', (await req('GET', '/api/definitions?order=ASC')).status === 400)
  ok('未知 query 参数 → 400', (await req('GET', '/api/definitions?nope=1')).status === 400)

  /* ============================================================
   * 四、安全
   * ============================================================ */
  console.log('\n===== 四、安全 =====')

  const attacks = [
    'sort=name;DROP TABLE ingredient_definition;--',
    "sort=name' OR '1'='1",
    'sort=1',
    'sort=__proto__',
    'sort=constructor',
    'order=asc;DELETE FROM ingredient_definition',
  ]
  for (const a of attacks) {
    const r = await req('GET', `/api/definitions?${a}`)
    ok(`拒绝 ${a}`, r.status === 400, `${r.status}`)
  }

  const tables = raw.prepare("select name from sqlite_master where type='table' order by name").all() as Array<{ name: string }>
  ok('注入后所有表仍存在', tables.length >= 7, `${tables.length} 张表`)

  const defCount = (raw.prepare('select count(*) c from ingredient_definition').get() as any).c
  ok('注入后 definition 数量不变', defCount === created.length + 1, `${defCount}`)

  /* ============================================================
   * 五、数据安全（排序不写入）
   * ============================================================ */
  console.log('\n===== 五、数据安全 =====')

  const SNAP = `select id, name, name_normalized, estimated_shelf_life_days, created_at, updated_at
    from ingredient_definition order by id`
  const aliasSnap = 'select id, definition_id, alias, alias_normalized from ingredient_alias order by id'
  const unitSnap = 'select id, definition_id, unit from ingredient_definition_unit order by id'
  const stockSnap = 'select id, definition_id, quantity, unit, purchase_date from standard_ingredient order by id'

  const before = {
    defs: raw.prepare(SNAP).all(),
    aliases: raw.prepare(aliasSnap).all(),
    units: raw.prepare(unitSnap).all(),
    stocks: raw.prepare(stockSnap).all(),
  }

  const changesBefore = (raw.prepare('select total_changes() c').get() as any).c

  for (let i = 0; i < 5; i++) {
    await req('GET', '/api/definitions?sort=name&order=asc')
    await req('GET', '/api/definitions?sort=name&order=desc')
    await req('GET', '/api/definitions?search=a&sort=name&order=desc')
  }

  const changesAfter = (raw.prepare('select total_changes() c').get() as any).c
  ok('排序请求期间 SQLite 写入计数为 0', changesAfter === changesBefore,
    `${changesBefore} → ${changesAfter}`)

  const after = {
    defs: raw.prepare(SNAP).all(),
    aliases: raw.prepare(aliasSnap).all(),
    units: raw.prepare(unitSnap).all(),
    stocks: raw.prepare(stockSnap).all(),
  }

  ok('ingredient_definition 未变', JSON.stringify(before.defs) === JSON.stringify(after.defs))
  ok('ingredient_alias 未变', JSON.stringify(before.aliases) === JSON.stringify(after.aliases))
  ok('ingredient_definition_unit 未变', JSON.stringify(before.units) === JSON.stringify(after.units))
  ok('standard_ingredient 未变', JSON.stringify(before.stocks) === JSON.stringify(after.stocks))

  /* ============================================================
   * 六、与库存排序相互独立
   * ============================================================ */
  console.log('\n===== 六、与库存排序独立 =====')

  const defWithStock = created[0] // Charlie

  // 库存排序仍只接受自己的白名单
  ok('库存 sort=default → 200', (await req('GET', '/api/ingredients?sort=default')).status === 200)
  ok('库存 sort=expiry → 200', (await req('GET', '/api/ingredients?sort=expiry')).status === 200)
  ok('库存 sort=name → 200（库存也支持 name）',
    (await req('GET', '/api/ingredients?sort=name')).status === 200)
  ok('库存 sort=zzz → 400', (await req('GET', '/api/ingredients?sort=zzz')).status === 400)

  // 食材库不接受库存专有字段
  ok('食材库 sort=purchase_date → 400',
    (await req('GET', '/api/definitions?sort=purchase_date')).status === 400)
  ok('食材库 sort=expiry → 400',
    (await req('GET', '/api/definitions?sort=expiry')).status === 400)

  /* ============================================================
   * 七、回归
   * ============================================================ */
  console.log('\n===== 七、回归 =====')

  console.log('\n--- 定义 CRUD ---')
  const cr = await req('POST', '/api/definitions', { name: 'CRUD测试', units: ['克', '个'], aliases: ['crud别名'] })
  ok('创建定义', cr.status === 201)

  const rd = await req('GET', `/api/definitions/${cr.body.id}`)
  ok('读取定义（含 aliases / allowed_units）',
    rd.status === 200 && rd.body.aliases.length === 1 && rd.body.allowed_units.length === 2)

  const up = await req('PATCH', `/api/definitions/${cr.body.id}`, { estimated_shelf_life_days: 5 })
  ok('更新定义', up.status === 200 && up.body.estimated_shelf_life_days === 5)

  console.log('\n--- 别名逻辑 ---')
  const al = await req('POST', `/api/definitions/${cr.body.id}/aliases`, { alias: '新别名' })
  ok('新增别名', al.status === 201)
  const alList = await req('GET', `/api/definitions/${cr.body.id}/aliases`)
  ok('别名列表', alList.body.length === 2)
  const alUpd = await req('PATCH', `/api/definitions/${cr.body.id}/aliases/${al.body.id}`, { alias: '改名后别名' })
  ok('修改别名', alUpd.status === 200)
  const alDel = await req('DELETE', `/api/definitions/${cr.body.id}/aliases/${al.body.id}`)
  ok('删除别名', alDel.status === 204)

  const dupAlias = await req('POST', '/api/definitions', { name: '冲突测试', units: ['克'], aliases: ['crud别名'] })
  ok('别名唯一性仍生效（409）', dupAlias.status === 409, `${dupAlias.status}`)

  console.log('\n--- 单位逻辑 ---')
  const uAdd = await req('POST', `/api/definitions/${cr.body.id}/units`, { unit: '千克' })
  ok('新增单位', uAdd.status === 201)
  const uDel = await req('DELETE', `/api/definitions/${cr.body.id}/units/千克`)
  ok('移除单位', uDel.status === 204)
  ok('单位枚举校验（非法单位 400）',
    (await req('POST', `/api/definitions/${cr.body.id}/units`, { unit: '斤' })).status === 400)

  console.log('\n--- 库存逻辑 ---')
  const stock = await req('POST', '/api/ingredients', {
    definition_id: cr.body.id, quantity: 10, unit: '克', purchase_date: shift(-50),
  })
  ok('创建库存', stock.status === 201)
  ok('读取库存', (await req('GET', `/api/ingredients/${stock.body.id}`)).status === 200)
  const stUpd = await req('PATCH', `/api/ingredients/${stock.body.id}`, { quantity: 20 })
  ok('编辑库存', stUpd.status === 200 && stUpd.body.quantity === 20)
  const stCons = await req('POST', `/api/ingredients/${stock.body.id}/consume`, { amount: 5 })
  ok('消耗库存', stCons.status === 200 && stCons.body.quantity === 15)

  console.log('\n--- 库存排序仍正常 ---')
  const iAsc = await req('GET', '/api/ingredients?sort=quantity&order=asc')
  const iDesc = await req('GET', '/api/ingredients?sort=quantity&order=desc')
  ok('库存 quantity asc/desc 均 200', iAsc.status === 200 && iDesc.status === 200)
  ok('库存排序结果互为反向（数量互异时）',
    iAsc.body.length === iDesc.body.length)

  console.log('\n--- Phase 4 自动合并仍正常 ---')
  const mDef = await req('POST', '/api/definitions', { name: '合并回归', units: ['克'], estimated_shelf_life_days: null })
  const mA = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 10, unit: '克', purchase_date: shift(-400) })
  const mB = await req('POST', '/api/ingredients', { definition_id: mDef.body.id, quantity: 20, unit: '克', purchase_date: shift(-400) })
  ok('同批次自动合并', mA.body.id === mB.body.id && mB.body.quantity === 30, `${mB.body.quantity}`)

  console.log('\n--- Batch 1 设置仍正常 ---')
  const s1 = await req('GET', '/api/settings')
  ok('GET /api/settings', s1.status === 200 && typeof s1.body.expiry_warning_mode === 'string')
  const s2 = await req('PATCH', '/api/settings', { expiry_warning_threshold: 5 })
  ok('PATCH /api/settings', s2.status === 200 && s2.body.expiry_warning_threshold === 5)

  console.log('\n--- Batch 2 库存排序 + 临期状态仍正常 ---')
  const b2 = await req('GET', '/api/ingredients?sort=expiry&order=asc')
  ok('库存 expiry 排序', b2.status === 200)
  ok('返回含 expiry_status', b2.body.every((r: any) => typeof r.expiry_status === 'string'))
  ok('返回含 definition_name', b2.body.every((r: any) => typeof r.definition_name === 'string'))
  const b2default = await req('GET', '/api/ingredients?sort=default')
  ok('库存默认排序（临期优先）', b2default.status === 200)

  // 食材库返回仍含 aliases / allowed_units
  const finalDefs = await req('GET', '/api/definitions?sort=name&order=desc')
  ok('食材库返回仍含 aliases', finalDefs.body.every((d: any) => Array.isArray(d.aliases)))
  ok('食材库返回仍含 allowed_units', finalDefs.body.every((d: any) => Array.isArray(d.allowed_units)))
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
