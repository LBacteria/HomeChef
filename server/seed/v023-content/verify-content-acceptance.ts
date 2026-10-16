/**
 * v0.2.3 内容包**真实数据验收**（隔离库；**绝不接触** `server/data`）
 *
 * 用真实 `content.json`（30 菜谱 / 136 食材定义）在**全新 0012 库**上验证：
 *   1. `dryRun` 的预测与 `apply` 的实际新增**完全一致**；
 *   2. 第一遍真实只新增；第二遍 **0 新增**（幂等）；
 *   3. 既有"用户数据"（定义 / 标签 / 菜谱 / 库存）**逐字段未变**；
 *   4. 每道新菜谱都保存了来源 URL（`recipe.note`）与两人份说明；
 *   5. 每条新配料的 `line_key` **非空且唯一**（否则烹饪确认/结算无法逐条定位）；
 *   6. 覆盖不变式：`新增 + 复用 + 跳过 = 包内总数`（定义与菜谱各自成立）。
 *
 * 运行：`cd server && node --import tsx seed/v023-content/verify-content-acceptance.ts`
 */
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import Database from 'better-sqlite3'

import { assertSafeDbPath } from '../../src/db/safe-db-path.js'
import { importRecipeContent, normalizeName } from './importer.js'

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
const contentPath = resolve(serverRoot, 'seed/v023-content/content.json')
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-content-acc-${randomUUID()}`)
const dbPath = resolve(runRoot, 'content-acceptance.db')

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
    if (!basename(resolvedRun).startsWith('hc-content-acc-')) return
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

const raw = JSON.parse(readFileSync(contentPath, 'utf8')) as {
  ingredients?: unknown[]
  recipes?: unknown[]
}
const totalDefs = raw.ingredients?.length ?? 0
const totalRecipes = raw.recipes?.length ?? 0
console.log(`\n内容包：definitions=${totalDefs} recipes=${totalRecipes}`)

const now = new Date().toISOString()
const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c

/* ---------- 既有"用户数据" ---------- */
const legacyCategoryId = (db.prepare("select id from category where name = '蔬菜'").get() as { id: number }).id
const legacyDefId = Number(
  db
    .prepare(
      'insert into ingredient_definition (name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?)',
    )
    .run('验收旧食材X', '验收旧食材x', legacyCategoryId, now, now).lastInsertRowid,
)
const legacyTagId = (db.prepare('select id from recipe_tag order by id limit 1').get() as { id: number }).id
const legacyRecipeId = Number(
  db
    .prepare(
      'insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)',
    )
    .run('验收旧菜谱X', '验收旧菜谱x', '用户自己写的备注', now, now).lastInsertRowid,
)
db.prepare(
  'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, line_key, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
).run(legacyRecipeId, legacyDefId, 1, '个', '旧备注', 'legacy-line-key', 0, now, now)
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

/**
 * 旧用户菜谱「西红柿炒鸡蛋」——模拟 Sol 真实库里已有的同名菜。
 * 内容包的「番茄炒鸡蛋」把常见同义名写进了 `synonyms`，因此**必须被跳过**（29 而非 30）。
 */
const legacyNamedRecipeId = Number(
  db
    .prepare(
      'insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)',
    )
    .run('西红柿炒鸡蛋', '西红柿炒鸡蛋', '用户既有菜谱（同义名判重用例）', now, now).lastInsertRowid,
)
db.prepare(
  'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, line_key, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
).run(legacyNamedRecipeId, legacyDefId, 2, '个', null, 'legacy-syn-line-key', 0, now, now)

const tablesToProtect = [
  'ingredient_definition',
  'ingredient_definition_unit',
  'ingredient_alias',
  'category',
  'standard_ingredient',
] as const
const snapshot = (): string =>
  JSON.stringify({
    legacy_def: db.prepare('select * from ingredient_definition where id = ?').get(legacyDefId),
    legacy_recipe: db.prepare('select * from recipe where id = ?').get(legacyRecipeId),
    legacy_lines: db
      .prepare('select * from recipe_ingredient where recipe_id = ? order by sort_order')
      .all(legacyRecipeId),
    legacy_links: db.prepare('select * from recipe_tag_link where recipe_id = ?').all(legacyRecipeId),
    legacy_stock: db.prepare('select * from standard_ingredient where id = ?').get(legacyStockId),
    stock_rows: count('select count(*) c from standard_ingredient'),
    stock_total: (db.prepare('select coalesce(sum(quantity),0) c from standard_ingredient').get() as { c: number }).c,
    /** 旧数据的**非新增**行：分类表必须一行不动（菜谱总数会因新增而变，不能纳入快照） */
    categories: count('select count(*) c from category'),
  })
const before = snapshot()

console.log('\n===== 1) dryRun（真实内容包，零写入） =====')
const dry = importRecipeContent(db, { contentPath, dryRun: true })
ok(
  'dryRun 零写入：定义/菜谱/配料/步骤/标签关联全部未变',
  count('select count(*) c from ingredient_definition') === 1 &&
    count('select count(*) c from recipe') === 2 &&
    count('select count(*) c from recipe_ingredient') === 2 &&
    count('select count(*) c from recipe_step') === 0 &&
    count('select count(*) c from recipe_tag_link') === 1,
  JSON.stringify({ defs: count('select count(*) c from ingredient_definition'), recipes: count('select count(*) c from recipe') }),
)
ok(
  'dryRun 覆盖不变式：新增+复用+跳过 = 包内定义总数',
  dry.definitions_added + dry.definitions_reused + dry.definitions_skipped.length === totalDefs,
  `${dry.definitions_added}+${dry.definitions_reused}+${dry.definitions_skipped.length}`,
)
ok(
  'dryRun 覆盖不变式：新增+跳过 = 包内菜谱总数',
  dry.recipes_added + dry.recipes_skipped.length === totalRecipes,
  `${dry.recipes_added}+${dry.recipes_skipped.length}`,
)

console.log('\n===== 2) apply（第一遍） =====')
const apply = importRecipeContent(db, { contentPath, dryRun: false })
ok(
  '预测一致：dry 与 apply 的定义新增数/复用数完全相同',
  dry.definitions_added === apply.definitions_added && dry.definitions_reused === apply.definitions_reused,
  `dry=${dry.definitions_added}/${dry.definitions_reused} apply=${apply.definitions_added}/${apply.definitions_reused}`,
)
ok(
  '预测一致：dry 与 apply 的菜谱新增数/跳过数完全相同',
  dry.recipes_added === apply.recipes_added &&
    dry.recipes_skipped.length === apply.recipes_skipped.length,
  `dry=${dry.recipes_added}/${dry.recipes_skipped.length} apply=${apply.recipes_added}/${apply.recipes_skipped.length}`,
)
ok(
  '预测一致：别名/单位/标签关联新增数相同',
  dry.aliases_added === apply.aliases_added &&
    dry.units_added === apply.units_added &&
    dry.tags_linked === apply.tags_linked,
  `${dry.aliases_added}/${dry.units_added}/${dry.tags_linked} vs ${apply.aliases_added}/${apply.units_added}/${apply.tags_linked}`,
)
ok(
  '同义名去重：既有「西红柿炒鸡蛋」→ 新「番茄炒鸡蛋」按 synonyms 跳过（29 而非 30）',
  apply.recipes_added === totalRecipes - 1 &&
    apply.recipes_skipped.length === 1 &&
    apply.recipes_skipped[0].includes('番茄炒鸡蛋'),
  `added=${apply.recipes_added} skipped=${JSON.stringify(apply.recipes_skipped)}`,
)
ok(
  '单位计数一致：dry 与 apply 的 units_added 完全相同（合法单位先去重）',
  dry.units_added === apply.units_added,
  `dry=${dry.units_added} apply=${apply.units_added}`,
)
console.log(
  `  统计：定义 +${apply.definitions_added}（复用 ${apply.definitions_reused}，跳过 ${apply.definitions_skipped.length}）` +
    `｜菜谱 +${apply.recipes_added}（跳过 ${apply.recipes_skipped.length}）` +
    `｜配料 +${apply.ingredients_added}｜步骤 +${apply.steps_added}` +
    `｜别名 +${apply.aliases_added}（跳过 ${apply.aliases_skipped.length}）｜单位 +${apply.units_added}` +
    `｜标签关联 +${apply.tags_linked}（缺标签 ${apply.tags_missing.length}）`,
)
if (apply.recipes_skipped.length > 0) {
  console.log(`  跳过菜谱原因：${JSON.stringify(apply.recipes_skipped.slice(0, 6))}`)
}
if (apply.definitions_skipped.length > 0) {
  console.log(`  跳过定义原因：${JSON.stringify(apply.definitions_skipped.slice(0, 6))}`)
}
if (apply.tags_missing.length > 0) {
  console.log(`  内容包引用了不存在的标签（未新建）：${JSON.stringify(apply.tags_missing)}`)
}

console.log('\n===== 3) 导入结果的完整性 =====')
ok(
  '每道新菜谱的 note 都含来源 URL',
  count("select count(*) c from recipe where note like '%http%'") === apply.recipes_added,
  `withUrl=${count("select count(*) c from recipe where note like '%http%'")} / added=${apply.recipes_added}`,
)
ok(
  '新菜谱的 note 均含「两人份」说明',
  count("select count(*) c from recipe where note like '%两人份%'") >= apply.recipes_added,
  `withServingsNote=${count("select count(*) c from recipe where note like '%两人份%'")}`,
)
ok(
  '新配料的 line_key 非空',
  count('select count(*) c from recipe_ingredient where line_key is null') === 0,
)
ok(
  '新配料的 line_key 唯一',
  count('select count(*) c from recipe_ingredient') ===
    count('select count(distinct line_key) c from recipe_ingredient'),
)
ok(
  '每条新配料的 unit 都在枚举内或为 null（由 CHECK 保证，这里再确认无异常行）',
  count(
    "select count(*) c from recipe_ingredient where unit is not null and unit not in ('个','克','千克','毫升','升','包','袋','瓶','盒','罐')",
  ) === 0,
)
ok(
  '新菜谱的步骤顺序从 1 连续编号',
  (() => {
    const rows = db
      .prepare(
        'select recipe_id, count(*) cnt, min(step_no) mn, max(step_no) mx from recipe_step group by recipe_id',
      )
      .all() as Array<{ cnt: number; mn: number; mx: number }>
    return rows.length > 0 && rows.every((r) => r.mn === 1 && r.mx === r.cnt)
  })(),
)

console.log('\n===== 4) 第二遍（幂等：0 新增） =====')
const second = importRecipeContent(db, { contentPath, dryRun: false })
ok(
  '第二遍：定义 0 新增、菜谱 0 新增、配料/步骤/别名/单位/标签关联均 0 新增',
  second.definitions_added === 0 &&
    second.recipes_added === 0 &&
    second.ingredients_added === 0 &&
    second.steps_added === 0 &&
    second.aliases_added === 0 &&
    second.units_added === 0 &&
    second.tags_linked === 0,
  JSON.stringify({
    defs: second.definitions_added,
    recipes: second.recipes_added,
    lines: second.ingredients_added,
    steps: second.steps_added,
    aliases: second.aliases_added,
  }),
)
ok(
  '第二遍：全部条目被跳过或复用（覆盖不变式仍成立）',
  second.definitions_reused + second.definitions_skipped.length + second.definitions_added === totalDefs &&
    second.recipes_skipped.length + second.recipes_added === totalRecipes,
  JSON.stringify({ defs: second.definitions_reused, skipped: second.definitions_skipped.length, recipesSkipped: second.recipes_skipped.length }),
)

console.log('\n===== 5) 既有用户数据与库存全字段未变 =====')
ok('既有实体快照逐字段一致（定义/菜谱/配料/标签关联/库存）', snapshot() === before)
ok(
  '分类表与库存行数未变、库存总量未变',
  count('select count(*) c from standard_ingredient') === 1 &&
    (db.prepare('select quantity q from standard_ingredient where id = ?').get(legacyStockId) as { q: number }).q === 3 &&
    count('select count(*) c from category') === (JSON.parse(before) as { categories: number }).categories,
)
ok(
  'user 旧定义未被改名/改分类（name_normalized 与 category_id 原样）',
  (() => {
    const row = db
      .prepare('select name_normalized, category_id from ingredient_definition where id = ?')
      .get(legacyDefId) as { name_normalized: string; category_id: number }
    return row.name_normalized === '验收旧食材x' && row.category_id === legacyCategoryId
  })(),
)

console.log('\n===== 6) 增量包 content-extra.json（同一隔离库：幂等 + 保护） =====')
const extraPath = resolve(serverRoot, 'seed/v023-content/content-extra.json')
const extraRaw = JSON.parse(readFileSync(extraPath, 'utf8')) as { ingredients?: unknown[] }
const extraTotal = extraRaw.ingredients?.length ?? 0
const extraDry = importRecipeContent(db, { contentPath: extraPath, dryRun: true })
ok(
  '增量包 dryRun 零写入（定义数不变）',
  count('select count(*) c from ingredient_definition') === 1 + apply.definitions_added,
  String(count('select count(*) c from ingredient_definition')),
)
const extraApply = importRecipeContent(db, { contentPath: extraPath, dryRun: false })
ok(
  '增量包：dry 与 apply 的预测一致，且全部被接受（无跳过）',
  extraDry.definitions_added === extraApply.definitions_added &&
    extraApply.definitions_skipped.length === 0 &&
    extraApply.definitions_added + extraApply.definitions_reused === extraTotal,
  `dry=${extraDry.definitions_added} apply=${extraApply.definitions_added} 复用=${extraApply.definitions_reused} 跳过=${JSON.stringify(extraApply.definitions_skipped.slice(0, 5))} 总数=${extraTotal}`,
)
ok(
  '增量包：单位与别名全部合法（单位非法会被拒绝，别名冲突只跳过并报告）',
  extraApply.aliases_skipped.length === 0,
  JSON.stringify(extraApply.aliases_skipped.slice(0, 6)),
)
const extraSecond = importRecipeContent(db, { contentPath: extraPath, dryRun: false })
ok(
  '增量包第二遍：0 新增',
  extraSecond.definitions_added === 0 && extraSecond.aliases_added === 0 && extraSecond.units_added === 0,
  JSON.stringify({ defs: extraSecond.definitions_added, aliases: extraSecond.aliases_added, units: extraSecond.units_added }),
)
ok(
  '两包合计真实新增（在 0012 空库口径）：content.json + content-extra.json',
  apply.definitions_added + extraApply.definitions_added > 0,
  `${apply.definitions_added} + ${extraApply.definitions_added} = ${apply.definitions_added + extraApply.definitions_added}`,
)
ok('增量包导入后既有用户数据与库存仍逐字段未变', snapshot() === before)

db.close()
console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
void normalizeName
process.exit(fail === 0 ? 0 : 1)
