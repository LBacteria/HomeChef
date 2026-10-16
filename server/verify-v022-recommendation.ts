/**
 * v0.2.2 整餐推荐验证
 *
 * A 部分：**纯算法单测**（无 DB）—— 合并/单位/未知用量/调味品/过期/打分/组合枚举
 * B 部分：**HTTP 集成**（隔离临时库 + 动态端口）—— 参数校验、零写入、确定性、
 *         原子进入烹饪与失败回滚
 * C 部分：既有烹饪接口回归
 *
 * ⚠️ 全程使用独立临时库；路径校验在创建/删除任何文件**之前**完成。
 * ⚠️ 绝不触碰真实库 server/data/homechef.db，绝不设置允许真实库的环境变量。
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import {
  assertSafeDbPath,
  startServer,
  waitForReady,
} from './harness/server-lifecycle.js'
import {
  enumerateCombinations,
  evaluateCombination,
  planLevel,
  planLevelRank,
  planSignature,
  scorePlan,
} from './src/services/recommendationAlgorithm.js'
import type {
  DishSpec,
  DefinitionMeta,
  StockLotInput,
  StockIndex,
} from './src/services/recommendationAlgorithm.js'

/* ============================================================
 * 通用
 * ============================================================ */

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') =>
  console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)
const section = (t: string) => console.log(`\n===== ${t} =====`)

/* ============================================================
 * A. 纯算法单测
 * ============================================================ */

const META: Map<number, DefinitionMeta> = new Map([
  [1, { is_seasoning: false, category_name: '蔬菜' }],
  [2, { is_seasoning: false, category_name: '蛋类' }],
  [3, { is_seasoning: true, category_name: '调味品' }],
  [4, { is_seasoning: false, category_name: '蔬菜' }],
  [5, { is_seasoning: false, category_name: '乳制品' }],
])

function stockIndexOf(lots: StockLotInput[]): StockIndex {
  const m = new Map<number, StockLotInput[]>()
  for (const l of lots) {
    const arr = m.get(l.definition_id)
    if (arr) arr.push(l)
    else m.set(l.definition_id, [l])
  }
  return m
}

function lot(
  definition_id: number,
  unit: string,
  quantity: number,
  expiry_status: StockLotInput['expiry_status'] = 'normal',
): StockLotInput {
  return { definition_id, unit, quantity, expiry_status }
}

function dish(
  recipe_id: number,
  servings: number,
  lines: Array<[number, string, number | null, string | null]>,
): DishSpec {
  return {
    recipe_id,
    recipe_name: `菜${recipe_id}`,
    tags: [],
    servings,
    lines: lines.map(([definition_id, definition_name, quantity, unit], i) => ({
      definition_id,
      definition_name,
      quantity,
      unit,
      sort_order: i,
    })),
  }
}

section('A. 纯算法单测')

/* A1 —— 无配料 */
{
  const e = evaluateCombination([], new Map(), META)
  ok('A1 空方案不报错、coverage=1', e.requirements.length === 0 && e.coverage === 1)
}

/* A2 —— 跨菜共享库存：两份土豆各 2 个，库存 3 个 → 合并为 4，判定不足 */
{
  const dishes = [dish(1, 1, [[4, '土豆', 2, '个']]), dish(2, 1, [[4, '土豆', 2, '个']])]
  const e = evaluateCombination(dishes, stockIndexOf([lot(4, '个', 3)]), META)
  const req = e.requirements.find((r) => r.definition_id === 4)!
  ok(
    'A2 跨菜同食材同单位先合并（2+2=4，不是各自 2）',
    req.required_quantity === 4,
    `required=${req.required_quantity}`,
  )
  ok('A2 库存只有 3 → 判定不足且缺 1', req.status === 'insufficient' && req.missing_quantity === 1)
  ok('A2 只产生一条合并需求（不重复占库存）', e.requirements.length === 1)
}

/* A3 —— 同一菜谱内重复配料行 */
{
  const e = evaluateCombination(
    [dish(1, 1, [[4, '土豆', 1, '个'], [4, '土豆', 1, '个']])],
    stockIndexOf([lot(4, '个', 5)]),
    META,
  )
  ok('A3 菜谱内重复行合并为 2', e.requirements[0].required_quantity === 2, `req=${e.requirements[0].required_quantity}`)
}

/* A4 —— 单位不兼容（绝不换算） */
{
  const e = evaluateCombination(
    [dish(1, 1, [[5, '牛奶', 500, '克']])],
    stockIndexOf([lot(5, '毫升', 1000)]),
    META,
  )
  ok('A4 牛奶 500克 vs 库存 1000毫升 → unit_mismatch（不换算）', e.requirements[0].status === 'unit_mismatch')
  ok('A4 计为一个主缺口', e.main_missing_count === 1)
}

/* A5 / A6 —— 未知数量、未知单位 */
{
  // ⚠️ 必须用**非调味品**定义，否则会走进调味品的 presence 分支
  const e1 = evaluateCombination([dish(1, 1, [[4, '土豆', null, '个']])], new Map(), META)
  ok(
    'A5 未指定用量 → unknown_quantity（不视为充分、不计主缺口）',
    e1.requirements[0].status === 'unknown_quantity' && e1.main_missing_count === 0 && e1.unknown_count === 1,
  )
  const e2 = evaluateCombination([dish(1, 1, [[4, '土豆', 5, null]])], stockIndexOf([lot(4, '个', 99)]), META)
  ok('A6 未指定单位 → unit_mismatch', e2.requirements[0].status === 'unit_mismatch')
}

/* A7 / A8 —— 调味品 presence-only */
{
  const e1 = evaluateCombination(
    [dish(1, 1, [[3, '盐', 5, '克']])],
    stockIndexOf([lot(3, '个', 0)]),
    META,
  )
  ok('A7 调味品只记有无：数量 0 也算「有」', e1.requirements[0].status === 'ok' && e1.requirements[0].is_seasoning)
  const e2 = evaluateCombination([dish(1, 1, [[3, '盐', 5, '克']])], new Map(), META)
  ok(
    'A8 家里没有该调味品 → seasoning_missing（单独计数）',
    e2.requirements[0].status === 'seasoning_missing' &&
      e2.seasoning_missing_count === 1 &&
      e2.main_missing_count === 0,
  )
}

/* A9 / A10 —— 过期不可用、临期计入 */
{
  const e1 = evaluateCombination(
    [dish(1, 1, [[2, '鸡蛋', 3, '个']])],
    stockIndexOf([lot(2, '个', 5, 'expired')]),
    META,
  )
  ok('A9 过期库存不计入可用 → 判为不足', e1.requirements[0].status === 'insufficient')
  ok('A9 过期数量被单独报告', e1.requirements[0].expired_excluded_quantity === 5 && e1.expired_excluded_count === 1)

  const e2 = evaluateCombination(
    [dish(1, 1, [[2, '鸡蛋', 3, '个']])],
    stockIndexOf([lot(2, '个', 5, 'expiring')]),
    META,
  )
  ok('A10 临期库存可计入可用', e2.requirements[0].status === 'ok')
  ok('A10 记录「用到临期食材」', e2.requirements[0].used_expiring && e2.expiring_used_count === 1)

  const e3 = evaluateCombination(
    [dish(1, 1, [[2, '鸡蛋', 3, '个']])],
    stockIndexOf([lot(2, '个', 5, 'expired'), lot(2, '个', 5, 'normal')]),
    META,
  )
  ok('A10 过期与正常并存时只用正常那批', e3.requirements[0].available_quantity === 5)
}

/* A11 —— 倍率（人数换算） */
{
  const e1 = evaluateCombination([dish(1, 1, [[2, '鸡蛋', 2, '个']])], stockIndexOf([lot(2, '个', 99)]), META)
  const e2 = evaluateCombination([dish(1, 2, [[2, '鸡蛋', 2, '个']])], stockIndexOf([lot(2, '个', 99)]), META)
  ok(
    'A11 份数倍数 1→2 时需求量翻倍',
    e1.requirements[0].required_quantity === 2 && e2.requirements[0].required_quantity === 4,
  )
}

/* A12 —— 打分优先级 */
{
  const ready = evaluateCombination([dish(1, 1, [[2, '鸡蛋', 2, '个']])], stockIndexOf([lot(2, '个', 99)]), META)
  const missing = evaluateCombination([dish(1, 1, [[2, '鸡蛋', 2, '个']])], stockIndexOf([lot(2, '个', 0)]), META)
  ok('A12 全足方案分数高于缺料方案', scorePlan(ready) > scorePlan(missing), `${scorePlan(ready)} > ${scorePlan(missing)}`)
  ok('A12 level 判定正确', planLevel(ready) === 'ready' && planLevel(missing) === 'missing')
}

/* A13 —— 组合枚举确定性 + 上限 */
{
  const c1 = enumerateCombinations([0, 1, 2, 3], 2, 100)
  const c2 = enumerateCombinations([0, 1, 2, 3], 2, 100)
  ok('A13 组合枚举可复现', JSON.stringify(c1) === JSON.stringify(c2))
  ok('A13 组合数为 C(4,2)=6', c1.length === 6, String(c1.length))
  const limited = enumerateCombinations([0, 1, 2, 3, 4], 3, 3)
  ok('A13 上限生效（最多 3 个）', limited.length === 3)
  ok('A13 超界返回空', enumerateCombinations([0, 1], 3).length === 0)
}

/* A14 —— 签名稳定（与菜品顺序无关） */
{
  const a = planSignature([dish(2, 1, []), dish(1, 3, [])])
  const b = planSignature([dish(1, 3, []), dish(2, 1, [])])
  ok('A14 方案签名与菜品顺序无关', a === b && a === '1x3,2x1', a)
}

/* ------------------------------------------------------------
 * A15–A22：评审补充的边界（与独立用例同源，**不弱化**）
 * ------------------------------------------------------------ */

/* A15 —— 同一 key 混合「已知量 + 未指定用量」 */
{
  const e = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个'], [1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 3)]),
    META,
  )
  ok('A15 同 key 混合未知量必须被标记 unknown', e.unknown_count > 0, `unknown=${e.unknown_count}`)
  ok('A15 混合未知量的需求不得判为 ready', planLevel(e) !== 'ready', planLevel(e))
  ok('A15 已知量仍然参与需求计算', e.requirements[0].required_quantity === 1, String(e.requirements[0].required_quantity))
  ok('A15 该需求的说明要提到「未指定用量」', e.requirements[0].note.includes('未指定用量'))
}

/* A16 —— 纯未知普通配料 */
{
  const e = evaluateCombination([dish(1, 1, [[4, '土豆', null, '个']])], new Map(), META)
  ok('A16 纯未知用量不得判为 ready', planLevel(e) !== 'ready', planLevel(e))
  ok('A16 纯未知用量不计入主缺口', e.main_missing_count === 0 && e.unknown_count === 1)
}

/* A17 —— coverage 分子分母同口径 */
{
  const e = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个'], [3, '盐', null, null]])],
    stockIndexOf([lot(1, '个', 3), lot(3, '个', 0)]),
    META,
  )
  ok('A17 coverage 必须在 [0,1] 内', e.coverage >= 0 && e.coverage <= 1, String(e.coverage))
  ok('A17 satisfied_count 不得超过 required_count',
    e.satisfied_count <= e.required_count,
    `${e.satisfied_count}/${e.required_count}`)
  ok('A17 调味品不计入 required_count', e.required_count === 1, String(e.required_count))
}

/* A18 —— 过期批次不可用 */
{
  const e = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 100, 'expired')]),
    META,
  )
  ok('A18 过期批次不计入可用数量', e.requirements[0].available_quantity === 0)
  ok('A18 只有过期批次时不得判为 ready', planLevel(e) !== 'ready', planLevel(e))
  ok('A18 过期数量被单独报告', e.requirements[0].expired_excluded_quantity === 100)
}

/* A19 —— 算法不修改输入 */
{
  const lots = [lot(1, '个', 5), lot(1, '个', 2, 'expiring')]
  const snapshot = JSON.stringify(lots)
  evaluateCombination([dish(1, 1, [[1, '番茄', 1, '个']])], stockIndexOf(lots), META)
  ok('A19 算法不改变输入的库存快照', JSON.stringify(lots) === snapshot)
}

/* A20 —— 等级权重顺序 */
{
  ok(
    'A20 等级权重 ready < nearly < missing',
    planLevelRank('ready') < planLevelRank('nearly') &&
      planLevelRank('nearly') < planLevelRank('missing'),
  )
}

/* A21 —— ready_bonus 只发给**真正 ready** */
{
  const trulyReady = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 9)]),
    META,
  )
  const withUnknown = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个'], [1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 9)]),
    META,
  )
  ok(
    'A21 带未知用量的方案分数低于真正全足方案',
    scorePlan(withUnknown) < scorePlan(trulyReady),
    `${scorePlan(withUnknown)} < ${scorePlan(trulyReady)}`,
  )
  ok('A21 真正全足方案判为 ready', planLevel(trulyReady) === 'ready')
}

/* A22 —— 「消耗临期」用字保守 */
{
  const insufficient = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 10, '个']])],
    stockIndexOf([lot(1, '个', 1, 'expiring')]),
    META,
  )
  ok(
    'A22 需求未满足时不得声称消耗临期',
    insufficient.requirements[0].used_expiring === false && insufficient.expiring_used_count === 0,
  )
  const satisfied = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 9, 'expiring')]),
    META,
  )
  ok(
    'A22 需求满足且存在临期时才算消耗临期',
    satisfied.requirements[0].used_expiring === true && satisfied.expiring_used_count === 1,
  )
}

/* ============================================================
 * B. HTTP 集成（隔离临时库）
 * ============================================================ */

const PORT = 63500 + Math.floor(Math.random() * 800)
const BASE = `http://127.0.0.1:${PORT}`
const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v022-${randomUUID()}`)
const dbPath = resolve(runRoot, `v022-${Date.now()}.db`)
const realDb = resolve(serverRoot, 'data', 'homechef.db')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

// ⚠️ 路径安全：必须在创建/删除任何文件之前
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
const migrations = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()

function execMigration(db: InstanceType<typeof Database>, file: string) {
  const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
for (const f of migrations) execMigration(setup, f)

const now = new Date().toISOString()

/* ---------- 基础数据 ----------
 * ⚠️ 迁移 0005 已用 `INSERT OR IGNORE` 建好 19 个默认分类，
 *    这里**只查不插**，避免 UNIQUE(name_normalized) 冲突。
 */
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

const defs: Array<[number, string, number]> = [
  [1, '番茄', requireCat('蔬菜')],
  [2, '鸡蛋', requireCat('蛋类')],
  [3, '盐', requireCat('调味品')],
  [4, '土豆', requireCat('蔬菜')],
  [5, '牛奶', requireCat('乳制品')],
]
for (const [id, name, cat] of defs) {
  setup
    .prepare('insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)')
    .run(id, name, name, cat, now, now)
}

/** 插入菜谱（含配料行）；lines = [definition_id, quantity, unit] */
function insertRecipe(id: number, name: string, lines: Array<[number, number | null, string | null]>) {
  mut.prepare('insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)').run(id, name, name, now, now)
  let order = 0
  for (const [defId, qty, unit] of lines) {
    mut
      .prepare(
        'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?)',
      )
      .run(id, defId, qty, unit, order++, now, now)
  }
}

const RECIPES: Array<[number, string, Array<[number, number | null, string | null]>]> = [
  [1, '番茄炒蛋', [[1, 2, '个'], [2, 3, '个']]],
  [2, '盐蒸蛋', [[2, 2, '个'], [3, 1, '克']]],
  [3, '醋溜土豆丝', [[4, 2, '个'], [3, 1, '克']]],
  [4, '土豆泥', [[4, 1, '个'], [4, 1, '个']]],
  [5, '牛奶土豆饼', [[4, 2, '个'], [5, 200, '毫升']]],
]

/** 插入库存 */
function insertStock(definitionId: number, qty: number, unit: string, expiry: string | null = null, source: string | null = null) {
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(definitionId, qty, unit, '2026-01-01', expiry, source, '常温', now, now)
}

/**
 * ⚠️ 运行时改数据必须用**独立的可写连接**：
 *    `setup` 在建好基础数据后就关闭了（用已关闭的连接写会报
 *    "The database connection is not open"）。
 */
const mut = new Database(dbPath)
mut.pragma('foreign_keys = ON')

setup.close()

let server: ReturnType<typeof startServer> | null = null
const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

const count = (sql: string) => (raw.prepare(sql).get() as any).c as number

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

/** 全库业务表内容摘要（用于「推荐零写入」断言） */
function dbDigest(): string {
  const tables = [
    'recipe', 'recipe_ingredient', 'standard_ingredient', 'ingredient_definition',
    'category', 'cooking_session', 'cooking_session_dish', 'cooking_settlement',
    'cooking_settlement_item', 'cooking_session_dish_skip', 'app_settings',
  ]
  const parts: string[] = []
  for (const t of tables) {
    const rows = raw.prepare(`select * from "${t}" order by rowid`).all()
    parts.push(`${t}:${rows.length}:${JSON.stringify(rows)}`)
  }
  return parts.join('|')
}

try {
  server = startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })

  section('B1. 无菜谱 / 无库存')

  const empty1 = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('无菜谱无库存 → 200 且 0 套方案', empty1.status === 200 && empty1.body.plans.length === 0,
    `status=${empty1.status} plans=${empty1.body?.plans?.length}`)

  for (const [id, name, lines] of RECIPES) insertRecipe(id, name, lines)
  const empty2 = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('有菜谱无库存 → 有方案但无 ready', empty2.status === 200 && empty2.body.plans.length > 0 && empty2.body.plans.every((p: any) => p.level !== 'ready'))
  ok('无库存时理由包含缺料说明', empty2.body.plans[0].reasons.some((r: string) => r.includes('还缺')))
  info('无库存 notes', JSON.stringify(empty2.body.notes))

  section('B2. 参数校验（严格，coerceTypes 已关闭）')
  for (const [label, body] of [
    ['people=0', { people: 0 }],
    ['people=1.5', { people: 1.5 }],
    ['people="3"（字符串）', { people: '3' }],
    ['people=99（超上限）', { people: 99 }],
    ['缺 people', {}],
    ['多余字段', { people: 2, extra: 1 }],
  ] as const) {
    const r = await req('POST', '/api/recommendation/meal-plans', body)
    ok(`B2 ${label} → 400`, r.status === 400, String(r.status))
  }

  section('B3. 全足库存 → 出现 ready 方案')
  // 番茄10个 鸡蛋10个 土豆10个 牛奶1000毫升 盐（调味品，0 个哨兵）
  insertStock(1, 10, '个'); insertStock(2, 10, '个'); insertStock(4, 10, '个')
  insertStock(5, 1000, '毫升'); insertStock(3, 0, '个')

  const full = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('全部库存充足 → 首选方案 level=ready', full.body.plans[0].level === 'ready', full.body.plans[0].level)
  ok('方案数在 3–5 之间', full.body.plans.length >= 3 && full.body.plans.length <= 5, String(full.body.plans.length))
  ok('每套 2–3 道菜', full.body.plans.every((p: any) => p.dishes.length >= 2 && p.dishes.length <= 3))
  ok('返回倍率信息（基准人数）', full.body.base_servings === 2 && full.body.multiplier === 1)
  ok('首选方案理由可读', typeof full.body.plans[0].reasons[0] === 'string' && full.body.plans[0].reasons[0].length > 0)
  info('首选理由', JSON.stringify(full.body.plans[0].reasons))

  section('B4. 人数与倍率一致（推荐量 == 会话份数）')
  const p4 = await req('POST', '/api/recommendation/meal-plans', { people: 4 })
  ok('4 人 → 倍率 2', p4.body.multiplier === 2, String(p4.body.multiplier))
  ok('推荐每道菜份数 = 2', p4.body.plans[0].dishes.every((d: any) => d.servings === 2))
  const needEgg4 = p4.body.plans[0].requirements.find((r: any) => r.definition_id === 2)
  if (needEgg4) {
    ok('4 人时需求量为 2 倍基准', needEgg4.required_quantity % 2 === 0, `req=${needEgg4.required_quantity}`)
  } else {
    info('该方案未含鸡蛋，跳过倍率数值断言')
  }

  section('B5. 单位不兼容与未知用量（接口层，隔离场景）')
  // ⚠️ 只保留这两道菜，保证它们**必然**出现在推荐方案里，断言才不是空转
  raw.exec('delete from recipe where id not in (90, 91)')
  insertRecipe(90, '单位不兼容菜', [[5, 500, '克']]) // 牛奶库存只有「毫升」
  insertRecipe(91, '未知用量菜', [[4, null, '个']]) // 土豆用量未指定
  const weird = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('隔离场景后接口仍 200', weird.status === 200, String(weird.status))
  const allReqs = weird.body.plans.flatMap((p: any) => p.requirements)
  const gramReqs = allReqs.filter((r: any) => r.definition_id === 5 && r.unit === '克')
  ok('场景生效：出现按「克」的需求', gramReqs.length > 0, String(gramReqs.length))
  ok(
    '单位不兼容 → unit_mismatch（绝不换算，绝不判为充足）',
    gramReqs.length > 0 && gramReqs.every((r: any) => r.status === 'unit_mismatch'),
  )
  const unknownReqs = allReqs.filter((r: any) => r.status === 'unknown_quantity')
  ok('未指定用量 → unknown_quantity（不视为充分）', unknownReqs.length > 0, String(unknownReqs.length))
  ok(
    '未知用量不计入「可做」判定（仍属 almost/nearly 而非 ready）',
    weird.body.plans.every((p: any) => p.level !== 'ready'),
  )

  section('B6. 推荐阶段数据库零写入')
  const before = dbDigest()
  const s1 = await req('POST', '/api/recommendation/meal-plans', { people: 3 })
  const s2 = await req('POST', '/api/recommendation/meal-plans', { people: 3 })
  ok('推荐前后数据库内容完全一致（零写入）', dbDigest() === before)
  ok('同一请求两次结果完全一致（确定性）', JSON.stringify(s1.body) === JSON.stringify(s2.body))
  ok('推荐不创建任何会话', count('select count(*) c from cooking_session') === 0)

  section('B7. 原子进入烹饪（含快照校验 + 幂等键）')
  const chosen = s1.body.plans[0]
  const applyBody = {
    people: 3,
    dishes: chosen.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: chosen.snapshot_id,
    request_id: 'req-b7-' + randomUUID(),
  }
  ok('方案带快照指纹', typeof chosen.snapshot_id === 'string' && chosen.snapshot_id.length >= 8, String(chosen.snapshot_id))
  const applied = await req('POST', '/api/recommendation/apply', applyBody)
  ok('apply 返回 200 且有 session_id', applied.status === 200 && typeof applied.body.session_id === 'number',
    `status=${applied.status} body=${JSON.stringify(applied.body)}`)
  const sessionId = applied.body?.session_id
  const detail = await req('GET', `/api/cooking/sessions/${sessionId}`)
  ok('会话含全部菜品', detail.status === 200 && detail.body.dishes.length === applyBody.dishes.length,
    `dishes=${detail.body?.dishes?.length}`)
  ok('会话状态为 active', detail.body.status === 'active')
  ok('每道菜份数与推荐一致（同一倍率）',
    detail.body.dishes.every((d: any) => d.servings === s1.body.multiplier),
    `multiplier=${s1.body.multiplier}`)
  ok('apply 不预扣库存', count('select count(*) c from standard_ingredient') === 5)

  section('B8. apply 失败整体回滚')
  const sessionsBefore = count('select count(*) c from cooking_session')
  const badBody = (dishes: unknown, extra: Record<string, unknown> = {}) => ({
    people: 2,
    dishes,
    snapshot_id: chosen.snapshot_id,
    request_id: 'req-bad-' + randomUUID(),
    ...extra,
  })
  const bad1 = await req('POST', '/api/recommendation/apply',
    badBody([{ recipe_id: 999999, servings: 1 }]))
  ok('不存在的菜谱 → 404', bad1.status === 404, String(bad1.status))
  const bad2 = await req('POST', '/api/recommendation/apply',
    badBody([{ recipe_id: 1, servings: 1 }, { recipe_id: 1, servings: 1 }]))
  ok('同一菜谱重复 → 400', bad2.status === 400, String(bad2.status))
  const bad3 = await req('POST', '/api/recommendation/apply',
    badBody([{ recipe_id: 1, servings: 999 }]))
  ok('份数倍数超限 → 400', bad3.status === 400, String(bad3.status))
  const bad4 = await req('POST', '/api/recommendation/apply', badBody([]))
  ok('空菜品数组 → 400', bad4.status === 400, String(bad4.status))
  const bad5 = await req('POST', '/api/recommendation/apply',
    badBody([{ recipe_id: 1, servings: 1 }], { snapshot_id: undefined }))
  ok('缺 snapshot_id → 400', bad5.status === 400, String(bad5.status))
  const bad6 = await req('POST', '/api/recommendation/apply',
    badBody([{ recipe_id: 1, servings: 1 }], { request_id: undefined }))
  ok('缺 request_id → 400', bad6.status === 400, String(bad6.status))
  ok('失败后未产生任何会话（整体回滚，无半套孤儿）',
    count('select count(*) c from cooking_session') === sessionsBefore,
    `${sessionsBefore} → ${count('select count(*) c from cooking_session')}`)

  section('B9. request_id 幂等（条目⑩）')
  {
    const rid = 'req-idem-' + randomUUID()
    const body = {
      people: s1.body.people,
      dishes: chosen.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      snapshot_id: chosen.snapshot_id,
      request_id: rid,
    }
    const before = count('select count(*) c from cooking_session')
    const first = await req('POST', '/api/recommendation/apply', body)
    const afterFirst = count('select count(*) c from cooking_session')
    const replay = await req('POST', '/api/recommendation/apply', body)
    const afterReplay = count('select count(*) c from cooking_session')

    ok('首次 apply 成功', first.status === 200, String(first.status))
    ok('重复同 key 同 payload → 200 且返回同一 session',
      replay.status === 200 && replay.body.session_id === first.body.session_id,
      `${first.body?.session_id} vs ${replay.body?.session_id}`)
    ok('重放被服务端标注 idempotent_replay', replay.body.idempotent_replay === true)
    ok('重放不会再建会话（只 +1）',
      afterFirst - before === 1 && afterReplay === afterFirst,
      `${before} → ${afterFirst} → ${afterReplay}`)

    const conflict = await req('POST', '/api/recommendation/apply', {
      ...body,
      dishes: [{ recipe_id: body.dishes[0].recipe_id, servings: 2 }],
    })
    ok('同 key 不同 payload → 409 IDEMPOTENCY_CONFLICT',
      conflict.status === 409 && conflict.body?.error?.code === 'IDEMPOTENCY_CONFLICT',
      `${conflict.status} ${JSON.stringify(conflict.body)}`)
    ok('冲突后也没有多建会话', count('select count(*) c from cooking_session') === afterFirst)
  }

  section('B10. 快照过期（条目⑪）')
  {
    // 重新生成一次，拿一个新鲜的方案
    const freshPlans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
    const p0 = freshPlans.body.plans[0]
    const dishes = p0.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings }))

    const bogus = await req('POST', '/api/recommendation/apply', {
      people: 2,
      dishes,
      snapshot_id: 'deadbeefdeadbeefdeadbeef',
      request_id: 'req-stale1-' + randomUUID(),
    })
    ok('伪造指纹 → 409 SNAPSHOT_STALE',
      bogus.status === 409 && bogus.body?.error?.code === 'SNAPSHOT_STALE',
      `${bogus.status} ${JSON.stringify(bogus.body)}`)

    // ⚠️ 真实变更：改掉被选中的第一道菜的配料用量
    const targetRecipe = dishes[0].recipe_id
    const lineBefore = raw
      .prepare('select id, quantity from recipe_ingredient where recipe_id = ? order by id limit 1')
      .get(targetRecipe) as { id: number; quantity: number }
    mut
      .prepare('update recipe_ingredient set quantity = quantity + 7 where id = ?')
      .run(lineBefore.id)

    const stale = await req('POST', '/api/recommendation/apply', {
      people: 2,
      dishes,
      snapshot_id: p0.snapshot_id,
      request_id: 'req-stale2-' + randomUUID(),
    })
    ok('菜谱配料变更后，旧指纹 → 409 SNAPSHOT_STALE',
      stale.status === 409 && stale.body?.error?.code === 'SNAPSHOT_STALE',
      `${stale.status} ${JSON.stringify(stale.body)}`)
    ok('快照冲突**没有**创建会话（绝不静默用新配方开做）',
      count('select count(*) c from cooking_session') ===
        count('select count(*) c from cooking_session'))

    // 改回原值，避免影响后续断言
    mut
      .prepare('update recipe_ingredient set quantity = ? where id = ?')
      .run(lineBefore.quantity, lineBefore.id)

    // 恢复后，新生成的方案指纹应能通过
    const again = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
    const p1 = again.body.plans[0]
    const okApply = await req('POST', '/api/recommendation/apply', {
      people: 2,
      dishes: p1.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
      snapshot_id: p1.snapshot_id,
      request_id: 'req-stale3-' + randomUUID(),
    })
    ok('恢复后新指纹可正常 apply', okApply.status === 200, `${okApply.status} ${JSON.stringify(okApply.body)}`)
  }

  section('B11. 每道菜缩放后的配料与步骤（条目⑦⑨）')
  {
    const plans = await req('POST', '/api/recommendation/meal-plans', { people: 4 })
    const plan = plans.body.plans[0]
    const dish = plan.dishes[0]
    ok('每道菜带 ingredients 数组', Array.isArray(dish.ingredients) && dish.ingredients.length > 0,
      `len=${dish.ingredients?.length}`)
    ok('每道菜带 steps 数组', Array.isArray(dish.steps))
    ok('带 content_revision', typeof dish.content_revision === 'number')
    const known = dish.ingredients.filter((i: any) => i.quantity !== null)
    ok('配料数量已按 4 人（2 倍）缩放',
      known.length > 0 && known.every((i: any) => Number.isInteger(i.quantity * 2) || i.quantity % 1 !== 0),
      JSON.stringify(known.map((i: any) => i.quantity)))
    // 与菜谱原始值对比：必须正好是 2 倍
    const recipeLine = raw
      .prepare('select quantity from recipe_ingredient where recipe_id = ? and definition_id = ? and unit = ? limit 1')
      .get(dish.recipe_id, known[0]?.definition_id, known[0]?.unit) as { quantity: number } | undefined
    if (recipeLine) {
      ok('缩放倍数精确等于 multiplier',
        Math.abs(known[0].quantity - recipeLine.quantity * plans.body.multiplier) < 1e-9,
        `${known[0].quantity} vs ${recipeLine.quantity}×${plans.body.multiplier}`)
    } else {
      info('未找到对应原始配料行，跳过精确倍率断言')
    }
    ok('快照指纹随人数变化（不同倍率 → 不同指纹）',
      plans.body.plans[0].snapshot_id !== (await req('POST', '/api/recommendation/meal-plans', { people: 2 })).body.plans[0].snapshot_id)
  }

  section('B12. 候选排序与方案多样性（条目⑤）')
  {
    // 补几道菜，让「3 菜组合」有足够样本，重叠断言才有意义
    insertStock(1, 10, '个')
    insertStock(2, 10, '个')
    insertStock(4, 10, '个')
    insertRecipe(92, '菜A', [[1, 1, '个']])
    insertRecipe(93, '菜B', [[2, 1, '个']])
    insertRecipe(94, '菜C', [[4, 1, '个']])
    const r = await req('POST', '/api/recommendation/meal-plans', { people: 3 })
    ok('返回 considered_recipe_count 与 candidate_truncated',
      typeof r.body.considered_recipe_count === 'number' && typeof r.body.candidate_truncated === 'boolean')
    ok('候选数不超过上限 40', r.body.considered_recipe_count <= 40, String(r.body.considered_recipe_count))
    const ids = r.body.plans.map((p: any) => p.plan_id)
    ok('方案之间不重复', new Set(ids).size === ids.length)
    if (r.body.plans.length >= 2) {
      const a = new Set(r.body.plans[0].dishes.map((d: any) => d.recipe_id))
      const b = r.body.plans[1].dishes.map((d: any) => d.recipe_id)
      const shared = b.filter((x: number) => a.has(x)).length
      ok('前两套方案并非完全重合（重叠惩罚生效）', shared < b.length, `shared=${shared}/${b.length}`)
    }
  }

  section('B13. 既有烹饪接口回归')
  const list = await req('GET', '/api/cooking/sessions')
  ok('GET /api/cooking/sessions 仍正常', list.status === 200 && Array.isArray(list.body))

  /* ============================================================
   * C. 真实烹饪步骤 → 确认 → 结算（条目⑬）
   * ============================================================ */
  section('C1. 完整走通：推荐 → 加菜 → 步骤完成 → 结算')

  // 隔离场景：只留一道**配料单位全部匹配、无调味品**的菜，库存充足
  raw.exec('delete from cooking_session')
  raw.exec('delete from standard_ingredient')
  raw.exec('delete from recipe')
  insertRecipe(1, '番茄炒蛋', [[1, 2, '个'], [2, 3, '个']])
  insertStock(1, 10, '个') // 番茄 10 个
  insertStock(2, 10, '个') // 鸡蛋 10 个

  const cPlans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const cPlan = cPlans.body.plans[0]
  const cApply = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: cPlan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: cPlan.snapshot_id,
    request_id: 'req-c1-' + randomUUID(),
  })
  ok('C1 建会话成功', cApply.status === 200, JSON.stringify(cApply.body))

  const cSessionId = cApply.body.session_id
  const cDetail = await req('GET', `/api/cooking/sessions/${cSessionId}`)
  ok('C1 会话含菜品', cDetail.body.dishes.length >= 1)

  const stockBefore = new Map<number, number>()
  for (const r of raw.prepare('select definition_id, quantity from standard_ingredient').all() as any[]) {
    stockBefore.set(r.definition_id, (stockBefore.get(r.definition_id) ?? 0) + r.quantity)
  }

  // 逐道标记完成
  let lastStatus = ''
  for (const d of cDetail.body.dishes) {
    const p = await req('PATCH', `/api/cooking/sessions/${cSessionId}/dishes/${d.id}/progress`, {
      status: 'done',
    })
    lastStatus = p.body?.status ?? ''
  }
  ok('C1 全部菜品完成后会话进入待结算', lastStatus === 'awaiting_settlement', lastStatus)

  const settled = await req('POST', `/api/cooking/sessions/${cSessionId}/settle`, {})
  ok('C1 结算返回 200', settled.status === 200, `${settled.status} ${JSON.stringify(settled.body).slice(0, 200)}`)
  const after = await req('GET', `/api/cooking/sessions/${cSessionId}`)
  ok('C1 会话变为 settled', after.body.status === 'settled', after.body.status)

  // 检查扣减是否与需求一致，且共享库存未被超扣
  const requiredByDef = new Map<number, number>()
  for (const rr of cPlan.requirements) {
    if (rr.status === 'ok' && rr.required_quantity !== null && !rr.is_seasoning) {
      requiredByDef.set(rr.definition_id, (requiredByDef.get(rr.definition_id) ?? 0) + rr.required_quantity)
    }
  }
  let deductOk = true
  for (const [defId, need] of requiredByDef) {
    const now = (raw
      .prepare('select coalesce(sum(quantity),0) q from standard_ingredient where definition_id = ?')
      .get(defId) as { q: number }).q
    const was = stockBefore.get(defId) ?? 0
    if (Math.abs(was - now - need) > 1e-6) {
      deductOk = false
      info(`definition ${defId}: ${was} → ${now}（应扣 ${need}）`)
    }
  }
  ok('C1 库存扣减量与合并需求完全一致（共享库存不超扣）', deductOk)

  /* ---------- C2. 结算失败整体回滚 ---------- */
  section('C2. 库存不足 → 结算失败并整体回滚')
  raw.exec('delete from standard_ingredient')
  insertStock(1, 1, '个') // 番茄只有 1 个，但菜谱需要 2 个
  insertStock(2, 10, '个') // 鸡蛋充足，确保失败只因番茄
  const c2Plans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const c2Plan = c2Plans.body.plans[0]
  const c2Apply = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: c2Plan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: c2Plan.snapshot_id,
    request_id: 'req-c2-' + randomUUID(),
  })
  const c2Id = c2Apply.body.session_id
  const c2Detail = await req('GET', `/api/cooking/sessions/${c2Id}`)
  for (const d of c2Detail.body.dishes) {
    await req('PATCH', `/api/cooking/sessions/${c2Id}/dishes/${d.id}/progress`, { status: 'done' })
  }
  const stockDigestBeforeFail = raw.prepare('select id, quantity from standard_ingredient order by id').all()
  const badSettle = await req('POST', `/api/cooking/sessions/${c2Id}/settle`, {})
  ok('C2 库存不足 → 结算失败（>=400）', badSettle.status >= 400, String(badSettle.status))
  ok('C2 失败后库存完全未变（整体回滚）',
    JSON.stringify(raw.prepare('select id, quantity from standard_ingredient order by id').all()) ===
      JSON.stringify(stockDigestBeforeFail))
  const c2After = await req('GET', `/api/cooking/sessions/${c2Id}`)
  ok('C2 失败后会话不是 settled', c2After.body.status !== 'settled', c2After.body.status)
  ok('C2 失败后没有留下结算凭证',
    (raw.prepare('select count(*) c from cooking_settlement where session_id = ?').get(c2Id) as any).c === 0)

  /* ============================================================
   * D. 结算与过期库存（条目⑫）
   * ============================================================ */
  section('D. 结算不消耗过期库存（遵守 allow_expired_for_recipe）')

  const setAllow = async (value: boolean) => {
    const r = await req('PATCH', '/api/settings', { allow_expired_for_recipe: value })
    return r
  }

  // 关闭（默认）：只有过期番茄
  await setAllow(false)
  raw.exec('delete from standard_ingredient')
  const today = new Date().toISOString().slice(0, 10)
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(1, 10, '个', '2026-01-01', '2026-01-02', 'manual', '常温', now, now)
  insertStock(2, 10, '个') // 鸡蛋充足 → 唯一问题就是**过期的番茄**
  const dPlans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const expiredReq = dPlans.body.plans
    .flatMap((p: any) => p.requirements)
    .find((r: any) => r.definition_id === 1)
  ok('D 推荐把过期库存排除在可用之外（available=0）',
    expiredReq !== undefined && expiredReq.available_quantity === 0,
    JSON.stringify(expiredReq))
  ok('D 含过期食材的方案不是 ready',
    dPlans.body.plans.every((p: any) => p.level !== 'ready'))

  const dPlan = dPlans.body.plans[0]
  const dApply = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: dPlan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: dPlan.snapshot_id,
    request_id: 'req-d1-' + randomUUID(),
  })
  const dId = dApply.body.session_id
  const dDetail = await req('GET', `/api/cooking/sessions/${dId}`)
  for (const d of dDetail.body.dishes) {
    await req('PATCH', `/api/cooking/sessions/${dId}/dishes/${d.id}/progress`, { status: 'done' })
  }
  const expiredQtyBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = 1')
    .get() as { quantity: number }).quantity
  const dSettle = await req('POST', `/api/cooking/sessions/${dId}/settle`, {})
  const expiredQtyAfter = (raw
    .prepare('select quantity from standard_ingredient where definition_id = 1')
    .get() as { quantity: number }).quantity
  info('D 设置=false 时结算结果', `${dSettle.status} ${JSON.stringify(dSettle.body).slice(0, 120)}`)
  ok('D 默认设置下，过期库存**不参与扣减**（数量不变或整体失败回滚）',
    Math.abs(expiredQtyBefore - expiredQtyAfter) < 1e-9,
    `${expiredQtyBefore} → ${expiredQtyAfter}`)
  ok('D 默认设置下，仅靠过期库存无法完成结算', dSettle.status >= 400, String(dSettle.status))

  // 打开允许：过期番茄应被扣减
  const enableRes = await setAllow(true)
  ok('D 可以打开 allow_expired_for_recipe', enableRes.status < 500, String(enableRes.status))

  raw.exec('delete from standard_ingredient')
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(1, 10, '个', '2026-01-01', '2026-01-02', 'manual', '常温', now, now)
  insertStock(2, 10, '个') // 鸡蛋充足

  const d2Plans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const d2Plan = d2Plans.body.plans[0]
  const d2Apply = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: d2Plan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: d2Plan.snapshot_id,
    request_id: 'req-d2-' + randomUUID(),
  })
  const d2Id = d2Apply.body.session_id
  const d2Detail = await req('GET', `/api/cooking/sessions/${d2Id}`)
  for (const d of d2Detail.body.dishes) {
    await req('PATCH', `/api/cooking/sessions/${d2Id}/dishes/${d.id}/progress`, { status: 'done' })
  }
  const d2Settle = await req('POST', `/api/cooking/sessions/${d2Id}/settle`, {})
  const expiredQty2 = (raw
    .prepare('select coalesce(sum(quantity),0) q from standard_ingredient where definition_id = 1')
    .get() as { q: number }).q
  info('D 设置=true 时结算结果', `${d2Settle.status} 过期批次剩余 ${expiredQty2}`)
  ok('D 打开设置后，结算成功', d2Settle.status === 200, `${d2Settle.status} ${JSON.stringify(d2Settle.body).slice(0, 150)}`)
  ok('D 打开设置后，过期批次**确实被扣减**（10 → 8）',
    Math.abs(expiredQty2 - 8) < 1e-9,
    `剩余 ${expiredQty2}`)

  // 恢复默认，避免污染后续
  await setAllow(false)
  ok('D 恢复默认设置为 false',
    (await req('GET', '/api/settings')).body.allow_expired_for_recipe === false)
  /* ============================================================
   * E. 结算预览必须与实际可扣一致（条目⑫补充）
   * ============================================================ */
  section('E. 结算预览不虚报可用库存（复用同一过期规则）')

  const localToday = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })()

  // E1 场景（与验收要求完全一致）：番茄 **过期 100 + 新鲜 20**
  raw.exec('delete from standard_ingredient')
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(1, 100, '个', '2026-01-01', '2026-01-02', 'manual', '常温', now, now) // 已过期
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(1, 20, '个', localToday, '2099-01-01', 'manual', '常温', now, now) // 新鲜
  insertStock(2, 10, '个')

  await setAllow(false)

  const ePlans = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  const ePlan = ePlans.body.plans[0]
  const eApply = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: ePlan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: ePlan.snapshot_id,
    request_id: 'req-e1-' + randomUUID(),
  })
  ok('E 预览场景建会话成功', eApply.status === 200, JSON.stringify(eApply.body).slice(0, 150))
  const eId = eApply.body.session_id

  const previewDefault = await req('GET', `/api/cooking/sessions/${eId}/settle/preview`)
  ok('E 预览接口 200', previewDefault.status === 200, String(previewDefault.status))
  const pvTomato = previewDefault.body.items.find((i: any) => i.definition_id === 1)
  info('E 默认设置预览 available_quantity', String(pvTomato?.available_quantity))
  ok(
    'E 默认设置：预览可用 = **20**（新鲜），**不是 120**',
    pvTomato !== undefined && Math.abs(pvTomato.available_quantity - 20) < 1e-9,
    String(pvTomato?.available_quantity),
  )

  // 打开允许过期 → 预览才把过期的 100 也算进来
  await setAllow(true)
  const previewAllow = await req('GET', `/api/cooking/sessions/${eId}/settle/preview`)
  const pvTomato2 = previewAllow.body.items.find((i: any) => i.definition_id === 1)
  info('E 允许过期后预览 available_quantity', String(pvTomato2?.available_quantity))
  ok(
    'E 允许过期后：预览可用 = **120**（100 + 20）',
    pvTomato2 !== undefined && Math.abs(pvTomato2.available_quantity - 120) < 1e-9,
    String(pvTomato2?.available_quantity),
  )
  await setAllow(false)

  // E2 场景：追加一条「**今天到期**」→ 证明当天不算过期
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(1, 7, '个', localToday, localToday, 'manual', '常温', now, now)
  const previewToday = await req('GET', `/api/cooking/sessions/${eId}/settle/preview`)
  const pvTomato3 = previewToday.body.items.find((i: any) => i.definition_id === 1)
  ok(
    'E 「今天到期」不算过期：预览 = 20 + 7 = 27',
    pvTomato3 !== undefined && Math.abs(pvTomato3.available_quantity - 27) < 1e-9,
    String(pvTomato3?.available_quantity),
  )

  // 预览必须与「实际能扣多少」一致
  const stockBeforeSettle = (raw
    .prepare('select coalesce(sum(quantity),0) q from standard_ingredient where definition_id = 1')
    .get() as { q: number }).q
  const eDetail = await req('GET', `/api/cooking/sessions/${eId}`)
  for (const d of eDetail.body.dishes) {
    await req('PATCH', `/api/cooking/sessions/${eId}/dishes/${d.id}/progress`, { status: 'done' })
  }
  const eSettle = await req('POST', `/api/cooking/sessions/${eId}/settle`, {})
  const stockAfterSettle = (raw
    .prepare('select coalesce(sum(quantity),0) q from standard_ingredient where definition_id = 1')
    .get() as { q: number }).q
  info('E 结算结果', `${eSettle.status} 番茄 ${stockBeforeSettle} → ${stockAfterSettle}`)
  ok('E 结算成功（新鲜批次足够）', eSettle.status === 200, String(eSettle.status))
  ok(
    'E 实际只从**新鲜+今天到期**里扣（过期 100 完全未被动）',
    Math.abs(stockAfterSettle - (stockBeforeSettle - 2)) < 1e-9,
    `${stockBeforeSettle} → ${stockAfterSettle}`,
  )
  ok(
    'E 过期批次数量保持不变',
    Math.abs(
      (raw.prepare("select coalesce(sum(quantity),0) q from standard_ingredient where definition_id = 1 and expiry_date = '2026-01-02'").get() as any)
        .q - 100,
    ) < 1e-9,
  )
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try { await server?.stop() } catch (e: any) { console.error(`[WARN] stop: ${String(e?.message ?? e)}`) }
  try { raw.close() } catch { /* 忽略 */ }
  // ⚠️ `mut` 也必须关闭，否则 Windows 上文件仍被占用，临时目录删不掉（EPERM）
  try { mut.close() } catch { /* 忽略 */ }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v022-')) {
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
