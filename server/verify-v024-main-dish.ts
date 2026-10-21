/**
 * v0.2.4 验证（第二阶段）：主菜优先变化 + 围绕主菜配菜
 *
 * A 部分：**纯函数**主菜锚点（无 DB）
 *   - 优先级：荤/半荤 → 主食 → 素菜 → 无标签 → 凉菜/汤 → 甜点
 *   - 同一集合任意顺序 → 同一锚点；一餐只有一个主菜
 *   - 配菜互补度（素/汤/凉菜/主食）
 * B 部分：**纯函数**方案选择（无 DB）
 *   - 5 个不同主菜 → 5 套主菜互异；仅 2 主菜 → 最多 2 套
 *   - 硬 tier 不可被软分/主菜变化越过（ready 不被 nearly 越过）
 *   - 同 tier：食材变化更大者优先；同主料不同做法不被淘汰
 *   - 签名去重、确定性
 * C 部分：**HTTP**（隔离库）响应契约
 *   - 每套有 main_dish_recipe_id；dishes 恰好一条 main 且排第一
 *   - 主菜互异、无重复菜谱、同输入确定性、只读
 *
 * ⚠️ 全程隔离临时库；绝不触碰 server/data；绝不设置 HOME_CHEF_ALLOW_REAL_DB。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-main-dish.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath, startServer, waitForReady } from './harness/server-lifecycle.js'
import {
  enumerateCombinations,
  evaluateCombination,
  planLevel,
  planLevelRank,
  scoreBreakdown,
} from './src/services/recommendationAlgorithm.js'
import type {
  DefinitionMetaMap,
  DishSpec,
  RecipeTagInput,
  StockIndex,
} from './src/services/recommendationAlgorithm.js'
import { quantityCoverageBucket } from './src/services/recommendationRanking.js'
import {
  anchorRankOf,
  mainDishAnchorOf,
  sideComplementScore,
  NO_ROLE_RANK,
} from './src/services/mainDish.js'
import { selectDistinctMainPlans } from './src/services/planSelection.js'
import type { SelectablePlan } from './src/services/planSelection.js'

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

/* ============================================================
 * 构造工具（纯函数部分）
 * ============================================================ */

const ROLE_CODE: Record<string, string> = {
  meat: 'dish_type.meat',
  vegetable: 'dish_type.vegetable',
  mixed: 'dish_type.mixed',
  soup: 'dish_type.soup',
  cold: 'dish_type.cold',
  staple: 'dish_type.staple',
  dessert: 'dish_type.dessert',
}

function tagRef(role: string): RecipeTagInput {
  return { name: role, category: 'dish_type', code: ROLE_CODE[role] ?? null }
}

function dish(
  recipeId: number,
  roles: string[],
  lines: Array<[number, string, number | null, string | null]>,
): DishSpec {
  return {
    recipe_id: recipeId,
    recipe_name: `菜${recipeId}`,
    tags: roles,
    tag_refs: roles.map(tagRef),
    servings: 1,
    lines: lines.map(([definition_id, definition_name, quantity, unit], i) => ({
      definition_id,
      definition_name,
      quantity,
      unit,
      sort_order: i,
    })),
  }
}

function candidate(
  planId: string,
  tierKey: string,
  score: number,
  mainId: number,
  recipeIds: number[],
  mainDefs: number[],
  sideComplement: number,
  mainRank = 1,
): SelectablePlan {
  return {
    plan_id: planId,
    tier_key: tierKey,
    score,
    main_dish_recipe_id: mainId,
    main_dish_rank: mainRank,
    recipe_ids: recipeIds,
    main_definition_ids: mainDefs,
    side_complement: sideComplement,
  }
}

/* ============================================================
 * A. 主菜锚点
 * ============================================================ */

function anchorTests(): void {
  console.log('\n[A] 主菜锚点（纯函数）')

  const meat = dish(11, ['meat'], [[1, '猪肉', 200, '克']])
  const veg = dish(12, ['vegetable'], [[2, '青菜', 100, '克']])
  const soup = dish(13, ['soup'], [[3, '番茄', 100, '克']])
  const staple = dish(14, ['staple'], [[4, '米', 100, '克']])

  ok(
    'A1 荤菜优先于主食/素菜/汤',
    mainDishAnchorOf([veg, soup, staple, meat])?.recipe_id === 11,
    String(mainDishAnchorOf([veg, soup, staple, meat])?.recipe_id),
  )
  ok(
    'A2 没有荤菜时主食优先',
    mainDishAnchorOf([veg, soup, staple])?.recipe_id === 14,
  )
  ok(
    'A3 只有素菜/汤时选素菜（rank=3）',
    (() => {
      const a = mainDishAnchorOf([soup, veg])
      return a?.recipe_id === 12 && a.rank === 3
    })(),
  )

  const noTag = dish(15, [], [[5, '土豆', 100, '克']])
  ok(
    'A4 全无标签 → 锚点存在且 rank 为「无标签」档',
    (() => {
      const a = mainDishAnchorOf([noTag, noTag])
      return a !== null && a.recipe_id === 15 && a.rank === NO_ROLE_RANK && a.role === null
    })(),
  )
  ok(
    'A5 纯素整餐 → 锚点存在（不因没有荤菜而失败）',
    (() => {
      const a = mainDishAnchorOf([veg, dish(16, ['vegetable'], [[6, '豆腐', 100, '克']])])
      return a !== null && a.rank === 3
    })(),
  )

  const mixed = dish(17, ['mixed'], [[7, '鸡蛋', 2, '个']])
  ok(
    'A6 半荤半素与荤菜同档（rank=1）',
    anchorRankOf(mixed) === 1 && mainDishAnchorOf([mixed, veg])?.recipe_id === 17,
  )

  const multiRole = dish(18, ['vegetable', 'meat'], [[8, '牛肉', 100, '克']])
  ok(
    'A7 多标签菜按最高优先级判定，且角色确定',
    (() => {
      const a = mainDishAnchorOf([multiRole, veg])
      return a?.recipe_id === 18 && a.rank === 1 && a.role === 'meat'
    })(),
  )

  // 排列不变性：同一集合的 6 种顺序必须得到同一锚点
  const set = [veg, meat, staple, soup]
  const perms = [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
    [3, 1, 2, 0],
    [0, 3, 1, 2],
  ]
  const anchors = perms.map((p) => mainDishAnchorOf(p.map((i) => set[i]))?.recipe_id)
  ok(
    'A8 同一集合任意顺序 → 同一主菜锚点',
    anchors.every((a) => a === anchors[0]) && anchors[0] === 11,
    JSON.stringify(anchors),
  )

  ok(
    'A9 一餐只有一个主菜：锚点唯一且属于该集合',
    (() => {
      const a = mainDishAnchorOf(set)
      return a !== null && set.filter((d) => d.recipe_id === a.recipe_id).length === 1
    })(),
  )

  const meatOnlySides = dish(21, ['meat'], [[9, '鸡腿', 2, '个']])
  const sidesGood = sideComplementScore([meat, veg, soup], 11)
  const sidesAllMeat = sideComplementScore([meat, meatOnlySides, dish(22, ['meat'], [[9, '鸡腿', 1, '个']])], 11)
  ok(
    'A10 配菜有素菜/汤时互补分更高；全是纯荤时被扣分',
    sidesGood > 0 && sidesAllMeat < sidesGood,
    `good=${sidesGood} allMeat=${sidesAllMeat}`,
  )
  ok(
    'A11 只有主菜（无配菜）时互补分为 0',
    sideComplementScore([meat], 11) === 0,
  )
  ok(
    'A12 带主食/凉菜的配菜同样加分',
    sideComplementScore([meat, staple, dish(23, ['cold'], [[10, '黄瓜', 1, '根']])], 11) > 0,
  )

  /* ---- 角色档位：只有汤/凉菜/甜点时不能被误判成「无标签 4」 ---- */
  const soupOnly = dish(31, ['soup'], [[11, '紫菜', 10, '克']])
  const dessertOnly = dish(32, ['dessert'], [[12, '红豆', 50, '克']])
  ok(
    'A13 只有汤的菜 rank=5、只有甜点的菜 rank=6（不再落到无标签档 4）',
    anchorRankOf(soupOnly) === 5 && anchorRankOf(dessertOnly) === 6,
    `soup=${anchorRankOf(soupOnly)} dessert=${anchorRankOf(dessertOnly)}`,
  )
  ok(
    'A14 混合输入：无标签(4) 优先于 汤(5)，汤(5) 优先于 甜点(6)',
    mainDishAnchorOf([dessertOnly, soupOnly, noTag])?.recipe_id === 15 &&
      mainDishAnchorOf([dessertOnly, soupOnly])?.recipe_id === 31 &&
      mainDishAnchorOf([dessertOnly])?.recipe_id === 32,
    `${mainDishAnchorOf([dessertOnly, soupOnly, noTag])?.recipe_id}/${mainDishAnchorOf([dessertOnly, soupOnly])?.recipe_id}`,
  )
}

/* ============================================================
 * B. 方案选择
 * ============================================================ */

function selectionTests(): void {
  console.log('\n[B] 方案选择（纯函数）')

  const TIER_READY = '0|0|20'

  // 5 个不同主菜 + 足够副菜：每个主菜各一套
  const five = [101, 102, 103, 104, 105].map((id) =>
    candidate(`p${id}`, TIER_READY, 900, id, [id, 201, 202], [id * 10], 4),
  )
  const fiveSelected = selectDistinctMainPlans(five, 5)
  ok(
    'B1 5 个不同主菜 → 5 套，主菜互不相同',
    fiveSelected.length === 5 &&
      new Set(fiveSelected.map((i) => five[i].main_dish_recipe_id)).size === 5,
    `n=${fiveSelected.length}`,
  )

  // 仅 2 个主菜、多个副菜组合：最多 2 套（不许换副菜凑数）
  const twoMains = [
    candidate('a1', TIER_READY, 900, 201, [201, 301, 302], [2010], 4),
    candidate('a2', TIER_READY, 880, 201, [201, 301, 303], [2010], 4),
    candidate('a3', TIER_READY, 870, 201, [201, 302, 303], [2010], 4),
    candidate('b1', TIER_READY, 860, 202, [202, 301, 302], [2020], 4),
    candidate('b2', TIER_READY, 850, 202, [202, 301, 303], [2020], 4),
  ]
  const twoSelected = selectDistinctMainPlans(twoMains, 5)
  ok(
    'B2 仅 2 个主菜 → 最多 2 套（不靠换副菜凑数）',
    twoSelected.length === 2 &&
      new Set(twoSelected.map((i) => twoMains[i].main_dish_recipe_id)).size === 2,
    `n=${twoSelected.length}`,
  )

  // 硬 tier：ready(0) 永远排在 nearly(1)/missing(2) 之前
  const tiers = [
    candidate('m1', '0|0|20', 500, 301, [301, 401], [3010], 0),
    candidate('m2', '0|0|18', 490, 302, [302, 401], [3020], 0),
    candidate('n1', '1|0|20', 9000, 303, [303, 401], [3030], 4),
    candidate('n2', '1|0|18', 8000, 304, [304, 401], [3040], 4),
  ]
  const tierSelected = selectDistinctMainPlans(tiers, 2)
  ok(
    'B3 ready 档（tier 0）不会被更高分的 nearly 越过',
    tierSelected.length === 2 &&
      tierSelected.every((i) => tiers[i].tier_key.startsWith('0|')),
    tierSelected.map((i) => tiers[i].plan_id).join(','),
  )

  /**
   * 同 tier：先选一个基准（分最高），再比较两个同分方案 ——
   * 与已选主菜高度重合的排后，食材完全不同的排前。
   */
  const similar = [
    candidate('base', TIER_READY, 1000, 401, [401, 501], [1, 2, 3, 4], 4),
    candidate('same', TIER_READY, 900, 402, [402, 501], [1, 2, 3, 4], 4), // 与已选主菜完全相同
    candidate('diff', TIER_READY, 900, 403, [403, 501], [9, 8, 7, 6], 4), // 完全不同
  ]
  const similarSelected = selectDistinctMainPlans(similar, 3)
  ok(
    'B4 同分同档：主菜食材变化更大的方案排在相似方案之前',
    similarSelected.length === 3 &&
      similar[similarSelected[0]].plan_id === 'base' &&
      similar[similarSelected[1]].plan_id === 'diff' &&
      similar[similarSelected[2]].plan_id === 'same',
    JSON.stringify(similarSelected.map((i) => similar[i].plan_id)),
  )

  // 同主料不同做法：不淘汰，仍各出一套
  const sameIngredient = [
    candidate('d1', TIER_READY, 900, 501, [501, 601], [1, 2, 3], 4),
    candidate('d2', TIER_READY, 899, 502, [502, 601], [1, 2, 3], 4), // 主料完全相同
  ]
  const sameSelected = selectDistinctMainPlans(sameIngredient, 2)
  ok(
    'B5 同主料不同做法（红烧鸡/咖喱鸡）不被硬淘汰，仍能各出一套',
    sameSelected.length === 2,
    `n=${sameSelected.length}`,
  )

  // 同 tier 配菜互补：基础分相同、主菜不同，互补分高者先
  const complement = [
    candidate('c1', TIER_READY, 800, 601, [601, 701], [6010], 1),
    candidate('c2', TIER_READY, 800, 602, [602, 701], [6020], 9),
  ]
  const complementSelected = selectDistinctMainPlans(complement, 2)
  ok(
    'B6 同档同分：配菜互补度高的方案先被选中',
    complementSelected[0] === 1,
    JSON.stringify(complementSelected),
  )

  // 签名去重
  const duplicated = [
    candidate('same', TIER_READY, 900, 701, [701, 801], [7010], 4),
    candidate('same', TIER_READY, 900, 701, [701, 801], [7010], 4),
    candidate('other', TIER_READY, 800, 702, [702, 801], [7020], 4),
  ]
  const depupSelected = selectDistinctMainPlans(duplicated, 5)
  ok(
    'B7 相同 plan_id 只出现一次',
    new Set(depupSelected.map((i) => duplicated[i].plan_id)).size === depupSelected.length,
    JSON.stringify(depupSelected),
  )

  // 确定性
  const again = selectDistinctMainPlans(five, 5)
  ok('B8 同一输入两次选择结果完全相同', JSON.stringify(again) === JSON.stringify(fiveSelected))

  // 空输入
  ok('B9 空候选 → 返回空数组（不抛错）', selectDistinctMainPlans([], 5).length === 0)

  /* ------------------------------------------------------------------
   * B10：2 荤主菜 + 4 副菜、3 菜餐（**真实枚举 + 真实评估**）
   * 目标：所有组合同一库存档时，只给 2 套，绝不拿「全副菜组合」凑第 3 套。
   * ------------------------------------------------------------------ */
  {
    const meta: DefinitionMetaMap = new Map([
      [1, { is_seasoning: false, category_name: '猪肉' }],
      [2, { is_seasoning: false, category_name: '鸡肉' }],
      [3, { is_seasoning: false, category_name: '蔬菜' }],
    ])
    const lots = (definitionId: number) => [
      {
        definition_id: definitionId,
        unit: '克',
        quantity: 5000,
        expiry_status: 'normal' as const,
      },
    ]
    const stock: StockIndex = new Map([
      [1, lots(1)],
      [2, lots(2)],
      [3, lots(3)],
    ])

    const meals: DishSpec[] = [
      dish(1, ['meat'], [[1, '猪肉', 100, '克']]),
      dish(2, ['meat'], [[2, '鸡肉', 100, '克']]),
      dish(3, ['vegetable'], [[3, '青菜', 100, '克']]),
      dish(4, ['vegetable'], [[3, '青菜', 100, '克']]),
      dish(5, ['soup'], [[3, '青菜', 100, '克']]),
      dish(6, ['cold'], [[3, '青菜', 100, '克']]),
    ]

    const combos = enumerateCombinations([0, 1, 2, 3, 4, 5], 3)
    const enumerated: SelectablePlan[] = []
    for (const combo of combos) {
      const comboDishes = combo.map((i) => meals[i])
      const evaluation = evaluateCombination(comboDishes, stock, meta)
      const anchor = mainDishAnchorOf(comboDishes)
      if (anchor === null) continue
      const rank = planLevelRank(planLevel(evaluation))
      enumerated.push(
        candidate(
          comboDishes.map((d) => `r${d.recipe_id}`).join('-'),
          `${rank}|${evaluation.main_missing_count}|${quantityCoverageBucket(evaluation.quantity_coverage)}`,
          scoreBreakdown(evaluation).total,
          anchor.recipe_id,
          comboDishes.map((d) => d.recipe_id),
          [1],
          sideComplementScore(comboDishes, anchor.recipe_id),
          anchor.rank,
        ),
      )
    }
    enumerated.sort((a, b) =>
      a.tier_key < b.tier_key ? -1 : a.tier_key > b.tier_key ? 1 : 0,
    )

    const picked = selectDistinctMainPlans(enumerated, 5)
    ok(
      'B10 2 荤主菜 + 4 副菜（3 菜餐）→ 只给 2 套，不用全副菜组合凑数',
      picked.length === 2 &&
        new Set(picked.map((i) => enumerated[i].main_dish_recipe_id)).size === 2 &&
        picked.every((i) => enumerated[i].main_dish_rank === 1),
      `n=${picked.length} ranks=${JSON.stringify(picked.map((i) => enumerated[i].main_dish_rank))}`,
    )
  }

  /* ------------------------------------------------------------------
   * B11：同 tier 内「主菜食材变化」优先于**巨大的**旧总分差
   * ------------------------------------------------------------------ */
  {
    const bigScore = [
      candidate('base', TIER_READY, 100, 801, [801, 901], [1, 2, 3], 12),
      candidate('simHigh', TIER_READY, 50000, 802, [802, 901], [1, 2, 3], 10),
      candidate('simLow', TIER_READY, 100, 803, [803, 901], [7, 8, 9], 1),
    ]
    const picked = selectDistinctMainPlans(bigScore, 3)
    ok(
      'B11 主菜食材变化优先：同主料的方案即使 50000 分也排在食材不同的方案之后',
      picked.length === 3 &&
        bigScore[picked[0]].plan_id === 'base' &&
        bigScore[picked[1]].plan_id === 'simLow' &&
        bigScore[picked[2]].plan_id === 'simHigh',
      JSON.stringify(picked.map((i) => bigScore[i].plan_id)),
    )
  }

  /* ------------------------------------------------------------------
   * B12：同为食材变化档时，配菜互补优先于旧总分
   * ------------------------------------------------------------------ */
  {
    const compVsScore = [
      candidate('compHigh', TIER_READY, 100, 811, [811, 911], [11, 12], 9),
      candidate('scoreHigh', TIER_READY, 9000, 812, [812, 911], [21, 22], 1),
    ]
    const picked = selectDistinctMainPlans(compVsScore, 2)
    ok(
      'B12 同 tier 同相似度：配菜互补优先于旧总分（9000 分不能盖过互补）',
      picked.length === 2 && picked[0] === 0,
      JSON.stringify(picked),
    )
  }
}

// ⚠️ 纯函数测试必须真的执行（上一轮曾漏调用，导致只写不跑）
anchorTests()
selectionTests()

/* ============================================================
 * C. HTTP（隔离库）
 * ============================================================ */

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-main-${randomUUID()}`)
const dbPath = resolve(runRoot, `v024-main-${Date.now()}.db`)
const realDb = resolve(serverRoot, 'data', 'homechef.db')
const PORT = 64600 + Math.floor(Math.random() * 300)
const BASE = `http://127.0.0.1:${PORT}`

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

try {
  assertSafeDbPath(dbPath, serverRoot)
} catch (e: any) {
  abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
}
if (resolve(dbPath).toLowerCase() === realDb.toLowerCase()) abort('测试库路径等于真实库')
if (!resolve(dbPath).startsWith(resolve(runRoot))) abort('测试库不在本次运行目录内')

mkdirSync(runRoot, { recursive: true })
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(serverRoot, 'drizzle')
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrations) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) setup.exec(t)
  }
}

const now = new Date().toISOString()
const catRows = setup.prepare('select id, name from category').all() as Array<{
  id: number
  name: string
}>
const catId = new Map(catRows.map((c) => [c.name, c.id]))
function requireCat(name: string): number {
  const id = catId.get(name)
  if (id === undefined) throw new Error(`测试数据依赖的分类不存在：${name}`)
  return id
}

/** 食材定义：id → 名称 */
const DEFS: Array<[number, string, string]> = [
  [1, '猪肉', '猪肉'],
  [2, '青椒', '蔬菜'],
  [3, '土豆', '蔬菜'],
  [4, '鸡蛋', '蛋类'],
  [5, '番茄', '蔬菜'],
  [6, '米', '主食/谷物'],
  [7, '青菜', '蔬菜'],
  [8, '豆腐', '豆制品'],
  [9, '黄瓜', '蔬菜'],
  [10, '紫菜', '蔬菜'],
  [11, '盐', '调味品'],
]
for (const [id, name, cat] of DEFS) {
  setup
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(id, name, name, requireCat(cat), now, now)
}

function insertRecipe(id: number, name: string, lines: Array<[number, number, string]>) {
  setup
    .prepare('insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)')
    .run(id, name, name, now, now)
  let order = 0
  for (const [defId, qty, unit] of lines) {
    setup
      .prepare(
        'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
      )
      .run(id, defId, qty, unit, order, `lk-${id}-${order}`, now, now)
    order++
  }
}

/** 按预设 Tag 名称挂到菜谱（0012 已播种系统预设） */
function linkTagByName(recipeId: number, tagName: string) {
  const tag = setup
    .prepare('select id from recipe_tag where name_normalized = ?')
    .get(tagName.toLowerCase()) as { id: number } | undefined
  if (!tag) throw new Error(`测试数据依赖的 Tag 不存在：${tagName}`)
  setup
    .prepare('insert or ignore into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)')
    .run(recipeId, tag.id, now)
}

// 5 个主菜（4 荤 + 1 半荤半素）
insertRecipe(1, '青椒炒肉', [[1, 200, '克'], [2, 100, '克'], [11, 2, '克']])
linkTagByName(1, '荤菜')
insertRecipe(2, '土豆炖肉', [[1, 200, '克'], [3, 150, '克']])
linkTagByName(2, '荤菜')
insertRecipe(3, '番茄炒蛋', [[4, 3, '个'], [5, 150, '克']])
linkTagByName(3, '荤菜')
insertRecipe(4, '豆腐青椒', [[8, 200, '克'], [2, 100, '克']])
linkTagByName(4, '半荤半素')
insertRecipe(5, '青菜炒肉', [[1, 150, '克'], [7, 150, '克']])
linkTagByName(5, '荤菜')

// 4 个副菜：汤 / 素菜 / 主食 / 凉菜
insertRecipe(6, '番茄蛋汤', [[5, 100, '克'], [4, 1, '个']])
linkTagByName(6, '汤')
insertRecipe(7, '清炒青菜', [[7, 200, '克']])
linkTagByName(7, '素菜')
insertRecipe(8, '米饭', [[6, 200, '克']])
linkTagByName(8, '主食')
insertRecipe(9, '凉拌黄瓜', [[9, 150, '克']])
linkTagByName(9, '凉菜')

// 库存充足：避免测试选中的组合本身因共用库存变不足
const STOCK: Array<[number, number, string]> = [
  [1, 5000, '克'],
  [2, 3000, '克'],
  [3, 3000, '克'],
  [4, 100, '个'],
  [5, 3000, '克'],
  [6, 5000, '克'],
  [7, 3000, '克'],
  [8, 3000, '克'],
  [9, 2000, '克'],
  [10, 1000, '克'],
  [11, 500, '克'],
]
for (const [defId, qty, unit] of STOCK) {
  setup
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(defId, qty, unit, '2026-01-01', null, null, '常温', now, now)
}

setup.close()

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

interface Res {
  status: number
  body: any
}
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  let parsed: any
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  return { status: res.status, body: parsed }
}

function dbDigest(): string {
  const tables = [
    'recipe',
    'recipe_ingredient',
    'recipe_step',
    'recipe_tag',
    'recipe_tag_link',
    'recipe_preference',
    'standard_ingredient',
    'ingredient_definition',
    'category',
    'cooking_session',
    'cooking_session_dish',
    'cooking_settlement',
    'cooking_settlement_item',
    'cooking_session_dish_skip',
    'app_settings',
    'recommendation_request',
  ]
  const parts: string[] = []
  for (const t of tables) {
    const rows = raw.prepare(`select * from "${t}" order by rowid`).all()
    parts.push(`${t}:${rows.length}:${JSON.stringify(rows)}`)
  }
  return parts.join('|')
}

let server: ReturnType<typeof startServer> | null = null

try {
  server = startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })

  console.log('\n[C] HTTP 契约（隔离库）')

  const digestBefore = dbDigest()
  const first = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('C1 推荐接口 200 且有方案', first.status === 200 && (first.body?.plans ?? []).length > 0, `${first.status}`)
  if (first.status !== 200 || (first.body?.plans ?? []).length === 0) {
    throw new Error('C1 前置失败：没有方案，后续断言不可信')
  }

  const plans: any[] = first.body.plans

  ok(
    'C2 每套方案都有 main_dish_recipe_id（正整数）',
    plans.every((p) => Number.isInteger(p.main_dish_recipe_id) && p.main_dish_recipe_id > 0),
    JSON.stringify(plans.map((p) => p.main_dish_recipe_id)),
  )
  ok(
    'C3 每套方案恰好一条 role_in_meal=main，且与 main_dish_recipe_id 一致',
    plans.every((p) => {
      const mains = (p.dishes ?? []).filter((d: any) => d.role_in_meal === 'main')
      return mains.length === 1 && mains[0].recipe_id === p.main_dish_recipe_id
    }),
  )
  ok(
    'C4 主菜排在 dishes 第一位',
    plans.every((p) => p.dishes?.[0]?.recipe_id === p.main_dish_recipe_id),
  )
  ok(
    'C5 返回的方案主菜互不相同（一个主菜最多一套）',
    new Set(plans.map((p) => p.main_dish_recipe_id)).size === plans.length,
    JSON.stringify(plans.map((p) => p.main_dish_recipe_id)),
  )
  ok(
    'C6 每套方案内部没有重复菜谱',
    plans.every((p) => {
      const ids = (p.dishes ?? []).map((d: any) => d.recipe_id)
      return new Set(ids).size === ids.length
    }),
  )
  ok(
    'C7 方案数不超过 5 套',
    plans.length <= 5,
    String(plans.length),
  )

  const digestAfterFirst = dbDigest()
  const second = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok(
    'C8 同输入同一天两次调用，方案结构完全一致（确定性）',
    JSON.stringify(second.body?.plans) === JSON.stringify(first.body?.plans),
  )
  ok(
    'C9 推荐是只读的：两次调用前后全库摘要不变',
    digestBefore === digestAfterFirst && digestAfterFirst === dbDigest(),
  )

  // 调味品库存变化不得影响推荐结果（它不计库存、不扣量）
  raw
    .prepare('update standard_ingredient set quantity = quantity + 500 where definition_id = 11')
    .run()
  const afterSalt = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok(
    'C10 只改调味品（盐）库存 → 推荐结果完全不变',
    JSON.stringify(afterSalt.body?.plans) === JSON.stringify(first.body?.plans),
  )

  // 纯素 / 无标签 / 仅 1 菜：直接改库后各再查一次（仍是同一个只读接口）
  console.log('\n[D] 边界：纯素 / 全无标签 / 仅 1 菜')

  raw.prepare('delete from recipe_tag_link where recipe_id in (1,2,3,4,5,6)').run()
  const vegOnly = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok(
    'D1 纯素/无标签时仍能返回非空方案，且每套都有主菜锚点',
    vegOnly.status === 200 &&
      (vegOnly.body?.plans ?? []).length > 0 &&
      (vegOnly.body?.plans ?? []).every((p: any) => Number.isInteger(p.main_dish_recipe_id)),
    `${vegOnly.status}/${(vegOnly.body?.plans ?? []).length}`,
  )

  // 只剩一道菜：recipe 7 原本就只挂了「素菜」，按 Tag 过滤即可收窄到单菜
  const single = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['素菜'],
    tag_mode: 'and',
  })
  ok(
    'D2 仅 1 道菜时仍返回 1 套、主菜即该菜（不为空、不报错）',
    single.status === 200 &&
      (single.body?.plans ?? []).length === 1 &&
      single.body.plans[0].main_dish_recipe_id === 7 &&
      single.body.plans[0].dishes.length === 1 &&
      single.body.plans[0].dishes[0].role_in_meal === 'main',
    `${single.status}/${JSON.stringify((single.body?.plans ?? []).map((p: any) => p.main_dish_recipe_id))}`,
  )
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    await server?.stop()
  } catch (e: any) {
    console.error(`[WARN] stop: ${String(e?.message ?? e)}`)
  }
  try {
    raw.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-main-')) {
      console.error(`[WARN] 拒绝清理：目录名前缀不符 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(`[WARN] 清理失败需人工处理 —— ${resolve(runRoot)}；原因：${String(e?.message ?? e)}`)
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
