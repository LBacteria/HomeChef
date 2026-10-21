/**
 * v0.2.3 验证（阶段 B 后端）：Tag 五大分类 + 单菜偏好 + 推荐算法扩展
 *
 * A 部分：**纯函数单测**（无 DB）
 *   - 五分类字典 / 预设 code 漂移检查 / 结构语义稳定性
 *   - 调味品 presence 的过期批次修复（v0.2.2 审计项）
 *   - 用量利用率、临期可实耗比例、共享食材计数（无量纲、不重复占用）
 *   - 评分分项、衰减、偏好加权、轮换确定性、排序优先级
 * B 部分：**HTTP 集成**（隔离临时库 + 动态端口）
 *   - Tag CRUD（分类、改名、校验、删除保留菜谱）
 *   - 单菜偏好 CRUD（like / dislike / 取消）
 *   - 推荐：标签筛选、软信号、缺口清单、每日轮换确定性、零写入
 *   - 快照语义：偏好/历史变化**不**使旧用量快照失效；配料变化**必须**失效
 *
 * ⚠️ 全程使用独立临时库；路径校验在创建/删除任何文件**之前**完成。
 * ⚠️ 绝不触碰真实库 server/data/homechef.db，绝不设置 HOME_CHEF_ALLOW_REAL_DB。
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
  planLevelRank,
  scoreBreakdown,
} from './src/services/recommendationAlgorithm.js'
import type {
  DishSpec,
  DefinitionMeta,
  StockIndex,
  StockLotInput,
} from './src/services/recommendationAlgorithm.js'
import {
  HISTORY_HALF_LIFE_DAYS,
  ROTATION_AMPLITUDE,
  ROTATION_REPEAT_PENALTY,
} from './src/services/recommendationConfig.js'
import {
  compareCandidateOrder,
  comparePlanOrder,
  computeSoftSignals,
  decayFactor,
  hashToUnit,
  historyPenalty,
  preferenceAdjustment,
  quantityCoverageBucket,
  rotationAdjustment,
} from './src/services/recommendationRanking.js'
import {
  PRESET_RECIPE_TAGS,
  RECIPE_TAG_CATEGORIES,
  RECIPE_TAG_CATEGORY_LABELS,
  DISH_ROLE_BY_CODE,
  resolveDishRole,
} from './src/services/tagConfig.js'
import { scaleLineQuantity } from './src/services/quantity.js'
import { deriveRequiredReason, isSatisfiedBy } from './src/services/skipReasonService.js'

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
 * A. 纯函数单测
 * ============================================================ */

const META: Map<number, DefinitionMeta> = new Map([
  [1, { is_seasoning: false, category_name: '蔬菜' }],
  [2, { is_seasoning: false, category_name: '蛋类' }],
  [3, { is_seasoning: true, category_name: '调味品' }],
  [4, { is_seasoning: false, category_name: '蔬菜' }],
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
  tags: string[] = [],
  tagRefs: Array<{ name: string; category: string | null; code: string | null }> = [],
): DishSpec {
  return {
    recipe_id,
    recipe_name: `菜${recipe_id}`,
    tags,
    tag_refs: tagRefs,
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

section('A. 纯函数单测')

/* ---------- A1–A4：分类字典与预设 ---------- */
{
  ok(
    'A1 五大分类固定且中文别名齐全',
    RECIPE_TAG_CATEGORIES.length === 5 &&
      RECIPE_TAG_CATEGORIES.every((c) => typeof RECIPE_TAG_CATEGORY_LABELS[c] === 'string'),
    RECIPE_TAG_CATEGORIES.join('、'),
  )

  /**
   * v0.2.4：标签体系由 0012（初版预设）+ 0014（移除时段、新增菜系等）共同决定。
   * A2 比对的是**应用迁移后的有效预设清单**，不再只拿 0012 的 code 对配置。
   */
  const codesInSql = new Set<string>()
  for (const file of ['0012_v023_tags_preference.sql', '0014_tag_taxonomy.sql']) {
    const sql = readFileSync(resolve(process.cwd(), 'drizzle', file), 'utf8')
    for (const m of sql.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) codesInSql.add(m[1])
  }
  // 0014 明确删除的四条系统时段标签
  for (const removed of ['scene.breakfast', 'scene.lunch', 'scene.dinner', 'scene.supper']) {
    codesInSql.delete(removed)
  }

  const codesInConfig = new Set(PRESET_RECIPE_TAGS.map((p) => p.code))
  const missingInSql = [...codesInConfig].filter((c) => !codesInSql.has(c))
  const extraInSql = [...codesInSql].filter((c) => !codesInConfig.has(c))
  ok(
    'A2 应用 0012+0014 后的有效预设 code 与配置清单一致（防漂移）',
    missingInSql.length === 0 && extraInSql.length === 0,
    `missing=${JSON.stringify(missingInSql)} extra=${JSON.stringify(extraInSql)}`,
  )
  ok(
    'A3 预设分类全部落在五大分类内、且 code 唯一',
    PRESET_RECIPE_TAGS.every((p) => (RECIPE_TAG_CATEGORIES as readonly string[]).includes(p.category)) &&
      codesInConfig.size === PRESET_RECIPE_TAGS.length,
  )
  ok(
    'A4 结构角色表覆盖全部菜品类型预设',
    PRESET_RECIPE_TAGS
      .filter((p) => p.category === 'dish_type')
      .every((p) => DISH_ROLE_BY_CODE[p.code] !== undefined),
  )
}

/* ---------- A5–A7：结构语义（稳定 code / 名称回退 / 降级） ---------- */
{
  ok(
    'A5 有 code → 按 code 判定（重命名不影响）',
    resolveDishRole({ code: 'dish_type.staple', name: '主食类改名了', category: 'dish_type' }) ===
      'staple',
  )
  ok(
    'A6 无 code 且分类为 dish_type → 按名称回退',
    resolveDishRole({ code: null, name: '素菜', category: 'dish_type' }) === 'vegetable',
  )
  ok(
    'A7 无 code 且非 dish_type → 不解析（不误判）',
    resolveDishRole({ code: null, name: '素菜', category: 'flavor' }) === null,
  )
  ok(
    'A7b 预设**改名**仍保留类型（稳定 code）',
    resolveDishRole({ code: 'dish_type.staple', name: '主食类', category: 'dish_type' }) === 'staple',
  )
  ok(
    'A7c 预设**迁到其他分类** → 停止类型推断（尊重用户的显式操作）',
    resolveDishRole({ code: 'dish_type.staple', name: '改名主食', category: 'flavor' }) === null,
  )
  ok(
    'A7d 预设**清空分类（未分类）** → 同样停止类型推断',
    resolveDishRole({ code: 'dish_type.staple', name: '主食', category: null }) === null,
  )

  /* ---------- A7e：迁类后结构**降级**（不产生隐形类型加分） ---------- */
  {
    const stillTyped = evaluateCombination(
      [
        dish(1, 1, [], ['荤菜'], [{ name: '荤菜', category: 'dish_type', code: 'dish_type.meat' }]),
        dish(2, 1, [], ['素菜'], [
          { name: '素菜', category: 'dish_type', code: 'dish_type.vegetable' },
        ]),
      ],
      new Map(),
      new Map(),
    )
    const movedOut = evaluateCombination(
      [
        // 用户把这两个预设**迁到「口味」**：界面已不再显示为菜品类型
        dish(1, 1, [], ['荤菜'], [{ name: '荤菜', category: 'flavor', code: 'dish_type.meat' }]),
        dish(2, 1, [], ['素菜'], [
          { name: '素菜', category: 'flavor', code: 'dish_type.vegetable' },
        ]),
      ],
      new Map(),
      new Map(),
    )
    ok(
      'A7e 迁类后结构分降为 0（不再按菜品类型加分，无隐形类型）',
      stillTyped.structure_score > 0 && movedOut.structure_score === 0,
      `${stillTyped.structure_score} → ${movedOut.structure_score}`,
    )
  }

  const stapleOnly = evaluateCombination(
    [
      dish(1, 1, [], ['主食'], [{ name: '主食', category: 'dish_type', code: 'dish_type.staple' }]),
      dish(2, 1, [], ['主食'], [{ name: '主食', category: 'dish_type', code: 'dish_type.staple' }]),
    ],
    new Map(),
    new Map(),
  )
  ok(
    'A8 全主食 → 结构分为负（至少避免全主食）',
    stapleOnly.structure_score < 0 && stapleOnly.dish_roles.join(',') === 'staple',
    `structure=${stapleOnly.structure_score}`,
  )

  const balanced = evaluateCombination(
    [
      dish(1, 1, [], ['荤菜'], [{ name: '荤菜', category: 'dish_type', code: 'dish_type.meat' }]),
      dish(2, 1, [], ['素菜'], [{ name: '素菜', category: 'dish_type', code: 'dish_type.vegetable' }]),
      dish(3, 1, [], ['主食'], [{ name: '主食', category: 'dish_type', code: 'dish_type.staple' }]),
    ],
    new Map(),
    new Map(),
  )
  ok(
    'A9 荤+素+主食 → 结构分为正、角色齐全',
    balanced.structure_score > 0 && balanced.dish_roles.join(',') === 'meat,staple,vegetable',
    `structure=${balanced.structure_score} roles=${balanced.dish_roles.join(',')}`,
  )

  const untagged = evaluateCombination([dish(1, 1, [])], new Map(), new Map())
  ok(
    'A10 标签缺失 → 结构分 0（正常降级，不惩罚）',
    untagged.structure_score === 0 && untagged.dish_roles.length === 0,
  )
}

/* ---------- A11–A13：调味品（v0.2.4 决策：库存状态不再影响结论，只出中性提醒） ---------- */
{
  const onlyExpired = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([lot(3, '克', 5, 'expired')]),
    META,
  )
  ok(
    'A11 调味品只剩过期批次 → 仍是中性提醒，不是缺口',
    onlyExpired.requirements[0].status === 'seasoning_reminder' &&
      onlyExpired.seasoning_missing_count === 0 &&
      onlyExpired.seasoning_reminder_count === 1,
    onlyExpired.requirements[0].status,
  )

  const zeroButFresh = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([lot(3, '克', 0, 'normal')]),
    META,
  )
  ok(
    'A12 调味品 quantity=0 → 出中性提醒，且不声称「家里有」',
    zeroButFresh.requirements[0].status === 'seasoning_reminder' &&
      zeroButFresh.seasoning_missing_count === 0,
    zeroButFresh.requirements[0].status,
  )

  const mixed = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([lot(3, '克', 5, 'expired'), lot(3, '克', 0, 'normal')]),
    META,
  )
  ok(
    'A13 过期 + 未过期混合 → 不把过期量算作临期消耗，也不声明消耗',
    mixed.requirements[0].used_expiring === false && mixed.expiring_used_count === 0,
  )
}

/* ---------- A14–A17：用量利用率 / 临期比例（无量纲、不重复占用） ---------- */
{
  const e = evaluateCombination(
    [
      dish(1, 1, [[1, '番茄', 2, '个']]),
      dish(2, 1, [[1, '番茄', 2, '个']]),
      dish(3, 1, [[4, '土豆', 5, '个']]),
    ],
    stockIndexOf([lot(1, '个', 6), lot(4, '个', 1)]),
    META,
  )
  // 番茄：合并需求 4，可用 6 → 满足；土豆：需求 5，可用 1 → 缺口
  // quantity_coverage = mean(1, 1/5) = 0.6
  // utilization（库存消耗比例）= mean(4/6, 0) ≈ 0.3333（缺口不给奖励）
  ok(
    'A14 需求满足比例：**逐条需求**算 min(需求,可用)/需求 再平均（不重复占用）',
    e.quantity_coverage === 0.6,
    `quantity_coverage=${e.quantity_coverage}`,
  )
  ok(
    'A14b 库存消耗比例：满足项按 需求/可用 计，缺口项恒为 0',
    e.utilization === 0.3333,
    `utilization=${e.utilization}`,
  )
  ok(
    'A14c 两条指标都落在 [0,1]',
    e.quantity_coverage >= 0 &&
      e.quantity_coverage <= 1 &&
      e.utilization >= 0 &&
      e.utilization <= 1,
  )
  ok(
    'A14d 跨菜共享需求确实被合并（番茄只有一条需求，需求 4）',
    e.requirements.filter((r) => r.definition_id === 1).length === 1 &&
      e.requirements.find((r) => r.definition_id === 1)!.required_quantity === 4,
  )
  ok(
    'A14e 共享食材计数：仅番茄被 2 道菜共享（土豆只出现在 1 道菜里）→ 1',
    e.shared_requirement_count === 1,
    String(e.shared_requirement_count),
  )

  const expiringOk = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 2, '个']])],
    stockIndexOf([lot(1, '个', 1, 'expiring'), lot(1, '个', 5)]),
    META,
  )
  ok(
    'A15 临期可实耗 = min(需求, 临期可用) = 1 → 比例 0.5',
    expiringOk.expiring_ratio === 0.5,
    String(expiringOk.expiring_ratio),
  )

  const expiringMissing = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 20, '个']])],
    stockIndexOf([lot(1, '个', 1, 'expiring')]),
    META,
  )
  ok(
    'A16 缺料时**不**虚称消耗临期（比例 0）',
    expiringMissing.expiring_ratio === 0 && expiringMissing.expiring_used_count === 0,
  )

  const expiringUnknown = evaluateCombination(
    [dish(1, 1, [[1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 9, 'expiring')]),
    META,
  )
  ok(
    'A17 未知用量**不**虚称消耗临期（比例 0）',
    expiringUnknown.expiring_ratio === 0 && expiringUnknown.requirements[0].used_expiring === false,
  )

  /* ---------- A17b–A17d：跨单位尺度不变性 / 混合未知量（Sol 审查项 1、2） ---------- */
  {
    const a = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1000, '克'], [2, '鸡蛋', 1, '个']])],
      stockIndexOf([lot(1, '克', 1000), lot(2, '个', 0)]),
      META,
    )
    const b = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1, '千克'], [2, '鸡蛋', 1, '个']])],
      stockIndexOf([lot(1, '千克', 1), lot(2, '个', 0)]),
      META,
    )
    ok(
      'A17b 换一个食材的计量尺度（克↔千克）后，满足比例与消耗比例都不变',
      a.quantity_coverage === b.quantity_coverage && a.utilization === b.utilization,
      `${a.quantity_coverage}/${a.utilization} vs ${b.quantity_coverage}/${b.utilization}`,
    )

    const ea = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1000, '克'], [2, '鸡蛋', 1, '个']])],
      stockIndexOf([lot(1, '克', 1000, 'expiring'), lot(2, '个', 1)]),
      META,
    )
    const eb = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1, '千克'], [2, '鸡蛋', 1, '个']])],
      stockIndexOf([lot(1, '千克', 1, 'expiring'), lot(2, '个', 1)]),
      META,
    )
    ok(
      'A17c 临期可实耗比例同样不把「克」与「个」相加（尺度不变）',
      ea.expiring_ratio === eb.expiring_ratio,
      `${ea.expiring_ratio} vs ${eb.expiring_ratio}`,
    )

    const small = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1, '个']])],
      stockIndexOf([lot(1, '个', 100)]),
      META,
    )
    const large = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 80, '个']])],
      stockIndexOf([lot(1, '个', 100)]),
      META,
    )
    ok(
      'A17d 库存消耗比例能区分「用一点点」与「用掉大半」（不能恒等于需求满足率）',
      large.utilization > small.utilization,
      `${large.utilization} > ${small.utilization}`,
    )

    const mixedUnknown = evaluateCombination(
      [dish(1, 1, [[1, '番茄', 1, '个'], [1, '番茄', null, '个']])],
      stockIndexOf([lot(1, '个', 10, 'expiring')]),
      META,
    )
    ok(
      'A17e 同 key 混有未知用量 → 既不声称消耗临期，也不给库存消耗奖励',
      mixedUnknown.requirements[0].used_expiring === false &&
        mixedUnknown.expiring_ratio === 0 &&
        mixedUnknown.utilization === 0 &&
        planLevel(mixedUnknown) !== 'ready',
      `expiring=${mixedUnknown.expiring_ratio} util=${mixedUnknown.utilization} level=${planLevel(mixedUnknown)}`,
    )
  }
}

/* ---------- A17f–A17l：共享奖励口径（Sol 审查项：同单位 / 非调味品 / 已知量 / 已满足） ---------- */
{
  const oneDishRepeated = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 2, '个'], [1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 10)]),
    META,
  )
  ok(
    'A17f 同一道菜里的重复行**不算**跨菜共享（0）',
    oneDishRepeated.shared_requirement_count === 0 &&
      oneDishRepeated.requirements[0].required_quantity === 3,
    String(oneDishRepeated.shared_requirement_count),
  )

  const sharedMissing = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 2, '个']]), dish(2, 1, [[1, '番茄', 2, '个']])],
    stockIndexOf([lot(1, '个', 3)]),
    META,
  )
  ok(
    'A17g 跨菜共享但**库存不足** → 不给共享奖励（0）',
    sharedMissing.shared_requirement_count === 0 &&
      sharedMissing.main_missing_count === 1,
    String(sharedMissing.shared_requirement_count),
  )

  const differentUnits = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '克']]), dish(2, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '克', 5), lot(1, '个', 5)]),
    META,
  )
  ok(
    'A17h 同一食材但**单位不同**不能互当共享（0）',
    differentUnits.shared_requirement_count === 0,
    String(differentUnits.shared_requirement_count),
  )

  const sharedUnknown = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']]), dish(2, 1, [[1, '番茄', 1, '个'], [1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 10)]),
    META,
  )
  ok(
    'A17i 共享需求**含未知用量** → 不给共享奖励（0），且不判 ready',
    sharedUnknown.shared_requirement_count === 0 && planLevel(sharedUnknown) !== 'ready',
    `shared=${sharedUnknown.shared_requirement_count} level=${planLevel(sharedUnknown)}`,
  )

  const sharedSeasoning = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']]), dish(2, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([lot(3, '克', 0)]),
    META,
  )
  ok(
    'A17j **调味品**不计入共享奖励（presence-only，没有可比数量）',
    sharedSeasoning.shared_requirement_count === 0 &&
      sharedSeasoning.seasoning_missing_count === 0,
    String(sharedSeasoning.shared_requirement_count),
  )

  const sharedOk = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']]), dish(2, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A17k 正例：两道菜同定义同单位、已知量且已满足 → 共享项数 1',
    sharedOk.shared_requirement_count === 1,
    String(sharedOk.shared_requirement_count),
  )

  const sharedThree = evaluateCombination(
    [
      dish(1, 1, [[1, '番茄', 1, '个']]),
      dish(2, 1, [[1, '番茄', 1, '个']]),
      dish(3, 1, [[1, '番茄', 1, '个']]),
    ],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A17l 三道菜共享同一合并需求 → 仍只计 **1 项**（按需求计，不按菜数计）',
    sharedThree.shared_requirement_count === 1,
    String(sharedThree.shared_requirement_count),
  )
}

/* ---------- A18–A19：评分分项 ---------- */{
  const ready = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  const missing = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 9, '个']])],
    stockIndexOf([lot(1, '个', 1)]),
    META,
  )
  const bReady = scoreBreakdown(ready)
  const bMissing = scoreBreakdown(missing)
  ok('A18 全足方案 > 缺料方案（库存侧）', bReady.stock_total > bMissing.stock_total)
  ok(
    'A18b ready 方案拿到全足奖励，缺料方案没有',
    bReady.ready_bonus === 1000 && bMissing.ready_bonus === 0,
  )
  ok(
    'A19 软信号只加在 total 上，不影响 stock_total',
    Math.abs(scoreBreakdown(ready, { preference: 40, history: -120, rotation: 7 }).stock_total -
      bReady.stock_total) < 1e-9,
  )

  const withUnknown = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 1, '个'], [1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A19b 未知用量不给全足奖励',
    scoreBreakdown(withUnknown).ready_bonus === 0 && withUnknown.unknown_count === 1,
  )
}

/* ---------- A20–A24：衰减、偏好、轮换 ---------- */
{
  ok(
    'A20 半衰期 7 天：0/7/14 天 → 1 / 0.5 / 0.25',
    decayFactor(0) === 1 && decayFactor(7) === 0.5 && decayFactor(14) === 0.25,
  )
  ok('A20b 未来天数（负数）被夹到 0，不产生加分', decayFactor(-5) === 1)

  const pref = new Map<number, 'like' | 'dislike'>([[1, 'like'], [2, 'dislike']])
  ok('A21 偏好：like +40 / dislike −80', preferenceAdjustment([1, 2, 3], pref) === -40)

  const history: { byRecipe: Map<number, { last_date: string; times: number }>; recentMeals: never[] } = {
    byRecipe: new Map([
      [1, { last_date: '2026-10-16', times: 1 }],
      [2, { last_date: '2026-10-09', times: 3 }],
    ]),
    recentMeals: [],
  }
  ok(
    'A22 历史降权：今天 −120，7 天前 −60（重复做也不叠加）',
    Math.abs(historyPenalty([1], history, '2026-10-16') + 120) < 1e-9 &&
      Math.abs(historyPenalty([2], history, '2026-10-16') + 60) < 1e-9,
    `${historyPenalty([1], history, '2026-10-16')} / ${historyPenalty([2], history, '2026-10-16')}`,
  )
  ok(
    'A22b 无历史的菜不惩罚',
    historyPenalty([99], history, '2026-10-16') === 0,
  )

  const r1 = rotationAdjustment('1x1,2x1', [1, 2], '2026-10-16', history)
  const r2 = rotationAdjustment('1x1,2x1', [1, 2], '2026-10-16', history)
  ok('A23 轮换确定性：同一天同签名结果完全相同', r1.value === r2.value, String(r1.value))
  ok(
    'A23b 轮换幅度不超过 ±amplitude',
    Math.abs(r1.value) <= ROTATION_AMPLITUDE + 1e-9,
    String(r1.value),
  )
  const u = hashToUnit('2026-10-16|1x1,2x1')
  ok('A23c 哈希稳定且落在 [0,1)', u >= 0 && u < 1 && hashToUnit('abc') === hashToUnit('abc'))

  const repeated = rotationAdjustment('1x1,2x1', [2, 1], '2026-10-16', {
    byRecipe: new Map(),
    recentMeals: [{ recipe_ids: [1, 2], last_date: '2026-10-15', days_ago: 1 }],
  })
  ok(
    'A24 与近期整餐完全重合 → 额外惩罚（含 −60，允许 ±amplitude）',
    repeated.repeatedMeal === true &&
      repeated.value <= -ROTATION_REPEAT_PENALTY + ROTATION_AMPLITUDE + 1e-9,
    String(repeated.value),
  )

  const repeatedOlder = rotationAdjustment('1x1,2x1', [2, 1], '2026-10-16', {
    byRecipe: new Map(),
    recentMeals: [{ recipe_ids: [1, 2], last_date: '2026-10-09', days_ago: 7 }],
  })
  const expectRepeatDelta =
    ROTATION_REPEAT_PENALTY * (decayFactor(1) - decayFactor(HISTORY_HALF_LIFE_DAYS))
  ok(
    'A24c 重复组合惩罚按同样的 7 天半衰期随时间衰减（1 天前 → 7 天前）',
    Math.abs(repeatedOlder.value - repeated.value - expectRepeatDelta) < 1e-9,
    `${repeated.value} → ${repeatedOlder.value}（期望差 ${expectRepeatDelta}）`,
  )
  ok(
    'A24d 时间越久惩罚越轻（不会在 14 天窗口内固定不变）',
    repeatedOlder.value > repeated.value,
  )

  const soft = computeSoftSignals({    signature: '1x1',
    recipeIds: [1],
    today: '2026-10-16',
    preference: new Map([[1, 'like']]),
    history: { byRecipe: new Map([[1, { last_date: '2026-10-16', times: 1 }]]), recentMeals: [] },
  })
  ok(
    'A24b 软信号汇总：total = preference + history + rotation',
    soft.total === soft.preference + soft.history + soft.rotation &&
      soft.liked.join(',') === '1' &&
      soft.cooked_recently.join(',') === '1',
  )
}

/* ---------- A25–A28：排序优先级 ---------- */
{
  const base = { main_missing_count: 0, signature: 'a' }
  ok(
    'A25 等级优先：缺料方案软评分再高也排在 ready 之后',
    comparePlanOrder(
      { ...base, level_rank: planLevelRank('ready'), quantity_coverage: 0.5, soft_total: -500 },
      { ...base, level_rank: planLevelRank('missing'), quantity_coverage: 1, soft_total: 999 },
    ) < 0,
  )
  ok(
    'A26 同一等级内：主缺口少者优先（软评分不能翻盘）',
    comparePlanOrder(
      { ...base, level_rank: planLevelRank('missing'), main_missing_count: 1, quantity_coverage: 0.1, soft_total: -500 },
      { ...base, level_rank: planLevelRank('missing'), main_missing_count: 2, quantity_coverage: 0.9, soft_total: 999 },
    ) < 0,
  )
  ok(
    'A27 覆盖差异跨档时优先覆盖；同档内才由软评分决定',
    comparePlanOrder(
      { ...base, level_rank: 0, quantity_coverage: 0.9, soft_total: -999 },
      { ...base, level_rank: 0, quantity_coverage: 0.5, soft_total: 999 },
    ) < 0 &&
      comparePlanOrder(
        { ...base, level_rank: 0, quantity_coverage: 0.51, soft_total: -1 },
        { ...base, level_rank: 0, quantity_coverage: 0.5, soft_total: 1 },
      ) > 0,
  )
  ok(
    'A27b 覆盖分桶函数：0.05 一档',
    quantityCoverageBucket(0.52) === quantityCoverageBucket(0.5) &&
      quantityCoverageBucket(0.75) !== quantityCoverageBucket(0.5),
  )
  ok(
    'A28 候选预筛：同档内单菜软评分高者优先（**截断前**生效）',
    compareCandidateOrder(
      { level_rank: 0, main_missing_count: 0, quantity_coverage: 1, recipe_soft_total: 100, expiring_used_count: 0, recipe_id: 9 },
      { level_rank: 0, main_missing_count: 0, quantity_coverage: 1, recipe_soft_total: -100, expiring_used_count: 5, recipe_id: 1 },
    ) < 0,
  )
}

/* ---------- A34–A46：R1 / R8 / R3 修复回归（本轮） ---------- */
{
  /* ===== R1：逐行缩放舍入、排列不变、与结算同口径 ===== */
  ok(
    'A34 R1 逐行缩放舍入：0.001×0.5=0.001、0.019×0.5=0.010（推荐/结算同一函数）',
    scaleLineQuantity(0.001, 0.5) === 0.001 && scaleLineQuantity(0.019, 0.5) === 0.01,
    `${scaleLineQuantity(0.001, 0.5)} / ${scaleLineQuantity(0.019, 0.5)}`,
  )

  const halfDish = (id: number, q: number) => dish(id, 0.5, [[1, '番茄', q, '千克']])
  const halfStock = stockIndexOf([lot(1, '千克', 0.01)])
  const orderSmallFirst = evaluateCombination([halfDish(1, 0.001), halfDish(2, 0.019)], halfStock, META)
  const orderBigFirst = evaluateCombination([halfDish(1, 0.019), halfDish(2, 0.001)], halfStock, META)
  ok(
    'A35 R1 排列不变：两种顺序都得到 0.011（修复前是 0.010 / 0.011 两种结论）',
    orderSmallFirst.requirements[0].required_quantity === 0.011 &&
      orderBigFirst.requirements[0].required_quantity === 0.011,
    `${orderSmallFirst.requirements[0].required_quantity} / ${orderBigFirst.requirements[0].required_quantity}`,
  )
  ok(
    'A36 R1 与结算一致：0.001+0.010=0.011 > 库存 0.010 → 两边都判「不够」',
    orderSmallFirst.requirements[0].status === 'insufficient' &&
      planLevel(orderSmallFirst) !== 'ready' &&
      planLevel(orderBigFirst) !== 'ready',
  )
  ok(
    'A37 R1 奇数人数（servings=1.5）× 重复行：逐行舍入后合并 = 0.002×2 = 0.004',
    (() => {
      const e = evaluateCombination(
        [dish(1, 1.5, [[1, '番茄', 0.001, '千克']]), dish(2, 1.5, [[1, '番茄', 0.001, '千克']])],
        stockIndexOf([lot(1, '千克', 0.004)]),
        META,
      )
      return e.requirements[0].required_quantity === 0.004 && e.requirements[0].status === 'ok'
    })(),
  )

  /* ===== R8：显式 0 = 零需求；null / 0+null 仍为未知 ===== */
  const zeroOnly = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 0, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A38 R8 显式 0 = 零需求：ok / required 0 / unknown 0 / level ready / 文案不再说"未指定"',
    zeroOnly.requirements[0].status === 'ok' &&
      zeroOnly.requirements[0].required_quantity === 0 &&
      zeroOnly.unknown_count === 0 &&
      planLevel(zeroOnly) === 'ready' &&
      zeroOnly.requirements[0].note.includes('用量为 0'),
    `${zeroOnly.requirements[0].status} / ${zeroOnly.requirements[0].note}`,
  )
  const zeroAndNull = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 0, '个'], [1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A39 R8 0+null 仍是未知：unknown_count 1 且不得 ready（不误报 ready）',
    zeroAndNull.unknown_count === 1 &&
      planLevel(zeroAndNull) !== 'ready' &&
      zeroAndNull.requirements[0].status === 'unknown_quantity',
  )
  const nullOnly = evaluateCombination(
    [dish(1, 1, [[1, '番茄', null, '个']])],
    stockIndexOf([lot(1, '个', 5)]),
    META,
  )
  ok(
    'A40 R8 仅 null 仍为未知（没有被误改成零需求）',
    nullOnly.unknown_count === 1 &&
      nullOnly.requirements[0].required_quantity === null &&
      nullOnly.requirements[0].status === 'unknown_quantity',
  )
  ok(
    'A41 R8 "缩放为 0" 只可能来自 quantity = 0（3 位小数最小步长 0.001×0.5→0.001）',
    scaleLineQuantity(0, 0.5) === 0 && scaleLineQuantity(0.001, 0.5) === 0.001,
  )

  /* ===== R3：临期收益按结算同款 FEFO 实际分配 ===== */
  const normalEarly = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'normal' as const,
    lot_id: 2,
    expiry_date: '2026-10-18',
  }
  const expiringLate = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'expiring' as const,
    lot_id: 1,
    expiry_date: '2026-10-20',
  }
  const fefoReality = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 50, '克']])],
    stockIndexOf([normalEarly, expiringLate]),
    META,
  )
  ok(
    'A42 R3 FEFO 反例：normal(到期 10-18) 先被扣 → 临期收益 0（不再误报 +12/+25）',
    fefoReality.expiring_ratio === 0 &&
      fefoReality.requirements[0].used_expiring === false &&
      fefoReality.expiring_used_count === 0,
    `ratio=${fefoReality.expiring_ratio}`,
  )

  const expiringEarly = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'expiring' as const,
    lot_id: 3,
    expiry_date: '2026-10-17',
  }
  const fefoPositive = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 50, '克']])],
    stockIndexOf([expiringEarly, normalEarly]),
    META,
  )
  ok(
    'A43 R3 临期确实更早到期 → 收益为正、used_expiring=true',
    fefoPositive.expiring_ratio === 1 && fefoPositive.requirements[0].used_expiring === true,
  )
  const fefoMixed = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 150, '克']])],
    stockIndexOf([expiringEarly, normalEarly]),
    META,
  )
  ok(
    'A44 R3 混合批次：只按 FEFO 实际扣到的临期量计（100/150 ≈ 0.6667）',
    fefoMixed.expiring_ratio === 0.6667,
    String(fefoMixed.expiring_ratio),
  )
  const noExpiryLate = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'normal' as const,
    lot_id: 9,
    expiry_date: null,
  }
  const noExpiryEarly = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'expiring' as const,
    lot_id: 4,
    expiry_date: null,
  }
  const fefoTie = evaluateCombination(
    [dish(1, 1, [[1, '番茄', 10, '克']])],
    stockIndexOf([noExpiryLate, noExpiryEarly]),
    META,
  )
  ok(
    'A45 R3 都无到期日 → 按 lot_id 升序（id4 先扣）→ 临期被扣到',
    fefoTie.requirements[0].used_expiring === true,
    `ratio=${fefoTie.expiring_ratio}`,
  )
  ok(
    'A46 R3 默认过期不计入：过期批次被排除后，临期收益只按可用批次算',
    (() => {
      const e = evaluateCombination(
        [dish(1, 1, [[1, '番茄', 50, '克']])],
        stockIndexOf([
          { definition_id: 1, unit: '克', quantity: 100, expiry_status: 'expired', lot_id: 1, expiry_date: '2026-10-01' },
          expiringEarly,
        ]),
        META,
      )
      return e.expiring_ratio === 1 && e.requirements[0].expired_excluded_quantity === 100
    })(),
  )
}

/* ---------- A47–A48：调味品在推荐侧的 presence 与临期声明 ---------- */
{
  const seasoningExpiring = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([
      { definition_id: 3, unit: '克', quantity: 0, expiry_status: 'expiring', lot_id: 1, expiry_date: '2026-10-17' },
    ]),
    META,
  )
  ok(
    'A47 调味品：v0.2.4 起为中性 seasoning_reminder，且 used_expiring 恒为 false（不虚报临期收益、免扣）',
    seasoningExpiring.requirements[0].status === 'seasoning_reminder' &&
      seasoningExpiring.expiring_used_count === 0 &&
      seasoningExpiring.expiring_ratio === 0 &&
      seasoningExpiring.requirements[0].used_expiring === false,
    `${seasoningExpiring.requirements[0]?.status}/${seasoningExpiring.expiring_used_count}`,
  )
  const seasoningExpiredOnly = evaluateCombination(
    [dish(1, 1, [[3, '盐', 1, '克']])],
    stockIndexOf([
      { definition_id: 3, unit: '克', quantity: 5, expiry_status: 'expired', lot_id: 1, expiry_date: '2026-10-01' },
    ]),
    META,
  )
  ok(
    'A48 调味品：只有过期批次 → v0.2.4 起仍只出中性提醒，不是缺口',
    seasoningExpiredOnly.requirements[0].status === 'seasoning_reminder' &&
      seasoningExpiredOnly.seasoning_missing_count === 0,
  )
}

/* ---------- A49–A52：R2/R8/R3 独立验收点的纯函数回归 ---------- */
{
  ok(
    'A49 零需求（含份数缩放为 0）不需确认；null 仍需确认；普通食材仍按单位判定',
    deriveRequiredReason({ is_seasoning: false, required_quantity: 0, has_unit_matched_lot: false }) ===
      null &&
      deriveRequiredReason({
        is_seasoning: false,
        required_quantity: null,
        has_unit_matched_lot: false,
      }) === 'null_quantity' &&
      deriveRequiredReason({
        is_seasoning: false,
        required_quantity: 0.004,
        has_unit_matched_lot: true,
      }) === null &&
      deriveRequiredReason({
        is_seasoning: false,
        required_quantity: 2,
        has_unit_matched_lot: false,
      }) === 'unit_mismatch',
  )
  ok(
    'A50 v0.2.4：调味品**一律**免确认（不论单位/数量/是否「适量」）；旧 user_choice 仍被识别为满足',
    deriveRequiredReason({ is_seasoning: true, required_quantity: 2, has_unit_matched_lot: true }) ===
      null &&
      deriveRequiredReason({
        is_seasoning: true,
        required_quantity: 2,
        has_unit_matched_lot: false,
      }) === null &&
      deriveRequiredReason({
        is_seasoning: true,
        required_quantity: null,
        has_unit_matched_lot: false,
      }) === null &&
      isSatisfiedBy('null_quantity', 'user_choice') === true &&
      isSatisfiedBy('unit_mismatch', 'user_choice') === true &&
      isSatisfiedBy('seasoning_presence', 'user_choice') === true,
  )

  /* ③ allow_expired_for_recipe = true：结算先扣过期 → 不得虚报临期收益，
        但"够不够"仍从严（过期不计可用）——两件事必须分开 */
  const expiredEarly = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'expired' as const,
    lot_id: 1,
    expiry_date: '2026-10-01',
  }
  const expiringTomorrow = {
    definition_id: 1,
    unit: '克',
    quantity: 100,
    expiry_status: 'expiring' as const,
    lot_id: 2,
    expiry_date: '2026-10-17',
  }
  const demoDish = [dish(1, 1, [[1, '番茄', 50, '克']])]
  const evenStock = stockIndexOf([expiredEarly, expiringTomorrow])
  const strictMode = evaluateCombination(demoDish, evenStock, META)
  const lenientMode = evaluateCombination(demoDish, evenStock, META, { includeExpiredInFefo: true })

  ok(
    'A51 默认（排除过期）：可用 = 临期 100 ≥ 50 → 临期收益正常给（ratio 1）',
    strictMode.requirements[0].available_quantity === 100 &&
      strictMode.expiring_ratio === 1 &&
      strictMode.requirements[0].used_expiring === true,
  )
  ok(
    'A52 allow_expired=true：可用量仍**从严**为 100（过期不计入），但收益预测按"过期先扣"→ ratio 0',
    lenientMode.requirements[0].available_quantity === 100 &&
      lenientMode.expiring_ratio === 0 &&
      lenientMode.requirements[0].used_expiring === false &&
      planLevel(lenientMode) === 'ready',
    `available=${lenientMode.requirements[0].available_quantity} ratio=${lenientMode.expiring_ratio} level=${planLevel(lenientMode)}`,
  )
}

/* ============================================================
 * B. HTTP 集成（隔离临时库）
 * ============================================================ */

const PORT = 63000 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`
const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v023-${randomUUID()}`)
const dbPath = resolve(runRoot, `v023-${Date.now()}.db`)
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

/* ---------- 基础数据（分类由 0005 迁移预置，只查不插） ---------- */
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
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(id, name, name, cat, now, now)
}

/** 测试运行的「今天」（本地日历）与 v0.2.3 的 todayDateString 保持一致 */
function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 插入菜谱（含配料行）；lines = [definition_id, quantity, unit] */
function insertRecipe(id: number, name: string, lines: Array<[number, number | null, string | null]>) {
  mut
    .prepare('insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)')
    .run(id, name, name, now, now)
  let order = 0
  for (const [defId, qty, unit] of lines) {
    mut
      .prepare(
        'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, line_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
      )
      .run(id, defId, qty, unit, order, `lk-${id}-${order}`, now, now)
    order++
  }
}

/** 插入库存 */
function insertStock(definitionId: number, qty: number, unit: string, expiry: string | null = null) {
  mut
    .prepare(
      'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
    )
    .run(definitionId, qty, unit, '2026-01-01', expiry, null, '常温', now, now)
}

/** 按名称把 Tag 挂到菜谱（Tag 必须已存在） */
function linkTagByName(recipeId: number, tagName: string) {
  const tag = mut
    .prepare('select id from recipe_tag where name_normalized = ?')
    .get(tagName.toLowerCase()) as { id: number } | undefined
  if (!tag) throw new Error(`测试数据依赖的 Tag 不存在：${tagName}`)
  mut
    .prepare('insert or ignore into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)')
    .run(recipeId, tag.id, now)
}

/** 直接写入一个烹饪会话（历史信号/预览/结算用）；dishes 第三项可指定份数（默认 1） */
function insertSession(
  sessionId: number,
  status: string,
  settledAt: string | null,
  dishes: Array<[number, 'pending' | 'done', number?]>,
) {
  mut
    .prepare(
      'insert into cooking_session (id, status, recipe_revision, started_at, settled_at, created_at, updated_at) values (?,?,?,?,?,?,?)',
    )
    .run(sessionId, status, 0, settledAt ?? now, settledAt, now, now)
  let order = 0
  for (const [recipeId, dishStatus, servings] of dishes) {
    mut
      .prepare(
        'insert into cooking_session_dish (session_id, recipe_id, status, servings, confirmed_revision, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
      )
      .run(sessionId, recipeId, dishStatus, servings ?? 1, 0, order++, now, now)
  }
}

/**
 * ⚠️ 运行时改数据必须用**独立的可写连接**（setup 已完成基础数据后关闭）。
 */
const mut = new Database(dbPath)
mut.pragma('foreign_keys = ON')

/* 菜品类型标签（结构搭配断言用）：⚠️ 必须在菜谱插入之后才能链接（外键） */

setup.close()

let server: ReturnType<typeof startServer> | null = null
const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

const count = (sql: string) => (raw.prepare(sql).get() as any).c as number

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

/** 全库业务表内容摘要（用于「推荐零写入」断言，含 v0.2.3 新表） */
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

  /* ---------- 基础数据 ---------- */
  insertRecipe(1, '番茄炒蛋', [
    [1, 2, '个'],
    [2, 3, '个'],
  ])
  insertRecipe(2, '盐蒸蛋', [
    [2, 2, '个'],
    [3, 1, '克'],
  ])
  insertRecipe(3, '醋溜土豆丝', [
    [4, 2, '个'],
    [3, 1, '克'],
  ])
  insertRecipe(4, '土豆泥', [
    [4, 1, '个'],
    [4, 1, '个'],
  ])
  insertRecipe(5, '牛奶土豆饼', [
    [4, 2, '个'],
    [5, 200, '毫升'],
  ])

  /* 菜品类型标签（结构搭配断言用） */
  for (const [recipeId, tagName] of [
    [1, '荤菜'],
    [2, '荤菜'],
    [3, '素菜'],
    [4, '主食'],
    [5, '主食'],
  ] as const) {
    linkTagByName(recipeId, tagName)
  }

  section('B1. Tag 分类与系统预设')
  const tags1 = await req('GET', '/api/tags')
  ok('B1 GET /api/tags → 200', tags1.status === 200 && Array.isArray(tags1.body))
  const presets = tags1.body.filter((t: any) => t.is_system === true)
  ok(
    `B1b 系统预设 ${PRESET_RECIPE_TAGS.length} 个且全部带分类与 code`,
    presets.length === PRESET_RECIPE_TAGS.length &&
      presets.every((t: any) => typeof t.category === 'string' && typeof t.code === 'string'),
    `presets=${presets.length}`,
  )
  const catsInApi = [...new Set(presets.map((t: any) => t.category))].sort()
  ok(
    'B1c API 中恰好出现五大分类',
    JSON.stringify(catsInApi) === JSON.stringify([...RECIPE_TAG_CATEGORIES].sort()),
    JSON.stringify(catsInApi),
  )
  ok(
    'B1d 旧字段 id / name / created_at 保持存在（兼容 v0.2.2）',
    tags1.body.every(
      (t: any) => typeof t.id === 'number' && typeof t.name === 'string' && typeof t.created_at === 'string',
    ),
  )
  const stapleTagRow = tags1.body.find((t: any) => t.code === 'dish_type.staple')
  ok(
    'B1e recipe_count 字段可用（预设主食挂了 2 道菜：土豆泥、牛奶土豆饼）',
    stapleTagRow?.recipe_count === 2,
    JSON.stringify(stapleTagRow),
  )

  section('B2. Tag 新建（分类 / 校验 / 去重）')
  const createFlavor = await req('POST', '/api/tags', { name: '测试自定义', category: 'flavor' })
  ok('B2 指定分类新建 → 201 且返回 id', createFlavor.status === 201 && typeof createFlavor.body.id === 'number')
  const customId = createFlavor.body.id as number
  const tags2 = await req('GET', '/api/tags')
  const custom = tags2.body.find((t: any) => t.id === customId)
  ok(
    'B2b 分类落库正确、且 is_system=false、code=null',
    custom?.category === 'flavor' && custom?.is_system === false && custom?.code === null,
  )
  const dup = await req('POST', '/api/tags', { name: '测试自定义', category: 'flavor' })
  ok('B2c 同名（跨分类也归一唯一）→ 409', dup.status === 409, String(dup.status))
  const badCat = await req('POST', '/api/tags', { name: '非法分类', category: 'bogus' })
  ok('B2d 非法分类 → 400（入口枚举拦截）', badCat.status === 400, String(badCat.status))
  const noCat = await req('POST', '/api/tags', { name: '未分类自定义' })
  ok('B2e 省略分类 → 201，落库为未分类', noCat.status === 201)
  const tags2b = await req('GET', '/api/tags')
  ok(
    'B2f 未分类 Tag 的 category 为 null',
    tags2b.body.find((t: any) => t.id === noCat.body.id)?.category === null,
  )

  section('B3. Tag 修改（改名 / 改分类 / 校验）')
  const patchRename = await req('PATCH', `/api/tags/${customId}`, { name: '测试自定义改' })
  ok('B3 PATCH 改名 → 204', patchRename.status === 204, String(patchRename.status))
  const tags3 = await req('GET', '/api/tags')
  ok(
    'B3b 改名生效',
    tags3.body.find((t: any) => t.id === customId)?.name === '测试自定义改',
  )
  const patchDup = await req('PATCH', `/api/tags/${customId}`, { name: '快手菜' })
  ok('B3c 改成已存在的名字 → 409', patchDup.status === 409, String(patchDup.status))
  const patchEmpty = await req('PATCH', `/api/tags/${customId}`, {})
  ok('B3d 空 body → 400', patchEmpty.status === 400, String(patchEmpty.status))
  const patchMissing = await req('PATCH', `/api/tags/999999`, { name: 'x' })
  ok('B3e 不存在的 id → 404', patchMissing.status === 404, String(patchMissing.status))
  const patchClear = await req('PATCH', `/api/tags/${customId}`, { category: null })
  ok('B3f category:null → 204 清空分类', patchClear.status === 204)
  const tags3b = await req('GET', '/api/tags')
  ok('B3g 清空后为未分类', tags3b.body.find((t: any) => t.id === customId)?.category === null)

  section('B4. 重命名预设不破坏结构语义（稳定 code）')
  const stapleTag = tags3b.body.find((t: any) => t.code === 'dish_type.staple')
  const renameStaple = await req('PATCH', `/api/tags/${stapleTag.id}`, { name: '主食类' })
  ok('B4 重命名预设「主食」→ 204', renameStaple.status === 204, String(renameStaple.status))
  const tags4 = await req('GET', '/api/tags')
  const stapleAfter = tags4.body.find((t: any) => t.id === stapleTag.id)
  ok(
    'B4b 名称已变、**code 与分类不变**（结构语义不失效）',
    stapleAfter.name === '主食类' &&
      stapleAfter.code === 'dish_type.staple' &&
      stapleAfter.category === 'dish_type',
  )
  const byStaple = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['主食类'],
  })
  ok(
    'B4c 用改名后的 Tag 仍能筛到菜谱（关联按 id 保留）',
    byStaple.status === 200 && byStaple.body.tag_filter.matched_recipe_count === 2,
    JSON.stringify(byStaple.body.tag_filter),
  )
  const staplePlanDishes = byStaple.body.plans.flatMap((p: any) => p.dishes.map((d: any) => d.recipe_id))
  ok(
    'B4d 且这些方案的结构角色仍是 staple（按 code 判定，未因改名失效）',
    staplePlanDishes.length > 0 &&
      byStaple.body.plans.every((p: any) => p.summary.dish_roles.includes('staple')),
    JSON.stringify(byStaple.body.plans.map((p: any) => p.summary.dish_roles)),
  )

  section('B5. 单菜偏好 CRUD')
  ok('B5 初始无偏好', (await req('GET', '/api/recipe-preferences')).body.length === 0)
  const like = await req('PUT', '/api/recipes/1/preference', { value: 'like' })
  ok('B5b 点赞 → 200', like.status === 200 && like.body.value === 'like')
  const dislike = await req('PUT', '/api/recipes/1/preference', { value: 'dislike' })
  ok('B5c 改为点踩（同菜谱仍只有一行）→ 200', dislike.status === 200 && dislike.body.value === 'dislike')
  ok('B5d 偏好表恒为 1 行', count('select count(*) c from recipe_preference') === 1)
  const cancel = await req('PUT', '/api/recipes/1/preference', { value: null })
  ok('B5e 取消 → 200 且 value=null', cancel.status === 200 && cancel.body.value === null)
  ok('B5f 取消 = 删行（不留占位记录）', count('select count(*) c from recipe_preference') === 0)
  const prefMissing = await req('PUT', '/api/recipes/999999/preference', { value: 'like' })
  ok('B5g 不存在的菜谱 → 404', prefMissing.status === 404, String(prefMissing.status))
  const prefBad = await req('PUT', '/api/recipes/1/preference', { value: 'meh' })
  ok('B5h 非法取值 → 400', prefBad.status === 400, String(prefBad.status))

  section('B6. Tag 删除（保留菜谱）')
  const delCustom = await req('DELETE', `/api/tags/${customId}`)
  ok('B6 删除自定义 Tag → 204', delCustom.status === 204, String(delCustom.status))
  const delMissing = await req('DELETE', '/api/tags/999999')
  ok('B6b 删除不存在的 Tag → 404', delMissing.status === 404, String(delMissing.status))
  ok('B6c 菜谱仍然存在', count('select count(*) c from recipe') === 5)

  section('B7. 推荐软信号（偏好 / 历史 / 轮换）')
  // 建一个只含 3 道菜的标签组 → 组合唯一，断言可确定
  const groupCreate = await req('POST', '/api/tags', { name: '测试组' })
  for (const recipeId of [3, 4, 5]) linkTagByName(recipeId, '测试组')
  void groupCreate

  insertStock(4, 50, '个')
  insertStock(5, 1000, '毫升')
  insertStock(3, 0, '克')
  insertStock(1, 50, '个')
  insertStock(2, 50, '个')

  await req('PUT', '/api/recipes/5/preference', { value: 'like' })
  await req('PUT', '/api/recipes/3/preference', { value: 'dislike' })

  const softRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['测试组'],
  })
  ok('B7 标签筛选后 3 个候选 → 唯一组合', softRes.body.tag_filter.matched_recipe_count === 3)
  ok('B7b 恰好 1 套方案', softRes.body.plans.length === 1, String(softRes.body.plans.length))
  const plan1 = softRes.body.plans[0]
  ok(
    'B7c 点踩的菜**未被排除**，方案仍是 ready（点踩只降权）',
    plan1.dishes.some((d: any) => d.recipe_id === 3) && plan1.level === 'ready',
    `level=${plan1.level}`,
  )
  ok(
    'B7d 偏好分项 = like(+40) − dislike(80) = −40',
    plan1.score_breakdown.preference === -40,
    String(plan1.score_breakdown.preference),
  )
  ok(
    'B7e 软信号明细正确（liked/disliked）',
    plan1.signals.liked.join(',') === '5' && plan1.signals.disliked.join(',') === '3',
  )
  ok(
    'B7f 结构搭配：素菜 + 主食 → 角色齐全且为正分',
    plan1.summary.dish_roles.length === 2 && plan1.summary.structure_score > 0,
    `roles=${plan1.summary.dish_roles} structure=${plan1.summary.structure_score}`,
  )
  ok(
    'B7g 无可解释性问题：理由数组非空且含结构说明',
    Array.isArray(plan1.reasons) && plan1.reasons.some((r: string) => r.includes('粗略搭配')),
  )

  section('B8. 烹饪历史只统计「已结算 + 菜品完成」')
  insertSession(1, 'settled', now, [
    [4, 'done'],
    [5, 'done'],
  ])
  insertSession(2, 'abandoned', now, [[3, 'done']]) // 放弃 → 不惩罚
  insertSession(3, 'settled', now, [[3, 'pending']]) // 未完成 → 不惩罚

  const histRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['测试组'],
  })
  const plan2 = histRes.body.plans[0]
  ok(
    'B8 历史只命中真正做完的菜（4、5），放弃/未完成（3）不计',
    plan2.signals.cooked_recently.join(',') === '4,5',
    JSON.stringify(plan2.signals.cooked_recently),
  )
  ok(
    `B8b 今天做过 → 每道 −120（共 −240）`,
    Math.abs(plan2.signals.history + 240) < 1e-9,
    String(plan2.signals.history),
  )
  ok(
    'B8c 历史概览回显窗口与命中数',
    histRes.body.history.window_days === 14 &&
      histRes.body.history.settled_meals === 1 &&
      histRes.body.history.cooked_recipes === 2,
    JSON.stringify(histRes.body.history),
  )
  ok(
    'B8d 理由中包含历史降权说明',
    plan2.reasons.some((r: string) => r.includes('最近刚做过')),
  )

  section('B9. 每日确定性轮换（无随机、可复现）')
  const rotA = await req('POST', '/api/recommendation/meal-plans', { people: 2, tags: ['测试组'] })
  const rotB = await req('POST', '/api/recommendation/meal-plans', { people: 2, tags: ['测试组'] })
  ok(
    'B9 同一天两次请求结果完全一致（plan_id 与总分）',
    JSON.stringify(rotA.body.plans) === JSON.stringify(rotB.body.plans),
  )
  ok(
    'B9b 轮换幅度在 ±15 内且被计入总分',
    Math.abs(rotA.body.plans[0].score_breakdown.rotation) <= ROTATION_AMPLITUDE + 1e-9 &&
      Math.abs(
        rotA.body.plans[0].score_breakdown.total -
          (rotA.body.plans[0].score_breakdown.stock_total +
            rotA.body.plans[0].score_breakdown.preference +
            rotA.body.plans[0].score_breakdown.history +
            rotA.body.plans[0].score_breakdown.rotation),
      ) < 0.01,
    String(rotA.body.plans[0].score_breakdown.rotation),
  )

  section('B10. 标签筛选语义（AND / OR / 空结果）')
  const andRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['荤菜', '素菜'],
    tag_mode: 'and',
  })
  ok(
    'B10 AND：同时含荤菜与素菜 → 0 个菜谱',
    andRes.body.tag_filter.matched_recipe_count === 0 && andRes.body.plans.length === 0,
    JSON.stringify(andRes.body.tag_filter),
  )
  ok(
    'B10b 空结果给出可读提示（不静默为空）',
    andRes.body.notes.some((n: string) => n.includes('标签')),
  )
  const orRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['荤菜', '素菜'],
    tag_mode: 'or',
  })
  ok(
    'B10c OR：荤菜或素菜 → 3 个菜谱（1/2/3）',
    orRes.body.tag_filter.matched_recipe_count === 3,
    JSON.stringify(orRes.body.tag_filter),
  )
  const badTagBody = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: [123],
  })
  ok('B10d tags 元素类型错误 → 400', badTagBody.status === 400, String(badTagBody.status))

  section('B11. 推荐阶段数据库零写入')
  const digestBefore = dbDigest()
  await req('POST', '/api/recommendation/meal-plans', { people: 3, tags: ['测试组'] })
  await req('POST', '/api/recommendation/meal-plans', { people: 3 })
  ok('B11 两次推荐（含标签筛选）后全库摘要完全一致', dbDigest() === digestBefore)

  section('B12. 缺口清单（不足方案必须逐项标明）')
  const potatoStockBefore = count('select count(*) c from standard_ingredient where definition_id = 4')
  raw.exec('delete from standard_ingredient where definition_id = 4')
  const gapRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['测试组'],
  })
  ok(
    'B12 土豆无库存 → 方案不再 ready',
    gapRes.body.plans.length > 0 && gapRes.body.plans.every((p: any) => p.level !== 'ready'),
  )
  const gapPlan = gapRes.body.plans[0]
  ok(
    'B12b 缺口清单非空且与主缺口数一致（v0.2.4：调味品不进缺口，seasoning 恒 0）',
    Array.isArray(gapPlan.shortages) &&
      gapPlan.shortages.length > 0 &&
      gapPlan.shortages.length === gapPlan.summary.main_missing_count &&
      gapPlan.summary.seasoning_missing_count === 0 &&
      gapPlan.shortages.every((s: any) => !s.is_seasoning),
    `shortages=${gapPlan.shortages.length} main=${gapPlan.summary.main_missing_count} seasoning=${gapPlan.summary.seasoning_missing_count}`,
  )
  ok(
    'B12c 每条缺口都有名称与状态（可直接展示）',
    gapPlan.shortages.every(
      (s: any) => typeof s.definition_name === 'string' && typeof s.status === 'string',
    ),
  )
  ok('B12d 临时删除的库存行数记录一致', potatoStockBefore > 0)

  // 恢复土豆库存（后续快照测试需要 ready）
  insertStock(4, 50, '个')

  section('B13. 快照语义：偏好/历史变动不失效，配料变动必须失效')
  const fresh = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['测试组'],
  })
  const freshPlan = fresh.body.plans[0]
  const applyDishes = freshPlan.dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings }))

  // ① 改偏好 + 再加一次历史 → 与「用什么、用多少」无关 → 不应让快照失效
  await req('PUT', '/api/recipes/4/preference', { value: 'like' })
  insertSession(4, 'settled', now, [[3, 'done']])
  const apply1 = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: applyDishes,
    snapshot_id: freshPlan.snapshot_id,
    request_id: `v023-apply-1-${randomUUID()}`,
  })
  ok(
    'B13 偏好/历史变化后，旧用量快照**仍然有效**（原子创建成功）',
    apply1.status === 200 && typeof apply1.body.session_id === 'number',
    `status=${apply1.status} body=${JSON.stringify(apply1.body)}`,
  )

  // ② 改配料数量 → 影响用量 → 必须 409 且不建会话
  const sessionsBefore = count('select count(*) c from cooking_session')
  raw
    .prepare('update recipe_ingredient set quantity = quantity + 5 where recipe_id = ?')
    .run(applyDishes[0].recipe_id)
  const apply2 = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: applyDishes,
    snapshot_id: freshPlan.snapshot_id,
    request_id: `v023-apply-2-${randomUUID()}`,
  })
  ok('B13b 配料变化 → 409 SNAPSHOT_STALE', apply2.status === 409, String(apply2.status))
  ok('B13c 且未创建任何会话', count('select count(*) c from cooking_session') === sessionsBefore)

  // ③ 重新生成 → 新快照可用
  const regen = await req('POST', '/api/recommendation/meal-plans', { people: 2, tags: ['测试组'] })
  const apply3 = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: regen.body.plans[0].dishes.map((d: any) => ({ recipe_id: d.recipe_id, servings: d.servings })),
    snapshot_id: regen.body.plans[0].snapshot_id,
    request_id: `v023-apply-3-${randomUUID()}`,
  })
  ok('B13d 重新生成的快照可用（恢复路径通畅）', apply3.status === 200, String(apply3.status))

  section('B14. 幂等与旧流程回归（未被本次改动破坏）')
  const idemDishes = regen.body.plans[0].dishes.map((d: any) => ({
    recipe_id: d.recipe_id,
    servings: d.servings,
  }))
  const idemKey = `v023-idem-${randomUUID()}`
  const i1 = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: idemDishes,
    snapshot_id: regen.body.plans[0].snapshot_id,
    request_id: idemKey,
  })
  const i2 = await req('POST', '/api/recommendation/apply', {
    people: 2,
    dishes: idemDishes,
    snapshot_id: regen.body.plans[0].snapshot_id,
    request_id: idemKey,
  })
  ok(
    'B14 同 request_id 同 payload → 幂等回放同一会话',
    i1.status === 200 && i2.status === 200 && i1.body.session_id === i2.body.session_id,
    `${JSON.stringify(i1.body)} / ${JSON.stringify(i2.body)}`,
  )
  ok(
    'B14b 回放被明确标记 idempotent_replay，且未重复建会话',
    i2.body.idempotent_replay === true,
    JSON.stringify(i2.body),
  )
  section('B15. 五大分类字典与统一名称校验（含 recipe full 入口）')
  const cats = await req('GET', '/api/tag-categories')
  ok('B15 GET /api/tag-categories → 200', cats.status === 200, String(cats.status))
  ok(
    'B15b 恰好五大分类，且 code 顺序与后端固定顺序一致',
    JSON.stringify(cats.body.categories.map((c: any) => c.code)) ===
      JSON.stringify([...RECIPE_TAG_CATEGORIES]),
    JSON.stringify(cats.body.categories?.map((c: any) => c.code)),
  )
  ok(
    'B15c 中文别名由**后端**提供（前端无需另写字典）',
    cats.body.categories.every((c: any) => typeof c.label === 'string' && c.label.length > 0),
    JSON.stringify(cats.body.categories?.map((c: any) => c.label)),
  )
  ok(
    'B15d 「未分类」分组标题同样由后端下发',
    cats.body.unclassified?.code === 'unclassified' &&
      typeof cats.body.unclassified?.label === 'string' &&
      cats.body.unclassified.label.length > 0,
    JSON.stringify(cats.body.unclassified),
  )

  const blankName = await req('POST', '/api/tags', { name: '   ' })
  ok('B15e 纯空白名称 → 400', blankName.status === 400, String(blankName.status))
  const longName = await req('POST', '/api/tags', { name: 'x'.repeat(61) })
  ok('B15f 超长名称（61 字符）→ 400', longName.status === 400, String(longName.status))
  const ctrlName = await req('POST', '/api/tags', { name: '坏\n名' })
  ok('B15g 含控制字符（换行）→ 400', ctrlName.status === 400, String(ctrlName.status))
  const trimName = await req('POST', '/api/tags', { name: '  两端空格  ' })
  ok('B15h 两端空白被 trim 后正常创建', trimName.status === 201, String(trimName.status))
  const trimmedTag = (await req('GET', '/api/tags')).body.find(
    (t: any) => t.id === trimName.body.id,
  )
  ok('B15i 落库名称无首尾空白', trimmedTag?.name === '两端空格', JSON.stringify(trimmedTag?.name))
  const patchLong = await req('PATCH', `/api/tags/${trimName.body.id}`, { name: 'y'.repeat(61) })
  ok('B15j PATCH 超长名称 → 400', patchLong.status === 400, String(patchLong.status))

  // ⚠️ 关键：菜谱「统一保存」是 Tag 的**自动创建**入口，必须走同一套校验
  const recipesBefore = count('select count(*) c from recipe')
  const bypassLong = await req('POST', '/api/recipes', {
    name: '绕过校验的菜',
    ingredients: [{ definition_id: 1, quantity: 1, unit: '个' }],
    tags: ['z'.repeat(61)],
  })
  ok(
    'B15k 菜谱保存里的超长 Tag → 400（不能绕过统一校验）',
    bypassLong.status === 400,
    String(bypassLong.status),
  )
  const bypassCtrl = await req('POST', '/api/recipes', {
    name: '绕过校验的菜2',
    ingredients: [{ definition_id: 1, quantity: 1, unit: '个' }],
    tags: ['带\n换行'],
  })
  ok(
    'B15l 菜谱保存里的控制字符 Tag → 400',
    bypassCtrl.status === 400,
    String(bypassCtrl.status),
  )
  ok(
    'B15m 两次被拒都没有建菜谱（无半成品数据）',
    count('select count(*) c from recipe') === recipesBefore,
  )

  section('B16. 预设迁类后接口层同样停止类型推断（无隐形类型）')
  const stapleTagNow = (await req('GET', '/api/tags')).body.find(
    (t: any) => t.code === 'dish_type.staple',
  )
  const moveCategory = await req('PATCH', `/api/tags/${stapleTagNow.id}`, { category: 'flavor' })
  ok('B16 把「主食类」从菜品类型迁到口味 → 204', moveCategory.status === 204, String(moveCategory.status))
  const movedRes = await req('POST', '/api/recommendation/meal-plans', {
    people: 2,
    tags: ['主食类'],
  })
  ok(
    'B16b 关联仍在（仍能筛到 2 道菜）',
    movedRes.body.tag_filter.matched_recipe_count === 2,
    JSON.stringify(movedRes.body.tag_filter),
  )
  ok(
    'B16c 但结构角色不再推断为主食（dish_roles 为空，结构分 0）',
    movedRes.body.plans.length > 0 &&
      movedRes.body.plans.every(
        (p: any) => !p.summary.dish_roles.includes('staple') && p.summary.structure_score === 0,
      ),
    JSON.stringify(movedRes.body.plans.map((p: any) => [p.summary.dish_roles, p.summary.structure_score])),
  )

  section('B17. R1/R4：推荐↔预览↔结算一致（逐行舍入 + 总量感知 + 回滚）')
  const vegCategoryId = (mut.prepare("select id from category where name = '蔬菜'").get() as any).id
  for (const [defId, defName] of [
    [7, '香料X'],
    [8, '豆腐X'],
  ] as const) {
    mut
      .prepare(
        'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
      )
      .run(defId, defName, defName, vegCategoryId, now, now)
  }
  // R1：同一菜谱两行 0.001 / 0.019 千克，份数 0.5 → 结算口径 0.001 + 0.010 = 0.011
  insertRecipe(7, '半值菜', [
    [7, 0.001, '千克'],
    [7, 0.019, '千克'],
  ])
  insertStock(7, 0.01, '千克')
  // R4：两道菜各要 豆腐X 2 个，库存 3 个
  insertRecipe(8, '豆腐菜A', [[8, 2, '个']])
  insertRecipe(9, '豆腐菜B', [[8, 2, '个']])
  insertStock(8, 3, '个')

  insertSession(10, 'active', null, [
    [7, 'done', 0.5],
    [8, 'done'],
    [9, 'done'],
  ])

  const preview10 = await req('GET', '/api/cooking/sessions/10/settle/preview')
  ok(
    'B17 预览 200 且返回 stock_sufficient（R4 新增字段）',
    preview10.status === 200 && typeof preview10.body.stock_sufficient === 'boolean',
    String(preview10.status),
  )

  const spiceItems = preview10.body.items.filter((i: any) => i.definition_id === 7)
  ok(
    'B17b R1 预览逐行需求 = 结算口径（0.001 / 0.010，合计 0.011 > 库存 0.010）',
    spiceItems.length === 2 &&
      spiceItems[0].required_quantity === 0.001 &&
      spiceItems[1].required_quantity === 0.01,
    JSON.stringify(spiceItems.map((i: any) => i.required_quantity)),
  )
  ok(
    'B17c R1 第二条不可扣（第一条先扣掉 0.001，剩 0.009 < 0.010）',
    spiceItems[1]?.can_consume === false,
    String(spiceItems[1]?.can_consume),
  )

  const tofuItems = preview10.body.items.filter((i: any) => i.definition_id === 8)
  ok(
    'B17d R4 库存 3 / 两条各 2：第一条可扣、第二条**不可扣**（不再都显示可扣）',
    tofuItems.length === 2 &&
      tofuItems[0].can_consume === true &&
      tofuItems[1].can_consume === false,
    JSON.stringify(tofuItems.map((i: any) => [i.available_quantity, i.can_consume])),
  )
  ok(
    'B17e R4 ready=「待确认 0」与 stock_sufficient=「库存足」已分离（本例 true / false）',
    preview10.body.ready === true && preview10.body.stock_sufficient === false,
    `ready=${preview10.body.ready} stock_sufficient=${preview10.body.stock_sufficient}`,
  )

  const digestBeforePreview = dbDigest()
  await req('GET', '/api/cooking/sessions/10/settle/preview')
  ok('B17f R4 预览零写入（副本分配只在内存）', dbDigest() === digestBeforePreview)

  const tofuBefore = (
    raw.prepare('select quantity from standard_ingredient where definition_id = 8').get() as any
  ).quantity
  const settleR1 = await req('POST', '/api/cooking/sessions/10/settle', {})
  ok(
    'B17g R1 结算按总量失败：409 INSUFFICIENT_STOCK',
    settleR1.status === 409 && settleR1.body?.error?.code === 'INSUFFICIENT_STOCK',
    `${settleR1.status}/${settleR1.body?.error?.code}`,
  )
  const tofuAfter = (
    raw.prepare('select quantity from standard_ingredient where definition_id = 8').get() as any
  ).quantity
  ok(
    'B17h 结算失败整体回滚：库存未变、无结算凭证、会话未进终态',
    tofuAfter === tofuBefore &&
      count('select count(*) c from cooking_settlement where session_id = 10') === 0 &&
      (raw.prepare('select status from cooking_session where id = 10').get() as any).status ===
        'active',
    `tofu ${tofuBefore} -> ${tofuAfter}`,
  )

  section('B18. R8/R2 边界：零需求无单位不显示缺料；user_choice 满足任何派生必需项')
  // 定义 9：**完全没有任何库存**，用于零需求与 null 用量两条边界
  mut
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(9, '零量料X', '零量料X', vegCategoryId, now, now)

  // 菜谱 10：显式零需求且**单位为空、无任何库存行**（旧行为会误报缺料）
  insertRecipe(10, '零需求菜', [[9, 0, null]])
  // 菜谱 11：null 用量（「适量」）
  insertRecipe(11, '适量菜', [[9, null, '个']])

  insertSession(11, 'active', null, [
    [10, 'done'],
    [11, 'done'],
  ])

  const pv11 = await req('GET', '/api/cooking/sessions/11/settle/preview')
  const zeroItem = pv11.body.items.find((i: any) => i.definition_id === 9 && i.required_quantity === 0)
  ok(
    'B18 零需求（单位 null、无库存行）→ can_consume=true，不显示缺料、不需确认',
    zeroItem !== undefined &&
      zeroItem.can_consume === true &&
      zeroItem.required_reason === null &&
      zeroItem.skipped === false,
    JSON.stringify(zeroItem),
  )
  ok(
    'B18b null 用量仍需确认（不自动跳过）',
    pv11.body.items.some((i: any) => i.required_reason === 'null_quantity' && !i.confirmed) &&
      pv11.body.needing_confirmation === 1,
    `needing_confirmation=${pv11.body.needing_confirmation}`,
  )

  const nullItem = pv11.body.items.find((i: any) => i.required_reason === 'null_quantity')
  const confirmUserChoice = await req('POST', '/api/cooking/sessions/11/skips', {
    confirmations: [
      { dish_id: nullItem.dish_id, line_key: nullItem.line_key, reason: 'user_choice' },
    ],
  })
  ok('B18c 用户主动跳过（user_choice）被接受 → 200', confirmUserChoice.status === 200, String(confirmUserChoice.status))

  const pv11b = await req('GET', '/api/cooking/sessions/11/settle/preview')
  ok(
    'B18d user_choice 满足当前派生必需项 → 预览无待确认、ready 且 stock_sufficient',
    pv11b.body.needing_confirmation === 0 &&
      pv11b.body.ready === true &&
      pv11b.body.stock_sufficient === true,
    `nc=${pv11b.body.needing_confirmation} ready=${pv11b.body.ready} stock=${pv11b.body.stock_sufficient}`,
  )

  const zeroStockBefore = count('select count(*) c from standard_ingredient where definition_id = 9')
  const settle11 = await req('POST', '/api/cooking/sessions/11/settle', {})
  ok(
    'B18e 结算成功（零需求 + 用户主动跳过，均不按量扣减）',
    settle11.status === 200,
    `${settle11.status}/${JSON.stringify(settle11.body?.error ?? null)}`,
  )
  const zeroItemResult = (settle11.body?.items ?? []).find(
    (i: any) => i.definition_id === 9 && i.required_quantity === 0,
  )
  ok(
    'B18f 零需求的凭证**如实记为 consumed 且扣减 0**（不误记 unit_mismatch 已跳过）',
    zeroItemResult !== undefined &&
      zeroItemResult.outcome === 'consumed' &&
      zeroItemResult.consumed_quantity === 0,
    JSON.stringify(zeroItemResult),
  )
  ok(
    'B18g 零需求未创建任何库存行（不占库、不造数据）',
    count('select count(*) c from standard_ingredient where definition_id = 9') === zeroStockBefore,
  )

  section('B19. v0.2.4：调味品改为中性提醒 —— 免确认、不扣量、不写凭证行')
  const seasoningCategoryId = (
    mut.prepare("select id from category where name = '调味品'").get() as any
  ).id
  mut
    .prepare(
      'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
    )
    .run(20, '盐测试X', '盐测试x', seasoningCategoryId, now, now)
  insertRecipe(20, '调味菜', [[20, 2, '个']])
  insertStock(20, 0, '个') // presence 哨兵：quantity 0
  insertSession(20, 'active', null, [[20, 'done']])

  const pv20 = await req('GET', '/api/cooking/sessions/20/settle/preview')
  const seaItem = pv20.body.items.find((i: any) => i.definition_id === 20)
  ok(
    'B19 调味品在预览里标记 is_seasoning，且 required_reason / confirm_reason 均为 null',
    seaItem?.is_seasoning === true &&
      seaItem?.required_reason === null &&
      seaItem?.confirm_reason === null &&
      seaItem?.skipped === true,
    JSON.stringify(seaItem),
  )
  ok(
    'B19b 调味品不计入待确认，预览直接 ready',
    pv20.body.needing_confirmation === 0 && pv20.body.ready === true,
    `nc=${pv20.body.needing_confirmation} ready=${pv20.body.ready}`,
  )

  const settle20a = await req('POST', '/api/cooking/sessions/20/settle', {})
  const seaResult = (settle20a.body?.items ?? []).find((i: any) => i.definition_id === 20)
  ok(
    'B19c 无需任何确认即可结算成功',
    settle20a.status === 200,
    `${settle20a.status}/${JSON.stringify(settle20a.body?.error ?? null)}`,
  )
  ok(
    'B19d 结算明细里没有调味品行（不伪造 user_choice / consumed 0）',
    seaResult === undefined && (settle20a.body?.items ?? []).length === 0,
    JSON.stringify(settle20a.body?.items),
  )
  ok(
    'B19e 调味哨兵库存未被改动（仍为 0）',
    (raw.prepare('select quantity from standard_ingredient where definition_id = 20').get() as any)
      .quantity === 0,
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
    mut.close()
  } catch {
    /* 忽略 */
  }
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(serverRoot, 'data').toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v023-')) {
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
