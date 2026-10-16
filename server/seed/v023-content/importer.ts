/**
 * v0.2.3 内容包导入器（**库函数，无副作用**）
 *
 * Sol 在**已备份**的真实库上、用事务保护调用：
 *
 * ```ts
 * import { importRecipeContent } from './seed/v023-content/importer.js'
 * const stats = db.transaction(() => importRecipeContent(db, { contentPath, dryRun: false }))()
 * // 抛错 → better-sqlite3 自动整体回滚
 * ```
 *
 * 铁律：
 *   1. **只新增**（INSERT）。绝不 UPDATE / DELETE / 覆盖既有用户数据。
 *   2. **幂等**：按归一名称（`trim().toLowerCase()`，与 `src/services/normalize.ts` 一致）
 *      解析既有定义与**别名**；菜谱按归一名称与同义名判重 → 已存在一律跳过。
 *   3. 分类**只用数据库已有分类**；标签**只用已有标签**；找不到就跳过并记录原因，绝不新建。
 *   4. **别名安全**：新别名不得与任何已有 `ingredient_definition.name_normalized`
 *      或其他别名冲突（避免把别名指向别人的主名）。
 *   5. 已有定义的 units / aliases **不补改**。
 *   6. 普通新增定义**至少 1 个合法单位**（单位枚举：个/克/千克/毫升/升/包/袋/瓶/盒/罐）；
 *      调味品（分类名「调味品」）允许 0 个。非法字段**拒绝该条**并记录，不做静默过滤。
 *   7. `source verified === false`（或缺失）→ **跳过该菜谱并报告**，默认拒绝。
 *   8. `dryRun`（默认 true）：只读 + 计数，**零写入**；用**纯计划索引**保证
 *      dry-run 的预测与 `apply` 的实际新增一致（定义/别名先入虚拟索引，
 *      菜谱解析时可见），且**不做"写事务再回滚"的假只读**。
 *   9. 内容包自带的 `estimated_shelf_life_days` **一律不导入**（数据库无此列，
 *      且本轮无来源证明）——不传播未经核实的保质期。
 *  10. 不写任何库存（`standard_ingredient`）。
 *
 * 实际数据键（真实 content.json）：`{ ingredients: [...], recipes: [...] }`；
 * 同时兼容 `{ definitions: [...] }` 作为 `ingredients` 的别名。
 */
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'

/** 与 `src/services/normalize.ts` 完全一致的归一规则 */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase()
}

export const UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const

/** 调味品分类名（允许 0 个单位；普通食材必须 ≥ 1） */
export const SEASONING_CATEGORY_NAME = '调味品'

export interface ContentDefinition {
  name: string
  /** **必须是数据库里已存在的分类名**（不得新建/合并） */
  category: string
  /** 既有单位枚举；普通食材至少 1 个；调味品允许 0 个 */
  allowed_units?: string[]
  /** ⚠️ **不导入**（数据库无此列，且本轮无来源证明）；保留仅作数据完整性说明 */
  estimated_shelf_life_days?: number | null
  aliases?: string[]
}

export interface ContentIngredient {
  definition: string
  /** 主料必须有可计算量；调味品允许 null（项目会走"用户确认跳过"路径） */
  quantity: number | null
  unit: string | null
  note?: string
}

export interface ContentRecipe {
  name: string
  /** 常见同义名：命中即视为同一道菜 → 跳过（不覆盖用户菜谱） */
  synonyms?: string[]
  /** 必须写明"按两人份家庭参考量整理，非原方精确份量" */
  servings_note?: string
  source_url: string
  /** 是否已按来源页核对过；`false` 或缺失 → 跳过并报告 */
  verified?: boolean
  note?: string
  /** 只用已有标签名 */
  tags?: string[]
  ingredients: ContentIngredient[]
  steps: string[]
}

export interface ContentPackage {
  checked_on?: string
  /** 包级两人份说明（真实 content.json 有该键） */
  servings_note?: string
  /** ⚠️ 真实数据键是 `ingredients`；`definitions` 作为兼容别名 */
  ingredients?: ContentDefinition[]
  definitions?: ContentDefinition[]
  recipes?: ContentRecipe[]
}

export interface ImportOptions {
  /** 直接传入内容包（测试/内存 fixture 用） */
  content?: ContentPackage
  /** 或从 JSON 文件读取（真实导入用） */
  contentPath?: string
  /** 默认 true：只统计不写库 */
  dryRun?: boolean
}

export interface ImportStats {
  dry_run: boolean
  definitions_added: number
  definitions_reused: number
  definitions_skipped: string[]
  recipes_added: number
  recipes_skipped: string[]
  ingredients_added: number
  steps_added: number
  tags_linked: number
  tags_missing: string[]
  aliases_added: number
  aliases_skipped: string[]
  units_added: number
}

interface RowId {
  id: number
}

function findDefinitionId(db: Database.Database, name: string): number | null {
  const n = normalizeName(name)
  const direct = db
    .prepare('select id from ingredient_definition where name_normalized = ? limit 1')
    .get(n) as RowId | undefined
  if (direct !== undefined) return direct.id
  const viaAlias = db
    .prepare('select definition_id as id from ingredient_alias where alias_normalized = ? limit 1')
    .get(n) as RowId | undefined
  return viaAlias?.id ?? null
}

function findCategoryId(db: Database.Database, categoryName: string): number | null {
  const row = db
    .prepare('select id from category where name_normalized = ? limit 1')
    .get(normalizeName(categoryName)) as RowId | undefined
  return row?.id ?? null
}

function findRecipeId(db: Database.Database, names: readonly string[]): number | null {
  for (const name of names) {
    const row = db
      .prepare('select id from recipe where name_normalized = ? limit 1')
      .get(normalizeName(name)) as RowId | undefined
    if (row !== undefined) return row.id
  }
  return null
}

function findTagId(db: Database.Database, tagName: string): number | null {
  const row = db
    .prepare('select id from recipe_tag where name_normalized = ? limit 1')
    .get(normalizeName(tagName)) as RowId | undefined
  return row?.id ?? null
}

/** 别名是否已被占用（主名或他人别名） */
function aliasTaken(db: Database.Database, aliasNormalized: string): boolean {
  const asName = db
    .prepare('select id from ingredient_definition where name_normalized = ? limit 1')
    .get(aliasNormalized)
  if (asName !== undefined) return true
  const asAlias = db
    .prepare('select definition_id from ingredient_alias where alias_normalized = ? limit 1')
    .get(aliasNormalized)
  return asAlias !== undefined
}

function loadPackage(options: ImportOptions): ContentPackage {
  if (options.content !== undefined) return options.content
  if (options.contentPath === undefined) {
    throw new Error('importRecipeContent: 需要 content 或 contentPath')
  }
  return JSON.parse(readFileSync(options.contentPath, 'utf8')) as ContentPackage
}

/**
 * 幂等导入内容包。**只新增**，可安全重复运行。
 *
 * ⚠️ 调用方负责事务与备份；本函数自身不开启事务（便于被 `db.transaction()` 包裹）。
 */
export function importRecipeContent(
  db: Database.Database,
  options: ImportOptions = {},
): ImportStats {
  const dryRun = options.dryRun !== false
  const content = loadPackage(options)

  const definitions = content.ingredients ?? content.definitions
  if (definitions === undefined && (content.recipes?.length ?? 0) > 0) {
    throw new Error(
      'importRecipeContent: 内容包缺少食材定义（期望顶层 `ingredients`，兼容 `definitions`）—— 拒绝静默 0 导入',
    )
  }

  const now = new Date().toISOString()
  const stats: ImportStats = {
    dry_run: dryRun,
    definitions_added: 0,
    definitions_reused: 0,
    definitions_skipped: [],
    recipes_added: 0,
    recipes_skipped: [],
    ingredients_added: 0,
    steps_added: 0,
    tags_linked: 0,
    tags_missing: [],
    aliases_added: 0,
    aliases_skipped: [],
    units_added: 0,
  }

  /** 所有写操作都经过它 → `dryRun` 时全部跳过（**零写入**） */
  const write = (fn: () => void): void => {
    if (!dryRun) fn()
  }

  /* ---------- 纯计划索引（dry-run 与 apply 的预测必须一致） ---------- */
  /** 本次将新增的定义名（归一化，含别名） */
  const planDefinitions = new Set<string>()
  /** 本次将新增的别名（归一化） */
  const planAliases = new Set<string>()
  /** 本次将新增的 "定义名|单位"（归一化）—— 用于 dry/apply 单位计数一致 */
  const planUnits = new Set<string>()
  const resolveDefinition = (name: string): number | null => {
    const found = findDefinitionId(db, name)
    if (found !== null) return found
    return planDefinitions.has(normalizeName(name)) ? -1 : null
  }

  /* ---------- 1. 食材定义（只新增；已存在则复用） ---------- */
  for (const def of definitions ?? []) {
    const name = (def.name ?? '').trim()
    if (name === '') {
      stats.definitions_skipped.push('(空名称)')
      continue
    }
    const normalized = normalizeName(name)
    if (findDefinitionId(db, name) !== null) {
      stats.definitions_reused++
      continue
    }
    if (planDefinitions.has(normalized)) {
      stats.definitions_skipped.push(`${name}（包内重名）`)
      continue
    }
    const categoryId = findCategoryId(db, def.category ?? '')
    if (categoryId === null) {
      stats.definitions_skipped.push(`${name}（分类不存在：${def.category}）`)
      continue
    }

    const isSeasoning = normalizeName(def.category ?? '') === normalizeName(SEASONING_CATEGORY_NAME)
    const rawUnits = def.allowed_units ?? []
    /** ① 先**过滤非法单位**（不在枚举内 → 拒绝该定义，不做静默过滤后插入） */
    const invalidUnits = rawUnits.filter((u) => !(UNITS as readonly string[]).includes(u))
    if (invalidUnits.length > 0) {
      stats.definitions_skipped.push(`${name}（单位不在枚举内：${[...new Set(invalidUnits)].join('/')}）`)
      continue
    }
    /**
     * ② 再对**合法单位去重**（保持首次出现顺序）。
     *
     * 数据里存在"同一食材重复列出同一单位"（例如 `只/条/块` 统一改成 `个` 后与新单位相撞），
     * 若不去重：`apply` 会被 DB 唯一性检查挡掉一个，而 `dryRun` 不会 → 两遍计数差 1。
     */
    const units = [...new Set(rawUnits)]
    if (units.length === 0 && !isSeasoning) {
      stats.definitions_skipped.push(`${name}（普通食材必须至少 1 个合法单位）`)
      continue
    }

    let definitionId = -1
    if (!dryRun) {
      const info = db
        .prepare(
          'insert into ingredient_definition (name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?)',
        )
        .run(name, normalized, categoryId, now, now)
      definitionId = Number(info.lastInsertRowid)
    }
    stats.definitions_added++
    planDefinitions.add(normalized)

    for (const unit of units) {
      /**
       * ⚠️ 计划索引：`dryRun` 下所有定义共用占位 id，DB 去重查不到任何行，
       * 于是"同一食材重复列出同一单位"会被**重复计数**，使 dry 预测比 apply 多 1。
       * 用计划集合去重后，两者完全一致。
       */
      const planUnitKey = `${normalized}|${unit}`
      if (planUnits.has(planUnitKey)) continue
      const existing = db
        .prepare(
          'select definition_id from ingredient_definition_unit where definition_id = ? and unit = ?',
        )
        .get(definitionId, unit)
      if (existing !== undefined) {
        planUnits.add(planUnitKey)
        continue
      }
      write(() => {
        db.prepare(
          'insert into ingredient_definition_unit (definition_id, unit, created_at) values (?,?,?)',
        ).run(definitionId, unit, now)
      })
      stats.units_added++
      planUnits.add(planUnitKey)
    }

    for (const alias of def.aliases ?? []) {
      const aliasText = (alias ?? '').trim()
      if (aliasText === '') continue
      const aliasNormalized = normalizeName(aliasText)
      if (aliasNormalized === normalized) continue
      if (
        aliasTaken(db, aliasNormalized) ||
        planDefinitions.has(aliasNormalized) ||
        planAliases.has(aliasNormalized)
      ) {
        stats.aliases_skipped.push(`${name} ← ${aliasText}（已被主名或其他别名占用）`)
        continue
      }
      write(() => {
        db.prepare(
          'insert into ingredient_alias (definition_id, alias, alias_normalized, created_at) values (?,?,?,?)',
        ).run(definitionId, aliasText, aliasNormalized, now)
      })
      stats.aliases_added++
      planAliases.add(aliasNormalized)
      planDefinitions.add(aliasNormalized)
    }
  }

  /* ---------- 2. 菜谱（只新增；同名/同义名已存在 → 跳过） ---------- */
  for (const recipe of content.recipes ?? []) {
    const name = (recipe.name ?? '').trim()
    if (name === '') {
      stats.recipes_skipped.push('(空名称)')
      continue
    }
    if (recipe.verified !== true) {
      stats.recipes_skipped.push(`${name}（来源未核实 verified=${String(recipe.verified)}）`)
      continue
    }
    if (findRecipeId(db, [name, ...(recipe.synonyms ?? [])]) !== null) {
      stats.recipes_skipped.push(`${name}（已存在同名或同义名）`)
      continue
    }

    /** 先解析全部料：任何一条非法/找不到定义 → 跳过整道菜（不留半成品菜谱） */
    const resolved: Array<{
      definitionId: number
      quantity: number | null
      unit: string | null
      note: string | null
    }> = []
    let invalid: string | null = null
    for (const ing of recipe.ingredients ?? []) {
      const definitionId = resolveDefinition(ing.definition ?? '')
      if (definitionId === null) {
        invalid = `食材无法解析：${ing.definition}`
        break
      }
      if (ing.quantity !== null && ing.quantity !== undefined) {
        if (!Number.isFinite(ing.quantity) || ing.quantity < 0) {
          invalid = `${ing.definition} 用量非法：${String(ing.quantity)}`
          break
        }
      }
      if (ing.unit !== null && ing.unit !== undefined && !(UNITS as readonly string[]).includes(ing.unit)) {
        invalid = `${ing.definition} 单位不在枚举内：${ing.unit}`
        break
      }
      resolved.push({
        definitionId,
        quantity: ing.quantity ?? null,
        unit: ing.unit ?? null,
        note: (ing.note ?? '').trim() === '' ? null : (ing.note as string).trim(),
      })
    }
    if (invalid !== null) {
      stats.recipes_skipped.push(`${name}（${invalid}）`)
      continue
    }
    if (resolved.length === 0) {
      stats.recipes_skipped.push(`${name}（没有可用配料）`)
      continue
    }
    const steps = (recipe.steps ?? []).map((s) => String(s).trim()).filter((s) => s !== '')
    if (steps.length === 0) {
      stats.recipes_skipped.push(`${name}（没有可用步骤）`)
      continue
    }

    /**
     * `recipe.note` 保存**来源 URL + 两人份说明 + 整理备注** ——
     * 否则来源与份量口径会在导入后丢失（界面无法追溯）。
     */
    const noteParts: string[] = []
    if ((recipe.source_url ?? '').trim() !== '') noteParts.push(`来源：${recipe.source_url.trim()}`)
    const servingsNote = (recipe.servings_note ?? content.servings_note ?? '').trim()
    if (servingsNote !== '') noteParts.push(servingsNote)
    if ((recipe.note ?? '').trim() !== '') noteParts.push(recipe.note!.trim())
    const recipeNote = noteParts.length === 0 ? null : noteParts.join('\n')

    let recipeId = -1
    if (!dryRun) {
      const info = db
        .prepare(
          'insert into recipe (name, name_normalized, note, created_at, updated_at) values (?,?,?,?,?)',
        )
        .run(name, normalizeName(name), recipeNote, now, now)
      recipeId = Number(info.lastInsertRowid)
    }
    stats.recipes_added++

    let order = 0
    for (const line of resolved) {
      const currentOrder = order
      /** ⚠️ 每条配料必须有自己的稳定 `line_key`，否则跳过确认/结算无法逐条定位 */
      const lineKey = randomUUID()
      write(() => {
        db.prepare(
          'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, note, line_key, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
        ).run(
          recipeId,
          line.definitionId,
          line.quantity,
          line.unit,
          line.note,
          lineKey,
          currentOrder,
          now,
          now,
        )
      })
      stats.ingredients_added++
      order++
    }

    let stepNo = 1
    for (const step of steps) {
      const currentStepNo = stepNo
      write(() => {
        db.prepare(
          'insert into recipe_step (recipe_id, step_no, content, created_at, updated_at) values (?,?,?,?,?)',
        ).run(recipeId, currentStepNo, step, now, now)
      })
      stats.steps_added++
      stepNo++
    }

    for (const tagName of recipe.tags ?? []) {
      const tagId = findTagId(db, tagName)
      if (tagId === null) {
        if (!stats.tags_missing.includes(tagName)) stats.tags_missing.push(tagName)
        continue
      }
      const linked = db
        .prepare('select id from recipe_tag_link where recipe_id = ? and tag_id = ?')
        .get(recipeId, tagId)
      if (linked !== undefined) continue
      write(() => {
        db.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(
          recipeId,
          tagId,
          now,
        )
      })
      stats.tags_linked++
    }
  }

  return stats
}
