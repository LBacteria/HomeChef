/**
 * v0.1.4 第二批定向测试：统一保存端点
 *   PATCH /api/definitions/:id/full
 *
 * 覆盖用户要求的场景：
 *   1. 全部成功
 *   2. 名称交换（设为默认）
 *   3. 别名增删
 *   4. 单位增删
 *   5. 校验失败（重名 / 非法单位 / 跨类保护）
 *   6. **事务中途失败后整体回滚**（关键）
 *   7. 失败后重新提交（安全性）
 *
 * ⚠️ 独立临时库 + 动态端口，不访问真实数据库。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 59000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `v014-full-${Date.now()}.db`)

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

/** definition 的完整行快照（用于回滚比对） */
function defRow(id: number) {
  return raw.prepare('select * from ingredient_definition where id = ?').get(id)
}
function aliasesOf(id: number) {
  return raw.prepare('select alias from ingredient_alias where definition_id = ? order by alias').all(id).map((r: any) => r.alias)
}
function unitsOf(id: number) {
  return raw.prepare('select unit from ingredient_definition_unit where definition_id = ? order by unit').all(id).map((r: any) => r.unit)
}

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
  const cats = (await req('GET', '/api/categories')).body as any[]
  const VEG = cats.find((c) => c.name === '蔬菜').id
  const FRUIT = cats.find((c) => c.name === '水果').id
  const SEASONING = cats.find((c) => c.name === '调味品').id

  /* ============================================================
   * 1. 全部成功
   * ============================================================ */
  console.log('===== 1. 全部成功 =====')

  const d1 = await req('POST', '/api/definitions', {
    name: '统一保存A', units: ['个', '克'], aliases: ['别名甲', '别名乙'], category_id: VEG,
  })
  ok('创建定义 → 201', d1.status === 201, `${d1.status}`)

  const full1 = await req('PATCH', `/api/definitions/${d1.body.id}/full`, {
    name: '统一保存A改',
    estimated_shelf_life_days: 15,
    category_id: FRUIT,
    aliases: [{ id: null, alias: '别名甲' }, { id: null, alias: '别名丙' }],
    units: ['个', '千克'],
  })
  ok('统一保存 → 200', full1.status === 200, `${full1.status}`)
  ok('  名称已改', defRow(d1.body.id)?.name === '统一保存A改', `${defRow(d1.body.id)?.name}`)
  ok('  保质期已改', defRow(d1.body.id)?.estimated_shelf_life_days === 15)
  ok('  分类已改', defRow(d1.body.id)?.category_id === FRUIT)
  ok('  别名已同步（甲/丙）',
    JSON.stringify(aliasesOf(d1.body.id)) === JSON.stringify(['别名丙', '别名甲']),
    aliasesOf(d1.body.id).join(','))
  ok('  单位已同步（个/千克）',
    JSON.stringify(unitsOf(d1.body.id)) === JSON.stringify(['个', '千克']),
    unitsOf(d1.body.id).join(','))

  /* ============================================================
   * 2. 名称交换（设为默认）
   * ============================================================ */
  console.log('\n===== 2. 名称交换（设为默认）=====')

  const d2 = await req('POST', '/api/definitions', {
    name: '原名D2', units: ['个'], aliases: ['别名D2'], category_id: VEG,
  })
  const aliasRow = raw.prepare("select id from ingredient_alias where definition_id = ? and alias = '别名D2'").get(d2.body.id) as any
  ok('取得别名 id', aliasRow !== undefined, `${aliasRow?.id}`)

  // 模拟前端草稿：设为默认后，名称=别名D2，别名列表=[原名D2]
  const full2 = await req('PATCH', `/api/definitions/${d2.body.id}/full`, {
    aliases: [{ id: null, alias: '原名D2' }],
    set_default_alias_id: aliasRow.id,
  })
  ok('设为默认统一保存 → 200', full2.status === 200, `${full2.status}`)
  ok('  名称已交换为「别名D2」', defRow(d2.body.id)?.name === '别名D2', `${defRow(d2.body.id)?.name}`)
  ok('  原名称降级为别名', aliasesOf(d2.body.id).includes('原名D2'), aliasesOf(d2.body.id).join(','))
  ok('  被提升的别名已从别名列表移除', !aliasesOf(d2.body.id).includes('别名D2'))
  ok('  别名总数仍为 1', aliasesOf(d2.body.id).length === 1, `${aliasesOf(d2.body.id).length}`)

  /* ============================================================
   * 3. 别名增删
   * ============================================================ */
  console.log('\n===== 3. 别名增删 =====')

  const d3 = await req('POST', '/api/definitions', {
    name: '别名测试D3', units: ['个'], aliases: ['旧1', '旧2'], category_id: VEG,
  })
  ok('初始别名 2 个', aliasesOf(d3.body.id).length === 2)

  const full3 = await req('PATCH', `/api/definitions/${d3.body.id}/full`, {
    aliases: [{ id: null, alias: '新1' }, { id: null, alias: '新2' }, { id: null, alias: '新3' }],
  })
  ok('别名全量替换 → 200', full3.status === 200, `${full3.status}`)
  ok('  旧别名已删除', !aliasesOf(d3.body.id).includes('旧1') && !aliasesOf(d3.body.id).includes('旧2'))
  ok('  新别名已添加', ['新1', '新2', '新3'].every((a) => aliasesOf(d3.body.id).includes(a)),
    aliasesOf(d3.body.id).join(','))
  ok('  总数为 3', aliasesOf(d3.body.id).length === 3)

  ok('别名去重（重复提交同一文本）',
    (await req('PATCH', `/api/definitions/${d3.body.id}/full`, {
      aliases: [{ id: null, alias: '新1' }, { id: null, alias: '新1' }],
    })).status === 200 && aliasesOf(d3.body.id).length === 1,
    aliasesOf(d3.body.id).join(','))

  /* ============================================================
   * 4. 单位增删
   * ============================================================ */
  console.log('\n===== 4. 单位增删 =====')

  const d4 = await req('POST', '/api/definitions', {
    name: '单位测试D4', units: ['个'], category_id: VEG,
  })
  const full4 = await req('PATCH', `/api/definitions/${d4.body.id}/full`, {
    units: ['克', '千克'],
  })
  ok('单位全量替换 → 200', full4.status === 200, `${full4.status}`)
  ok('  单位已同步', JSON.stringify(unitsOf(d4.body.id)) === JSON.stringify(['克', '千克']),
    unitsOf(d4.body.id).join(','))

  /* ============================================================
   * 5. 校验失败
   * ============================================================ */
  console.log('\n===== 5. 校验失败 =====')

  const d5 = await req('POST', '/api/definitions', { name: '校验E1', units: ['个'], category_id: VEG })
  const d5b = await req('POST', '/api/definitions', { name: '校验E2', units: ['个'], category_id: VEG })

  const dupName = await req('PATCH', `/api/definitions/${d5.body.id}/full`, { name: '校验E2' })
  ok('名称重名 → 409', dupName.status === 409, `${dupName.status}`)
  ok('  错误码 DUPLICATE_NAME', dupName.body?.error?.code === 'DUPLICATE_NAME', dupName.body?.error?.code)

  const badUnit = await req('PATCH', `/api/definitions/${d5.body.id}/full`, { units: ['斤'] })
  ok('非法单位枚举 → 400', badUnit.status === 400, `${badUnit.status}`)

  const noUnit = await req('PATCH', `/api/definitions/${d5.body.id}/full`, { units: [] })
  ok('普通食材 0 单位 → 400', noUnit.status === 400, `${noUnit.status}`)

  ok('非法保质期 → 400',
    (await req('PATCH', `/api/definitions/${d5.body.id}/full`, { estimated_shelf_life_days: -1 })).status === 400)
  ok('未知字段 → 400',
    (await req('PATCH', `/api/definitions/${d5.body.id}/full`, { nope: 1 })).status === 400)
  ok('空 body → 400', (await req('PATCH', `/api/definitions/${d5.body.id}/full`, {})).status === 400)
  ok('不存在的定义 → 404',
    (await req('PATCH', '/api/definitions/999999/full', { name: 'x' })).status === 404)
  ok('不存在的分类 → 404',
    (await req('PATCH', `/api/definitions/${d5.body.id}/full`, { category_id: 999999 })).status === 404)

  /* ============================================================
   * 6. ★ 事务中途失败 → 整体回滚（关键测试）
   * ============================================================ */
  console.log('\n===== 6. 事务整体回滚（关键）=====')

  // 构造：定义有库存（阻止跨类）+ 同时提交名称/别名/单位改动
  // 期望：跨类校验失败 → 前面的别名/单位改动也必须回滚
  const d6 = await req('POST', '/api/definitions', {
    name: '回滚D6', units: ['个'], aliases: ['回滚别名'], category_id: VEG,
  })
  await req('POST', '/api/ingredients', {
    definition_id: d6.body.id, quantity: 5, unit: '个', purchase_date: '2026-10-01',
  })

  const before = {
    row: defRow(d6.body.id),
    aliases: aliasesOf(d6.body.id),
    units: unitsOf(d6.body.id),
  }
  info('回滚前', `name=${(before.row as any).name} aliases=${before.aliases.join(',')} units=${before.units.join(',')}`)

  // 一次性提交：改名 + 改别名 + 改单位 + 跨类（有库存 → 必须 409）
  const rollback = await req('PATCH', `/api/definitions/${d6.body.id}/full`, {
    name: '回滚D6改名',
    aliases: [{ id: null, alias: '全新的别名' }],
    units: ['克'],
    category_id: SEASONING,
  })
  ok('跨类（有库存）→ 409', rollback.status === 409, `${rollback.status}`)
  ok('  错误码 CATEGORY_TRANSITION_NOT_ALLOWED',
    rollback.body?.error?.code === 'CATEGORY_TRANSITION_NOT_ALLOWED', rollback.body?.error?.code)

  const after = {
    row: defRow(d6.body.id),
    aliases: aliasesOf(d6.body.id),
    units: unitsOf(d6.body.id),
  }
  ok('★ 名称未变（回滚）', (after.row as any).name === (before.row as any).name,
    `${(before.row as any).name} → ${(after.row as any).name}`)
  ok('★ 别名未变（回滚）', JSON.stringify(after.aliases) === JSON.stringify(before.aliases),
    after.aliases.join(','))
  ok('★ 单位未变（回滚）', JSON.stringify(after.units) === JSON.stringify(before.units),
    after.units.join(','))
  ok('★ 整个 definition 行逐字段未变',
    JSON.stringify(after.row) === JSON.stringify(before.row))

  // 另一个中途失败场景：别名唯一性冲突
  console.log('\n--- 中途失败：别名冲突也应整体回滚 ---')

  const d7 = await req('POST', '/api/definitions', {
    name: '回滚D7', units: ['个'], category_id: VEG,
  })
  await req('POST', '/api/definitions', { name: '占用者', units: ['个'], aliases: ['被占用的别名'], category_id: VEG })

  const before7 = {
    row: defRow(d7.body.id),
    units: unitsOf(d7.body.id),
  }

  const rollback7 = await req('PATCH', `/api/definitions/${d7.body.id}/full`, {
    name: '回滚D7改名',
    units: ['克', '千克'],
    aliases: [{ id: null, alias: '被占用的别名' }],
  })
  ok('别名被占用 → 409', rollback7.status === 409, `${rollback7.status}`)

  const after7 = {
    row: defRow(d7.body.id),
    units: unitsOf(d7.body.id),
  }
  ok('★ 名称未变（回滚）', (after7.row as any).name === (before7.row as any).name,
    `${(after7.row as any).name}`)
  ok('★ 单位未变（回滚）', JSON.stringify(after7.units) === JSON.stringify(before7.units),
    after7.units.join(','))
  ok('★ 别名未被添加', aliasesOf(d7.body.id).length === 0, `${aliasesOf(d7.body.id).length}`)

  // 单位在用 → 中途失败回滚
  console.log('\n--- 中途失败：移除在用单位也应整体回滚 ---')

  const d8 = await req('POST', '/api/definitions', { name: '回滚D8', units: ['个', '克'], category_id: VEG })
  await req('POST', '/api/ingredients', {
    definition_id: d8.body.id, quantity: 3, unit: '个', purchase_date: '2026-10-01',
  })
  const before8 = { row: defRow(d8.body.id), units: unitsOf(d8.body.id) }

  const rollback8 = await req('PATCH', `/api/definitions/${d8.body.id}/full`, {
    name: '回滚D8改名',
    units: ['克'],   // 移除「个」，但它有库存
  })
  ok('移除在用单位 → 409', rollback8.status === 409, `${rollback8.status}`)
  ok('  错误码 UNIT_IN_USE', rollback8.body?.error?.code === 'UNIT_IN_USE', rollback8.body?.error?.code)
  ok('★ 名称未变（回滚）', defRow(d8.body.id)?.name === (before8.row as any).name)
  ok('★ 单位未变（回滚）', JSON.stringify(unitsOf(d8.body.id)) === JSON.stringify(before8.units),
    unitsOf(d8.body.id).join(','))

  /* ============================================================
   * 7. 失败后重新提交（重试安全性）
   * ============================================================ */
  console.log('\n===== 7. 失败后重新提交 =====')

  // 承接 d6：修正跨类问题（改成同侧分类，且**不动单位草稿**，避免移除在用单位）
  const retry = await req('PATCH', `/api/definitions/${d6.body.id}/full`, {
    name: '回滚D6改名',
    aliases: [{ id: null, alias: '全新的别名' }],
    category_id: FRUIT,      // 同侧，允许
  })
  ok('修正后重新提交 → 200', retry.status === 200, `${retry.status}`)
  if (retry.status !== 200) {
    info('  重试失败详情', JSON.stringify(retry.body))
  }
  ok('  名称已生效', defRow(d6.body.id)?.name === '回滚D6改名', `${defRow(d6.body.id)?.name}`)
  ok('  别名已生效', aliasesOf(d6.body.id).includes('全新的别名'))
  ok('  单位保持原样（未被误改）', JSON.stringify(unitsOf(d6.body.id)) === JSON.stringify(['个']),
    unitsOf(d6.body.id).join(','))

  // 承接 d2：用**确实不存在**的 alias id 提交 → 应 404，且不破坏数据
  console.log('\n--- 用不存在的 alias id 重试（应友好失败，不破坏数据）---')
  const missingAliasId = 999999
  ok('该 alias id 确实不存在',
    raw.prepare('select id from ingredient_alias where id = ?').get(missingAliasId) === undefined)

  const beforeStale = {
    row: defRow(d2.body.id),
    aliases: aliasesOf(d2.body.id),
  }

  const staleRetry = await req('PATCH', `/api/definitions/${d2.body.id}/full`, {
    set_default_alias_id: missingAliasId,
  })
  ok('不存在的 alias id → 404', staleRetry.status === 404, `${staleRetry.status}`)
  ok('  名称未被破坏', defRow(d2.body.id)?.name === (beforeStale.row as any).name,
    `${(beforeStale.row as any).name} → ${defRow(d2.body.id)?.name}`)
  ok('  别名未被破坏',
    JSON.stringify(aliasesOf(d2.body.id)) === JSON.stringify(beforeStale.aliases),
    aliasesOf(d2.body.id).join(','))
  ok('  整个 definition 行未变',
    JSON.stringify(defRow(d2.body.id)) === JSON.stringify(beforeStale.row))

  // 无 set_default_alias_id 的普通重试应成功
  const okRetry = await req('PATCH', `/api/definitions/${d2.body.id}/full`, {
    aliases: [{ id: null, alias: '重试别名' }],
  })
  ok('去掉失效操作后重试 → 200', okRetry.status === 200, `${okRetry.status}`)
  ok('  数据正确', aliasesOf(d2.body.id).join(',') === '重试别名', aliasesOf(d2.body.id).join(','))

  /* ============================================================
   * 8. 旧端点未被破坏
   * ============================================================ */
  console.log('\n===== 8. 旧端点仍可用 =====')

  const d9 = await req('POST', '/api/definitions', { name: '旧端点D9', units: ['个'], category_id: VEG })
  ok('PATCH /api/definitions/:id（普通）→ 200',
    (await req('PATCH', `/api/definitions/${d9.body.id}`, { name: '旧端点D9改' })).status === 200)
  ok('POST 别名端点 → 201',
    (await req('POST', `/api/definitions/${d9.body.id}/aliases`, { alias: '旧别名' })).status === 201)
  ok('POST 单位端点 → 201',
    (await req('POST', `/api/definitions/${d9.body.id}/units`, { unit: '克' })).status === 201)
  ok('DELETE 单位端点 → 204',
    (await req('DELETE', `/api/definitions/${d9.body.id}/units/克`)).status === 204)
  ok('DELETE 别名端点 → 204',
    (await req('DELETE', `/api/definitions/${d9.body.id}/aliases/${(await req('GET', `/api/definitions/${d9.body.id}/aliases`)).body[0].id}`)).status === 204)
  ok('别名端点仍拒绝未知字段 → 400',
    (await req('POST', `/api/definitions/${d9.body.id}/aliases`, { alias: 'x', extra: 1 })).status === 400)
  ok('单位端点仍拒绝未知字段 → 400',
    (await req('POST', `/api/definitions/${d9.body.id}/units`, { unit: '克', extra: 1 })).status === 400)

  /* ============================================================
   * 9. 库存未受影响
   * ============================================================ */
  console.log('\n===== 9. 库存记录未被触碰 =====')

  const stockBefore = raw.prepare('select * from standard_ingredient order by id').all()
  await req('PATCH', `/api/definitions/${d6.body.id}/full`, {
    name: '库存隔离测试',
    aliases: [{ id: null, alias: 'x' }],
    units: ['克'],
  })
  const stockAfter = raw.prepare('select * from standard_ingredient order by id').all()
  ok('统一保存后库存表逐字段未变', JSON.stringify(stockBefore) === JSON.stringify(stockAfter))
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
  raw.close()
}

console.log(`\n===== 统一保存结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
