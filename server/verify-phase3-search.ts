/**
 * v0.1.1 Phase 3 验证：食材选择搜索
 *
 * 覆盖 Case 1-8。
 * 前端无测试框架，这里用真实 HTTP 请求验证前端所依赖的 API 契约，
 * 并直接验证选择器所用的搜索语义。
 *
 * 使用独立临时库与高位端口，不触碰正式库。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

// 动态端口：避免与上一次运行残留的 server 冲突
// （若端口被旧实例占用，测试会静默连到旧库，导致误判）
const PORT = 27000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `v011-p3-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

// 建表
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

// 预检端口必须空闲：否则会连到旧实例的旧数据库并产生误判
try {
  await fetch(`${BASE}/health`)
  console.log(`[FAIL] 端口 ${PORT} 已被占用（存在残留进程），测试会误判`)
  process.exit(1)
} catch {
  /* 连接失败 = 端口空闲，正确 */
}

if (!(await waitFor(`${BASE}/health`))) {
  console.log('[FAIL] 服务未就绪')
  proc.kill()
  process.exit(1)
}
console.log(`server ${BASE}\n`)

try {
  /* ---------- 准备数据 ---------- */
  console.log('===== 准备 =====')
  const tomato = await req('POST', '/api/definitions', {
    name: '番茄', units: ['个', '克', '千克'], aliases: ['西红柿', '番茄子'], estimated_shelf_life_days: 7,
  })
  const ketchup = await req('POST', '/api/definitions', {
    name: '番茄酱', units: ['瓶', '克'], aliases: ['番茄沙司'],
  })
  const sweetpotato = await req('POST', '/api/definitions', {
    name: '番薯', units: ['个', '克'], aliases: [],
  })
  const potato = await req('POST', '/api/definitions', {
    name: '土豆', units: ['个', '克', '千克'], aliases: ['马铃薯'],
  })
  ok('准备 4 个定义', tomato.status === 201 && ketchup.status === 201 && sweetpotato.status === 201 && potato.status === 201)
  const tomatoId = tomato.body.id
  console.log(`  番茄 id=${tomatoId}  番茄酱 id=${ketchup.body.id}  番薯 id=${sweetpotato.body.id}  土豆 id=${potato.body.id}`)

  /* ---------- Case 1：空搜索 ---------- */
  console.log('\n===== Case 1：空搜索 =====')
  const empty = await req('GET', '/api/definitions')
  ok('空搜索返回全部', empty.status === 200 && empty.body.length === 4, `${empty.body.length} 条`)
  ok('每条含 aliases', empty.body.every((d: any) => Array.isArray(d.aliases)))
  ok('每条含 allowed_units', empty.body.every((d: any) => Array.isArray(d.allowed_units)))
  ok('每条含 id（保存用）', empty.body.every((d: any) => typeof d.id === 'number'))

  /* ---------- Case 2：默认名称搜索 ---------- */
  console.log('\n===== Case 2：默认名称搜索「番茄」=====')
  const s2 = await req('GET', '/api/definitions?search=番茄')
  ok('命中番茄', s2.body.some((d: any) => d.name === '番茄' && d.id === tomatoId))
  const t2 = s2.body.find((d: any) => d.id === tomatoId)
  ok('番茄带 aliases', t2.aliases.map((a: any) => a.alias).sort().join(',') === '番茄子,西红柿', t2.aliases.map((a: any) => a.alias).join(','))
  ok('番茄带 allowed_units', t2.allowed_units.length === 3)
  ok('返回的是 definition id', t2.id === tomatoId)

  /* ---------- Case 3：alias 搜索 ---------- */
  console.log('\n===== Case 3：alias 搜索「西红柿」=====')
  const s3 = await req('GET', '/api/definitions?search=西红柿')
  ok('通过 alias 找到番茄', s3.body.length === 1 && s3.body[0].id === tomatoId, `${s3.body.length} 条`)
  ok('返回同一个 definition id', s3.body[0].id === tomatoId, `${s3.body[0]?.id} == ${tomatoId}`)
  ok('返回的是默认名称番茄', s3.body[0].name === '番茄')

  // alias 不会作为独立条目出现
  ok('alias 未变成独立结果', s3.body.filter((d: any) => d.name === '西红柿').length === 0)

  /* ---------- Case 4：substring ---------- */
  console.log('\n===== Case 4：substring 搜索「番」=====')
  const s4 = await req('GET', '/api/definitions?search=番')
  const names4 = s4.body.map((d: any) => d.name).sort()
  ok('返回多个匹配', s4.body.length >= 3, `${s4.body.length} 条: ${names4.join(',')}`)
  ok('含番茄', names4.includes('番茄'))
  ok('含番茄酱', names4.includes('番茄酱'))
  ok('含番薯', names4.includes('番薯'))
  ok('不含土豆', !names4.includes('土豆'))

  // 搜索别名子串
  const s4b = await req('GET', '/api/definitions?search=红')
  ok('别名子串「红」→ 命中番茄', s4b.body.some((d: any) => d.id === tomatoId))

  /* ---------- Case 5：无结果 ---------- */
  console.log('\n===== Case 5：无结果 =====')
  const beforeCount = (await req('GET', '/api/definitions')).body.length
  const s5 = await req('GET', '/api/definitions?search=不存在的食材xyz')
  ok('返回空数组', s5.status === 200 && Array.isArray(s5.body) && s5.body.length === 0, `${s5.body.length}`)
  const afterCount = (await req('GET', '/api/definitions')).body.length
  ok('未创建数据库记录', afterCount === beforeCount, `${beforeCount} → ${afterCount}`)

  /* ---------- Case 6：新增库存保存 definition_id ---------- */
  console.log('\n===== Case 6：新增库存 =====')
  const inv = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 3, unit: '个', purchase_date: '2026-10-05',
  })
  ok('创建成功', inv.status === 201, `${inv.status}`)
  ok('保存的是 definition_id', inv.body.definition_id === tomatoId, `${inv.body.definition_id}`)
  ok('响应不含 name（名称在 definition 上）', inv.body.name === undefined)

  const invId = inv.body.id
  const readBack = await req('GET', `/api/ingredients/${invId}`)
  ok('回读 definition_id 正确', readBack.body.definition_id === tomatoId)

  // 同定义多条
  const inv2 = await req('POST', '/api/ingredients', {
    definition_id: tomatoId, quantity: 1, unit: '千克', purchase_date: '2026-10-05',
  })
  ok('同定义可多条（1:N）', inv2.status === 201 && inv2.body.definition_id === tomatoId)

  /* ---------- Case 7：编辑库存 ---------- */
  console.log('\n===== Case 7：编辑库存 =====')
  const edit = await req('PATCH', `/api/ingredients/${invId}`, { quantity: 8, unit: '克' })
  ok('编辑数量/单位成功', edit.status === 200 && edit.body.quantity === 8 && edit.body.unit === '克')
  ok('definition_id 未被改动', edit.body.definition_id === tomatoId, `${edit.body.definition_id}`)

  // 后端不支持改 definition_id —— 这是与任务假设的差异，明确记录
  // 注意：Phase 3.1 起后端**已支持** definition_id，此处断言相应更新。
  const tryChange = await req('PATCH', `/api/ingredients/${invId}`, { definition_id: potato.body.id })
  console.log(`  尝试 PATCH definition_id → HTTP ${tryChange.status}`)
  if (tryChange.status === 200) {
    ok('Phase 3.1：后端支持更换 definition_id', tryChange.body.definition_id === potato.body.id,
      `实际 ${tryChange.body.definition_id}`)
    // 换回番茄，便于后续用例
    await req('PATCH', `/api/ingredients/${invId}`, { definition_id: tomatoId })
  } else {
    ok('后端拒绝 definition_id', tryChange.status === 400, `${tryChange.status}`)
  }

  /* ---------- Case 8：现有库存兼容 ---------- */
  console.log('\n===== Case 8：现有库存兼容 =====')
  const list = await req('GET', '/api/ingredients')
  ok('列表返回', list.status === 200 && list.body.length >= 2, `${list.body.length} 条`)

  const consume = await req('POST', `/api/ingredients/${invId}/consume`, { amount: 3 })
  ok('消耗正常', consume.status === 200 && consume.body.quantity === 5, `${consume.body.quantity}`)

  const over = await req('POST', `/api/ingredients/${invId}/consume`, { amount: 999 })
  ok('库存不足被拒绝', over.status === 409 && over.body.error.code === 'INSUFFICIENT_STOCK')

  const del = await req('DELETE', `/api/ingredients/${inv2.body.id}`)
  ok('删除正常', del.status === 204)
  ok('定义仍存在', (await req('GET', `/api/definitions/${tomatoId}`)).status === 200)

  // 定义删除保护
  const delDef = await req('DELETE', `/api/definitions/${tomatoId}`)
  ok('有库存时定义不可删', delDef.status === 409 && delDef.body.error.code === 'HAS_STOCK')

  /* ---------- 搜索边界 ---------- */
  console.log('\n===== 搜索边界 =====')
  const pct = await req('GET', '/api/definitions?search=%25')
  ok('LIKE 通配符 % 被转义（返回空）', pct.body.length === 0, `${pct.body.length}`)

  const underscore = await req('GET', '/api/definitions?search=_')
  ok('LIKE 通配符 _ 被转义（返回空）', underscore.body.length === 0, `${underscore.body.length}`)

  const caseTest = await req('GET', '/api/definitions?search=ABC')
  ok('不存在的输入返回空', caseTest.body.length === 0)

  const padded = await req('GET', '/api/definitions?search=%20番茄%20')
  ok('搜索词首尾空格被 trim', padded.body.some((d: any) => d.id === tomatoId))
} finally {
  proc.kill()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
