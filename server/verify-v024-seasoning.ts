/**
 * v0.2.4 验证（第一阶段 A）：调味品 = 中性备料提醒
 *
 * 决策口径（Lumi 最终审查）：
 *   - 调味品**不做常备记忆**，也不要求确认：`deriveRequiredReason` 对调味品一律 null，
 *     且该分支必须排在 `null_quantity` 之前（盐「适量」也免确认）。
 *   - 不计库存、不扣量、不占库；新结算**不写**调味品凭证行，
 *     不伪造 `user_choice`，也不新增 outcome。
 *   - 推荐侧：不进缺口、不进覆盖率分母、不进 unknown（含 0+null 混合）、
 *     不参与临期收益 / 共享奖励 / 利用率，库存变化也不影响排序结论。
 *   - 预览保留中性提醒并明确 `is_seasoning`；显式纯零不提醒。
 *   - 非调味品的 null / 单位不匹配 / 零需求 / FEFO 规则**保持原样**。
 *
 * ⚠️ 全程隔离临时库；绝不触碰 server/data；绝不设置 HOME_CHEF_ALLOW_REAL_DB。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-seasoning.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath, startServer, waitForReady } from './harness/server-lifecycle.js'
import {
  evaluateCombination,
  planLevel,
  scoreBreakdown,
} from './src/services/recommendationAlgorithm.js'
import type {
  DishSpec,
  DefinitionMeta,
  StockLotInput,
} from './src/services/recommendationAlgorithm.js'
import { deriveRequiredReason } from './src/services/skipReasonService.js'

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
 * A. 纯函数（无 DB）
 * ============================================================ */

function pureTests(): void {
  console.log('\n[A] 纯函数')

  ok(
    'A1 非零调味品 → 不需要确认',
    deriveRequiredReason({ is_seasoning: true, required_quantity: 2, has_unit_matched_lot: false }) ===
      null,
  )
  ok(
    'A2 调味品「适量」(null) → 不需要确认（分支在 null_quantity 之前）',
    deriveRequiredReason({ is_seasoning: true, required_quantity: null, has_unit_matched_lot: false }) ===
      null,
  )
  ok(
    'A3 调味品显式 0 → 不需要确认',
    deriveRequiredReason({ is_seasoning: true, required_quantity: 0, has_unit_matched_lot: false }) ===
      null,
  )
  ok(
    'A4 非调味品 null → 仍为 null_quantity',
    deriveRequiredReason({ is_seasoning: false, required_quantity: null, has_unit_matched_lot: true }) ===
      'null_quantity',
  )
  ok(
    'A5 非调味品无同单位库存 → 仍为 unit_mismatch',
    deriveRequiredReason({ is_seasoning: false, required_quantity: 2, has_unit_matched_lot: false }) ===
      'unit_mismatch',
  )
  ok(
    'A6 非调味品显式 0 → null',
    deriveRequiredReason({ is_seasoning: false, required_quantity: 0, has_unit_matched_lot: false }) ===
      null,
  )

  const metaMap = new Map<number, DefinitionMeta>([
    [1, { is_seasoning: false, category_name: '蔬菜' }],
    [2, { is_seasoning: true, category_name: '调味品' }],
    [3, { is_seasoning: false, category_name: '蛋类' }],
  ])
  const stock = new Map<number, StockLotInput[]>()
  stock.set(1, [{ definition_id: 1, unit: '个', quantity: 10, expiry_status: 'normal' }])
  stock.set(3, [{ definition_id: 3, unit: '个', quantity: 10, expiry_status: 'normal' }])

  const dishWithSalt: DishSpec = {
    recipe_id: 1,
    recipe_name: '番茄炒蛋',
    tags: [],
    servings: 1,
    lines: [
      { definition_id: 1, definition_name: '番茄', quantity: 2, unit: '个', sort_order: 0 },
      { definition_id: 2, definition_name: '盐', quantity: 2, unit: '克', sort_order: 1 },
    ],
  }
  const dishWithoutSalt: DishSpec = {
    ...dishWithSalt,
    lines: [dishWithSalt.lines[0]],
  }

  const withSalt = evaluateCombination([dishWithSalt], stock, metaMap)
  const withoutSalt = evaluateCombination([dishWithoutSalt], stock, metaMap)

  ok(
    'A7 缺调味品时方案仍是 ready',
    planLevel(withSalt) === 'ready',
    `level=${planLevel(withSalt)}`,
  )
  ok(
    'A8 seasoning_missing_count 恒为 0，提醒计数为 1',
    withSalt.seasoning_missing_count === 0 && withSalt.seasoning_reminder_count === 1,
    `missing=${withSalt.seasoning_missing_count} reminder=${withSalt.seasoning_reminder_count}`,
  )
  ok(
    'A9 调味品不进 unknown / coverage 分母',
    withSalt.unknown_count === 0 && withSalt.coverage === 1 && withSalt.required_count === 1,
    `unknown=${withSalt.unknown_count} coverage=${withSalt.coverage} required=${withSalt.required_count}`,
  )
  ok(
    'A10 调味品不影响任何库存侧评分项（多样性只反映分类结构信息，不算库存影响）',
    (() => {
      const a = scoreBreakdown(withSalt)
      const b = scoreBreakdown(withoutSalt)
      return (
        a.ready_bonus === b.ready_bonus &&
        a.coverage === b.coverage &&
        a.utilization === b.utilization &&
        a.expiring === b.expiring &&
        a.shared === b.shared &&
        a.missing_penalty === b.missing_penalty &&
        a.unknown_penalty === b.unknown_penalty &&
        a.seasoning_penalty === 0
      )
    })(),
    `${JSON.stringify(scoreBreakdown(withSalt))} vs ${JSON.stringify(scoreBreakdown(withoutSalt))}`,
  )
  ok(
    'A11 警告项状态为 seasoning_reminder，且不进缺口语义',
    withSalt.requirements.find((r) => r.is_seasoning)?.status === 'seasoning_reminder',
    String(withSalt.requirements.find((r) => r.is_seasoning)?.status),
  )
  ok(
    'A12 调味品提醒不声称「家里有/没有」，也不取库存数量',
    (() => {
      const r = withSalt.requirements.find((x) => x.is_seasoning)
      return r !== undefined && r.available_quantity === 0 && !/家里(有|没有)/.test(r.note)
    })(),
  )

  const saltUnknown: DishSpec = {
    ...dishWithSalt,
    lines: [
      dishWithSalt.lines[0],
      { definition_id: 2, definition_name: '盐', quantity: null, unit: null, sort_order: 1 },
    ],
  }
  const saltUnknownEval = evaluateCombination([saltUnknown], stock, metaMap)
  ok(
    'A13 调味品「适量」不进 unknown，方案仍 ready',
    saltUnknownEval.unknown_count === 0 && planLevel(saltUnknownEval) === 'ready',
    `unknown=${saltUnknownEval.unknown_count} level=${planLevel(saltUnknownEval)}`,
  )

  const saltZero: DishSpec = {
    ...dishWithSalt,
    lines: [
      dishWithSalt.lines[0],
      { definition_id: 2, definition_name: '盐', quantity: 0, unit: null, sort_order: 1 },
    ],
  }
  const saltZeroEval = evaluateCombination([saltZero], stock, metaMap)
  ok(
    'A14 显式纯零调味品：不提醒',
    saltZeroEval.seasoning_reminder_count === 0 &&
      saltZeroEval.requirements.every((r) => !r.is_seasoning),
    `reminder=${saltZeroEval.seasoning_reminder_count}`,
  )

  // 额外造一批「临期调味品」库存（显式构造，避免 Map 条目元组推断歧义）
  const saltExpiring = new Map<number, StockLotInput[]>()
  for (const [k, v] of stock) saltExpiring.set(k, [...v])
  saltExpiring.set(2, [
    {
      definition_id: 2,
      unit: '克',
      quantity: 5,
      expiry_status: 'expiring',
      lot_id: 1,
    },
  ])
  const saltExpiringEval = evaluateCombination([dishWithSalt], saltExpiring, metaMap)
  ok(
    'A15 临期调味品不产生临期收益、不计入共享奖励',
    saltExpiringEval.expiring_used_count === 0 &&
      saltExpiringEval.expiring_ratio === 0 &&
      saltExpiringEval.shared_requirement_count === 0,
    `used=${saltExpiringEval.expiring_used_count} ratio=${saltExpiringEval.expiring_ratio} shared=${saltExpiringEval.shared_requirement_count}`,
  )

  /**
   * A16：两道菜**主料不同**、只共享盐。
   *
   * ⚠️ 不能用「同一道菜放两遍」来测 —— 那会同时共享番茄，测不出「只盐不计」。
   */
  const dishEggSalt: DishSpec = {
    recipe_id: 2,
    recipe_name: '鸡蛋配盐',
    tags: [],
    servings: 1,
    lines: [
      { definition_id: 3, definition_name: '鸡蛋', quantity: 3, unit: '个', sort_order: 0 },
      { definition_id: 2, definition_name: '盐', quantity: 2, unit: '克', sort_order: 1 },
    ],
  }
  const differentMainsSharedSalt = evaluateCombination([dishWithSalt, dishEggSalt], stock, metaMap)
  ok(
    'A16 两道菜主料不同、只共享盐 → 共享计数为 0（盐不计）',
    differentMainsSharedSalt.shared_requirement_count === 0,
    `shared=${differentMainsSharedSalt.shared_requirement_count}`,
  )

  /** A17 正向对照：共享的**非调味品**确实会被算 1，证明指标本身有效 */
  const dishTomatoSalt2: DishSpec = {
    recipe_id: 3,
    recipe_name: '番茄配盐二',
    tags: [],
    servings: 1,
    lines: [
      { definition_id: 1, definition_name: '番茄', quantity: 1, unit: '个', sort_order: 0 },
      { definition_id: 2, definition_name: '盐', quantity: 1, unit: '克', sort_order: 1 },
    ],
  }
  const sharedTomato = evaluateCombination([dishWithSalt, dishTomatoSalt2], stock, metaMap)
  ok(
    'A17 对照：共享番茄被计 1，同一方案里共享的盐没有被计入',
    sharedTomato.shared_requirement_count === 1,
    `shared=${sharedTomato.shared_requirement_count}`,
  )

  /** A18：同一个合并 key 里「0 + null」混合的调味品 */
  const saltZeroAndNull: DishSpec = {
    recipe_id: 4,
    recipe_name: '盐零加适量',
    tags: [],
    servings: 1,
    lines: [
      { definition_id: 1, definition_name: '番茄', quantity: 2, unit: '个', sort_order: 0 },
      { definition_id: 2, definition_name: '盐', quantity: 0, unit: '克', sort_order: 1 },
      { definition_id: 2, definition_name: '盐', quantity: null, unit: '克', sort_order: 2 },
    ],
  }
  const zeroAndNullEval = evaluateCombination([saltZeroAndNull], stock, metaMap)
  ok(
    'A18 同 key「0 + null」调味品：不计 unknown、仍出 1 条提醒、方案 ready',
    zeroAndNullEval.unknown_count === 0 &&
      zeroAndNullEval.seasoning_reminder_count === 1 &&
      planLevel(zeroAndNullEval) === 'ready',
    `unknown=${zeroAndNullEval.unknown_count} reminder=${zeroAndNullEval.seasoning_reminder_count} level=${planLevel(zeroAndNullEval)}`,
  )
}

// ⚠️ 纯函数块必须真的执行（曾漏调用，导致 16 项只写不跑）
pureTests()

/* ============================================================
 * B. 隔离库 HTTP
 * ============================================================ */

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-seasoning-${randomUUID()}`)
const dbPath = resolve(runRoot, `v024-seasoning-${Date.now()}.db`)
const realDb = resolve(serverRoot, 'data', 'homechef.db')
const PORT = 63400 + Math.floor(Math.random() * 400)
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

const DEF_TOMATO = 1
const DEF_SALT = 2
for (const [id, name, cat] of [
  [DEF_TOMATO, '番茄', requireCat('蔬菜')],
  [DEF_SALT, '盐', requireCat('调味品')],
] as Array<[number, string, number]>) {
  setup
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(id, name, name, cat, now, now)
}

function insertRecipe(id: number, name: string, lines: Array<[number, number | null, string | null]>) {
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

// R1：番茄 2 个 + 盐 2 克（调味品、有量、库存里完全没有盐）
insertRecipe(1, '番茄配盐', [
  [DEF_TOMATO, 2, '个'],
  [DEF_SALT, 2, '克'],
])
// R2：番茄「适量」——非调味品未知用量，规则必须保持
insertRecipe(2, '番茄适量', [[DEF_TOMATO, null, null]])
// R3：番茄 2 个 + 盐「适量」
insertRecipe(3, '番茄配盐适量', [
  [DEF_TOMATO, 2, '个'],
  [DEF_SALT, null, null],
])

// 只备番茄，没有盐（也不放哨兵批次）
setup
  .prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  )
  .run(DEF_TOMATO, 10, '个', '2026-01-01', null, null, '常温', now, now)

function insertSession(id: number, recipeId: number) {
  setup
    .prepare(
      'insert into cooking_session (id, status, recipe_revision, started_at, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(id, 'active', 0, now, now, now)
  setup
    .prepare(
      'insert into cooking_session_dish (session_id, recipe_id, status, servings, confirmed_revision, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    )
    .run(id, recipeId, 'pending', 1, 0, 0, now, now)
}
insertSession(101, 1)
insertSession(102, 2)
insertSession(103, 3)

// 历史兼容：会话 104 用同一菜谱，且**预先落了一条调味品的 user_choice**
insertSession(104, 1)
setup
  .prepare(
    'insert into cooking_session_dish_skip (session_id, dish_id, line_key, definition_id, unit_key, reason, confirmed_at) values (?,?,?,?,?,?,?)',
  )
  .run(
    104,
    (setup
      .prepare('select id from cooking_session_dish where session_id = 104')
      .get() as { id: number }).id,
    'lk-1-1',
    DEF_SALT,
    '克',
    'user_choice',
    now,
  )

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

let server: ReturnType<typeof startServer> | null = null

try {
  server = startServer({ cwd: serverRoot, port: PORT, dbPath, stdio: 'pipe' })
  await waitForReady({ url: `${BASE}/health`, timeoutMs: 30_000, handle: server })

  console.log('\n[B] 结算预览 / 结算（隔离库 HTTP）')

  const pv1 = await req('GET', '/api/cooking/sessions/101/settle/preview')
  const saltItem = (pv1.body?.items ?? []).find((i: any) => i.definition_id === DEF_SALT)
  ok('B1 预览：调味品出现在列表里并标记 is_seasoning', pv1.status === 200 && saltItem?.is_seasoning === true)
  ok(
    'B2 预览：调味品不需要确认（required_reason/confirm_reason 为 null、skipped）',
    saltItem?.required_reason === null && saltItem?.confirm_reason === null && saltItem?.skipped === true,
    JSON.stringify(saltItem),
  )
  ok('B3 预览：没有任何待确认项，ready=true', pv1.body?.needing_confirmation === 0 && pv1.body?.ready === true)
  ok(
    'B4 预览：调味品不参与库存充足判定（没有盐库存也 stock_sufficient=true）',
    pv1.body?.stock_sufficient === true,
  )

  const tomatoBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ?')
    .get(DEF_TOMATO) as { quantity: number }).quantity

  const st1 = await req('POST', '/api/cooking/sessions/101/settle', {})
  ok('B5 结算成功（无需任何调味品确认）', st1.status === 200, `${st1.status} ${JSON.stringify(st1.body)}`)
  ok(
    'B6 结算明细里没有调味品行（不伪造 user_choice / consumed 0）',
    (st1.body?.items ?? []).every((i: any) => i.definition_id !== DEF_SALT) &&
      (st1.body?.items ?? []).length === 1,
    JSON.stringify(st1.body?.items),
  )
  ok(
    'B7 库存只扣了计库存项（番茄 10 → 8）',
    (raw.prepare('select quantity from standard_ingredient where definition_id = ?').get(DEF_TOMATO) as {
      quantity: number
    }).quantity === tomatoBefore - 2,
  )
  ok(
    'B8 本次结算没有新增调味品的跳过确认行（不伪造 user_choice）',
    (raw
      .prepare('select count(*) as c from cooking_session_dish_skip where definition_id = ? and session_id = 101')
      .get(DEF_SALT) as { c: number }).c === 0,
  )

  /* ---- B8b/B8c：调味品**有正库存**时同样一分不扣（否则"没扣"只是没库存可扣） ---- */
  raw
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(DEF_SALT, 100, '克', '2026-01-01', null, null, '常温', now, now)
  raw
    .prepare(
      'insert into cooking_session (id, status, recipe_revision, started_at, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(105, 'active', 0, now, now, now)
  raw
    .prepare(
      'insert into cooking_session_dish (session_id, recipe_id, status, servings, confirmed_revision, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
    )
    .run(105, 1, 'pending', 1, 0, 0, now, now)

  const saltBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ? and unit = ?')
    .get(DEF_SALT, '克') as { quantity: number }).quantity
  const pv5 = await req('GET', '/api/cooking/sessions/105/settle/preview')
  ok(
    'B8b 有正库存的调味品仍然免确认、预览 ready',
    pv5.body?.needing_confirmation === 0 && pv5.body?.ready === true,
    `nc=${pv5.body?.needing_confirmation} ready=${pv5.body?.ready}`,
  )
  const st5 = await req('POST', '/api/cooking/sessions/105/settle', {})
  const saltAfter = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ? and unit = ?')
    .get(DEF_SALT, '克') as { quantity: number }).quantity
  ok(
    'B8c 结算后调味品数量完全不变（100 克），且未写入凭证行',
    st5.status === 200 &&
      saltBefore === 100 &&
      saltAfter === saltBefore &&
      (st5.body?.items ?? []).every((i: any) => i.definition_id !== DEF_SALT),
    `before=${saltBefore} after=${saltAfter} status=${st5.status}`,
  )

  const pv2 = await req('GET', '/api/cooking/sessions/102/settle/preview')
  ok(
    'B9 非调味品「适量」仍然需要确认（规则未被放宽）',
    pv2.body?.needing_confirmation === 1 && pv2.body?.ready === false,
    `nc=${pv2.body?.needing_confirmation} ready=${pv2.body?.ready}`,
  )
  const st2 = await req('POST', '/api/cooking/sessions/102/settle', {})
  ok('B10 未确认的非调味品仍阻挡结算（409）', st2.status === 409, String(st2.status))

  const pv3 = await req('GET', '/api/cooking/sessions/103/settle/preview')
  const salt3 = (pv3.body?.items ?? []).find((i: any) => i.definition_id === DEF_SALT)
  ok(
    'B11 调味品「适量」也不进待确认（needing_confirmation=0）',
    pv3.body?.needing_confirmation === 0 && salt3?.is_seasoning === true,
    `nc=${pv3.body?.needing_confirmation}`,
  )
  const st3 = await req('POST', '/api/cooking/sessions/103/settle', {})
  ok('B12 含「盐 适量」的会话可直接结算', st3.status === 200, String(st3.status))

  const pv4 = await req('GET', '/api/cooking/sessions/104/settle/preview')
  ok('B13 历史 user_choice 行不再造成额外要求', pv4.body?.needing_confirmation === 0)
  const st4 = await req('POST', '/api/cooking/sessions/104/settle', {})
  ok('B14 带历史确认的旧会话仍能结算', st4.status === 200, String(st4.status))
  ok(
    'B15 旧确认行保留、未被清理（兼容而非改写历史）',
    (raw
      .prepare('select count(*) as c from cooking_session_dish_skip where session_id = 104')
      .get() as { c: number }).c === 1,
  )

  console.log('\n[C] 推荐（隔离库 HTTP）')
  const rec = await req('POST', '/api/recommendation/meal-plans', { people: 2 })
  ok('C1 推荐接口 200', rec.status === 200, String(rec.status))
  const plans: any[] = rec.body?.plans ?? []
  ok('C2 有方案返回', plans.length > 0)
  ok(
    'C3 没有方案因为缺调味品被降级（不出现 seasoning_missing_count > 0）',
    plans.every((p) => (p.summary?.seasoning_missing_count ?? 0) === 0),
  )
  ok(
    'C4 缺口清单里没有调味品',
    plans.every((p) => (p.shortages ?? []).every((s: any) => !s.is_seasoning)),
  )
  ok(
    'C5 调味品以 seasoning_reminder 出现，且不声称家里有/没有',
    plans.every((p) => {
      const reminder = (p.requirements ?? []).find((r: any) => r.status === 'seasoning_reminder')
      return reminder === undefined || !/家里(有|没有)/.test(String(reminder.note))
    }),
  )
  ok(
    'C6 调味品不进 unknown_count',
    plans.every((p) => {
      const unknownSeasoning = (p.requirements ?? []).some(
        (r: any) => r.status === 'unknown_quantity' && r.is_seasoning === true,
      )
      return !unknownSeasoning
    }),
  )

  console.log('\n[D] 快照与调味品库存（apply 的 snapshot 不应因盐变化而失效）')

  const plan0 = plans[0]
  const snap0: string = plan0?.snapshot_id
  const dishes0 = (plan0?.dishes ?? []).map((d: any) => ({
    recipe_id: d.recipe_id,
    servings: d.servings,
  }))
  const applyBody = (requestId: string) => ({
    people: 2,
    dishes: dishes0,
    snapshot_id: snap0,
    request_id: requestId,
  })

  const ap1 = await req('POST', '/api/recommendation/apply', applyBody(`d-${randomUUID()}`))
  ok(
    'D1 当前快照可直接 apply（200）',
    ap1.status === 200 && typeof ap1.body?.session_id === 'number',
    `${ap1.status} ${JSON.stringify(ap1.body)}`,
  )
  if (ap1.status !== 200) throw new Error('D1 前置失败：无法用当前快照创建会话，后续断言不可信')

  // ① 只改**调味品**库存 → 快照不得失效
  const saltQtyBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ? and unit = ?')
    .get(DEF_SALT, '克') as { quantity: number }).quantity
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ? and unit = ?')
    .run(saltQtyBefore + 50, new Date().toISOString(), DEF_SALT, '克')
  const ap2 = await req('POST', '/api/recommendation/apply', applyBody(`d-${randomUUID()}`))
  ok(
    'D2 只改调味品库存（+50 克）→ 旧快照仍有效（200，不是 SNAPSHOT_STALE）',
    ap2.status === 200,
    `${ap2.status} ${JSON.stringify(ap2.body)}`,
  )
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ? and unit = ?')
    .run(saltQtyBefore, new Date().toISOString(), DEF_SALT, '克')

  // ② 改**非调味品**库存 → 快照必须失效
  const tomatoQtyBefore = (raw
    .prepare('select quantity from standard_ingredient where definition_id = ?')
    .get(DEF_TOMATO) as { quantity: number }).quantity
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ?')
    .run(tomatoQtyBefore - 1, new Date().toISOString(), DEF_TOMATO)
  const ap3 = await req('POST', '/api/recommendation/apply', applyBody(`d-${randomUUID()}`))
  ok(
    'D3 改非调味品库存 → 409 SNAPSHOT_STALE',
    ap3.status === 409 && ap3.body?.error?.code === 'SNAPSHOT_STALE',
    `${ap3.status} ${JSON.stringify(ap3.body)}`,
  )
  raw
    .prepare('update standard_ingredient set quantity = ?, updated_at = ? where definition_id = ?')
    .run(tomatoQtyBefore, new Date().toISOString(), DEF_TOMATO)
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
    } else if (!basename(resolvedRun).startsWith('hc-v024-seasoning-')) {
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
