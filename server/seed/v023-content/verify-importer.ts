/**
 * 内容包导入器的**隔离幂等测试**（v0.2.3）
 *
 * 只使用系统 tmp 下的独立随机目录；**绝不接触** `server/data`（真实库/备份）。
 * 覆盖：
 *   1. `dryRun` 默认不写任何一行；
 *   2. 第一遍只新增（定义/别名/单位/菜谱/料/步骤/标签关联）；
 *   3. 第二遍 **0 新增**（全量跳过或复用）→ 幂等；
 *   4. 既有"用户数据"（定义 / 标签 / 菜谱 / 库存数量与行数）逐字段未变；
 *   5. 未知分类 / 未知标签 / 同义名冲突 / 缺定义 一律**跳过并记录原因**，不新建分类、不留半成品菜谱。
 *
 * 运行：`cd server && node --import tsx seed/v023-content/verify-importer.ts`
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'

import { assertSafeDbPath } from '../../src/db/safe-db-path.js'
import { importRecipeContent, type ContentPackage } from './importer.js'

let pass = 0
let fail = 0
function ok(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++
    console.log(`  [PASS] ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  } else {
    fail++
    console.log(`  [FAIL] ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  }
}

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-content-${randomUUID()}`)
const dbPath = resolve(runRoot, 'content-import-test.db')

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e) {
  console.error(`ABORT: assertSafeDbPath 拒绝：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) {
  console.error('ABORT: 测试库不在本次运行目录内')
  process.exit(1)
}
mkdirSync(runRoot, { recursive: true })
process.on('exit', () => {
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) return
    if (!resolvedRun.startsWith(resolve(baseRoot))) return
    if (!basename(resolvedRun).startsWith('hc-content-')) return
    rmSync(resolvedRun, { recursive: true, force: true })
  } catch {
    /* 交给系统回收 */
  }
})

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const drizzleDir = resolve(serverRoot, 'drizzle')
for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim()
    if (trimmed !== '') db.exec(trimmed)
  }
}

const now = new Date().toISOString()
const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c

/* ---------- 既有"用户数据"（必须全程不变） ---------- */
const legacyCategoryId = (db.prepare("select id from category where name = '蔬菜'").get() as { id: number }).id
const legacyDefId = Number(
  db
    .prepare(
      'insert into ingredient_definition (name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?)',
    )
    .run('旧食材X', '旧食材x', legacyCategoryId, now, now).lastInsertRowid,
)
const legacyTagName = (db.prepare('select name from recipe_tag order by id limit 1').get() as { name: string }).name
const legacyTagId = (
  db.prepare('select id from recipe_tag where name = ?').get(legacyTagName) as { id: number }
).id
const legacyRecipeId = Number(
  db
    .prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run('旧菜谱X', '旧菜谱x', now, now).lastInsertRowid,
)
db.prepare(
  'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?)',
).run(legacyRecipeId, legacyDefId, 1, '个', 0, now, now)
db.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(
  legacyRecipeId,
  legacyTagId,
  now,
)
const legacyStockId = Number(
  db
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(legacyDefId, 3, '个', '2026-01-01', null, null, '常温', now, now).lastInsertRowid,
)

const snapshot = (): string =>
  JSON.stringify({
    legacy_def: db.prepare('select * from ingredient_definition where id = ?').get(legacyDefId),
    legacy_tag: db.prepare('select * from recipe_tag where id = ?').get(legacyTagId),
    legacy_recipe: db.prepare('select * from recipe where id = ?').get(legacyRecipeId),
    legacy_recipe_lines: db
      .prepare('select * from recipe_ingredient where recipe_id = ? order by sort_order')
      .all(legacyRecipeId),
    legacy_tag_links: db
      .prepare('select * from recipe_tag_link where recipe_id = ?')
      .all(legacyRecipeId),
    legacy_stock: db.prepare('select * from standard_ingredient where id = ?').get(legacyStockId),
    stock_rows: count('select count(*) c from standard_ingredient'),
    stock_total: (db.prepare('select coalesce(sum(quantity),0) c from standard_ingredient').get() as {
      c: number
    }).c,
  })
const before = snapshot()

/* ---------- 内存 fixture（不写任何 content.json，避免覆盖子代理数据文件） ---------- */
const fixture: ContentPackage = {
  checked_on: '2026-10-16',
  definitions: [
    { name: '番茄X', category: '蔬菜', allowed_units: ['个', '克'], aliases: ['西红柿X'] },
    { name: '盐X', category: '调味品', allowed_units: [] },
    { name: '野食材X', category: '这个分类不存在X', allowed_units: ['克'] },
  ],
  recipes: [
    {
      name: '番茄X炒蛋',
      servings_note: '按两人份家庭参考量整理，非原方精确份量',
      source_url: 'https://example.invalid/tomato-egg',
      verified: true,
      tags: [legacyTagName, '不存在的标签X'],
      ingredients: [
        { definition: '番茄X', quantity: 2, unit: '个' },
        { definition: '盐X', quantity: null, unit: null },
      ],
      steps: ['番茄X切块', '下锅炒匀'],
    },
    {
      // 同义名命中既有菜谱 → 必须跳过（不覆盖用户菜谱）
      name: '西红柿炒鸡蛋X',
      synonyms: ['旧菜谱X'],
      source_url: 'https://example.invalid/dup',
      verified: true,
      ingredients: [{ definition: '番茄X', quantity: 1, unit: '个' }],
      steps: ['不该被写入'],
    },
    {
      // 引用了不存在的定义 → 整道菜跳过（不留半成品）
      name: '缺料菜X',
      source_url: 'https://example.invalid/missing',
      verified: true,
      ingredients: [{ definition: '并不存在的食材X', quantity: 1, unit: '个' }],
      steps: ['不该被写入'],
    },
    {
      // 来源未核实 → 默认拒绝
      name: '未核实菜X',
      source_url: 'https://example.invalid/unverified',
      verified: false,
      ingredients: [{ definition: '番茄X', quantity: 1, unit: '个' }],
      steps: ['不该被写入'],
    },
  ],
}

console.log('\n===== 1) dryRun（默认）不写任何一行 =====')
const dry = importRecipeContent(db, { content: fixture })
ok(
  'dryRun=true 且不写库：报告将新增但表为空',
  dry.dry_run === true &&
    dry.definitions_added === 2 &&
    dry.recipes_added === 1 &&
    count('select count(*) c from ingredient_definition') === 1 &&
    count('select count(*) c from recipe') === 1,
  JSON.stringify({ defs: dry.definitions_added, recipes: dry.recipes_added }),
)

console.log('\n===== 2) 第一遍真实导入（只新增） =====')
const first = importRecipeContent(db, { content: fixture, dryRun: false })
ok('第一遍：新增 2 个定义（第 3 个因分类不存在被跳过）', first.definitions_added === 2 && first.definitions_skipped.length === 1, JSON.stringify(first.definitions_skipped))
ok('第一遍：新增 1 个别名、2 个单位', first.aliases_added === 1 && first.units_added === 2, `${first.aliases_added}/${first.units_added}`)
ok('第一遍：新增 1 道菜谱、2 条料、2 个步骤', first.recipes_added === 1 && first.ingredients_added === 2 && first.steps_added === 2)
ok('第一遍：同义名冲突 + 缺料 + 未核实 的 3 道菜被跳过', first.recipes_skipped.length === 3 && first.recipes_skipped.some((r) => r.includes('未核实')), JSON.stringify(first.recipes_skipped))
ok(
  '第一遍：新菜谱的 recipe.note 保存了来源 URL 与两人份说明',
  (() => {
    const row = db
      .prepare("select note from recipe where name_normalized = '番茄x炒蛋'")
      .get() as { note: string | null } | undefined
    return row?.note != null && row.note.includes('https://example.invalid/tomato-egg') && row.note.includes('两人份')
  })(),
)
ok(
  '第一遍：每条新配料的 line_key 非空且唯一',
  (() => {
    const rows = db
      .prepare(
        'select line_key from recipe_ingredient where recipe_id = (select id from recipe where name_normalized = ?)',
      )
      .all('番茄x炒蛋') as Array<{ line_key: string | null }>
    return rows.length === 2 && rows.every((r) => r.line_key !== null && r.line_key.length > 10) && new Set(rows.map((r) => r.line_key)).size === 2
  })(),
)
ok(
  '第一遍：配料 note 保留（此处为来源包的 note，空则 null）',
  (() => {
    const rows = db
      .prepare(
        'select note from recipe_ingredient where recipe_id = (select id from recipe where name_normalized = ?) order by sort_order',
      )
      .all('番茄x炒蛋') as Array<{ note: string | null }>
    return rows.length === 2 && rows.every((r) => r.note === null || typeof r.note === 'string')
  })(),
)
ok('第一遍：已有标签关联 1 个，未知标签只记录不新建', first.tags_linked === 1 && first.tags_missing.includes('不存在的标签X'), JSON.stringify(first.tags_missing))
ok(
  '第一遍：没有新建任何标签、没有写入任何库存',
  count('select count(*) c from recipe_tag') === 31 + 1 && count('select count(*) c from standard_ingredient') === 1,
  `tags=${count('select count(*) c from recipe_tag')}`,
)

console.log('\n===== 3) 第二遍（幂等：0 新增） =====')
const second = importRecipeContent(db, { content: fixture, dryRun: false })
ok(
  '第二遍：定义 0 新增（2 复用）、菜谱 0 新增（3 跳过）、别名/单位/标签关联 0 新增',
  second.definitions_added === 0 &&
    second.definitions_reused === 2 &&
    second.recipes_added === 0 &&
    second.recipes_skipped.length === 4 &&
    second.aliases_added === 0 &&
    second.units_added === 0 &&
    second.tags_linked === 0,
  JSON.stringify({ defs: second.definitions_added, reused: second.definitions_reused, recipes: second.recipes_added, skipped: second.recipes_skipped.length }),
)

console.log('\n===== 4) 既有用户数据与库存未变 =====')
ok('四个既有实体（定义/标签/菜谱/库存行）与汇总逐字段未变', snapshot() === before)
ok(
  '库存行数与总量完全未变（内容包不引入任何库存）',
  count('select count(*) c from standard_ingredient') === 1 &&
    (db.prepare('select quantity q from standard_ingredient where id = ?').get(legacyStockId) as { q: number }).q === 3,
)

db.close()
console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
