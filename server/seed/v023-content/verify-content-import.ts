/**
 * 隔离测试：内容包导入器（幂等 + 旧数据不受影响 + 不新建分类/标签）
 *
 * 用法（示例）：
 *   $env:HOME_CHEF_TEST_DB_DIR = "C:\Users\<you>\AppData\Local\Temp\hc-v023-<random>"
 *   npx tsx seed/v023-content/verify-content-import.ts
 *
 * 安全约束（**必须遵守**）：
 *   - 只使用 `HOME_CHEF_TEST_DB_DIR`（未设置时用系统 tmp 下新建的独立目录）；
 *   - 绝不读取 / 写入 `server/data/**`（该目录在本脚本中完全不被触碰）；
 *   - 迁移只跑 `server/drizzle/*.sql`（drizzle migrator，全部迁移包在一个事务里）；
 *   - 结束前打印库文件位置，便于人工核查。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from '../../src/db/schema.js'
import { UNITS } from '../../src/db/schema.js'
import { importRecipeContent, loadContentPack, DEFAULT_CONTENT_PATH } from './import-v023-content.js'

/* ============================================================
 * 断言工具
 * ============================================================ */

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  if (cond) pass += 1
  else fail += 1
}

const CONTENT_DIR = resolve(fileURLToPath(import.meta.url), '..')
const SERVER_ROOT = resolve(CONTENT_DIR, '..', '..')

/* ============================================================
 * ① 全新的隔离目录 + 迁移建库
 * ============================================================ */

const envDir = process.env.HOME_CHEF_TEST_DB_DIR
const freshDir = envDir && envDir.trim().length > 0 ? resolve(envDir) : mkdtempSync(join(tmpdir(), 'hc-v023-'))
if (!existsSync(freshDir)) mkdirSync(freshDir, { recursive: true })

// 防御：绝不允许落到 server/data/ 下
const serverData = resolve(SERVER_ROOT, 'data').toLowerCase()
if (freshDir.toLowerCase().startsWith(serverData)) {
  console.error(`[verify] 拒绝执行：测试目录位于受保护的 server/data/ 内：${freshDir}`)
  process.exit(3)
}

const dbPath = join(freshDir, 'verify-v023.db')
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  if (existsSync(f)) rmSync(f)
}

console.log('=== HomeChef v023 内容包隔离测试 ===')
console.log(`临时目录：${freshDir}`)
console.log(`测试库  ：${dbPath}`)
console.log('')

const sqlite = new Database(dbPath)
sqlite.pragma('foreign_keys = ON')
const db = drizzle(sqlite, { schema })

migrate(db, { migrationsFolder: resolve(SERVER_ROOT, 'drizzle') })

const tables = sqlite
  .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")
  .all() as Array<{ name: string }>
ok('迁移建库成功（含 0012 结构）', tables.some((t) => t.name === 'recipe_tag'))
ok('食材分类已播种（19 个）', countCategory() === 19, `category=${countCategory()}`)
ok('系统预设标签 32 个', countTags() === 32, `recipe_tag=${countTags()}`)

/* ============================================================
 * ② 写入「旧数据」（模拟用户已有数据）
 * ============================================================ */

const NOW = '2026-01-01T00:00:00.000Z'

const customDef = db
  .insert(schema.ingredientDefinition)
  .values({
    name: '老王家秘制酱',
    name_normalized: '老王家秘制酱',
    estimated_shelf_life_days: 30,
    category_id: categoryIdOf('调味品'),
    created_at: NOW,
    updated_at: NOW,
  })
  .returning({ id: schema.ingredientDefinition.id })
  .get()
const customDefId = customDef.id

db.insert(schema.ingredientDefinitionUnit)
  .values([
    { definition_id: customDefId, unit: '克', created_at: NOW },
    { definition_id: customDefId, unit: '毫升', created_at: NOW },
  ])
  .run()
db.insert(schema.ingredientAlias)
  .values({ definition_id: customDefId, alias: '秘制酱', alias_normalized: '秘制酱', created_at: NOW })
  .run()

const customTag = db
  .insert(schema.recipeTag)
  .values({ name: '传家菜', name_normalized: '传家菜', category: null, code: null, is_system: 0, sort_order: 0, created_at: NOW })
  .returning({ id: schema.recipeTag.id })
  .get()

const oldRecipe = db
  .insert(schema.recipe)
  .values({
    name: '王家秘制酱蒸蛋',
    name_normalized: '王家秘制酱蒸蛋',
    note: '用户自己的菜谱',
    content_revision: 3,
    created_at: NOW,
    updated_at: NOW,
  })
  .returning({ id: schema.recipe.id })
  .get()
db.insert(schema.recipeIngredient)
  .values({
    recipe_id: oldRecipe.id,
    definition_id: customDefId,
    quantity: 2,
    unit: '毫升',
    note: '自家口味',
    line_key: 'user-line-key-1',
    sort_order: 1,
    created_at: NOW,
    updated_at: NOW,
  })
  .run()
db.insert(schema.recipeStep)
  .values({ recipe_id: oldRecipe.id, step_no: 1, content: '鸡蛋打散，加一勺秘制酱蒸熟。', created_at: NOW, updated_at: NOW })
  .run()
db.insert(schema.recipeTagLink)
  .values({ recipe_id: oldRecipe.id, tag_id: customTag.id, created_at: NOW })
  .run()

const stockRows = [
  { quantity: 500, unit: '克', purchase_date: '2026-09-01', storage_method: '常温', note: '第一批' },
  { quantity: 250, unit: '毫升', purchase_date: '2026-09-10', storage_method: '冷藏', note: '开封的' },
  { quantity: 100, unit: '克', purchase_date: '2026-09-20', storage_method: '冷冻', note: '' },
]
for (const [i, row] of stockRows.entries()) {
  db.insert(schema.standardIngredient)
    .values({
      definition_id: customDefId,
      quantity: row.quantity,
      unit: row.unit,
      purchase_date: row.purchase_date,
      production_date: null,
      expiry_date: null,
      expiry_date_source: null,
      storage_method: row.storage_method,
      note: row.note.length > 0 ? row.note : null,
      created_at: NOW,
      updated_at: `${NOW}#${i}`,
    })
    .run()
}

console.log('')
console.log('=== 旧数据快照（导入前） ===')
const before = snapshot()
console.log(
  `  definition=${before.customDef.length} unit=${before.customDefUnits.length} alias=${before.customDefAliases.length} ` +
    `tag=${before.customTag.length} recipe=${before.oldRecipe.length} ingredient=${before.oldRecipeIngredients.length} ` +
    `step=${before.oldRecipeSteps.length} tagLink=${before.oldRecipeTagLinks.length} stock=${before.stock.length}`,
)
console.log(`  库存行：${before.stock.map((s) => `${s.quantity}${s.unit}`).join(', ')}`)

const tagCountBefore = countTags()
const categoryCountBefore = countCategory()
const stockCountBefore = before.stock.length

/* ============================================================
 * ③ 第一遍导入（真实写入）
 * ============================================================ */

console.log('')
console.log('=== 第一遍导入（dryRun: false） ===')
const run1 = sqlite.transaction(() => importRecipeContent(sqlite, { dryRun: false }))()
printStats(run1)

ok('第一遍：食材定义新增 > 0', run1.definitions_added > 0, `definitions_added=${run1.definitions_added}`)
ok('第一遍：菜谱新增 = 30', run1.recipes_added === 30, `recipes_added=${run1.recipes_added}`)
ok('第一遍：菜谱跳过 = 0', run1.recipes_skipped.length === 0, `recipes_skipped=${JSON.stringify(run1.recipes_skipped)}`)
ok(
  '第一遍：无跳过原因',
  run1.recipes_skipped.length === 0 && run1.definitions_skipped.length === 0,
  [...run1.recipes_skipped, ...run1.definitions_skipped].join(' | ') || '（无）',
)
ok(
  '第一遍：别名解析复用生效（内置食材的别名不计入新增）',
  run1.definitions_added + run1.definitions_reused === loadContentPack(DEFAULT_CONTENT_PATH).ingredients.length,
  `added=${run1.definitions_added} reused=${run1.definitions_reused}`,
)
ok(
  '第一遍：未新增任何分类',
  countCategory() === categoryCountBefore,
  `${categoryCountBefore} → ${countCategory()}`,
)
ok('第一遍：未新增任何标签', countTags() === tagCountBefore, `${tagCountBefore} → ${countTags()}`)
ok('第一遍：未写入库存行', before.stock.length === stockCountBefore && countStock() === stockCountBefore)

/* ============================================================
 * ④ 第二遍导入（必须 0 新增、全部 skipped）
 * ============================================================ */

console.log('')
console.log('=== 第二遍导入（同一库，dryRun: false） ===')
const run2 = sqlite.transaction(() => importRecipeContent(sqlite, { dryRun: false }))()
printStats(run2)

ok('第二遍：definitions_added = 0', run2.definitions_added === 0, `${run2.definitions_added}`)
ok('第二遍：aliases_added = 0', run2.aliases_added === 0, `${run2.aliases_added}`)
ok('第二遍：recipes_added = 0', run2.recipes_added === 0, `${run2.recipes_added}`)
ok('第二遍：recipes_skipped = 30（全部 skipped）', run2.recipes_skipped.length === 30, `${run2.recipes_skipped.length}`)
ok(
  '第二遍：跳过原因全部为「已存在同名或同义名」',
  run2.recipes_skipped.length === 30 &&
    run2.recipes_skipped.every((r) => r.includes('已存在同名或同义名')),
  JSON.stringify(run2.recipes_skipped.slice(0, 3)),
)
ok(
  '第二遍：定义全部复用（0 新增）',
  run2.definitions_reused === loadContentPack(DEFAULT_CONTENT_PATH).ingredients.length,
  `reused=${run2.definitions_reused}`,
)

/* ============================================================
 * ⑤ 旧数据完全未变（逐字段比对）
 * ============================================================ */

console.log('')
console.log('=== 旧数据快照（导入后）逐字段比对 ===')
const after = snapshot()

const same = (label: string, a: unknown, b: unknown) => {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  ok(label, sa === sb, sa === sb ? '' : `\nbefore=${sa}\nafter =${sb}`)
}
same('自定义食材定义行未变', before.customDef, after.customDef)
same('自定义食材的允许单位行未变', before.customDefUnits, after.customDefUnits)
same('自定义食材的别名行未变', before.customDefAliases, after.customDefAliases)
same('用户自定义标签行未变', before.customTag, after.customTag)
same('用户菜谱行未变（含 content_revision）', before.oldRecipe, after.oldRecipe)
same('用户菜谱食材行未变（含 line_key）', before.oldRecipeIngredients, after.oldRecipeIngredients)
same('用户菜谱步骤行未变', before.oldRecipeSteps, after.oldRecipeSteps)
same('用户菜谱标签关联未变', before.oldRecipeTagLinks, after.oldRecipeTagLinks)
same('库存行未变（数量/单位/日期/储存方式/备注）', before.stock, after.stock)

ok('库存行数未变', countStock() === stockCountBefore, `${stockCountBefore} → ${countStock()}`)
ok('分类总数未变', countCategory() === categoryCountBefore, `${categoryCountBefore} → ${countCategory()}`)
ok('标签总数未变', countTags() === tagCountBefore, `${tagCountBefore} → ${countTags()}`)

/* ============================================================
 * ⑥ 内容包自洽性 / 与库的一致性
 * ============================================================ */

console.log('')
console.log('=== 内容包与数据库一致性 ===')
const pack = loadContentPack(DEFAULT_CONTENT_PATH)
const catNames = new Set(
  db.select({ n: schema.category.name_normalized }).from(schema.category).all().map((c) => c.n),
)
const badCat = pack.ingredients.filter((i) => !catNames.has(i.category.trim().toLowerCase()))
ok('内容包所有食材分类都命中数据库已有分类', badCat.length === 0, badCat.map((b) => b.category).join(',') || '（无）')
ok(
  '食材定义数量在 100–150 之间',
  pack.ingredients.length >= 100 && pack.ingredients.length <= 150,
  `${pack.ingredients.length}`,
)
ok(
  '所有 allowed_units 都是既有单位枚举',
  pack.ingredients.every((i) => i.allowed_units.every((u) => (UNITS as readonly string[]).includes(u))),
)
ok(
  '普通食材至少 1 个单位，调味品允许 0 个',
  pack.ingredients.every((i) => i.category === '调味品' || i.allowed_units.length >= 1),
)
ok('每道菜都带两人份说明', pack.recipes.every((r) => r.servings_note === '按两人份家庭参考量整理，非原方精确份量'))
ok('每道菜都有来源 URL', pack.recipes.every((r) => /^https?:\/\//.test(r.source_url)))
ok('verified 字段均为布尔', pack.recipes.every((r) => typeof r.verified === 'boolean'))
ok(
  '单菜步骤总字数 ≤ 200 字（自行改写，未复制长文）',
  pack.recipes.every((r) => r.steps.join('').length <= 200),
  `max=${Math.max(...pack.recipes.map((r) => r.steps.join('').length))}`,
)

// 标签全部命中已有标签（预设 32 或用户自定义）
const tagNames = new Set(db.select({ n: schema.recipeTag.name_normalized }).from(schema.recipeTag).all().map((t) => t.n))
const packagedTags = new Set(pack.recipes.flatMap((r) => r.tags))
const missingTags = [...packagedTags].filter((t) => !tagNames.has(t.trim().toLowerCase()))
ok('内容包标签全部命中已有标签（未新建）', missingTags.length === 0, missingTags.join(',') || '（无）')

// 抽查导入后的关联关系
const newRecipe = db
  .select({ id: schema.recipe.id })
  .from(schema.recipe)
  .where(eq(schema.recipe.name_normalized, '番茄炒鸡蛋'))
  .get()
ok('导入后能查到「番茄炒鸡蛋」', newRecipe !== undefined)
if (newRecipe) {
  const steps = db.select().from(schema.recipeStep).where(eq(schema.recipeStep.recipe_id, newRecipe.id)).all()
  const ings = db.select().from(schema.recipeIngredient).where(eq(schema.recipeIngredient.recipe_id, newRecipe.id)).all()
  const links = db.select().from(schema.recipeTagLink).where(eq(schema.recipeTagLink.recipe_id, newRecipe.id)).all()
  ok('该菜谱步骤已写入', steps.length >= 4, `${steps.length} 步`)
  ok('该菜谱食材行已写入', ings.length === 7, `${ings.length} 行`)
  ok('该菜谱标签关联已写入', links.length === 5, `${links.length} 个标签`)
  ok(
    '标签关联全部指向已存在标签（tag_id < 新建的菜谱 id 之前的预设区间）',
    links.every((l) => l.tag_id <= 32 + 1),
    links.map((l) => l.tag_id).join(','),
  )
}

/* ============================================================
 * ⑦ 汇总
 * ============================================================ */

console.log('')
console.log('=== 抽查：第二遍 dry-run 统计（应与第二遍写入一致，且不写库） ===')
const stockBeforeDry = countStock()
const run3 = sqlite.transaction(() => importRecipeContent(sqlite, { dryRun: true }))()
ok('dry-run：recipes_added = 0', run3.recipes_added === 0, `${run3.recipes_added}`)
ok('dry-run：recipes_skipped = 30', run3.recipes_skipped.length === 30, `${run3.recipes_skipped.length}`)
ok('dry-run：未写库', countStock() === stockBeforeDry)

const counts = {
  definitions: db.select().from(schema.ingredientDefinition).all().length,
  units: db.select().from(schema.ingredientDefinitionUnit).all().length,
  aliases: db.select().from(schema.ingredientAlias).all().length,
  recipes: db.select().from(schema.recipe).all().length,
  recipeIngredients: db.select().from(schema.recipeIngredient).all().length,
  recipeSteps: db.select().from(schema.recipeStep).all().length,
  tagLinks: db.select().from(schema.recipeTagLink).all().length,
}
console.log('')
console.log('=== 库内最终计数 ===')
console.log(JSON.stringify(counts, null, 2))

console.log('')
console.log(`===== 结果：PASS=${pass} FAIL=${fail} =====`)
console.log(`测试库位置（可人工检查）：${dbPath}`)

sqlite.close()
process.exit(fail === 0 ? 0 : 1)

/* ============================================================
 * 辅助函数
 * ============================================================ */

function countCategory(): number {
  return db.select().from(schema.category).all().length
}
function countTags(): number {
  return db.select().from(schema.recipeTag).all().length
}
function countStock(): number {
  return db.select().from(schema.standardIngredient).all().length
}
function categoryIdOf(name: string): number {
  const row = db
    .select({ id: schema.category.id })
    .from(schema.category)
    .where(eq(schema.category.name_normalized, name))
    .get()
  if (!row) throw new Error(`分类不存在：${name}`)
  return row.id
}

/** 逐字段快照：只取用户旧数据，字段顺序固定，便于 JSON 比对 */
function snapshot() {
  const defId = customDefId
  const recipeId = oldRecipe.id
  const tagId = customTag.id
  return {
    customDef: db.select().from(schema.ingredientDefinition).where(eq(schema.ingredientDefinition.id, defId)).all(),
    customDefUnits: db
      .select()
      .from(schema.ingredientDefinitionUnit)
      .where(eq(schema.ingredientDefinitionUnit.definition_id, defId))
      .all(),
    customDefAliases: db.select().from(schema.ingredientAlias).where(eq(schema.ingredientAlias.definition_id, defId)).all(),
    customTag: db.select().from(schema.recipeTag).where(eq(schema.recipeTag.id, tagId)).all(),
    oldRecipe: db.select().from(schema.recipe).where(eq(schema.recipe.id, recipeId)).all(),
    oldRecipeIngredients: db
      .select()
      .from(schema.recipeIngredient)
      .where(eq(schema.recipeIngredient.recipe_id, recipeId))
      .all(),
    oldRecipeSteps: db.select().from(schema.recipeStep).where(eq(schema.recipeStep.recipe_id, recipeId)).all(),
    oldRecipeTagLinks: db.select().from(schema.recipeTagLink).where(eq(schema.recipeTagLink.recipe_id, recipeId)).all(),
    stock: db
      .select()
      .from(schema.standardIngredient)
      .where(eq(schema.standardIngredient.definition_id, defId))
      .all(),
  }
}

function printStats(s: ReturnType<typeof importRecipeContent>): void {
  console.log(
    JSON.stringify(
      {
        definitions_added: s.definitions_added,
        definitions_reused: s.definitions_reused,
        definitions_skipped: s.definitions_skipped,
        aliases_added: s.aliases_added,
        recipes_added: s.recipes_added,
        recipes_skipped: s.recipes_skipped.length,
        tags_linked: s.tags_linked,
        tags_missing: s.tags_missing,
        aliases_skipped: s.aliases_skipped.length,
        dry_run: s.dry_run,
      },
      null,
      2,
    ),
  )
}
