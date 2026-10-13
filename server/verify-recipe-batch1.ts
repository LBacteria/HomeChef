/**
 * v0.2.0 Phase 3 批次 1 验证：菜谱数据模型 + 只读 API
 *
 * 覆盖：
 *   1. migration 可从现有版本增量应用到临时库（含 0007_recipe）
 *   2. 四张新表及其外键、约束符合设计
 *   3. 空列表
 *   4. 列表及食材数量
 *   5. 详情及食材顺序
 *   6. 关联 Tag 数据正确
 *   7. 无效 ID 与不存在的菜谱返回正确错误
 *   8. **同一菜谱可以重复关联同一种食材**（未加错唯一约束）
 *   9. 数据约束（单位枚举、数量非负、名称唯一、Tag 唯一）
 *
 * ⚠️ 使用独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 63000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `recipe-b1-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* ---------- 建库：按顺序执行全部 migration ---------- */
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

/* ---------- 准备：执行 seed，产生真实的食材定义 ---------- */
section('准备：执行 seed')

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
const createdMatch = seedOut.match(/新建\s*：(\d+)/)
info('seed 新建数量', createdMatch?.[1] ?? '未解析')
ok('seed 执行完成', seedOut.includes('seed 执行完成'))

const defCount = (raw.prepare('select count(*) c from ingredient_definition').get() as any).c
ok('seed 后有 229 个食材定义', defCount === 229, `${defCount}`)

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

/* ============================================================
 * 一、Migration 与表结构（直接查临时库）
 * ============================================================ */
section('一、Migration 与表结构')

// ⚠️ 不写死 migration 数量：数量会随版本增长，「= N」必然过时。
//    改验证：① 必要 migration 存在 ② 菜谱 migration 已登记 ③ 已实际执行成功
const REQUIRED_MIGRATIONS = [
  '0000_calm_ronan',
  '0001_ingredient_definition_model',
  '0002_definition_id_autoincrement',
  '0003_seed_infrastructure',
  '0004_app_settings',
  '0005_category',
  '0006_category_color',
]
const missingMigrations = REQUIRED_MIGRATIONS.filter(
  (tag) => !migrationFiles.some((m) => m.startsWith(tag)),
)
ok('必要 migration 文件全部存在（0000~0006）', missingMigrations.length === 0,
  missingMigrations.length ? `缺失: ${missingMigrations.join(', ')}` : `${REQUIRED_MIGRATIONS.length} 个齐备`)

ok('含 0007_recipe.sql', migrationFiles.some((f) => f.startsWith('0007')),
  migrationFiles.filter((f) => f.startsWith('0007')).join(',') || '未找到')

// 菜谱 migration 必须在 journal 中登记（否则不会被 migrate 执行）
const journal = JSON.parse(
  readFileSync(resolve(drizzleDir, 'meta', '_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> }
const recipeEntry = journal.entries.find((e) => e.tag === '0007_recipe')
ok('0007_recipe 已在 _journal.json 登记', recipeEntry !== undefined,
  recipeEntry ? `idx=${recipeEntry.idx}` : '未登记')
ok('  登记 idx = 7', recipeEntry?.idx === 7, `${recipeEntry?.idx}`)
ok('  journal 条目数与 .sql 文件数一致',
  journal.entries.length === migrationFiles.length,
  `${journal.entries.length} vs ${migrationFiles.length}`)

// 实际执行成功的证据：migration 建出的表**确实存在**。
// ⚠️ 不用 __drizzle_migrations 表验证 —— 本脚本为了隔离性，
//    是直接按顺序执行 .sql 文件建库的，该记录表由 drizzle-kit migrate 维护，
//    此处不存在。真正有意义的契约是"表被建出来了"。
const appliedTables = (raw
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
  .all() as Array<{ name: string }>).map((t) => t.name)
info('已建出的表', appliedTables.join(', '))

const EXPECTED_MIGRATION_TABLES = [
  'ingredient_definition',
  'ingredient_alias',
  'ingredient_definition_unit',
  'standard_ingredient',
  'app_settings',
  'category',
  'recipe',
  'recipe_ingredient',
  'recipe_tag',
  'recipe_tag_link',
]
const missingTables = EXPECTED_MIGRATION_TABLES.filter((t) => !appliedTables.includes(t))
ok('全部 migration 已实际执行（各 migration 建出的表均存在）',
  missingTables.length === 0,
  missingTables.length ? `缺失: ${missingTables.join(', ')}` : `${EXPECTED_MIGRATION_TABLES.length} 张表齐备`)

const tables = (raw
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all() as Array<{ name: string }>).map((t) => t.name)

info('全部表', tables.join(', '))
for (const t of ['recipe', 'recipe_ingredient', 'recipe_tag', 'recipe_tag_link']) {
  ok(`表 ${t} 已创建`, tables.includes(t))
}

// 既有表未被破坏
for (const t of ['ingredient_definition', 'standard_ingredient', 'category', 'app_settings']) {
  ok(`既有表 ${t} 仍存在`, tables.includes(t))
}

/* ---------- recipe 列 ---------- */
const recipeCols = (raw.prepare('pragma table_info(recipe)').all() as any[]).map((c) => c.name)
info('recipe 列', recipeCols.join(', '))
ok('recipe 含必要列',
  ['id', 'name', 'name_normalized', 'note', 'created_at', 'updated_at'].every((c) => recipeCols.includes(c)))

/* ---------- recipe_ingredient 列 ---------- */
const riCols = (raw.prepare('pragma table_info(recipe_ingredient)').all() as any[])
info('recipe_ingredient 列', riCols.map((c) => `${c.name}(${c.type}${c.notnull ? ',NOT NULL' : ''})`).join(', '))
ok('recipe_ingredient 含必要列',
  ['id', 'recipe_id', 'definition_id', 'quantity', 'unit', 'note', 'sort_order'].every((c) => riCols.some((x) => x.name === c)))

// ⚠️ 关键：quantity / unit / note 必须可空
for (const col of ['quantity', 'unit', 'note']) {
  const c = riCols.find((x) => x.name === col)
  ok(`recipe_ingredient.${col} 允许为空`, c !== undefined && c.notnull === 0, `notnull=${c?.notnull}`)
}

/* ---------- 外键行为 ---------- */
const riFks = raw.prepare('pragma foreign_key_list(recipe_ingredient)').all() as any[]
info('recipe_ingredient 外键', riFks.map((f) => `${f.from}→${f.table}.${f.to} on_delete=${f.on_delete}`).join('; '))
const fkRecipe = riFks.find((f) => f.from === 'recipe_id')
const fkDef = riFks.find((f) => f.from === 'definition_id')
// ⚠️ SQLite 的 pragma 返回**大写** on_delete（'CASCADE' / 'RESTRICT'），故统一转小写比较
ok('recipe_id 外键 CASCADE',
  fkRecipe?.table === 'recipe' && String(fkRecipe?.on_delete).toLowerCase() === 'cascade',
  `${fkRecipe?.table}/${fkRecipe?.on_delete}`)
ok('definition_id 外键 RESTRICT',
  fkDef?.table === 'ingredient_definition' && String(fkDef?.on_delete).toLowerCase() === 'restrict',
  `${fkDef?.table}/${fkDef?.on_delete}`)

const linkFks = raw.prepare('pragma foreign_key_list(recipe_tag_link)').all() as any[]
info('recipe_tag_link 外键', linkFks.map((f) => `${f.from}→${f.table}.${f.to} on_delete=${f.on_delete}`).join('; '))
ok('recipe_tag_link 两个外键都是 CASCADE',
  linkFks.length === 2 && linkFks.every((f) => String(f.on_delete).toLowerCase() === 'cascade'))

/* ---------- 索引 ---------- */
const idxNames = (raw
  .prepare("select name from sqlite_master where type='index' and tbl_name in ('recipe','recipe_ingredient','recipe_tag','recipe_tag_link')")
  .all() as Array<{ name: string }>).map((i) => i.name)
info('菜谱相关索引', idxNames.join(', '))
ok('recipe 名称唯一索引存在', idxNames.includes('recipe_name_normalized_unique'))
ok('recipe_tag 名称唯一索引存在', idxNames.includes('recipe_tag_name_normalized_unique'))
ok('recipe_tag_link 唯一索引存在', idxNames.includes('recipe_tag_link_unique'))

/* ============================================================
 * 二、★ 关键：允许重复关联同一食材
 * ============================================================ */
section('二、允许重复关联同一食材（关键）')

const riIndexes = (raw
  .prepare("select name, sql from sqlite_master where type='index' and tbl_name='recipe_ingredient'")
  .all() as Array<{ name: string; sql: string | null }>)

info('recipe_ingredient 索引', riIndexes.map((i) => i.name).join(', '))
const uniqueOnPair = riIndexes.filter(
  (i) => i.sql && /unique/i.test(i.sql) && /recipe_id/i.test(i.sql) && /definition_id/i.test(i.sql),
)
ok('★ recipe_ingredient 上没有 UNIQUE(recipe_id, definition_id)', uniqueOnPair.length === 0,
  uniqueOnPair.map((i) => i.name).join(',') || '无')

// 表级约束里也没有
const riTableSql = (raw
  .prepare("select sql from sqlite_master where type='table' and name='recipe_ingredient'")
  .get() as any)?.sql ?? ''
ok('★ 建表 SQL 中没有 UNIQUE(recipe_id, definition_id)',
  !/unique\s*\([^)]*recipe_id[^)]*definition_id/i.test(riTableSql))

try {
  await fetch(`${BASE}/health`)
  console.log(`  [FAIL] 端口 ${PORT} 已占用`); fail++
} catch { /* 未占用，继续 */ }

// 绝对超时：服务**提前退出**或超过 30s 未就绪都会抛错，绝不无限等待
let ready = false
try {
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })
  ready = true
} catch (e) {
  console.log('  [FAIL] 服务未就绪：' + (e instanceof Error ? e.message : String(e)))
  if (e instanceof ServerStartupError && e.detail.length > 0) console.log(e.detail)
  fail++
}

try {
if (ready) {
  info('服务地址', BASE)

  /* ============================================================
   * 三、只读 API —— 空列表
   * ============================================================ */
  section('三、只读 API：空列表')

  const empty = await req('GET', '/api/recipes')
  ok('GET /api/recipes → 200', empty.status === 200, `${empty.status}`)
  ok('  空库返回空数组', Array.isArray(empty.body) && empty.body.length === 0, `${JSON.stringify(empty.body)}`)

  const emptyTags = await req('GET', '/api/tags')
  ok('GET /api/tags → 200', emptyTags.status === 200, `${emptyTags.status}`)
  ok('  空库返回空数组', Array.isArray(emptyTags.body) && emptyTags.body.length === 0)

  /* ============================================================
   * 四、无效 ID 与不存在
   * ============================================================ */
  section('四、错误处理')

  ok('GET /api/recipes/abc → 400', (await req('GET', '/api/recipes/abc')).status === 400)
  ok('GET /api/recipes/0 → 400', (await req('GET', '/api/recipes/0')).status === 400)
  ok('GET /api/recipes/-1 → 400', (await req('GET', '/api/recipes/-1')).status === 400)
  const nf = await req('GET', '/api/recipes/999999')
  ok('GET /api/recipes/999999 → 404', nf.status === 404, `${nf.status}`)
  ok('★ 返回 RECIPE_NOT_FOUND（而非 INGREDIENT_NOT_FOUND）',
    nf.body?.error?.code === 'RECIPE_NOT_FOUND', `${nf.body?.error?.code}`)
  ok('  错误信息含"菜谱"', typeof nf.body?.error?.message === 'string' && nf.body.error.message.includes('菜谱'),
    `${nf.body?.error?.message}`)

  // ★ 原有食材错误处理未被破坏：不存在的食材定义仍返回 INGREDIENT_NOT_FOUND
  const ingNf = await req('GET', '/api/ingredients/999999')
  ok('★ 原有食材 404 仍为 INGREDIENT_NOT_FOUND（未被新错误码影响）',
    ingNf.status === 404 && ingNf.body?.error?.code === 'INGREDIENT_NOT_FOUND',
    `${ingNf.status}/${ingNf.body?.error?.code}`)

  // 原有分类 404 也应保持不变
  const catNf = await req('GET', '/api/categories')
  ok('原有分类接口仍正常（未受影响）', catNf.status === 200, `${catNf.status}`)
  ok('GET /api/recipes?unknown=1 → 400（拒绝未知参数）',
    (await req('GET', '/api/recipes?unknown=1')).status === 400)
  ok('GET /api/tags?unknown=1 → 400',
    (await req('GET', '/api/tags?unknown=1')).status === 400)

  /* ============================================================
   * 五、列表、详情、食材顺序、Tag
   * ============================================================ */
  section('五、列表 / 详情 / 顺序 / Tag')

  // 直接写库构造数据（批次 1 无写入 API）
  const now = new Date().toISOString()

  // 取两个真实食材定义
  const defs = raw.prepare('select id, name from ingredient_definition order by id limit 3').all() as Array<{ id: number; name: string }>
  ok('临时库中有食材定义（需先 seed）', defs.length >= 2, `${defs.length} 个`)
  info('使用的食材', defs.map((d) => `${d.id}:${d.name}`).join(', '))

  if (defs.length >= 2) {
    const [d1, d2] = defs

    // 菜谱 1：含**重复关联** d1 两次（验证允许）+ d2 一次，顺序刻意打乱
    const r1 = raw.prepare(
      'insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)',
    ).run('番茄炒蛋', '番茄炒蛋', '家常菜', now, now)
    const r1id = Number(r1.lastInsertRowid)

    raw.prepare(
      'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    ).run(r1id, d1.id, 2, '个', null, 0, now, now)
    raw.prepare(
      'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    ).run(r1id, d2.id, null, null, '适量', 1, now, now)
    // ★ 重复关联 d1
    raw.prepare(
      'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    ).run(r1id, d1.id, 1, '个', '额外', 2, now, now)

    // Tag
    raw.prepare('insert into recipe_tag (name, name_normalized, created_at) values (?,?,?)').run('家常菜', '家常菜', now)
    raw.prepare('insert into recipe_tag (name, name_normalized, created_at) values (?,?,?)').run('快手', '快手', now)
    const tag1 = raw.prepare("select id from recipe_tag where name_normalized='家常菜'").get() as any
    const tag2 = raw.prepare("select id from recipe_tag where name_normalized='快手'").get() as any
    raw.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(r1id, tag1.id, now)
    raw.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(r1id, tag2.id, now)

    // 菜谱 2：无 Tag、单食材（验证可以没有 Tag）
    const r2 = raw.prepare(
      'insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)',
    ).run('白灼菜心', '白灼菜心', null, now, now)
    const r2id = Number(r2.lastInsertRowid)
    raw.prepare(
      'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    ).run(r2id, d2.id, 300, '克', null, 0, now, now)

    /* ---------- 列表 ---------- */
    const list = await req('GET', '/api/recipes')
    ok('GET /api/recipes → 200', list.status === 200, `${list.status}`)
    ok('  返回 2 条', list.body.length === 2, `${list.body.length}`)

    const item1 = list.body.find((r: any) => r.id === r1id)
    const item2 = list.body.find((r: any) => r.id === r2id)
    ok('  含菜谱 1', item1 !== undefined)
    ok('★ 菜谱 1 的 ingredient_count = 3（含重复关联）', item1?.ingredient_count === 3, `${item1?.ingredient_count}`)
    ok('  菜谱 1 的 note 正确', item1?.note === '家常菜', `${item1?.note}`)
    ok('  菜谱 1 的 tags 有 2 个', item1?.tags?.length === 2, `${JSON.stringify(item1?.tags)}`)
    ok('  菜谱 1 的 tags 内容正确',
      JSON.stringify(item1?.tags) === JSON.stringify(['家常菜', '快手']), JSON.stringify(item1?.tags))
    ok('★ 菜谱 2 无 Tag（允许）', Array.isArray(item2?.tags) && item2.tags.length === 0, JSON.stringify(item2?.tags))
    ok('  菜谱 2 的 note 为 null', item2?.note === null, `${item2?.note}`)
    ok('  菜谱 2 的 ingredient_count = 1', item2?.ingredient_count === 1, `${item2?.ingredient_count}`)

    /* ---------- 详情 ---------- */
    const detail = await req('GET', `/api/recipes/${r1id}`)
    ok('GET /api/recipes/:id → 200', detail.status === 200, `${detail.status}`)
    ok('  含 ingredients 数组', Array.isArray(detail.body.ingredients))
    ok('★ 返回 3 条食材（重复关联都在）', detail.body.ingredients.length === 3, `${detail.body.ingredients.length}`)

    const ings = detail.body.ingredients as any[]
    info('食材顺序', ings.map((i) => `${i.sort_order}:${i.definition_name}`).join(' → '))
    ok('★ 按 sort_order 升序返回',
      JSON.stringify(ings.map((i) => i.sort_order)) === JSON.stringify([0, 1, 2]),
      JSON.stringify(ings.map((i) => i.sort_order)))
    ok('★ 前两条是同一 definition_id（重复关联）',
      ings[0].definition_id === ings[2].definition_id,
      `${ings[0].definition_id} vs ${ings[2].definition_id}`)
    ok('  食材名来自定义表', ings[0].definition_name === d1.name, `${ings[0].definition_name}`)
    ok('  第 2 条 quantity 为 null', ings[1].quantity === null, `${ings[1].quantity}`)
    ok('  第 2 条 unit 为 null', ings[1].unit === null, `${ings[1].unit}`)
    ok('  第 2 条 note 正确', ings[1].note === '适量', `${ings[1].note}`)
    ok('  第 1 条 quantity = 2', ings[0].quantity === 2, `${ings[0].quantity}`)
    ok('  第 1 条 unit 正确', ings[0].unit === '个', `${ings[0].unit}`)
    ok('  详情含 tags', JSON.stringify(detail.body.tags) === JSON.stringify(['家常菜', '快手']),
      JSON.stringify(detail.body.tags))

    /* ---------- Tag 列表 ---------- */
    const tags = await req('GET', '/api/tags')
    ok('GET /api/tags → 200', tags.status === 200, `${tags.status}`)
    ok('  返回 2 个 Tag', tags.body.length === 2, `${tags.body.length}`)
    ok('  Tag 名称正确',
      JSON.stringify(tags.body.map((t: any) => t.name)) === JSON.stringify(['家常菜', '快手']),
      JSON.stringify(tags.body.map((t: any) => t.name)))

    /* ---------- 无 Tag 的菜谱详情 ---------- */
    const detail2 = await req('GET', `/api/recipes/${r2id}`)
    ok('无 Tag 菜谱详情 → 200', detail2.status === 200)
    ok('  tags 为空数组', Array.isArray(detail2.body.tags) && detail2.body.tags.length === 0)

    /* ============================================================
     * 六、数据约束（直接写库验证）
     * ============================================================ */
    section('六、数据约束')

    // 名称唯一
    let dupNameRejected = false
    try {
      raw.prepare('insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)')
        .run('番茄炒蛋', '番茄炒蛋', null, now, now)
    } catch { dupNameRejected = true }
    ok('★ 菜谱名称重复被拒绝', dupNameRejected)

    // Tag 名称唯一
    let dupTagRejected = false
    try {
      raw.prepare('insert into recipe_tag (name, name_normalized, created_at) values (?,?,?)')
        .run('快手', '快手', now)
    } catch { dupTagRejected = true }
    ok('★ Tag 名称重复被拒绝', dupTagRejected)

    // 单位枚举 CHECK
    let badUnitRejected = false
    try {
      raw.prepare('insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)')
        .run(r1id, d1.id, 1, '勺', null, 9, now, now)
    } catch { badUnitRejected = true }
    ok('★ 非法单位「勺」被 CHECK 拒绝（未改单位枚举）', badUnitRejected)

    // 合法单位通过
    let goodUnitAccepted = false
    try {
      raw.prepare('insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)')
        .run(r1id, d1.id, 1, '克', null, 10, now, now)
      goodUnitAccepted = true
    } catch { /* */ }
    ok('合法单位「克」可以写入', goodUnitAccepted)

    // 负数数量 CHECK
    let negRejected = false
    try {
      raw.prepare('insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)')
        .run(r1id, d1.id, -1, '个', null, 11, now, now)
    } catch { negRejected = true }
    ok('★ 负数数量被 CHECK 拒绝', negRejected)

    // ★ 重复关联同一食材（house 允许）
    let dupPairAccepted = false
    try {
      raw.prepare('insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)')
        .run(r1id, d1.id, 5, '个', '第三次重复', 12, now, now)
      dupPairAccepted = true
    } catch { /* */ }
    ok('★★ 同一菜谱重复关联同一食材**成功**（证明未加错约束）', dupPairAccepted)

    // recipe_tag_link 唯一
    let dupLinkRejected = false
    try {
      raw.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(r1id, tag1.id, now)
    } catch { dupLinkRejected = true }
    ok('同一菜谱重复挂同一 Tag 被拒绝', dupLinkRejected)

    // 外键 RESTRICT：被菜谱引用的定义不能删
    let restrictWorks = false
    try {
      raw.prepare('delete from ingredient_definition where id = ?').run(d1.id)
    } catch { restrictWorks = true }
    ok('★ 被菜谱引用的食材定义无法删除（RESTRICT）', restrictWorks)

    // 外键 CASCADE：删菜谱清关联
    const beforeIng = (raw.prepare('select count(*) c from recipe_ingredient where recipe_id = ?').get(r2id) as any).c
    raw.prepare('delete from recipe where id = ?').run(r2id)
    const afterIng = (raw.prepare('select count(*) c from recipe_ingredient where recipe_id = ?').get(r2id) as any).c
    ok('删除菜谱级联清理食材关联', beforeIng > 0 && afterIng === 0, `${beforeIng} → ${afterIng}`)

    const tagStillThere = raw.prepare('select count(*) c from recipe_tag').get() as any
    ok('★ 删除菜谱**不会**删除 Tag', tagStillThere.c === 2, `${tagStillThere.c}`)
  }
}

/* ============================================================
 * 七、完整性
 * ============================================================ */
section('七、数据库完整性')

const integrity = (raw.prepare('PRAGMA integrity_check').get() as any).integrity_check
const fkCheck = raw.prepare('PRAGMA foreign_key_check').all()
info('integrity_check', integrity)
info('foreign_key_check 违规数', String(fkCheck.length))
ok('integrity_check = ok', integrity === 'ok')
ok('外键无违规', fkCheck.length === 0)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
}

raw.close()

console.log(`\n===== 批次 1 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
