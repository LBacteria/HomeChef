/**
 * HomeChef v0.1.1 —— 内置食材 seed 执行器
 *
 * 用法：npm run db:seed --workspace server
 *
 * ============================================================
 * 核心设计：幂等单元是 (seed_name, seed_key)，不是整个 seed
 * ============================================================
 *
 * ❌ 错误做法（本脚本**没有**这样做）：
 *      if (seed_history 里已有记录) return
 *    这样未来 1.0.1 版本新增的食材永远不会被插入。
 *
 * ✅ 正确做法：
 *      逐条检查 seed_ingredient_map(seed_name, seed_key)
 *      - 已存在 → 跳过（无论 definition_id 是否为 NULL）
 *      - 不存在 → 尝试创建，并写入 map
 *
 * ============================================================
 * 三条不可违背的规则
 * ============================================================
 *
 * 1. **绝不覆盖用户数据**
 *    seed 只做 INSERT，从不 UPDATE / DELETE 任何已有 definition、alias、unit。
 *    名称冲突时直接跳过，不修改冲突方。
 *
 * 2. **绝不复活用户删除的食材**
 *    seed_ingredient_map.definition_id 是 ON DELETE SET NULL。
 *    用户删除食材后 map 行保留、definition_id 变为 NULL，
 *    下次 seed 看到 seed_key 已存在 → 跳过。
 *
 * 3. **单条失败不影响其他**
 *    每条食材独立事务；冲突记为 warning 并继续。
 */

import { eq } from 'drizzle-orm'

import { db, databasePath, sqlite } from '../src/db/index.js'
import { ingredientDefinition, seedHistory, seedIngredientMap } from '../src/db/schema.js'
import { listCategories } from '../src/services/categoryService.js'
import {
  assertNameAvailableAcrossTables,
  createDefinition,
} from '../src/services/definitionService.js'
import { ServiceError } from '../src/services/errors.js'
import { normalizeName } from '../src/services/normalize.js'
import {
  BUILTIN_INGREDIENTS,
  BUILTIN_SEED_NAME,
  BUILTIN_SEED_VERSION,
  countByCategory,
} from './builtin-ingredients.js'

/* ============================================================
 * 统计
 * ============================================================ */

interface SeedStats {
  created: number
  skippedAlreadyProcessed: number
  conflict: number
  failed: number
}

const stats: SeedStats = {
  created: 0,
  skippedAlreadyProcessed: 0,
  conflict: 0,
  failed: 0,
}

const conflictDetails: string[] = []
const failureDetails: string[] = []

function nowIso(): string {
  return new Date().toISOString()
}

/* ============================================================
 * 查询辅助
 * ============================================================ */

/** 查找某个 seed_key 的处理记录 */
function findMapEntry(seedKey: string) {
  return db
    .select()
    .from(seedIngredientMap)
    .where(eq(seedIngredientMap.seed_key, seedKey))
    .all()
    .find((row) => row.seed_name === BUILTIN_SEED_NAME)
}

/**
 * 记录一条 conflict。
 *
 * 为什么写入 map 而不是什么都不记：
 *   否则每次 seed 都会重新尝试这条数据、每次都会产生同样的冲突日志。
 *   写入 status='conflict' 后，下次直接跳过。
 *
 * 为什么用 status 而不是靠 definition_id 是否为 NULL 区分：
 *   definition_id = NULL 有两种含义：
 *     (a) status='conflict'  → 从未创建过（名称被占用）
 *     (b) status='created'   → 创建过，后来被用户删除
 *   两者都需要"跳过"，但语义不同，日志和未来排查都需要区分。
 */
function recordConflict(seedKey: string, reason: string): void {
  db.insert(seedIngredientMap)
    .values({
      seed_name: BUILTIN_SEED_NAME,
      seed_key: seedKey,
      definition_id: null,
      status: 'conflict',
      seeded_at: nowIso(),
      deleted_at: null,
    })
    .run()

  stats.conflict++
  conflictDetails.push(`${seedKey} (${reason})`)
}

/* ============================================================
 * 准备工作：确认表存在
 * ============================================================ */

function assertSeedTablesExist(): void {
  const tables = sqlite
    .prepare("select name from sqlite_master where type='table' and name like 'seed_%'")
    .all() as Array<{ name: string }>

  const names = tables.map((t) => t.name)

  if (!names.includes('seed_history') || !names.includes('seed_ingredient_map')) {
    console.error('错误：seed 相关表不存在。请先执行 migration：')
    console.error('  npm run db:migrate --workspace server')
    process.exit(1)
  }
}

/* ============================================================
 * v0.1.3：分类回填
 * ============================================================ */

/**
 * 为既有 definition 回填分类。
 *
 * 只处理满足**全部**条件的记录：
 *   1. 在 seed_ingredient_map 中且 status = 'created'（即来自内置 seed）
 *   2. definition 仍然存在（definition_id 非 NULL）
 *   3. definition.category_id **为 NULL**（从未设置过分类）
 *
 * 任何一条不满足就跳过 —— 绝不覆盖用户已设置的分类。
 *
 * @returns 实际回填的条数
 */
function backfillCategories(categoryIdByBudgetName: Map<string, number>): number {
  let count = 0

  for (const item of BUILTIN_INGREDIENTS) {
    const entry = findMapEntry(item.key)
    if (!entry || entry.status !== 'created' || entry.definition_id === null) {
      continue
    }

    const targetCategoryId = categoryIdByBudgetName.get(item.category)
    if (targetCategoryId === undefined) {
      continue
    }

    const def = db
      .select()
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, entry.definition_id))
      .get()

    if (!def) continue

    // ⚠️ 已有分类 → 不动
    if (def.category_id !== null) continue

    db.update(ingredientDefinition)
      .set({ category_id: targetCategoryId, updated_at: nowIso() })
      .where(eq(ingredientDefinition.id, def.id))
      .run()

    count++
  }

  return count
}

/* ============================================================
 * 主流程
 * ============================================================ */

function runSeed(): void {
  console.log('============================================')
  console.log('  HomeChef 内置食材 seed')
  console.log('============================================')
  console.log(`数据库文件：${databasePath}`)
  console.log(`seed 名称  ：${BUILTIN_SEED_NAME}`)
  console.log(`seed 版本  ：${BUILTIN_SEED_VERSION}`)
  console.log(`待处理条数：${BUILTIN_INGREDIENTS.length}`)
  console.log('')

  assertSeedTablesExist()

  // 检查 seed 数据自身的 key 唯一性（防止 seed 文件写错）
  const seenKeys = new Set<string>()
  for (const item of BUILTIN_INGREDIENTS) {
    if (seenKeys.has(item.key)) {
      console.error(`错误：seed 数据内部 key 重复：${item.key}`)
      process.exit(1)
    }
    seenKeys.add(item.key)
  }

  /* ---------- v0.1.3：准备分类映射 ---------- */
  //
  // 把「分类名 → category.id。建立映射，供创建与回填使用。
  // 分类由 migration 0005 播种；这里只查不建。
  const allCategories = listCategories()
  const categoryIdByBudgetName = new Map<string, number>()
  for (const c of allCategories) {
    categoryIdByBudgetName.set(c.name, c.id)
  }

  const missingCategories = [
    ...new Set(BUILTIN_INGREDIENTS.map((i) => i.category)),
  ].filter((name) => !categoryIdByBudgetName.has(name))

  if (missingCategories.length > 0) {
    console.error(`错误：以下分类不存在（应由 migration 0005 播种）：${missingCategories.join('、')}`)
    console.error('请先执行：npm run db:migrate --workspace server')
    process.exit(1)
  }

  console.log(`分类映射已就绪：${categoryIdByBudgetName.size} 个分类`)
  console.log('')

  /* ---------- v0.1.3：回填既有 definition 的分类 ---------- */
  //
  // ⚠️ 只回填 category_id IS NULL 的记录 ——
  //    用户在 v0.1.3 之前创建的 definition 没有分类，需要补上；
  //    已经有分类的（无论是 seed 写入还是用户手改）**一律不动**。
  //
  // ⚠️ 只处理 seed map 中状态为 created 且 definition 仍存在的条目，
  //    避免误碰用户自建的 definition。
  const backfilled = backfillCategories(categoryIdByBudgetName)
  if (backfilled > 0) {
    console.log(`已为 ${backfilled} 个既有 definition 回填分类。`)
    console.log('')
  }

  for (const item of BUILTIN_INGREDIENTS) {
    const existing = findMapEntry(item.key)

    /* ---------- 情况 1：已处理过 → 跳过 ---------- */
    if (existing) {
      if (existing.status === 'conflict') {
        // 之前因名称冲突跳过，不重试（避免每次产生相同日志）
        stats.skippedAlreadyProcessed++
        continue
      }

      if (existing.definition_id !== null) {
        // 已创建，且 definition 仍存在 → 用户可能改过，绝不触碰
        stats.skippedAlreadyProcessed++
        continue
      }

      // status='created' 但 definition_id 为 NULL
      // → 用户曾经创建后删除 → **永久尊重，不复活**
      stats.skippedAlreadyProcessed++
      continue
    }

    /* ---------- 情况 2：未处理过 → 尝试创建 ---------- */
    try {
      // 2a. 先做跨表唯一性预检（名称 + 所有别名）
      //
      //     复用 Service 的规则，不自行实现一份。
      //     任何一项冲突 → 整条跳过，绝不修改冲突方。
      assertNameAvailableAcrossTables(normalizeName(item.name))
      for (const alias of item.aliases) {
        assertNameAvailableAcrossTables(normalizeName(alias))
      }

      // 2b. 创建 definition + aliases + units。
      //
      //     createDefinition 内部使用 db.transaction，
      //     因此 definition / units / aliases 三者要么全成、要么全不成，
      //     不会留下"definition 建了但 alias 没建"的半成品。
      const created = createDefinition({
        name: item.name,
        units: item.units,
        estimated_shelf_life_days: item.shelfLife,
        aliases: item.aliases.length > 0 ? item.aliases : undefined,
        // v0.1.3：写入分类
        category_id: categoryIdByBudgetName.get(item.category) ?? null,
      })

      // 2c. 记录 map（独立的极小写入；失败也不影响已建好的 definition）
      db.insert(seedIngredientMap)
        .values({
          seed_name: BUILTIN_SEED_NAME,
          seed_key: item.key,
          definition_id: created.id,
          status: 'created',
          seeded_at: nowIso(),
          deleted_at: null,
        })
        .run()

      stats.created++
    } catch (error) {
      // 名称冲突：这是**预期情况**，不是错误，继续处理下一条
      if (error instanceof ServiceError && error.code === 'DUPLICATE_NAME') {
        try {
          recordConflict(item.key, error.message)
        } catch {
          // map 写入失败也不应中断整体流程
          stats.failed++
          failureDetails.push(`${item.key}: conflict 记录写入失败`)
        }
        continue
      }

      // 其他错误：记录并继续，不影响后续食材
      stats.failed++
      const msg = error instanceof Error ? error.message : String(error)
      failureDetails.push(`${item.key}: ${msg}`)
    }
  }

  /* ---------- 写入 seed_history ---------- */
  //
  // ⚠️ seed_history 只记录"跑过哪个版本"，**不是跳过整个 seed 的依据**。
  //    真正的幂等依据是每条 seed_ingredient_map。
  const existingHistory = db
    .select()
    .from(seedHistory)
    .where(eq(seedHistory.seed_name, BUILTIN_SEED_NAME))
    .get()

  if (existingHistory) {
    db.update(seedHistory)
      .set({ version: BUILTIN_SEED_VERSION, applied_at: nowIso() })
      .where(eq(seedHistory.seed_name, BUILTIN_SEED_NAME))
      .run()
  } else {
    db.insert(seedHistory)
      .values({
        seed_name: BUILTIN_SEED_NAME,
        version: BUILTIN_SEED_VERSION,
        applied_at: nowIso(),
      })
      .run()
  }

  printReport()
}

/* ============================================================
 * 报告
 * ============================================================ */

function printReport(): void {
  console.log('')
  console.log('--------------------------------------------')
  console.log('  结果')
  console.log('--------------------------------------------')
  console.log(`  新建        ：${stats.created}`)
  console.log(`  已处理跳过  ：${stats.skippedAlreadyProcessed}`)
  console.log(`  名称冲突    ：${stats.conflict}`)
  console.log(`  失败        ：${stats.failed}`)

  const totalDefinitions = db.select().from(ingredientDefinition).all().length
  const totalMapRows = db.select().from(seedIngredientMap).all().length

  console.log('')
  console.log(`  食材定义总数（库内全部）：${totalDefinitions}`)
  console.log(`  seed map 记录数        ：${totalMapRows}`)

  if (conflictDetails.length > 0) {
    console.log('')
    console.log('  以下条目因名称已存在而跳过（未修改任何已有数据）：')
    for (const c of conflictDetails.slice(0, 20)) {
      console.log(`    - ${c}`)
    }
    if (conflictDetails.length > 20) {
      console.log(`    ...另有 ${conflictDetails.length - 20} 条`)
    }
  }

  if (failureDetails.length > 0) {
    console.log('')
    console.log('  以下条目处理失败：')
    for (const f of failureDetails) {
      console.log(`    - ${f}`)
    }
  }

  console.log('')
  console.log('  各分类数据量（seed 文件定义）：')
  for (const [category, count] of Object.entries(countByCategory())) {
    console.log(`    ${category}：${count}`)
  }

  console.log('')
  console.log('seed 执行完成。')
}

/* ============================================================
 * 入口
 * ============================================================ */

runSeed()
sqlite.close()
