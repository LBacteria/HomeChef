/**
 * v0.2.4 内容包导入器（**库函数，无副作用**）
 *
 * 与 v0.2.3 导入器的区别：
 *   - 数据来源是 `provenance: 'curated-test'`（人工规则整理），
 *     **不要求 verified=true**，也**不接受**伪造的 source_url；
 *   - 旧 v023 导入器保持 strict 默认，不被本文件放宽。
 *
 * 铁律：
 *   1. 只 INSERT，绝不 UPDATE / DELETE 既有数据；
 *   2. 幂等：按归一名称判重（定义 / 菜谱 / 同义名），第二遍新增 0；
 *   3. dry-run（默认）**零写入**，统计与 apply 一致；
 *   4. 既有定义不补改单位；单位不在允许集合的菜谱**整条跳过并报告**；
 *   5. 每条菜谱至少一个「非调味 + 有数量 + 有单位」的主料，否则跳过；
 *   6. 标签只用数据库里已存在的名称（v0.2.4 预设已由 0014 播种）；
 *   7. 硬上限 1500 条（`MAX_IMPORT_RECIPES`），防误导入。
 */

import { randomUUID } from 'node:crypto'

import type Database from 'better-sqlite3'

import type { GeneratedContent, GenRecipe } from './recipes.js'

export const MAX_IMPORT_RECIPES = 1500
export const ALLOWED_UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const
const SEASONING_CATEGORY = '调味品'

export interface ImportStats {
  dry_run: boolean
  content_version: string
  /** 输入条数 */
  input_recipes: number
  /** 实际新增菜谱数（dry-run 为预计值） */
  inserted_recipes: number
  /** 名称重复（含同义名）而跳过 */
  skipped_duplicate: number
  /** 校验不通过而跳过（单位/主料/标签/步骤等） */
  skipped_invalid: number
  /** 新增的食材定义 */
  inserted_definitions: number
  /** 已有定义的菜谱因单位不允许被跳过（报告用） */
  unit_rejections: Array<{ recipe: string; definition: string; unit: string; allowed: string[] }>
  /** 缺失的标签名（出现即跳过该菜谱） */
  missing_tags: string[]
  /** 内容包里声明了、但不在 11 种枚举内的单位（已丢弃） */
  invalid_declared_units: Array<{ definition: string; unit: string }>
  /** 触达上限的保护 */
  capped_at?: number
}

interface ExistingDefinition {
  id: number
  category: string | null
  units: Set<string>
}

const norm = (s: string): string => s.trim().toLowerCase()

function loadDefinitions(db: Database.Database): Map<string, ExistingDefinition> {
  const rows = db
    .prepare(
      `select d.id, d.name_normalized, c.name as category
       from ingredient_definition d left join category c on c.id = d.category_id`,
    )
    .all() as Array<{ id: number; name_normalized: string; category: string | null }>
  const units = db
    .prepare('select definition_id, unit from ingredient_definition_unit')
    .all() as Array<{ definition_id: number; unit: string }>

  const unitsByDef = new Map<number, Set<string>>()
  for (const u of units) {
    const set = unitsByDef.get(u.definition_id)
    if (set) set.add(u.unit)
    else unitsByDef.set(u.definition_id, new Set([u.unit]))
  }

  const byId = new Map<number, ExistingDefinition>()
  const map = new Map<string, ExistingDefinition>()
  for (const r of rows) {
    const def: ExistingDefinition = {
      id: r.id,
      category: r.category,
      units: unitsByDef.get(r.id) ?? new Set(),
    }
    byId.set(r.id, def)
    map.set(r.name_normalized, def)
  }

  /**
   * ⚠️ 别名也是既有身份：`ingredient_alias.alias_normalized` 必须先命中既有定义，
   *    否则「番茄 / 西红柿」会被当成两种食材各建一个定义。
   */
  const aliases = db
    .prepare('select definition_id, alias_normalized from ingredient_alias')
    .all() as Array<{ definition_id: number; alias_normalized: string }>
  for (const a of aliases) {
    const def = byId.get(a.definition_id)
    if (def !== undefined && !map.has(a.alias_normalized)) map.set(a.alias_normalized, def)
  }
  return map
}

function loadTagIds(db: Database.Database): Map<string, number> {
  const rows = db.prepare('select id, name_normalized from recipe_tag').all() as Array<{
    id: number
    name_normalized: string
  }>
  return new Map(rows.map((r) => [r.name_normalized, r.id]))
}

/**
 * 导入内容包（调用方负责包事务；dry-run 时**绝不写**）。
 *
 * 用法（真实库，Sol 执行）：
 * ```ts
 * db.transaction(() => importContentV024(db, content, { dryRun: false }))()
 * ```
 */
export function importContentV024(
  db: Database.Database,
  content: GeneratedContent,
  options: { dryRun?: boolean } = {},
): ImportStats {
  // ⚠️ 运行时信任检查：不接受伪造来源，避免旧 strict 门槛被绕过
  if (content.provenance !== 'curated-test') {
    throw new Error(`拒绝导入：provenance 必须是 curated-test，实际为 ${String(content.provenance)}`)
  }

  const dryRun = options.dryRun !== false
  const stats: ImportStats = {
    dry_run: dryRun,
    content_version: content.content_version,
    input_recipes: content.recipes.length,
    inserted_recipes: 0,
    skipped_duplicate: 0,
    skipped_invalid: 0,
    inserted_definitions: 0,
    unit_rejections: [],
    missing_tags: [],
    invalid_declared_units: [],
  }

  if (content.recipes.length > MAX_IMPORT_RECIPES) {
    stats.capped_at = MAX_IMPORT_RECIPES
  }
  const recipes = content.recipes.slice(0, MAX_IMPORT_RECIPES)

  const timestamp = new Date().toISOString()
  const defs = loadDefinitions(db)
  const tagIds = loadTagIds(db)
  const categoryIds = new Map(
    (db.prepare('select id, name from category').all() as Array<{ id: number; name: string }>).map(
      (c) => [c.name, c.id],
    ),
  )

  /* ---------- 1. 定义：只补缺，不改既有 ---------- */
  function ensureDefinition(name: string): ExistingDefinition | null {
    const key = norm(name)
    const existing = defs.get(key)
    if (existing !== undefined) return existing

    const declared = content.definitions.find((d) => norm(d.name) === key)
    if (declared === undefined) return null
    const categoryId = categoryIds.get(declared.category)
    if (categoryId === undefined) return null

    // ⚠️ 声明的单位必须在枚举内；非法单位直接丢弃并报告，不交给数据库报错
    const safeUnits = declared.allowed_units.filter((u) =>
      (ALLOWED_UNITS as readonly string[]).includes(u),
    )
    for (const bad of declared.allowed_units) {
      if (!(ALLOWED_UNITS as readonly string[]).includes(bad)) {
        stats.invalid_declared_units.push({ definition: declared.name, unit: bad })
      }
    }
    if (declared.category !== SEASONING_CATEGORY && safeUnits.length === 0) return null
    declared.allowed_units = safeUnits

    stats.inserted_definitions++
    if (dryRun) {
      const virtual: ExistingDefinition = {
        id: -1,
        category: declared.category,
        units: new Set(declared.allowed_units),
      }
      defs.set(key, virtual)
      return virtual
    }

    const inserted = db
      .prepare(
        `insert into ingredient_definition (name, name_normalized, category_id, created_at, updated_at)
         values (?,?,?,?,?)`,
      )
      .run(name.trim(), key, categoryId, timestamp, timestamp)
    const id = Number(inserted.lastInsertRowid)
    for (const unit of declared.allowed_units) {
      // ⚠️ 该表只有 (definition_id, unit, created_at)，没有 updated_at
      db.prepare(
        'insert or ignore into ingredient_definition_unit (definition_id, unit, created_at) values (?,?,?)',
      ).run(id, unit, timestamp)
    }
    const created: ExistingDefinition = { id, category: declared.category, units: new Set(declared.allowed_units) }
    defs.set(key, created)
    return created
  }

  const existingRecipeNames = new Set(
    (db.prepare('select name_normalized from recipe').all() as Array<{ name_normalized: string }>).map(
      (r) => r.name_normalized,
    ),
  )
  const seenNames = new Set<string>()

  /* ---------- 2. 菜谱 ---------- */
  for (const recipe of recipes) {
    const nameKey = norm(recipe.name)
    if (seenNames.has(nameKey) || existingRecipeNames.has(nameKey)) {
      stats.skipped_duplicate++
      continue
    }

    if ((recipe as { verified?: unknown }).verified === true || (recipe as { source_url?: unknown }).source_url !== undefined) {
      stats.skipped_invalid++
      continue
    }

    const reason = validateRecipe(recipe, ensureDefinition, tagIds, stats)
    if (reason !== null) {
      stats.skipped_invalid++
      continue
    }

    seenNames.add(nameKey)
    stats.inserted_recipes++
    if (dryRun) continue

    const rec = db
      .prepare(
        `insert into recipe (name, name_normalized, note, content_revision, created_at, updated_at)
         values (?,?,?,?,?,?)`,
      )
      .run(recipe.name.trim(), nameKey, `${recipe.note}（来源：curated-test）`, 1, timestamp, timestamp)
    const recipeId = Number(rec.lastInsertRowid)

    let order = 0
    for (const line of recipe.ingredients) {
      const def = defs.get(norm(line.definition))
      if (def === undefined || def.id < 0) continue
      db.prepare(
        `insert into recipe_ingredient
           (recipe_id, definition_id, quantity, unit, note, line_key, sort_order, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?)`,
      ).run(
        recipeId,
        def.id,
        line.quantity,
        line.unit,
        null,
        `lk-${recipeId}-${order}`,
        order,
        timestamp,
        timestamp,
      )
      order++
    }

    let stepNo = 1
    for (const step of recipe.steps) {
      db.prepare(
        'insert into recipe_step (recipe_id, step_no, content, created_at, updated_at) values (?,?,?,?,?)',
      ).run(recipeId, stepNo++, step, timestamp, timestamp)
    }

    const tagNames = [recipe.cuisine, recipe.dish_type, recipe.flavor, recipe.method, ...recipe.features]
      .filter((t): t is string => typeof t === 'string' && t.length > 0)
    for (const tagName of new Set(tagNames)) {
      const tagId = tagIds.get(norm(tagName))
      if (tagId === undefined) continue
      db.prepare('insert or ignore into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(
        recipeId,
        tagId,
        timestamp,
      )
    }
  }

  return stats
}

/**
 * 校验一条菜谱；返回 null 表示通过，否则返回原因（同时累计统计）。
 *
 * ⚠️ 校验里会 touch `ensureDefinition`：dry-run 时它只做内存虚拟定义，
 *    因此 dry-run 的「预计新增」与 apply 完全一致。
 */
function validateRecipe(
  recipe: GenRecipe,
  ensureDefinition: (name: string) => ExistingDefinition | null,
  tagIds: Map<string, number>,
  stats: ImportStats,
): string | null {
  if (typeof recipe.name !== 'string' || recipe.name.trim().length === 0) return '空名称'
  if (!Array.isArray(recipe.steps) || recipe.steps.length < 2) return '步骤不足'
  if (recipe.steps.some((s) => typeof s !== 'string' || s.trim().length === 0)) return '空步骤'
  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) return '没有配料'

  const requiredTags = [recipe.dish_type, recipe.method]
  for (const tag of requiredTags) {
    if (typeof tag !== 'string' || !tagIds.has(norm(tag))) {
      const missing = String(tag)
      if (!stats.missing_tags.includes(missing)) stats.missing_tags.push(missing)
      return `缺少必需标签：${missing}`
    }
  }
  const optionalTags = [recipe.cuisine, recipe.flavor, ...recipe.features].filter(
    (t): t is string => typeof t === 'string' && t.length > 0,
  )
  for (const tag of new Set(optionalTags)) {
    if (!tagIds.has(norm(tag))) {
      if (!stats.missing_tags.includes(tag)) stats.missing_tags.push(tag)
      return `缺少标签：${tag}`
    }
  }

  let computableMain = 0
  for (const line of recipe.ingredients) {
    if (typeof line.definition !== 'string' || line.definition.trim().length === 0) {
      return '配料缺少定义名'
    }
    if (line.quantity !== null && (!Number.isFinite(line.quantity) || line.quantity < 0)) {
      return `非法用量：${line.definition}=${String(line.quantity)}`
    }
    if (line.unit !== null && !(ALLOWED_UNITS as readonly string[]).includes(line.unit)) {
      stats.unit_rejections.push({
        recipe: recipe.name,
        definition: line.definition,
        unit: line.unit,
        allowed: [],
      })
      return `单位不在枚举：${line.unit}`
    }

    const def = ensureDefinition(line.definition)
    if (def === null) return `无法解析定义：${line.definition}`

    const isSeasoning = def.category === SEASONING_CATEGORY
    if (!isSeasoning && line.quantity !== null && line.quantity > 0 && line.unit !== null) {
      if (!def.units.has(line.unit)) {
        stats.unit_rejections.push({
          recipe: recipe.name,
          definition: line.definition,
          unit: line.unit,
          allowed: [...def.units],
        })
        return `既有定义不允许该单位：${line.definition} ${line.unit}`
      }
      computableMain++
    }
  }

  if (computableMain < 1) return '没有可计算的非调味主料（需 quantity>0 且单位合法）'
  return null
}

/** 生成 dry-run 报告（字符串，便于 CLI 打印） */
export function formatStats(stats: ImportStats): string {
  const lines = [
    `模式：${stats.dry_run ? 'dry-run（零写入）' : 'apply（已写入）'}`,
    `内容版本：${stats.content_version}`,
    `输入菜谱：${stats.input_recipes}`,
    `新增菜谱：${stats.inserted_recipes}`,
    `跳过（重名/同义）：${stats.skipped_duplicate}`,
    `跳过（校验失败）：${stats.skipped_invalid}`,
    `新增食材定义：${stats.inserted_definitions}`,
    `单位拒绝：${stats.unit_rejections.length}`,
    `缺失标签：${stats.missing_tags.length === 0 ? '无' : stats.missing_tags.join('、')}`,
    `非法声明单位（已丢弃）：${stats.invalid_declared_units.length}`,
  ]
  if (stats.capped_at !== undefined) lines.push(`⚠️ 触达上限 ${stats.capped_at}`)
  for (const u of stats.unit_rejections.slice(0, 10)) {
    lines.push(`  - ${u.recipe}：${u.definition} ${u.unit}（允许：${u.allowed.join('/') || '无'}）`)
  }
  return lines.join('\n')
}

/** 供 CLI 使用的空内容模板（避免未使用导入告警） */
export const EMPTY_CONTENT: GeneratedContent = {
  content_version: 'empty',
  provenance: 'curated-test',
  recipe_count: 0,
  definitions: [],
  recipes: [],
}

/** 稳定 line_key（与既有格式一致，保留给调用方） */
export function makeLineKey(recipeId: number, order: number): string {
  return `lk-${recipeId}-${order}-${randomUUID().slice(0, 8)}`
}
