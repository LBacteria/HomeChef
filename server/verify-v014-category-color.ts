/**
 * v0.1.4 批次一验证：分类颜色
 *
 * 覆盖本批次要求：
 *   1. 分类颜色格式验证（服务端拒绝非法值）
 *   2. 分类颜色保存与读取（持久化）
 *   3. 默认颜色兼容已有分类（19 个内置分类各有合理默认色）
 *   4. 库存列表标签所需数据（category 返回 color，前端可据此渲染）
 *   5. 修改颜色不影响名称、顺序、与食材的关联
 *
 * ⚠️ 使用独立临时库 + 动态端口；不访问真实数据库。
 * ⚠️ 迁移在本脚本内对临时库执行（不触碰 homechef.db）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const PORT = 58000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `v014-color-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

/* ---------- 建库：执行全部迁移（含新的 0006） ---------- */
const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()
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
  stdio: 'ignore', shell: true,
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

try {
  /* ============================================================
   * 一、迁移与 schema
   * ============================================================ */
  console.log('===== 一、迁移与 schema =====')

  const migrations = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()
  info('迁移文件', migrations.join(', '))

  // ⚠️ 不写死数量：migration 会随版本持续增加，
  //    「数量 = N」这类断言天然会随演进失效（v0.2.0 新增 0007 时即触发）。
  //    这里改为验证**必要文件确实存在**，这才是真正的契约。
  const REQUIRED_MIGRATIONS = [
    '0000_calm_ronan',
    '0001_ingredient_definition_model',
    '0002_definition_id_autoincrement',
    '0003_seed_infrastructure',
    '0004_app_settings',
    '0005_category',
    '0006_category_color',
  ]
  const missing = REQUIRED_MIGRATIONS.filter((tag) => !migrations.some((m) => m.startsWith(tag)))
  ok('必要 migration 文件全部存在（0000~0006）', missing.length === 0,
    missing.length ? `缺失: ${missing.join(', ')}` : `${REQUIRED_MIGRATIONS.length} 个齐备`)

  ok('至少存在 7 个 migration', migrations.length >= 7, `${migrations.length}`)
  ok('含 0006_category_color', migrations.some((m) => m.startsWith('0006')),
    migrations.filter((m) => m.startsWith('0006')).join(','))

  const cols = (raw.prepare('pragma table_info(category)').all() as Array<{ name: string }>).map((c) => c.name)
  info('category 列', cols.join(', '))
  ok('category 表含 color 列', cols.includes('color'))
  ok('原有列未被破坏',
    ['id', 'name', 'name_normalized', 'sort_order', 'created_at', 'updated_at'].every((c) => cols.includes(c)))

  // 已有分类是否自动获得默认值
  const nullColors = (raw.prepare('select count(*) c from category where color is null').get() as any).c
  ok('无 NULL color（迁移 DEFAULT 生效）', nullColors === 0, `${nullColors}`)

  /* ============================================================
   * 二、默认颜色兼容已有分类
   * ============================================================ */
  console.log('\n===== 二、默认颜色 =====')

  const cats = (await req('GET', '/api/categories')).body as any[]
  ok('GET /api/categories 返回 19 个分类', cats.length === 19, `${cats.length}`)
  ok('每个分类都返回 color 字段', cats.every((c) => typeof c.color === 'string'))
  ok('所有 color 都是 #RRGGBB 格式',
    cats.every((c) => /^#[0-9a-fA-F]{6}$/.test(c.color)),
    cats.filter((c) => !/^#[0-9a-fA-F]{6}$/.test(c.color)).map((c) => `${c.name}=${c.color}`).join(',') || '全部合法')

  // 需求点名的 4 个分类
  const byName = new Map<string, any>()
  for (const c of cats) byName.set(c.name, c)

  const seasoning = byName.get('调味品')
  const veg = byName.get('蔬菜')
  ok('调味品有颜色（黄色系）', seasoning?.color === '#FFC107', `${seasoning?.color}`)
  ok('蔬菜有颜色（绿色系）', veg?.color === '#4CAF50', `${veg?.color}`)

  // 肉类与水果：允许同级多种实现，只要求"有合理颜色且不重复于明显冲突"
  const meatColors = ['猪肉', '牛肉', '羊肉', '其他畜肉'].map((n) => byName.get(n)?.color)
  ok('肉类分类都有颜色', meatColors.every((c) => typeof c === 'string' && c.length === 7),
    meatColors.join(','))
  ok('水果有颜色', typeof byName.get('水果')?.color === 'string', `${byName.get('水果')?.color}`)

  // 全部 19 个分类都必须有颜色（不是只为 4 个实现）
  ok('19 个分类全部有非空颜色', cats.every((c) => c.color.length === 7))
  const distinct = new Set(cats.map((c) => c.color))
  info('不同的颜色数量', `${distinct.size} / ${cats.length}`)
  ok('颜色具备可区分度（至少 4 种不同颜色）', distinct.size >= 4, `${distinct.size}`)

  /* ============================================================
   * 三、颜色格式校验（服务端拒绝非法值）
   * ============================================================ */
  console.log('\n===== 三、颜色格式校验 =====')

  const target = cats[0]
  const badColors = [
    'red', '#FFF', '#GGGGGG', 'FFC107', '#FFC1077', '#ff c107', '', '  ',
    '#12345', '#1234567', 'rgb(1,2,3)',
  ]
  for (const bad of badColors) {
    const r = await req('PATCH', `/api/categories/${target.id}`, { color: bad })
    ok(`非法颜色被拒绝：${JSON.stringify(bad)} → 400`, r.status === 400, `${r.status}`)
  }

  // 合法格式（大小写均可）
  ok('合法 #RRGGBB（大写）→ 200',
    (await req('PATCH', `/api/categories/${target.id}`, { color: '#AABBCC' })).status === 200)
  ok('合法 #rrggbb（小写）→ 200',
    (await req('PATCH', `/api/categories/${target.id}`, { color: '#112233' })).status === 200)

  // 未知字段 / 空 body
  ok('未知字段 → 400', (await req('PATCH', `/api/categories/${target.id}`, { nope: 1 })).status === 400)
  ok('空 body → 400', (await req('PATCH', `/api/categories/${target.id}`, {})).status === 400)
  ok('color 非字符串 → 400',
    (await req('PATCH', `/api/categories/${target.id}`, { color: 123 })).status === 400)

  /* ============================================================
   * 四、保存与持久化
   * ============================================================ */
  console.log('\n===== 四、保存与持久化 =====')

  const saveRes = await req('PATCH', `/api/categories/${target.id}`, { color: '#0A0B0C' })
  ok('保存颜色 → 200', saveRes.status === 200, `${saveRes.status}`)
  ok('  返回 color 已更新', saveRes.body?.color === '#0A0B0C', `${saveRes.body?.color}`)

  const inDb = raw.prepare('select color from category where id = ?').get(target.id) as any
  ok('  真正写入数据库', inDb?.color === '#0A0B0C', `${inDb?.color}`)

  const reread = (await req('GET', '/api/categories')).body.find((c: any) => c.id === target.id)
  ok('  重新读取仍是新颜色', reread?.color === '#0A0B0C', `${reread?.color}`)

  /* ============================================================
   * 五、修改颜色不影响其他属性
   * ============================================================ */
  console.log('\n===== 五、不影响名称 / 顺序 / 关联 =====')

  const beforeRow = raw.prepare('select * from category where id = ?').get(target.id) as any
  const beforeDefs = raw.prepare('select id, category_id from ingredient_definition order by id').all()

  await req('PATCH', `/api/categories/${target.id}`, { color: '#123ABC' })

  const afterRow = raw.prepare('select * from category where id = ?').get(target.id) as any
  ok('名称未变', afterRow.name === beforeRow.name, `${beforeRow.name} → ${afterRow.name}`)
  ok('name_normalized 未变', afterRow.name_normalized === beforeRow.name_normalized)
  ok('sort_order 未变', afterRow.sort_order === beforeRow.sort_order,
    `${beforeRow.sort_order} → ${afterRow.sort_order}`)
  ok('created_at 未变', afterRow.created_at === beforeRow.created_at)
  ok('updated_at 已更新（仅此字段随颜色变化）', afterRow.updated_at !== beforeRow.updated_at)
  ok('color 已更新', afterRow.color === '#123ABC', `${afterRow.color}`)

  const afterDefs = raw.prepare('select id, category_id from ingredient_definition order by id').all()
  ok('食材与分类的关联未变', JSON.stringify(beforeDefs) === JSON.stringify(afterDefs))

  const catsAfter = (await req('GET', '/api/categories')).body as any[]
  ok('分类数量未变', catsAfter.length === 19, `${catsAfter.length}`)
  ok('分类顺序未变',
    JSON.stringify(catsAfter.map((c: any) => c.id)) === JSON.stringify(cats.map((c: any) => c.id)))

  /* ============================================================
   * 六、库存标签所需数据
   * ============================================================ */
  console.log('\n===== 六、库存标签数据 =====')

  // 库存列表返回的 definition 带 category_id；分类列表返回 color
  // 前端据此渲染标签，无需额外请求
  const stockList = await req('GET', '/api/ingredients')
  ok('库存列表接口正常 → 200', stockList.status === 200, `${stockList.status}`)

  const defs = (await req('GET', '/api/definitions?sort=name&order=asc')).body as any[]
  ok('食材列表返回 category_id', defs.every((d) => 'category_id' in d))
  const withCat = defs.filter((d) => d.category_id !== null).length
  info('有分类的食材数', `${withCat} / ${defs.length}`)

  // 模拟前端的标签查找：definition.category_id → categories 中的 color
  const colorMap = new Map<number, string>()
  for (const c of catsAfter) colorMap.set(c.id, c.color)
  const resolvable = defs.filter((d) => d.category_id !== null && colorMap.has(d.category_id)).length
  ok('所有有分类的食材都能解析到颜色', resolvable === withCat, `${resolvable} / ${withCat}`)

  /* ============================================================
   * 七、删除与新建不受颜色影响
   * ============================================================ */
  console.log('\n===== 七、删除 / 新建仍正常 =====')

  const created = await req('POST', '/api/categories', { name: 'v014颜色测试分类' })
  ok('新建分类 → 201', created.status === 201, `${created.status}`)
  ok('  新分类自带合法颜色', /^#[0-9a-fA-F]{6}$/.test(created.body?.color ?? ''), `${created.body?.color}`)

  ok('仍可改新分类颜色',
    (await req('PATCH', `/api/categories/${created.body.id}`, { color: '#654321' })).status === 200)

  const del = await req('DELETE', `/api/categories/${created.body.id}`)
  ok('删除该分类 → 204', del.status === 204, `${del.status}`)

  ok('删除不存在的分类 → 404', (await req('DELETE', '/api/categories/999999')).status === 404)
  ok('修改不存在分类的颜色 → 404',
    (await req('PATCH', '/api/categories/999999', { color: '#000000' })).status === 404)
  ok('非法 ID 改颜色 → 400', (await req('PATCH', '/api/categories/abc', { color: '#000000' })).status === 400)

  // ⚠️ 前置条件说明：
  //   本脚本用「只跑迁移、不跑 seed」的临时库，
  //   因此「调味品」分类下默认**没有任何食材**，
  //   直接删除会返回 204（合法删除）而不是 409。
  //   这里先创建一个属于调味品的食材，让「分类仍被使用」这一前提成立，
  //   再验证删除保护。**不是放宽断言**。
  const seasoningCategoryId = byName.get('调味品')!.id
  const guard = await req('POST', '/api/definitions', {
    name: 'v014删除保护测试食材',
    units: [],
    category_id: seasoningCategoryId,
  })
  ok('前置：创建调味品食材 → 201', guard.status === 201, `${guard.status}`)

  const refCount = (raw
    .prepare('select count(*) c from ingredient_definition where category_id = ?')
    .get(seasoningCategoryId) as any).c
  ok('前置：调味品分类下有食材引用', refCount > 0, `${refCount}`)

  ok('仍有食材的分类不能删除 → 409',
    (await req('DELETE', `/api/categories/${seasoningCategoryId}`)).status === 409)

  ok('  该分类确实仍然存在',
    (await req('GET', '/api/categories')).body.some((c: any) => c.id === seasoningCategoryId))

  /* ============================================================
   * 八、数据完整性
   * ============================================================ */
  console.log('\n===== 八、数据完整性 =====')

  const dangling = (raw.prepare(`
    select count(*) c from ingredient_definition d
    left join category c on c.id = d.category_id
    where d.category_id is not null and c.id is null
  `).get() as any).c
  ok('无悬空 category_id', dangling === 0, `${dangling}`)

  const badColorInDb = (raw.prepare(`
    select count(*) c from category where color not glob '#[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]'
  `).get() as any).c
  ok('库中所有 color 格式合法', badColorInDb === 0, `${badColorInDb}`)
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== 批次一结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
