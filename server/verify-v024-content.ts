/**
 * v0.2.4 验证：测试内容包 + 测试库存（隔离临时库）
 *
 * 覆盖：
 *   - 生成器条数区间（≥1000，≤1500）、名称唯一、可计算主料、步骤非空；
 *   - dry-run **零写入**，预测与 apply 一致；
 *   - apply 后第二遍新增 0（幂等）；菜谱/配料/步骤/标签结构完整；
 *   - 库存：按单位补差额、期限拉长到 ≥ 今天+90、第二次同日 0 变更。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-content.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from './src/db/safe-db-path.js'
import { generateContent } from './seed/v024-content/recipes.js'
import { importContentV024 } from './seed/v024-content/importer.js'
import { applyStock, planStock } from './seed/v024-content/stock.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-content-${randomUUID()}`)
const dbPath = resolve(runRoot, `content-${Date.now()}.db`)
const realData = resolve(serverRoot, 'data')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
}
if (!resolve(dbPath).startsWith(resolve(runRoot))) abort('测试库不在运行目录内')
if (resolve(dbPath).toLowerCase().startsWith(realData.toLowerCase())) abort('测试库在 server/data 内')

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(serverRoot, 'drizzle')
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
for (const file of readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

const countOf = (sql: string) => (db.prepare(sql).get() as { c: number }).c

try {
  console.log('\n[A] 生成器质量（纯内存）')

  const content = generateContent()
  const WESTERN_CUISINES = new Set(['意式', '美式', '法式', '地中海', '西式家常'])
  const chineseCount = content.recipes.filter((r) => !WESTERN_CUISINES.has(r.cuisine ?? '')).length
  const westernCount = content.recipes.length - chineseCount

  ok(
    'A1 中式 ≥ 1000、西式 ≥ 200、总数 ≤ 1500',
    chineseCount >= 1000 && westernCount >= 200 && content.recipes.length <= 1500,
    `中式=${chineseCount} 西式=${westernCount} 总数=${content.recipes.length}`,
  )
  ok('A1b 总数 1000 多（≥ 1200）', content.recipes.length >= 1200, String(content.recipes.length))

  const names = content.recipes.map((r) => r.name.trim().toLowerCase())
  ok('A2 名称归一后唯一', new Set(names).size === names.length, `${new Set(names).size}/${names.length}`)

  const noMain = content.recipes.filter((r) => {
    return !r.ingredients.some((i) => i.quantity !== null && i.unit !== null)
  })
  ok('A3 每条都有可计算主料', noMain.length === 0, noMain.slice(0, 3).map((r) => r.name).join(','))

  const badSteps = content.recipes.filter((r) => r.steps.length < 2 || r.steps.some((s) => s.trim().length === 0))
  ok('A4 步骤至少 2 步且非空', badSteps.length === 0, badSteps.slice(0, 3).map((r) => r.name).join(','))

  const dupIngredient = content.recipes.filter((r) => {
    const set = new Set(r.ingredients.map((i) => i.definition))
    return set.size !== r.ingredients.length
  })
  ok('A5 同一菜谱内食材不重复堆叠', dupIngredient.length === 0, String(dupIngredient.length))

  const cuisines = new Set(content.recipes.map((r) => r.cuisine))
  ok('A6 菜系覆盖 ≥ 8 类', cuisines.size >= 8, String(cuisines.size))

  ok('A7 西式 ≥ 200 且 ≤ 300', westernCount >= 200 && westernCount <= 300, String(westernCount))

  // 做法与配料一致性（防「蒜蓉没蒜 / 干煸没辣椒 / 白灼标炒」）
  const rice = content.recipes.find((r) => r.name.startsWith('蒜蓉'))!
  ok('A8 蒜蓉菜一定含蒜', rice.ingredients.some((i) => i.definition === '蒜'))
  const dryDish = content.recipes.find((r) => r.name.startsWith('干煸'))!
  ok('A9 干煸菜含干辣椒', dryDish.ingredients.some((i) => i.definition === '干辣椒'))
  const boiled = content.recipes.find((r) => r.name.startsWith('白灼'))!
  ok('A10 白灼是水煮做法', boiled.method === '煮' && boiled.steps.some((s) => s.includes('水')))
  const cold = content.recipes.find((r) => r.name.startsWith('泡椒'))!
  ok('A11 泡椒凉菜含泡椒', cold.ingredients.some((i) => i.definition === '泡椒'))
  const tofuStir = content.recipes.find((r) => r.name === '青椒炒豆干')
  ok('A12 豆制品类炒菜不是荤菜', tofuStir === undefined || tofuStir.dish_type === '素菜',
    tofuStir?.dish_type)
  ok('A13 青椒炒菜默认不贴香辣', (content.recipes.find((r) => r.name.startsWith('青椒炒'))?.flavor ?? '咸鲜') === '咸鲜')
  const soupNames = content.recipes.filter((r) => r.dish_type === '汤').map((r) => r.name)
  ok('A14 汤名不重名', new Set(soupNames.map((n) => n.toLowerCase())).size === soupNames.length)

  console.log('\n[A9] 运行时质量闸门（负例，全部应被拒绝）')

  const goodBase = {
    content_version: 'fixture',
    provenance: 'curated-test' as const,
    recipe_count: 0,
    definitions: content.definitions,
  }
  const mkRecipe = (over: Record<string, unknown>) => ({
    name: `负例${Math.random().toString(36).slice(2, 7)}`,
    cuisine: '川菜',
    dish_type: '荤菜',
    flavor: '咸鲜',
    method: '炒',
    features: ['家常'],
    servings_note: 'x',
    ingredients: [{ definition: '猪肉', quantity: 200, unit: '克' }],
    steps: ['切配。', '炒熟。'],
    provenance: 'curated-test' as const,
    note: 'x',
    ...over,
  })

  const cases: Array<[string, Record<string, unknown>]> = [
    ['负数量', { ingredients: [{ definition: '猪肉', quantity: -5, unit: '克' }] }],
    ['零主料', { ingredients: [{ definition: '猪肉', quantity: 0, unit: '克' }] }],
    ['NaN 数量', { ingredients: [{ definition: '猪肉', quantity: Number.NaN, unit: '克' }] }],
    ['无单位主料', { ingredients: [{ definition: '猪肉', quantity: 200, unit: null }] }],
    ['空步骤', { steps: [] }],
    ['缺做法标签', { method: '不存在的做法' }],
    ['伪造 verified', { verified: true }],
    ['伪造 source_url', { source_url: 'https://example.com' }],
  ]
  for (const [label, over] of cases) {
    const stats = importContentV024(db, { ...goodBase, recipes: [mkRecipe(over) as never] }, { dryRun: true })
    ok(`A9 ${label} 被拒绝`, stats.inserted_recipes === 0 && stats.skipped_invalid === 1,
      `ins=${stats.inserted_recipes} bad=${stats.skipped_invalid}`)
  }

  let provenanceErr: any = null
  try {
    importContentV024(db, { ...goodBase, provenance: 'fake' as never, recipes: [] }, { dryRun: true })
  } catch (e) {
    provenanceErr = e
  }
  ok('A9 provenance≠curated-test 直接抛错', provenanceErr !== null)

  const badUnitContent = {
    ...goodBase,
    definitions: [{ name: '测试料', category: '蔬菜', allowed_units: ['片'] }],
    recipes: [mkRecipe({ ingredients: [{ definition: '测试料', quantity: 10, unit: '克' }] }) as never],
  }
  const badUnitStats = importContentV024(db, badUnitContent, { dryRun: true })
  ok('A9 非法声明单位被记录并拒绝该菜谱',
    badUnitStats.invalid_declared_units.length === 1 &&
      badUnitStats.inserted_recipes === 0,
    JSON.stringify(badUnitStats.invalid_declared_units))

  console.log('\n[B] dry-run 零写入 + apply 幂等')

  const beforeRecipes = countOf('select count(*) as c from recipe')
  const beforeDefs = countOf('select count(*) as c from ingredient_definition')
  const beforeStock = countOf('select count(*) as c from standard_ingredient')

  const dry = importContentV024(db, content, { dryRun: true })
  ok(
    'B1 dry-run 零写入',
    countOf('select count(*) as c from recipe') === beforeRecipes &&
      countOf('select count(*) as c from ingredient_definition') === beforeDefs &&
      countOf('select count(*) as c from standard_ingredient') === beforeStock,
  )
  ok('B2 dry-run 预测有新增菜谱', dry.inserted_recipes > 0, String(dry.inserted_recipes))

  const applied = db.transaction(() => importContentV024(db, content, { dryRun: false }))()
  ok(
    'B3 apply 实际新增数与预测一致',
    applied.inserted_recipes === dry.inserted_recipes &&
      applied.inserted_definitions === dry.inserted_definitions,
    `apply=${applied.inserted_recipes}/${applied.inserted_definitions} dry=${dry.inserted_recipes}/${dry.inserted_definitions}`,
  )
  ok(
    'B4 菜谱库里确实多了这么多条',
    countOf('select count(*) as c from recipe') === beforeRecipes + applied.inserted_recipes,
  )

  const second = db.transaction(() => importContentV024(db, content, { dryRun: false }))()
  ok('B5 第二遍新增 0（幂等）', second.inserted_recipes === 0 && second.inserted_definitions === 0,
    `${second.inserted_recipes}/${second.inserted_definitions}`)

  console.log('\n[C] 入库结构完整性')

  const emptyRecipe = db
    .prepare(
      `select r.id from recipe r
       where not exists (select 1 from recipe_ingredient ri where ri.recipe_id = r.id) limit 5`,
    )
    .all() as Array<{ id: number }>
  ok('C1 没有空菜谱', emptyRecipe.length === 0, JSON.stringify(emptyRecipe))

  const noMainRows = db
    .prepare(
      `select r.id from recipe r
       where not exists (
         select 1 from recipe_ingredient ri
         join ingredient_definition d on d.id = ri.definition_id
         left join category c on c.id = d.category_id
         where ri.recipe_id = r.id and ri.quantity is not null and ri.unit is not null
           and (c.name is null or c.name <> '调味品')
       ) limit 5`,
    )
    .all() as Array<{ id: number }>
  ok('C2 每条都有可计算的非调味主料（DB 侧）', noMainRows.length === 0, JSON.stringify(noMainRows))

  const noTags = db
    .prepare(
      `select r.id from recipe r
       where not exists (select 1 from recipe_tag_link l where l.recipe_id = r.id) limit 5`,
    )
    .all() as Array<{ id: number }>
  ok('C3 每条菜谱至少一个标签', noTags.length === 0, JSON.stringify(noTags))

  const dupLine = db
    .prepare(
      `select recipe_id, definition_id, count(*) as c from recipe_ingredient
       group by recipe_id, definition_id having c > 1 limit 5`,
    )
    .all() as Array<{ recipe_id: number; definition_id: number; c: number }>
  ok('C4 同一菜谱不重复堆叠同一定义', dupLine.length === 0, JSON.stringify(dupLine))

  console.log('\n[D] 测试库存：补量 + 期限拉长 + 双跑幂等')

  // 先造一条「期限过短」的旧批次，验证会被拉长
  const tomato = db
    .prepare("select id from ingredient_definition where name_normalized = '番茄'")
    .get() as { id: number } | undefined
  if (tomato === undefined) throw new Error('缺少番茄定义')
  const today = new Date()
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  db.prepare(
    `insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?)`,
  ).run(tomato.id, 100, '克', '2026-01-01', iso, 'manual', '常温', nowIso(), nowIso())

  const plan1 = planStock(db)
  ok('D1 计划包含补量与期限拉长', plan1.topups.length > 0 && plan1.expiry_updates.length > 0,
    `topups=${plan1.topups.length} expiry=${plan1.expiry_updates.length}`)

  const r1 = db.transaction(() => applyStock(db, plan1))()
  ok('D2 执行结果与计划一致', r1.inserted_batches === plan1.topups.length && r1.updated_expiry === plan1.expiry_updates.length)

  const cutoff = addDays(iso, 90)
  const shortExpiry = db
    .prepare('select count(*) as c from standard_ingredient where expiry_date is not null and expiry_date < ?')
    .get(cutoff) as { c: number }
  ok('D3 所有有到期日的批次都 ≥ 今天+90 天', shortExpiry.c === 0, String(shortExpiry.c))

  const plan2 = planStock(db)
  ok('D4 同日第二次计划：无补量、无期限更新', plan2.topups.length === 0 && plan2.expiry_updates.length === 0,
    `topups=${plan2.topups.length} expiry=${plan2.expiry_updates.length}`)

  const seasoningStock = db
    .prepare(
      `select count(*) as c from standard_ingredient s
       join ingredient_definition d on d.id = s.definition_id
       join category c on c.id = d.category_id
       where c.name = '调味品' and s.quantity > 0`,
    )
    .get() as { c: number }
  ok('D5 调味品没有造数值库存', seasoningStock.c === 0, String(seasoningStock.c))

  const noteRows = db
    .prepare("select count(*) as c from standard_ingredient where note like 'v024 测试库存%'")
    .get() as { c: number }
  ok('D6 新增批次标注测试库存备注', noteRows.c === r1.inserted_batches, `${noteRows.c}/${r1.inserted_batches}`)
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    db.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === realData.toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-content-')) {
      console.error(`[WARN] 拒绝清理：目录名前缀不符 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(`[WARN] 清理失败需人工处理 —— ${resolve(runRoot)}：${String(e?.message ?? e)}`)
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
