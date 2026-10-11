/**
 * v0.2.0 Phase 3 批次 2 验证：菜谱 CRUD + 统一保存 + Tag CRUD + HAS_RECIPE
 *
 * 覆盖：
 *   A. 结构：迁移与表
 *   B. 菜谱新增 / 详情 / 编辑 / 删除 / 不存在 ID
 *   C. 名称校验：空、重复、首尾空格判重、大小写判重
 *   D. 食材约束：至少一条、重复关联、独立字段与顺序、不存在的定义、非法单位、负数
 *   E. Tag：新建、复用、同菜谱不重复关联、删除保留菜谱、不存在 ID
 *   F. 统一保存：成功、三部分一起提交
 *   G. 事务回滚：食材失败 / Tag 失败 / 基本信息失败 → 整体回滚
 *   H. HAS_RECIPE 删除保护 + 现有 HAS_STOCK 规则
 *   I. 集成：删除菜谱保留定义与 Tag
 *
 * ⚠️ 使用独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

// ⚠️ 端口必须 < 65536。65000 + [0, 500) 最坏 65499，安全。
//    （曾误写成 65000 + [0, 4000)，最大 68999 会触发 ERR_SOCKET_BAD_PORT）
const PORT = 65000 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `recipe-b2-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* ---------- 建库 ---------- */
const drizzleDir = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrationFiles) {
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
const section = (t: string) => console.log(`\n===== ${t} =====`)

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

/* ---------- seed ---------- */
section('准备：seed')
const seedOut = await new Promise<string>((res) => {
  const p = spawn('npx', ['tsx', 'seed/seed.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, HOME_CHEF_DB_PATH: dbPath },
    shell: true,
  })
  let out = ''
  p.stdout?.on('data', (d) => { out += String(d) })
  p.stderr?.on('data', (d) => { out += String(d) })
  p.on('close', () => res(out))
})
ok('seed 执行完成', seedOut.includes('seed 执行完成'))

const defs = raw.prepare('select id, name from ingredient_definition order by id limit 5').all() as Array<{ id: number; name: string }>
ok('有足够食材定义', defs.length >= 3, `${defs.length}`)

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
  // 保留输出以便启动失败时诊断（而不是 stdio: 'ignore' 什么都看不到）
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})
let serverLog = ''
proc.stdout?.on('data', (d) => { serverLog += String(d) })
proc.stderr?.on('data', (d) => { serverLog += String(d) })

async function waitFor(url: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (proc.exitCode !== null) return false // 进程已退出，不必再等
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

if (!(await waitFor(`${BASE}/health`))) {
  console.log('  [FAIL] 服务未就绪')
  console.log(`  端口=${PORT} 进程退出码=${proc.exitCode}`)
  console.log('  --- 服务输出（最后 2000 字符）---')
  console.log('  ' + serverLog.slice(-2000).replace(/\n/g, '\n  '))
  fail++
} else {
  info('服务地址', BASE)
  const [d1, d2, d3] = defs
  info('测试用食材', defs.map((d) => `${d.id}:${d.name}`).join(', '))

  /* ============================================================
   * A. 结构
   * ============================================================ */
  section('A. 结构')
  const tables = (raw.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as any[]).map((t) => t.name)
  ok('四张菜谱表存在', ['recipe', 'recipe_ingredient', 'recipe_tag', 'recipe_tag_link'].every((t) => tables.includes(t)))
  ok('既有表未被破坏', ['ingredient_definition', 'standard_ingredient', 'category', 'app_settings'].every((t) => tables.includes(t)))

  /* ============================================================
   * B. 菜谱 CRUD
   * ============================================================ */
  section('B. 菜谱 CRUD')

  const created = await req('POST', '/api/recipes', {
    name: '番茄炒蛋',
    note: '家常菜',
    ingredients: [{ definition_id: d1.id, quantity: 2, unit: '个' }],
    tags: ['家常菜'],
  })
  ok('POST /api/recipes → 201', created.status === 201, `${created.status}`)
  ok('  返回详情含 id', typeof created.body?.id === 'number', `${created.body?.id}`)
  ok('  返回食材', Array.isArray(created.body?.ingredients) && created.body.ingredients.length === 1)
  ok('  返回 Tag', JSON.stringify(created.body?.tags) === JSON.stringify(['家常菜']), JSON.stringify(created.body?.tags))
  const rid = created.body.id

  const detail = await req('GET', `/api/recipes/${rid}`)
  ok('GET 详情 → 200', detail.status === 200)
  ok('  备注正确', detail.body.note === '家常菜', `${detail.body.note}`)

  // 编辑（统一保存）
  const edited = await req('PATCH', `/api/recipes/${rid}/full`, {
    name: '番茄炒蛋（改良）',
    note: '少油',
    ingredients: [
      { definition_id: d1.id, quantity: 3, unit: '个' },
      { definition_id: d2.id, quantity: null, unit: null, note: '适量' },
    ],
    tags: ['家常菜', '快手'],
  })
  ok('PATCH /:id/full → 200', edited.status === 200, `${edited.status}`)
  ok('  名称已更新', edited.body.name === '番茄炒蛋（改良）', `${edited.body.name}`)
  ok('  备注已更新', edited.body.note === '少油', `${edited.body.note}`)
  ok('  食材变为 2 条', edited.body.ingredients.length === 2, `${edited.body.ingredients.length}`)
  ok('  Tag 变为 2 个', edited.body.tags.length === 2, JSON.stringify(edited.body.tags))

  // 不存在 ID
  ok('GET 不存在 → 404', (await req('GET', '/api/recipes/999999')).status === 404)
  ok('  ★ 错误码 RECIPE_NOT_FOUND', (await req('GET', '/api/recipes/999999')).body?.error?.code === 'RECIPE_NOT_FOUND')
  ok('PATCH 不存在 → 404', (await req('PATCH', '/api/recipes/999999/full', {
    name: 'x', ingredients: [{ definition_id: d1.id }],
  })).status === 404)
  ok('DELETE 不存在 → 404', (await req('DELETE', '/api/recipes/999999')).status === 404)
  ok('非法 ID → 400', (await req('GET', '/api/recipes/abc')).status === 400)

  /* ============================================================
   * C. 名称校验
   * ============================================================ */
  section('C. 名称校验')

  ok('名称为空 → 400', (await req('POST', '/api/recipes', {
    name: '', ingredients: [{ definition_id: d1.id }],
  })).status === 400)
  ok('名称纯空白 → 400', (await req('POST', '/api/recipes', {
    name: '   ', ingredients: [{ definition_id: d1.id }],
  })).status === 400)

  const dup = await req('POST', '/api/recipes', {
    name: '番茄炒蛋（改良）', ingredients: [{ definition_id: d1.id }],
  })
  ok('★ 同名重复 → 409', dup.status === 409, `${dup.status}`)
  ok('  错误码 DUPLICATE_NAME', dup.body?.error?.code === 'DUPLICATE_NAME', `${dup.body?.error?.code}`)

  const dupSpace = await req('POST', '/api/recipes', {
    name: '  番茄炒蛋（改良）  ', ingredients: [{ definition_id: d1.id }],
  })
  ok('★★ 首尾空格判重 → 409', dupSpace.status === 409, `${dupSpace.status}`)

  const dupCase = await req('POST', '/api/recipes', {
    name: 'AbC菜谱', ingredients: [{ definition_id: d1.id }],
  })
  ok('创建 AbC菜谱 → 201', dupCase.status === 201, `${dupCase.status}`)
  const dupCase2 = await req('POST', '/api/recipes', {
    name: 'abc菜谱', ingredients: [{ definition_id: d1.id }],
  })
  ok('★★ 大小写判重 → 409', dupCase2.status === 409, `${dupCase2.status}`)

  // 编辑成他人名称
  const conflictEdit = await req('PATCH', `/api/recipes/${rid}/full`, {
    name: 'AbC菜谱', ingredients: [{ definition_id: d1.id }],
  })
  ok('编辑成已存在名称 → 409', conflictEdit.status === 409, `${conflictEdit.status}`)

  // 编辑保持自己名称应成功
  const selfEdit = await req('PATCH', `/api/recipes/${rid}/full`, {
    name: '番茄炒蛋（改良）', ingredients: [{ definition_id: d1.id }],
  })
  ok('★ 编辑保持自己名称 → 200（不应与自己冲突）', selfEdit.status === 200, `${selfEdit.status}`)

  /* ============================================================
   * D. 食材约束
   * ============================================================ */
  section('D. 食材约束')

  ok('食材为空数组 → 400', (await req('POST', '/api/recipes', {
    name: '空食材菜', ingredients: [],
  })).status === 400)
  ok('缺少 ingredients 字段 → 400', (await req('POST', '/api/recipes', { name: '无食材' })).status === 400)

  ok('不存在的 definition_id → 400', (await req('POST', '/api/recipes', {
    name: '坏食材菜', ingredients: [{ definition_id: 999999 }],
  })).status === 400)

  const badUnit = await req('POST', '/api/recipes', {
    name: '坏单位菜', ingredients: [{ definition_id: d1.id, quantity: 1, unit: '勺' }],
  })
  ok('★ 非法单位「勺」→ 400', badUnit.status === 400, `${badUnit.status}`)
  ok('  错误信息含单位提示',
    typeof badUnit.body?.error?.message === 'string' && badUnit.body.error.message.includes('单位'),
    `${badUnit.body?.error?.message}`)

  ok('负数数量 → 400', (await req('POST', '/api/recipes', {
    name: '负数菜', ingredients: [{ definition_id: d1.id, quantity: -5 }],
  })).status === 400)

  // ★ 重复关联同一食材：允许，且各字段独立
  const dupIng = await req('POST', '/api/recipes', {
    name: '重复食材菜',
    ingredients: [
      { definition_id: d1.id, quantity: 2, unit: '个', note: '第一次' },
      { definition_id: d1.id, quantity: 500, unit: '克', note: '第二次' },
      { definition_id: d1.id, quantity: null, unit: null, note: '第三次' },
    ],
  })
  ok('★★ 重复关联同一食材 → 201（允许）', dupIng.status === 201, `${dupIng.status}`)
  ok('  返回 3 条食材记录', dupIng.body?.ingredients?.length === 3, `${dupIng.body?.ingredients?.length}`)

  const dupIngs = dupIng.body.ingredients as any[]
  ok('  三者 definition_id 相同', dupIngs.every((i) => i.definition_id === d1.id))
  ok('★ 各条数量独立', dupIngs[0].quantity === 2 && dupIngs[1].quantity === 500 && dupIngs[2].quantity === null,
    dupIngs.map((i) => i.quantity).join(','))
  ok('★ 各条单位独立', dupIngs[0].unit === '个' && dupIngs[1].unit === '克' && dupIngs[2].unit === null,
    dupIngs.map((i) => i.unit).join(','))
  ok('★ 各条备注独立', dupIngs[0].note === '第一次' && dupIngs[1].note === '第二次' && dupIngs[2].note === '第三次',
    dupIngs.map((i) => i.note).join(','))
  ok('★★ 顺序 = 添加顺序', JSON.stringify(dupIngs.map((i) => i.sort_order)) === JSON.stringify([0, 1, 2]),
    JSON.stringify(dupIngs.map((i) => i.sort_order)))
  const dupRid = dupIng.body.id

  /* ============================================================
   * E. Tag
   * ============================================================ */
  section('E. Tag')

  const t1 = await req('POST', '/api/tags', { name: '川菜' })
  ok('POST /api/tags → 201', t1.status === 201, `${t1.status}`)
  ok('  返回 id', typeof t1.body?.id === 'number', `${t1.body?.id}`)

  const t1dup = await req('POST', '/api/tags', { name: '川菜' })
  ok('★ Tag 同名重复 → 409', t1dup.status === 409, `${t1dup.status}`)
  const t1dupCase = await req('POST', '/api/tags', { name: '川菜' })
  ok('  重复创建错误码 DUPLICATE_NAME', t1dupCase.body?.error?.code === 'DUPLICATE_NAME')

  ok('Tag 名称为空 → 400', (await req('POST', '/api/tags', { name: '' })).status === 400)
  ok('Tag 名称纯空白 → 400', (await req('POST', '/api/tags', { name: '  ' })).status === 400)

  // 复用已有 Tag（不新建）
  const beforeTagCount = (raw.prepare('select count(*) c from recipe_tag').get() as any).c
  const reuse = await req('POST', '/api/recipes', {
    name: '复用Tag菜',
    ingredients: [{ definition_id: d2.id }],
    tags: ['川菜'],
  })
  ok('★ 复用已有 Tag 创建菜谱 → 201', reuse.status === 201, `${reuse.status}`)
  const afterTagCount = (raw.prepare('select count(*) c from recipe_tag').get() as any).c
  ok('★★ 复用不新建 Tag（数量不变）', beforeTagCount === afterTagCount, `${beforeTagCount} → ${afterTagCount}`)
  ok('  菜谱正确关联该 Tag', JSON.stringify(reuse.body?.tags) === JSON.stringify(['川菜']), JSON.stringify(reuse.body?.tags))

  // 同一请求内重复 Tag 名称应去重
  const dupTagInReq = await req('POST', '/api/recipes', {
    name: '重复Tag菜',
    ingredients: [{ definition_id: d2.id }],
    tags: ['川菜', '川菜', ' 川菜 '],
  })
  ok('同一请求内重复 Tag 名称 → 201（去重）', dupTagInReq.status === 201, `${dupTagInReq.status}`)
  ok('★ 最终只关联 1 个 Tag', dupTagInReq.body?.tags?.length === 1, JSON.stringify(dupTagInReq.body?.tags))

  // 删除 Tag：保留菜谱
  const tagIdToDelete = t1.body.id
  const delTag = await req('DELETE', `/api/tags/${tagIdToDelete}`)
  ok('DELETE /api/tags/:id → 204', delTag.status === 204, `${delTag.status}`)
  ok('DELETE 不存在 Tag → 404', (await req('DELETE', '/api/tags/999999')).status === 404)
  ok('  ★ 错误码 TAG_NOT_FOUND', (await req('DELETE', '/api/tags/999999')).body?.error?.code === 'TAG_NOT_FOUND')

  const reuseAfter = await req('GET', `/api/recipes/${reuse.body.id}`)
  ok('★★ 删除 Tag 后菜谱仍存在 → 200', reuseAfter.status === 200, `${reuseAfter.status}`)
  ok('★ 菜谱的 Tag 关联已清理', reuseAfter.body.tags.length === 0, JSON.stringify(reuseAfter.body.tags))
  ok('★ 菜谱食材未被影响', reuseAfter.body.ingredients.length === 1, `${reuseAfter.body.ingredients.length}`)

  /* ============================================================
   * F. 统一保存：三部分一致提交
   * ============================================================ */
  section('F. 统一保存一致性')

  const fullSave = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: '统一保存菜',
    note: '整单保存',
    ingredients: [
      { definition_id: d1.id, quantity: 1, unit: '个' },
      { definition_id: d2.id, quantity: 2, unit: '克' },
    ],
    tags: ['新标签A', '新标签B'],
  })
  ok('统一保存 → 200', fullSave.status === 200, `${fullSave.status}`)
  ok('  基本信息已提交', fullSave.body.name === '统一保存菜' && fullSave.body.note === '整单保存')
  ok('  食材已提交（2 条）', fullSave.body.ingredients.length === 2, `${fullSave.body.ingredients.length}`)
  ok('  Tag 已提交（2 个）', fullSave.body.tags.length === 2, JSON.stringify(fullSave.body.tags))

  const r = (await req('GET', `/api/recipes/${dupRid}`)).body
  ok('  重新读取一致：名称', r.name === '统一保存菜')
  ok('  重新读取一致：食材顺序',
    JSON.stringify(r.ingredients.map((i: any) => i.definition_id)) === JSON.stringify([d1.id, d2.id]),
    JSON.stringify(r.ingredients.map((i: any) => i.definition_id)))
  ok('  重新读取一致：Tag 集合',
    JSON.stringify([...r.tags].sort()) === JSON.stringify(['新标签A', '新标签B'].sort()), JSON.stringify(r.tags))

  const dbIngCount = (raw.prepare('select count(*) c from recipe_ingredient where recipe_id=?').get(dupRid) as any).c
  ok('  数据库中食材行数 = 2（旧的已清理）', dbIngCount === 2, `${dbIngCount}`)

  /* ============================================================
   * G. 事务回滚
   * ============================================================ */
  section('G. 事务回滚（关键）')

  // 先建立基线状态
  const before = (await req('GET', `/api/recipes/${dupRid}`)).body
  info('回滚前基线', `name=${before.name} ingredients=${before.ingredients.length} tags=${JSON.stringify(before.tags)}`)

  // G1. 食材中途失败（第 2 条定义不存在）
  const g1 = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: '不该保存的名称',
    note: '不该保存的备注',
    ingredients: [
      { definition_id: d1.id, quantity: 9, unit: '个' },
      { definition_id: 999999, quantity: 1, unit: '个' },
    ],
    tags: ['不该保存的Tag'],
  })
  ok('G1 食材无效 → 400', g1.status === 400, `${g1.status}`)
  const afterG1 = (await req('GET', `/api/recipes/${dupRid}`)).body
  ok('★★ 回滚：名称未变', afterG1.name === before.name, `${afterG1.name}`)
  ok('★★ 回滚：备注未变', afterG1.note === before.note, `${afterG1.note}`)
  ok('★★ 回滚：食材未变（仍 2 条且值相同）',
    JSON.stringify(afterG1.ingredients.map((i: any) => [i.definition_id, i.quantity, i.unit])) ===
    JSON.stringify(before.ingredients.map((i: any) => [i.definition_id, i.quantity, i.unit])),
    JSON.stringify(afterG1.ingredients.map((i: any) => [i.definition_id, i.quantity])))
  ok('★★ 回滚：Tag 未变', JSON.stringify(afterG1.tags) === JSON.stringify(before.tags), JSON.stringify(afterG1.tags))
  const tagLeak = raw.prepare("select count(*) c from recipe_tag where name_normalized='不该保存的tag'").get() as any
  ok('★★ 回滚：未留下未使用的 Tag', tagLeak.c === 0, `${tagLeak.c}`)

  // G2. Tag 关联写入失败（tags 不是字符串数组）
  const g2 = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: '另一个不该保存的名称',
    ingredients: [{ definition_id: d1.id, quantity: 7, unit: '个' }],
    tags: [123],
  })
  ok('G2 tags 类型非法 → 400', g2.status === 400, `${g2.status}`)
  const afterG2 = (await req('GET', `/api/recipes/${dupRid}`)).body
  ok('★★ 回滚：名称仍未变', afterG2.name === before.name, `${afterG2.name}`)
  ok('★★ 回滚：食材仍未变', afterG2.ingredients.length === before.ingredients.length, `${afterG2.ingredients.length}`)

  // G3. 数量非法（-1）
  const g3 = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: '负数量不该保存',
    ingredients: [{ definition_id: d1.id, quantity: -1 }],
  })
  ok('G3 负数数量 → 400', g3.status === 400, `${g3.status}`)
  const afterG3 = (await req('GET', `/api/recipes/${dupRid}`)).body
  ok('★★ 回滚：名称仍未变', afterG3.name === before.name, `${afterG3.name}`)

  // G4. 名称重复（与其他菜谱冲突）
  const g4 = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: before.name === 'AbC菜谱' ? '统一保存菜' : 'AbC菜谱',
    ingredients: [{ definition_id: d1.id }],
  })
  ok('G4 名称冲突 → 409', g4.status === 409, `${g4.status}`)
  const afterG4 = (await req('GET', `/api/recipes/${dupRid}`)).body
  ok('★★ 回滚：名称与食材均未变',
    afterG4.name === before.name && afterG4.ingredients.length === before.ingredients.length,
    `${afterG4.name} / ${afterG4.ingredients.length}`)

  // G5. 非法单位（服务层校验，发生在事务外）
  const g5 = await req('PATCH', `/api/recipes/${dupRid}/full`, {
    name: '坏单位不该保存',
    ingredients: [{ definition_id: d1.id, unit: '勺' }],
  })
  ok('G5 非法单位 → 400', g5.status === 400, `${g5.status}`)
  ok('★★ 回滚：名称仍未变', (await req('GET', `/api/recipes/${dupRid}`)).body.name === before.name)

  /* ============================================================
   * H. HAS_RECIPE 删除保护
   * ============================================================ */
  section('H. HAS_RECIPE 删除保护')

  const refCount = (raw.prepare('select count(*) c from recipe_ingredient where definition_id=?').get(d1.id) as any).c
  info(`食材 ${d1.name}(id=${d1.id}) 被引用次数`, String(refCount))
  ok('前置：该食材确被菜谱引用', refCount > 0, `${refCount}`)

  const delDef = await req('DELETE', `/api/definitions/${d1.id}`)
  ok('★ 删除被菜谱引用的食材定义 → 409', delDef.status === 409, `${delDef.status}`)
  ok('★★ 错误码 HAS_RECIPE', delDef.body?.error?.code === 'HAS_RECIPE', `${delDef.body?.error?.code}`)
  ok('  错误信息含「菜谱」',
    typeof delDef.body?.error?.message === 'string' && delDef.body.error.message.includes('菜谱'),
    `${delDef.body?.error?.message}`)

  const defStill = raw.prepare('select count(*) c from ingredient_definition where id=?').get(d1.id) as any
  ok('★ 定义确实仍在（未被破坏）', defStill.c === 1, `${defStill.c}`)

  // HAS_STOCK 优先级：有库存时仍返回 HAS_STOCK
  const freeDef = raw.prepare(
    'select id from ingredient_definition where id not in (select definition_id from recipe_ingredient) limit 1',
  ).get() as any
  if (freeDef) {
    raw.prepare('insert into standard_ingredient (definition_id, quantity, unit, purchase_date, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?)')
      .run(freeDef.id, 1, '个', '2026-10-11', '常温', new Date().toISOString(), new Date().toISOString())
    const delStock = await req('DELETE', `/api/definitions/${freeDef.id}`)
    ok('★ 有库存的定义删除 → 409', delStock.status === 409, `${delStock.status}`)
    ok('  ★ 错误码仍是 HAS_STOCK（未被 HAS_RECIPE 覆盖）',
      delStock.body?.error?.code === 'HAS_STOCK', `${delStock.body?.error?.code}`)
  }

  // 无引用无库存 → 可删除
  const trulyFree = raw.prepare(
    `select id from ingredient_definition
     where id not in (select definition_id from recipe_ingredient)
       and id not in (select definition_id from standard_ingredient)
     limit 1`,
  ).get() as any
  if (trulyFree) {
    const okDel = await req('DELETE', `/api/definitions/${trulyFree.id}`)
    ok('无引用无库存的定义可以删除 → 204', okDel.status === 204, `${okDel.status}`)
  }

  /* ============================================================
   * I. 删除菜谱：保留定义与 Tag
   * ============================================================ */
  section('I. 删除菜谱的边界')

  const defCountBefore = (raw.prepare('select count(*) c from ingredient_definition').get() as any).c
  const tagCountBefore = (raw.prepare('select count(*) c from recipe_tag').get() as any).c
  const linkBefore = (raw.prepare('select count(*) c from recipe_tag_link where recipe_id=?').get(dupRid) as any).c
  const ingBefore = (raw.prepare('select count(*) c from recipe_ingredient where recipe_id=?').get(dupRid) as any).c
  info('删除前', `定义=${defCountBefore} Tag=${tagCountBefore} 该菜谱食材关联=${ingBefore} Tag关联=${linkBefore}`)

  const del = await req('DELETE', `/api/recipes/${dupRid}`)
  ok('DELETE /api/recipes/:id → 204', del.status === 204, `${del.status}`)
  ok('  再次 GET → 404', (await req('GET', `/api/recipes/${dupRid}`)).status === 404)

  const ingAfter = (raw.prepare('select count(*) c from recipe_ingredient where recipe_id=?').get(dupRid) as any).c
  const linkAfter = (raw.prepare('select count(*) c from recipe_tag_link where recipe_id=?').get(dupRid) as any).c
  ok('★ 食材关联已级联清理', ingAfter === 0, `${ingAfter}`)
  ok('★ Tag 关联已级联清理', linkAfter === 0, `${linkAfter}`)

  const defCountAfter = (raw.prepare('select count(*) c from ingredient_definition').get() as any).c
  const tagCountAfter = (raw.prepare('select count(*) c from recipe_tag').get() as any).c
  ok('★★ 食材定义未被删除', defCountAfter === defCountBefore, `${defCountBefore} → ${defCountAfter}`)
  ok('★★ Tag 未被删除', tagCountAfter === tagCountBefore, `${tagCountBefore} → ${tagCountAfter}`)

  /* ============================================================
   * J. 输入校验边界
   * ============================================================ */
  section('J. 输入校验边界')

  ok('未知 body 字段被拒绝 → 400', (await req('POST', '/api/recipes', {
    name: '多余字段菜', ingredients: [{ definition_id: d1.id }], 未知字段: 1,
  })).status === 400)
  ok('食材未知字段被拒绝 → 400', (await req('POST', '/api/recipes', {
    name: '多余食材字段', ingredients: [{ definition_id: d1.id, 未知: 1 }],
  })).status === 400)
  ok('GET /api/recipes?unknown=1 → 400', (await req('GET', '/api/recipes?unknown=1')).status === 400)
  ok('unit 为空字符串 → 视为 null（201）', (await req('POST', '/api/recipes', {
    name: '空单位菜', ingredients: [{ definition_id: d1.id, unit: '' }],
  })).status === 201)
  ok('食材 note 可为 null', (await req('POST', '/api/recipes', {
    name: '空备注菜', ingredients: [{ definition_id: d1.id, note: null }],
  })).status === 201)
}

/* ============================================================
 * 完整性
 * ============================================================ */
section('数据库完整性')
const integrity = (raw.prepare('PRAGMA integrity_check').get() as any).integrity_check
const fkViolations = raw.prepare('PRAGMA foreign_key_check').all()
info('integrity_check', integrity)
info('foreign_key_check 违规数', String(fkViolations.length))
ok('integrity_check = ok', integrity === 'ok')
ok('外键无违规', fkViolations.length === 0)

proc.kill()
raw.close()
await new Promise((r) => setTimeout(r, 500))

console.log(`\n===== 批次 2 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
