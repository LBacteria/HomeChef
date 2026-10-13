/**
 * v0.2.0 Phase 3 批次 3 验证：搜索 / Tag 筛选 / 排序 / 列表设置持久化
 *
 * 覆盖：
 *   A. migration 0008 与 schema
 *   B. 搜索（名称 / Tag / 大小写 / 空白 / 空词 / 无结果）
 *   C. Tag 筛选（单个 / AND / OR / 无选择 / 无效 / 重复 / 不重复出菜谱）
 *   D. 排序（三字段 × 方向 / 默认 / 次级排序）
 *   E. 组合（搜索 + 筛选 + 排序）
 *   F. 设置持久化（默认 / 修改 / 恢复 / 非法值 / 损坏 JSON / 旧数据）
 *   G. 不破坏批次 1/2 行为
 *
 * ⚠️ 独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import { startServer, waitForReady, ServerStartupError } from './harness/server-lifecycle.js'

const PORT = 65200 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`
// 临时库根目录：默认 server/data/（行为与改造前一致）；
// 设置 HOME_CHEF_TEST_DB_DIR 时改写到隔离目录，避免在受保护区内建库。
const dataRoot = resolve(
  process.env.HOME_CHEF_TEST_DB_DIR || resolve(process.cwd(), 'data'),
)
const dbPath = resolve(dataRoot, `recipe-b3-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrationFiles) {
  for (const st of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = st.trim(); if (t) setup.exec(t)
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

/* ---------- migration 检查（在 seed 之前做，保证是"空库升级"路径）---------- */
section('A. migration 0008 与 schema')

const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta', '_journal.json'), 'utf8')) as {
  entries: Array<{ idx: number; tag: string }>
}
ok('含 0008_recipe_list_settings', migrationFiles.some((f) => f.startsWith('0008')),
  migrationFiles.filter((f) => f.startsWith('0008')).join(','))
const e8 = journal.entries.find((e) => e.tag === '0008_recipe_list_settings')
ok('已在 journal 登记', e8 !== undefined, e8 ? `idx=${e8.idx}` : '未登记')
ok('  idx = 8', e8?.idx === 8, `${e8?.idx}`)
ok('  journal 条目数与 .sql 文件数一致',
  journal.entries.length === migrationFiles.length, `${journal.entries.length} vs ${migrationFiles.length}`)

const settingCols = (raw.prepare('pragma table_info(app_settings)').all() as any[]).map((c) => c.name)
info('app_settings 列', settingCols.join(', '))
for (const c of ['recipe_sort_field', 'recipe_sort_order', 'recipe_tag_mode', 'recipe_selected_tags']) {
  ok(`新增列 ${c}`, settingCols.includes(c))
}
// 4 个新列必须可空
for (const c of ['recipe_sort_field', 'recipe_sort_order', 'recipe_tag_mode', 'recipe_selected_tags']) {
  const col = (raw.prepare('pragma table_info(app_settings)').all() as any[]).find((x) => x.name === c)
  ok(`  ${c} 允许为 NULL`, col?.notnull === 0, `notnull=${col?.notnull}`)
}
// 既有列未被破坏
ok('既有列未被破坏',
  ['id', 'expiry_warning_mode', 'expiry_warning_threshold', 'allow_expired_for_recipe']
    .every((c) => settingCols.includes(c)))

/* ---------- 兼容性：模拟"旧库已有 app_settings 行"后升级 ---------- */
// 上面是空库全量执行。这里再验证：先只跑到 0007，插一行旧数据，再跑 0008。
{
  const legacyPath = resolve(dataRoot, `legacy-${Date.now()}.db`)
  for (const s of ['', '-shm', '-wal']) rmSync(`${legacyPath}${s}`, { force: true })
  const legacy = new Database(legacyPath)
  legacy.pragma('foreign_keys = ON')
  const upTo0007 = migrationFiles.filter((f) => !f.startsWith('0008'))
  for (const f of upTo0007) {
    for (const st of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
      const t = st.trim(); if (t) legacy.exec(t)
    }
  }
  // 写入一行"旧版设置"
  const ts = new Date().toISOString()
  legacy.prepare(
    'insert into app_settings (id, expiry_warning_mode, expiry_warning_threshold, allow_expired_for_recipe, created_at, updated_at) values (?,?,?,?,?,?)',
  ).run(1, 'percentage', 20, 1, ts, ts)
  info('旧库已写入临期设置', 'mode=percentage threshold=20 allow_expired=1')

  // 升级：执行 0008
  for (const f of migrationFiles.filter((x) => x.startsWith('0008'))) {
    for (const st of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
      const t = st.trim(); if (t) legacy.exec(t)
    }
  }
  const row = legacy.prepare('select * from app_settings where id = 1').get() as any
  ok('★ 旧库升级后数据保留：临期模式', row.expiry_warning_mode === 'percentage', `${row.expiry_warning_mode}`)
  ok('★ 旧库升级后数据保留：阈值', row.expiry_warning_threshold === 20, `${row.expiry_warning_threshold}`)
  ok('★ 旧库升级后数据保留：allow_expired', row.allow_expired_for_recipe === 1, `${row.allow_expired_for_recipe}`)
  ok('★ 新列为 NULL（未设置状态）',
    row.recipe_sort_field === null && row.recipe_sort_order === null &&
    row.recipe_tag_mode === null && row.recipe_selected_tags === null,
    `${row.recipe_sort_field}/${row.recipe_sort_order}/${row.recipe_tag_mode}/${row.recipe_selected_tags}`)
  legacy.close()
  for (const s of ['', '-shm', '-wal']) {
    try { rmSync(`${legacyPath}${s}`, { force: true }) } catch { /* */ }
  }
}

/* ---------- seed ---------- */
section('准备：seed')
await new Promise<void>((res) => {
  const p = spawn('npx', ['tsx', 'seed/seed.ts'], {
    cwd: process.cwd(), env: { ...process.env, HOME_CHEF_DB_PATH: dbPath }, shell: true, stdio: 'ignore',
  })
  p.on('close', () => res())
})
const defs = raw.prepare('select id from ingredient_definition order by id limit 3').all() as Array<{ id: number }>
ok('seed 完成', defs.length >= 3, `${defs.length}`)
const [d1, d2, d3] = defs

/* ---------- 启动服务 ---------- */
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
  // 保留输出以便启动失败时诊断（有上限，不会无限增长）
  stdio: 'pipe',
})
const j = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const t = await r.text(); let b: any
  try { b = t ? JSON.parse(t) : undefined } catch { b = undefined }
  return { status: r.status, body: b }
}
const listNames = (arr: any[]) => arr.map((x) => x.name)

// 绝对超时：服务**提前退出**或超过 30s 未就绪都会抛错，绝不无限等待
let ready = false
try {
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })
  ready = true
} catch (e) {
  console.log('  [FAIL] 服务未就绪：' + (e instanceof Error ? e.message : String(e)))
  if (e instanceof ServerStartupError && e.detail.length > 0) console.log(e.detail)
  console.log('  ' + (server.stderr() + server.output()).slice(-1500))
  fail++
}

try {
if (ready) {
  info('服务地址', BASE)

  /* ============================================================
   * 构造测试数据
   *   用 API 创建，确保走真实业务路径
   * ============================================================ */
  section('准备：构造测试菜谱')

  const mk = async (name: string, tags: string[] = [], def = d1.id) =>
    j('POST', '/api/recipes', { name, ingredients: [{ definition_id: def }], tags })

  const rTomato = await mk('番茄炒蛋', ['家常菜', '快手'])
  const rTomatoSoup = await mk('番茄蛋汤', ['家常菜', '汤品'])
  const rCucumber = await mk('凉拌黄瓜', ['快手', '凉菜'])
  const rBeef = await mk('黑椒牛肉', ['荤菜'])
  const rPlain = await mk('白灼菜心', [])

  ok('创建 5 个测试菜谱',
    [rTomato, rTomatoSoup, rCucumber, rBeef, rPlain].every((r) => r.status === 201),
    [rTomato, rTomatoSoup, rCucumber, rBeef, rPlain].map((r) => r.status).join(','))
  info('菜谱', [rTomato, rTomatoSoup, rCucumber, rBeef, rPlain].map((r) => r.body?.name).join(', '))

  /* ============================================================
   * B. 搜索
   * ============================================================ */
  section('B. 搜索')

  const s1 = await j('GET', '/api/recipes?search=番茄')
  ok('按名称搜索「番茄」→ 2 条', s1.status === 200 && s1.body.length === 2, `${s1.status}/${s1.body?.length}`)
  ok('  命中番茄炒蛋与番茄蛋汤',
    JSON.stringify(listNames(s1.body).sort()) === JSON.stringify(['番茄炒蛋', '番茄蛋汤'].sort()),
    JSON.stringify(listNames(s1.body)))

  // ⚠️ v0.2.0 产品决策变更：搜索**只匹配菜谱名称**，Tag 名称不再参与搜索。
  //    下面用「确实带该 Tag 的菜谱」做**反证**：
  //    不是数据不存在，而是搜索不匹配 Tag；同时证明 Tag 筛选功能未受影响。
  const s2 = await j('GET', '/api/recipes?search=快手')
  ok('★★ Tag 名称不参与搜索（「快手」是 Tag 名 → 0 条）',
    s2.status === 200 && s2.body.length === 0, `${s2.status}/${s2.body?.length}`)

  const s2b = await j('GET', '/api/recipes?tags=' + encodeURIComponent('快手'))
  ok('  反证：Tag 筛选「快手」仍命中 2 条（Tag 数据存在，筛选未受影响）',
    s2b.body.length === 2, `${s2b.body?.length}`)
  ok('  反证命中：凉拌黄瓜与番茄炒蛋',
    JSON.stringify(listNames(s2b.body).sort()) === JSON.stringify(['凉拌黄瓜', '番茄炒蛋'].sort()),
    JSON.stringify(listNames(s2b.body)))

  const s3 = await j('GET', '/api/recipes?search=汤品')
  ok('★★ Tag 名称不参与搜索（「汤品」是 Tag 名 → 0 条）',
    s3.status === 200 && s3.body.length === 0, `${s3.status}/${s3.body?.length}`)

  const s3b = await j('GET', '/api/recipes?tags=' + encodeURIComponent('汤品'))
  ok('  反证：Tag 筛选「汤品」仍命中 1 条',
    s3b.body.length === 1 && s3b.body[0]?.name === '番茄蛋汤',
    `${s3b.body?.length}/${s3b.body[0]?.name}`)

  const s4 = await j('GET', '/api/recipes?search=不存在的菜')
  ok('无匹配 → 空数组', s4.status === 200 && Array.isArray(s4.body) && s4.body.length === 0,
    `${s4.status}/${JSON.stringify(s4.body)}`)

  const s5 = await j('GET', '/api/recipes?search=')
  ok('★ 空搜索词 → 返回全部 5 条', s5.body.length === 5, `${s5.body?.length}`)

  const s6 = await j('GET', '/api/recipes?search=%20%20')
  ok('★ 纯空白搜索词 → 返回全部 5 条', s6.body.length === 5, `${s6.body?.length}`)

  const s7 = await j('GET', '/api/recipes?search=' + encodeURIComponent('  番茄  '))
  ok('★ 首尾空白被 trim → 2 条', s7.body.length === 2, `${s7.body?.length}`)

  // 大小写不敏感：用英文 Tag / 名称验证
  const rAbc = await mk('ABC 沙拉', ['Salad'])
  ok('创建含大写名称与 Tag 的菜谱 → 201', rAbc.status === 201, `${rAbc.status}`)
  const s8 = await j('GET', '/api/recipes?search=abc')
  ok('★★ 搜索大小写不敏感（abc 命中 ABC）', s8.body.length === 1, `${s8.body?.length}`)
  ok('  命中 ABC 沙拉', s8.body[0]?.name === 'ABC 沙拉', `${s8.body[0]?.name}`)
  const s9 = await j('GET', '/api/recipes?search=salad')
  ok('★★ Tag 名称不参与搜索（「Salad」是 Tag 名 → 0 条）',
    s9.status === 200 && s9.body.length === 0, `${s9.status}/${s9.body?.length}`)

  const s9b = await j('GET', '/api/recipes?tags=' + encodeURIComponent('Salad'))
  ok('  反证：Tag 筛选「Salad」仍命中 1 条',
    s9b.body.length === 1 && s9b.body[0]?.name === 'ABC 沙拉',
    `${s9b.body?.length}/${s9b.body[0]?.name}`)

  // SQL 注入尝试（应被参数化/转义处理，不报错、不返回异常结果）
  const s10 = await j('GET', '/api/recipes?search=' + encodeURIComponent("' OR 1=1 --"))
  ok('★ SQL 注入字符串 → 200 且无匹配（不报错）',
    s10.status === 200 && s10.body.length === 0, `${s10.status}/${s10.body?.length}`)
  const s11 = await j('GET', '/api/recipes?search=' + encodeURIComponent('%'))
  ok('★ 通配符 % 被当作普通字符（不匹配全部）',
    s11.status === 200 && s11.body.length === 0, `${s11.status}/${s11.body?.length}`)

  /* ============================================================
   * C. Tag 筛选
   * ============================================================ */
  section('C. Tag 筛选')

  const t1 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('家常菜'))
  ok('单个 Tag → 2 条', t1.status === 200 && t1.body.length === 2, `${t1.status}/${t1.body?.length}`)

  const t2 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('家常菜') + '&tags=' + encodeURIComponent('快手'))
  ok('★ AND：家常菜+快手 → 1 条（番茄炒蛋）',
    t2.body.length === 1 && t2.body[0].name === '番茄炒蛋',
    `${t2.body?.length}/${t2.body[0]?.name}`)

  const t3 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('家常菜') + '&tags=' + encodeURIComponent('快手') + '&tag_mode=or')
  ok('★ OR：家常菜|快手 → 3 条',
    t3.body.length === 3, `${t3.body?.length}`)
  ok('  OR 结果正确',
    JSON.stringify(listNames(t3.body).sort()) === JSON.stringify(['凉拌黄瓜', '番茄炒蛋', '番茄蛋汤'].sort()),
    JSON.stringify(listNames(t3.body)))

  const t4 = await j('GET', '/api/recipes')
  ok('★ 未选择 Tag → 不因 Tag 排除（返回全部 6 条）', t4.body.length === 6, `${t4.body?.length}`)

  const t5 = await j('GET', '/api/recipes?tags=')
  ok('空 tags 参数 → 返回全部 6 条', t5.body.length === 6, `${t5.body?.length}`)

  const t6 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('不存在的Tag'))
  ok('★ 无效 Tag 名称 → 空数组（不报错）',
    t6.status === 200 && t6.body.length === 0, `${t6.status}/${t6.body?.length}`)

  const t7 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('家常菜') + '&tags=' + encodeURIComponent('家常菜'))
  ok('★ 重复 Tag → 结果与单个一致（1 个不重复）',
    t7.body.length === 2, `${t7.body?.length}`)
  const ids7 = t7.body.map((r: any) => r.id)
  ok('★★ 不产生重复菜谱记录', new Set(ids7).size === ids7.length, `${ids7.length} vs ${new Set(ids7).size}`)

  const t8 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('家常菜,快手'))
  ok('逗号分隔写法也被支持', t8.body.length === 1, `${t8.body?.length}`)

  const t9 = await j('GET', '/api/recipes?tags=' + encodeURIComponent('快手') + '&tag_mode=or')
  ok('OR 模式单个 Tag → 与单个筛选一致', t9.body.length === 2, `${t9.body?.length}`)

  ok('非法 tag_mode → 400',
    (await j('GET', '/api/recipes?tag_mode=invalid')).status === 400)

  /* ============================================================
   * D. 排序
   * ============================================================ */
  section('D. 排序')

  const byUpdatedDesc = await j('GET', '/api/recipes')
  ok('默认排序 = updated_at desc', byUpdatedDesc.status === 200, `${byUpdatedDesc.status}`)
  const updDesc = byUpdatedDesc.body.map((r: any) => r.updated_at)
  ok('  确实按 updated_at 倒序',
    JSON.stringify(updDesc) === JSON.stringify([...updDesc].sort().reverse()), JSON.stringify(updDesc))

  const byUpdatedAsc = await j('GET', '/api/recipes?sort=updated_at&order=asc')
  const updAsc = byUpdatedAsc.body.map((r: any) => r.updated_at)
  ok('updated_at asc 正确',
    JSON.stringify(updAsc) === JSON.stringify([...updAsc].sort()), JSON.stringify(updAsc))

  const byCreatedDesc = await j('GET', '/api/recipes?sort=created_at&order=desc')
  const creDesc = byCreatedDesc.body.map((r: any) => r.created_at)
  ok('created_at desc 正确',
    JSON.stringify(creDesc) === JSON.stringify([...creDesc].sort().reverse()), JSON.stringify(creDesc))

  const byCreatedAsc = await j('GET', '/api/recipes?sort=created_at&order=asc')
  const creAsc = byCreatedAsc.body.map((r: any) => r.created_at)
  ok('created_at asc 正确',
    JSON.stringify(creAsc) === JSON.stringify([...creAsc].sort()), JSON.stringify(creAsc))

  const byNameAsc = await j('GET', '/api/recipes?sort=name&order=asc')
  const nmAsc = listNames(byNameAsc.body)
  info('name asc 结果', JSON.stringify(nmAsc))
  ok('name asc 正确（按名称升序）',
    JSON.stringify(nmAsc) === JSON.stringify([...nmAsc].sort()), JSON.stringify(nmAsc))

  const byNameDesc = await j('GET', '/api/recipes?sort=name&order=desc')
  const nmDesc = listNames(byNameDesc.body)
  ok('name desc 正确（按名称降序）',
    JSON.stringify(nmDesc) === JSON.stringify([...nmAsc].sort().reverse()), JSON.stringify(nmDesc))

  ok('非法排序字段 → 400',
    (await j('GET', '/api/recipes?sort=id')).status === 400)
  ok('非法排序方向 → 400',
    (await j('GET', '/api/recipes?order=random')).status === 400)
  ok('SQL 注入式排序字段 → 400',
    (await j('GET', '/api/recipes?sort=' + encodeURIComponent('name; DROP TABLE recipe'))).status === 400)

  /* ---------- 次级排序稳定性 ---------- */
  // 直接把 3 个菜谱的 updated_at 改成同值
  const sameTs = '2026-01-01T00:00:00.000Z'
  const idsAll = byUpdatedDesc.body.map((r: any) => r.id).sort((a: number, b: number) => a - b)
  raw.prepare('update recipe set updated_at = ? where id in (' + idsAll.map(() => '?').join(',') + ')')
    .run(sameTs, ...idsAll)

  const stable1 = await j('GET', '/api/recipes?sort=updated_at&order=asc')
  const stable2 = await j('GET', '/api/recipes?sort=updated_at&order=asc')
  const ids1 = stable1.body.map((r: any) => r.id)
  const ids2 = stable2.body.map((r: any) => r.id)
  ok('★ 相同 updated_at 时结果顺序稳定（两次请求一致）',
    JSON.stringify(ids1) === JSON.stringify(ids2), JSON.stringify(ids1))
  ok('★ 次级排序 = id 升序',
    JSON.stringify(ids1) === JSON.stringify([...ids1].sort((a: number, b: number) => a - b)),
    JSON.stringify(ids1))

  /* ============================================================
   * E. 组合
   * ============================================================ */
  section('E. 搜索 + 筛选 + 排序 组合')

  const combo1 = await j('GET', '/api/recipes?search=' + encodeURIComponent('番茄') + '&tags=' + encodeURIComponent('快手'))
  ok('搜索「番茄」+ Tag「快手」→ 1 条（番茄炒蛋）',
    combo1.status === 200 && combo1.body.length === 1 && combo1.body[0].name === '番茄炒蛋',
    `${combo1.body?.length}/${combo1.body[0]?.name}`)

  const combo2 = await j('GET',
    '/api/recipes?tags=' + encodeURIComponent('家常菜') + '&tags=' + encodeURIComponent('快手') +
    '&tag_mode=or&sort=name&order=asc')
  ok('OR 筛选 + name 排序 → 3 条且按名称升序',
    combo2.body.length === 3 &&
    JSON.stringify(listNames(combo2.body)) === JSON.stringify([...listNames(combo2.body)].sort()),
    JSON.stringify(listNames(combo2.body)))

  const combo3 = await j('GET', '/api/recipes?search=' + encodeURIComponent('沙拉') + '&sort=name&order=desc')
  ok('搜索 + 排序可组合', combo3.status === 200 && combo3.body.length === 1, `${combo3.body?.length}`)

  /* ============================================================
   * F. 设置持久化
   * ============================================================ */
  section('F. 列表设置持久化')

  const def = await j('GET', '/api/recipe-list-settings')
  ok('GET 默认设置 → 200', def.status === 200, `${def.status}`)
  ok('★★ 默认 sort_field = updated_at', def.body.sort_field === 'updated_at', `${def.body.sort_field}`)
  ok('★★ 默认 sort_order = desc', def.body.sort_order === 'desc', `${def.body.sort_order}`)
  ok('★★ 默认 tag_mode = and', def.body.tag_mode === 'and', `${def.body.tag_mode}`)
  ok('★★ 默认 selected_tags = []',
    Array.isArray(def.body.selected_tags) && def.body.selected_tags.length === 0,
    JSON.stringify(def.body.selected_tags))

  const upd = await j('PATCH', '/api/recipe-list-settings', {
    sort_field: 'name',
    sort_order: 'asc',
    tag_mode: 'or',
    selected_tags: ['家常菜', '快手'],
  })
  ok('PATCH 更新设置 → 200', upd.status === 200, `${upd.status}`)
  ok('  返回值正确',
    upd.body.sort_field === 'name' && upd.body.sort_order === 'asc' &&
    upd.body.tag_mode === 'or' &&
    JSON.stringify(upd.body.selected_tags) === JSON.stringify(['家常菜', '快手']),
    JSON.stringify(upd.body))

  const reread = await j('GET', '/api/recipe-list-settings')
  ok('★★ 重新读取可恢复（持久化生效）',
    reread.body.sort_field === 'name' && reread.body.sort_order === 'asc' &&
    reread.body.tag_mode === 'or' &&
    JSON.stringify(reread.body.selected_tags) === JSON.stringify(['家常菜', '快手']),
    JSON.stringify(reread.body))

  // 部分更新
  const partial = await j('PATCH', '/api/recipe-list-settings', { sort_order: 'desc' })
  ok('部分更新（只改方向）→ 200', partial.status === 200, `${partial.status}`)
  ok('  其他字段保留',
    partial.body.sort_field === 'name' && partial.body.tag_mode === 'or' &&
    JSON.stringify(partial.body.selected_tags) === JSON.stringify(['家常菜', '快手']),
    JSON.stringify(partial.body))

  // 非法值
  ok('★ 非法 sort_field → 400',
    (await j('PATCH', '/api/recipe-list-settings', { sort_field: 'id' })).status === 400)
  ok('★ 非法 sort_order → 400',
    (await j('PATCH', '/api/recipe-list-settings', { sort_order: 'up' })).status === 400)
  ok('★ 非法 tag_mode → 400',
    (await j('PATCH', '/api/recipe-list-settings', { tag_mode: 'xor' })).status === 400)
  ok('★ selected_tags 非数组 → 400',
    (await j('PATCH', '/api/recipe-list-settings', { selected_tags: 'abc' })).status === 400)
  ok('★ selected_tags 含非字符串 → 400',
    (await j('PATCH', '/api/recipe-list-settings', { selected_tags: [1, 2] })).status === 400)
  ok('★ selected_tags 含空白名称 → 400',
    (await j('PATCH', '/api/recipe-list-settings', { selected_tags: ['  '] })).status === 400)
  ok('空 body → 400',
    (await j('PATCH', '/api/recipe-list-settings', {})).status === 400)

  // selected_tags 去重
  const dedup = await j('PATCH', '/api/recipe-list-settings', { selected_tags: ['A', 'B', 'A', ' B '] })
  ok('selected_tags 自动去重',
    JSON.stringify(dedup.body.selected_tags) === JSON.stringify(['A', 'B']),
    JSON.stringify(dedup.body.selected_tags))

  /* ---------- ★ 损坏数据容错（不 500）---------- */
  section('F2. 损坏 / 旧数据容错')

  const cases: Array<[string, string | null, string]> = [
    ['非法 JSON', '{不是合法JSON', '[]'],
    ['JSON 不是数组', '"just a string"', '[]'],
    ['JSON 是数字', '123', '[]'],
    ['JSON 对象', '{"a":1}', '[]'],
    ['数组含非字符串', '["ok", 1, null, "also"]', '["ok","also"]'],
    ['数组含空白', '["ok", "  "]', '["ok"]'],
    ['空字符串', '', '[]'],
    ['NULL', null, '[]'],
  ]
  for (const [label, rawValue, expected] of cases) {
    raw.prepare('update app_settings set recipe_selected_tags = ? where id = 1').run(rawValue)
    const res = await j('GET', '/api/recipe-list-settings')
    ok(`★ 损坏数据「${label}」→ 200 且回退`,
      res.status === 200 && JSON.stringify(res.body.selected_tags) === expected,
      `${res.status} ${JSON.stringify(res.body.selected_tags)}`)
  }

  // 非法枚举值（绕过 API 直接写库）
  for (const [col, badValue, expectField, expectValue] of [
    ['recipe_sort_field', 'hacked', 'sort_field', 'updated_at'],
    ['recipe_sort_order', 'sideways', 'sort_order', 'desc'],
    ['recipe_tag_mode', 'xor', 'tag_mode', 'and'],
  ] as Array<[string, string, string, string]>) {
    raw.prepare(`update app_settings set ${col} = ? where id = 1`).run(badValue)
    const res = await j('GET', '/api/recipe-list-settings')
    ok(`★ 非法 ${col}「${badValue}」→ 回退 ${expectValue}`,
      res.status === 200 && (res.body as any)[expectField] === expectValue,
      `${res.status} ${(res.body as any)[expectField]}`)
    // 复原
    raw.prepare(`update app_settings set ${col} = ? where id = 1`)
      .run(expectField === 'sort_field' ? 'updated_at' : expectField === 'sort_order' ? 'desc' : 'and')
  }

  // 整行删除（模拟"从未保存过设置"）→ 应返回默认值，不 500
  raw.prepare('delete from app_settings where id = 1').run()
  const noRow = await j('GET', '/api/recipe-list-settings')
  ok('★★ app_settings 无行时 → 返回默认值（不 500）',
    noRow.status === 200 && noRow.body.sort_field === 'updated_at' &&
    noRow.body.sort_order === 'desc' && noRow.body.tag_mode === 'and' &&
    noRow.body.selected_tags.length === 0,
    `${noRow.status} ${JSON.stringify(noRow.body)}`)

  // 无行时更新应能创建（走 INSERT 分支）
  const createOnEmpty = await j('PATCH', '/api/recipe-list-settings', {
    sort_field: 'created_at', selected_tags: ['X'],
  })
  ok('★ 无行时 PATCH → 成功创建（200）', createOnEmpty.status === 200, `${createOnEmpty.status}`)
  ok('  值正确', createOnEmpty.body.sort_field === 'created_at', `${createOnEmpty.body.sort_field}`)
  const afterCreate = await j('GET', '/api/recipe-list-settings')
  ok('  持久化成功', afterCreate.body.sort_field === 'created_at', `${afterCreate.body.sort_field}`)
  // 验证既有临期设置列未被破坏（默认值）
  const settingsRow = raw.prepare('select * from app_settings where id = 1').get() as any
  ok('★ 未破坏既有临期设置列（NOT NULL 且有值）',
    settingsRow.expiry_warning_mode === 'days' && settingsRow.expiry_warning_threshold === 3,
    `${settingsRow.expiry_warning_mode}/${settingsRow.expiry_warning_threshold}`)

  /* ============================================================
   * G. 批次 1/2 行为未破坏
   * ============================================================ */
  section('G. 批次 1/2 行为回归')

  ok('详情接口仍正常', (await j('GET', `/api/recipes/${rTomato.body.id}`)).status === 200)
  ok('Tag 列表仍正常', (await j('GET', '/api/tags')).status === 200)
  ok('未知 query 参数仍被拒绝 → 400',
    (await j('GET', '/api/recipes?unknown=1')).status === 400)
  ok('列表项仍含 tags 与 ingredient_count',
    typeof t4.body[0]?.ingredient_count === 'number' && Array.isArray(t4.body[0]?.tags),
    JSON.stringify({ c: t4.body[0]?.ingredient_count, t: t4.body[0]?.tags }))

  // 统一保存后 updated_at 变化，默认排序应体现（说明排序字段确有实际意义）
  const beforeEdit = (await j('GET', '/api/recipes?sort=updated_at&order=desc')).body[0].id
  await j('PATCH', `/api/recipes/${rPlain.body.id}/full`, {
    name: '白灼菜心', ingredients: [{ definition_id: d2.id }],
  })
  const afterEdit = (await j('GET', '/api/recipes?sort=updated_at&order=desc')).body[0].id
  ok('★ 编辑后该菜谱排到最前（updated_at 生效）',
    afterEdit === rPlain.body.id, `before=${beforeEdit} after=${afterEdit}`)

  // HAS_RECIPE 仍生效
  const delDef = await j('DELETE', `/api/definitions/${d1.id}`)
  ok('HAS_RECIPE 仍生效 → 409',
    delDef.status === 409 && delDef.body?.error?.code === 'HAS_RECIPE',
    `${delDef.status}/${delDef.body?.error?.code}`)
}

/* ---------- 完整性 ---------- */
section('数据库完整性')
const integrity = (raw.prepare('PRAGMA integrity_check').get() as any).integrity_check
const fkViolations = raw.prepare('PRAGMA foreign_key_check').all()
ok('integrity_check = ok', integrity === 'ok', integrity)
ok('外键无违规', fkViolations.length === 0, `${fkViolations.length}`)
} finally {
  // 幂等停止：任何成功 / 失败 / 异常路径都会走到这里，进程已退出时重复调用也安全
  await server.stop()
}

raw.close()
for (const s of ['', '-shm', '-wal']) {
  try { rmSync(`${dbPath}${s}`, { force: true }) } catch { /* */ }
}

console.log(`\n===== 批次 3 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
