/**
 * v0.2.4 测试库存补量 + 批次期限拉长（**库函数，无副作用**）
 *
 * 目标（用户本轮授权）：
 *   - 只针对**非调味**、且在菜谱里被用到的 (definition, unit) 组合；
 *   - 按单位累计目标：克 3000–5000、个/包/袋/盒等 10–30、毫升 3000、升 3、千克 3；
 *     **绝不跨单位相加**；
 *   - 已有批次 `expiry_date` 早于今天 +90 天的，拉长到 +90（更晚的保留），
 *     `expiry_date_source` 改为 `manual`；`purchase_date` / `production_date` 不动；
 *   - 差额补**新批次**，期限 +90~180 天，备注「v024 测试库存」；
 *   - 不新增过期 / 短期批次；不删旧行、不归零；不调味品不造数值库存；
 *   - dry-run 与 apply 的计划完全一致，第二遍（同日）无补量、无日期更新。
 */

import type Database from 'better-sqlite3'

export const MIN_EXPIRY_DAYS = 90
export const MAX_EXPIRY_DAYS = 180
/** ⚠️ 期限是测试值，不代表真实食用安全期限 */
const TEST_STOCK_NOTE = 'v024 测试库存（有效期为测试值，不代表真实食用安全期限）'

export interface StockTarget {
  unit: string
  /** 目标累计量（按 definition + unit 汇总） */
  target: number
}

/** 按单位的累计目标 */
export function targetForUnit(unit: string): number {
  switch (unit) {
    case '克':
      return 4000
    case '千克':
      return 4
    case '毫升':
      return 3000
    case '升':
      return 3
    case '个':
    case '包':
    case '袋':
    case '盒':
    case '瓶':
    case '罐':
      return 20
    default:
      return 0
  }
}

export interface TopUpRow {
  definition_id: number
  definition_name: string
  category: string | null
  unit: string
  current: number
  target: number
  add: number
}

export interface ExpiryUpdate {
  id: number
  definition_id: number
  definition_name: string
  unit: string
  from: string | null
  to: string
}

export interface StockPlan {
  today: string
  topups: TopUpRow[]
  expiry_updates: ExpiryUpdate[]
  /** 有库存但没有到期日的批次（不改，仅报告） */
  null_expiry_count: number
  /** 调味品定义（不造数值库存，仅报告数量） */
  seasoning_definition_count: number
  /** 菜谱里出现、但定义不允许的单位（跳过，不造库存） */
  skipped_invalid_pairs: Array<{ definition_name: string; unit: string }>
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`
}

/** 计划：只读，不写任何数据 */
export function planStock(db: Database.Database, options: { today?: string } = {}): StockPlan {
  const today = options.today ?? todayLocal()
  const cutoff = addDays(today, MIN_EXPIRY_DAYS)

  /**
   * ⚠️ 只认**定义允许的单位**：菜谱里若写了定义不允许的单位（历史脏数据，
   *    例如「红枣 / 个」），不拿它造库存，只记录并跳过。
   */
  const pairs = db
    .prepare(
      `select distinct ri.definition_id, ri.unit, d.name as definition_name, c.name as category
       from recipe_ingredient ri
       join ingredient_definition d on d.id = ri.definition_id
       join ingredient_definition_unit u
         on u.definition_id = ri.definition_id and u.unit = ri.unit
       left join category c on c.id = d.category_id
       where ri.unit is not null
         and (c.name is null or c.name <> '调味品')`,
    )
    .all() as Array<{
    definition_id: number
    unit: string
    definition_name: string
    category: string | null
  }>

  const stockRows = db
    .prepare(
      `select id, definition_id, quantity, unit, expiry_date
       from standard_ingredient`,
    )
    .all() as Array<{
    id: number
    definition_id: number
    quantity: number
    unit: string
    expiry_date: string | null
  }>

  const currentByKey = new Map<string, number>()
  for (const r of stockRows) {
    const key = `${r.definition_id}|${r.unit}`
    currentByKey.set(key, (currentByKey.get(key) ?? 0) + r.quantity)
  }

  const topups: TopUpRow[] = []
  for (const p of pairs) {
    const target = targetForUnit(p.unit)
    if (target <= 0) continue
    const current = currentByKey.get(`${p.definition_id}|${p.unit}`) ?? 0
    const add = Math.round((target - current) * 1000) / 1000
    if (add <= 0) continue
    topups.push({
      definition_id: p.definition_id,
      definition_name: p.definition_name,
      category: p.category,
      unit: p.unit,
      current: Math.round(current * 1000) / 1000,
      target,
      add,
    })
  }

  // 所有非调味定义（包括不在新菜谱里的旧定义）都可以拉长期限
  const allDefs = db
    .prepare(
      `select d.id, d.name, c.name as category
       from ingredient_definition d left join category c on c.id = d.category_id`,
    )
    .all() as Array<{ id: number; name: string; category: string | null }>
  const defInfo = new Map(allDefs.map((d) => [d.id, d]))

  const expiry_updates: ExpiryUpdate[] = []
  let nullExpiry = 0
  for (const r of stockRows) {
    const info = defInfo.get(r.definition_id)
    // ⚠️ 调味品不按量管理：不改它的日期，也不造数值库存
    if (info?.category === '调味品') continue

    if (r.expiry_date === null) {
      // 用户明确要求「延长保质期」：测试批次统一补一个 +90 天的到期日
      expiry_updates.push({
        id: r.id,
        definition_id: r.definition_id,
        definition_name: info?.name ?? `#${r.definition_id}`,
        unit: r.unit,
        from: null,
        to: addDays(today, MIN_EXPIRY_DAYS),
      })
      nullExpiry++
      continue
    }
    if (r.expiry_date < cutoff) {
      expiry_updates.push({
        id: r.id,
        definition_id: r.definition_id,
        definition_name: info?.name ?? `#${r.definition_id}`,
        unit: r.unit,
        from: r.expiry_date,
        to: addDays(today, MIN_EXPIRY_DAYS),
      })
    }
  }

  const seasoningCount = (
    db
      .prepare(
        `select count(*) as c from ingredient_definition d
         join category c on c.id = d.category_id where c.name = '调味品'`,
      )
      .get() as { c: number }
  ).c

  const skippedInvalid = db
    .prepare(
      `select distinct d.name as definition_name, ri.unit as unit
       from recipe_ingredient ri
       join ingredient_definition d on d.id = ri.definition_id
       left join category c on c.id = d.category_id
       where ri.unit is not null
         and (c.name is null or c.name <> '调味品')
         and not exists (
           select 1 from ingredient_definition_unit u
           where u.definition_id = ri.definition_id and u.unit = ri.unit
         )
       order by d.name, ri.unit`,
    )
    .all() as Array<{ definition_name: string; unit: string }>

  return {
    today,
    topups: topups.sort((a, b) => a.definition_id - b.definition_id || (a.unit < b.unit ? -1 : 1)),
    expiry_updates: expiry_updates.sort((a, b) => a.id - b.id),
    null_expiry_count: nullExpiry,
    seasoning_definition_count: seasoningCount,
    skipped_invalid_pairs: skippedInvalid,
  }
}

/** 新批次的储存方式：按分类给出常识值（测试数据也用合理储存方式） */
export function storageMethodFor(category: string | null): string {
  switch (category) {
    case '猪肉':
    case '牛肉':
    case '羊肉':
    case '其他畜肉':
    case '鸡肉':
    case '鸭肉':
    case '鹅肉':
    case '其他禽肉':
    case '水产':
    case '冷冻食品':
      return '冷冻'
    case '蛋类':
    case '豆制品':
    case '乳制品':
    case '蔬菜':
    case '水果':
      return '冷藏'
    default:
      return '常温'
  }
}

export interface ApplyStockResult {
  updated_expiry: number
  inserted_batches: number
}

/** 执行计划（调用方负责包事务；本函数只做写，不做判断） */
export function applyStock(
  db: Database.Database,
  plan: StockPlan,
  options: { timestamp?: string } = {},
): ApplyStockResult {
  const timestamp = options.timestamp ?? new Date().toISOString()
  const update = db.prepare(
    `update standard_ingredient
     set expiry_date = ?, expiry_date_source = 'manual', updated_at = ?
     where id = ?`,
  )
  const insert = db.prepare(
    `insert into standard_ingredient
       (definition_id, quantity, unit, purchase_date, production_date, expiry_date,
        expiry_date_source, storage_method, note, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?)`,
  )

  let updated = 0
  for (const u of plan.expiry_updates) {
    update.run(u.to, timestamp, u.id)
    updated++
  }

  let inserted = 0
  for (const t of plan.topups) {
    // 期限 90–180 天之间，按 definition_id 确定性取值
    const span = MAX_EXPIRY_DAYS - MIN_EXPIRY_DAYS
    const offset = MIN_EXPIRY_DAYS + (t.definition_id % (span + 1))
    insert.run(
      t.definition_id,
      t.add,
      t.unit,
      plan.today,
      null,
      addDays(plan.today, offset),
      'manual',
      storageMethodFor(t.category),
      TEST_STOCK_NOTE,
      timestamp,
      timestamp,
    )
    inserted++
  }

  return { updated_expiry: updated, inserted_batches: inserted }
}

/** 文本报告（dry-run 打印计划） */
export function formatStockPlan(plan: StockPlan): string {
  const lines = [
    `今天：${plan.today}`,
    `期限拉长：${plan.expiry_updates.length} 条（目标 ≥ 今天 +${MIN_EXPIRY_DAYS} 天）`,
    `补量批次：${plan.topups.length} 条`,
    `无到期日批次（已补 +${MIN_EXPIRY_DAYS} 天）：${plan.null_expiry_count}`,
    `调味品定义（不造数值库存、不改日期）：${plan.seasoning_definition_count}`,
    `菜谱里非法单位组合（已跳过）：${plan.skipped_invalid_pairs.length}`,
  ]
  for (const p of plan.skipped_invalid_pairs.slice(0, 10)) {
    lines.push(`  ! ${p.definition_name} 的「${p.unit}」不在允许单位内，未造库存`)
  }
  for (const t of plan.topups.slice(0, 20)) {
    lines.push(`  + ${t.definition_name} ${t.unit}：${t.current} → ${t.target}（补 ${t.add}）`)
  }
  if (plan.topups.length > 20) lines.push(`  … 其余 ${plan.topups.length - 20} 条省略`)
  for (const u of plan.expiry_updates.slice(0, 10)) {
    lines.push(`  ~ ${u.definition_name} ${u.unit}：${u.from} → ${u.to}`)
  }
  if (plan.expiry_updates.length > 10) lines.push(`  … 其余 ${plan.expiry_updates.length - 10} 条省略`)
  return lines.join('\n')
}
