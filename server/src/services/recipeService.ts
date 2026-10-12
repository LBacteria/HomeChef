import { asc, desc, eq, inArray } from 'drizzle-orm'

import { db } from '../db/index.js'
import {
  UNITS,
  ingredientDefinition,
  recipe,
  recipeIngredient,
  recipeTag,
  recipeTagLink,
} from '../db/schema.js'
import type { RecipeSortField, RecipeSortOrder, RecipeTagMode, Unit } from '../db/schema.js'
import {
  duplicateNameError,
  recipeNotFoundError,
  tagNotFoundError,
  validationError,
} from './errors.js'
import { isBlankName, normalizeName } from './normalize.js'
import { faultPoint } from './faultInjection.js'

/**
 * 菜谱 Service（v0.2.0 Phase 3）。
 *
 * 批次 1（只读）：listRecipes / getRecipeById / listTags
 * 批次 2（写入）：createRecipe / updateRecipe / deleteRecipe / saveRecipeFull
 *                 createTag / deleteTag
 *
 * ⚠️ 搜索 / 筛选 / 排序 / 列表设置属于**批次 3**，此处不实现。
 *
 * 设计要点：
 *   - 业务规则在 Service 层，路由只做入口校验
 *   - 食材**按 sort_order 顺序**返回（固定按用户添加顺序）
 *   - 允许同一菜谱重复关联同一食材 → 食材列表**可能有重复的 definition_id**
 *   - `name_normalized` **必须**用全项目唯一的 `normalizeName()`
 *   - 统一保存（saveRecipeFull）在**单个事务**内完成
 */

/** 列表项：菜谱 + Tag + 食材数量 */
export interface RecipeSummary {
  id: number
  name: string
  note: string | null
  created_at: string
  updated_at: string
  /** 该菜谱的 Tag 名称列表（按关联顺序） */
  tags: string[]
  /** 该菜谱的食材记录条数（可能因重复关联而大于不同食材数） */
  ingredient_count: number
}

/** 详情中的一条食材记录 */
export interface RecipeIngredientDetail {
  id: number
  definition_id: number
  /** 食材定义的当前名称（改名后仍正确，因为按 id 关联） */
  definition_name: string
  quantity: number | null
  unit: string | null
  note: string | null
  sort_order: number
}

/** 详情 */
export interface RecipeDetail {
  id: number
  name: string
  note: string | null
  created_at: string
  updated_at: string
  tags: string[]
  ingredients: RecipeIngredientDetail[]
}

/** 取某个菜谱的 Tag 名称列表（按关联记录 id 排序，保证稳定） */
function loadTagsOf(recipeId: number): string[] {
  return db
    .select({ name: recipeTag.name })
    .from(recipeTagLink)
    .innerJoin(recipeTag, eq(recipeTag.id, recipeTagLink.tag_id))
    .where(eq(recipeTagLink.recipe_id, recipeId))
    .orderBy(asc(recipeTagLink.id))
    .all()
    .map((r) => r.name)
}

/** 列表查询选项（批次 3） */
export interface RecipeListQuery {
  /** 搜索词：同时匹配菜谱名称与 Tag 名称；空/未传 = 不搜索 */
  search?: string
  /** 选中的 Tag 名称列表；空数组 = 不做 Tag 筛选 */
  tagNames?: string[]
  /** Tag 筛选模式：'and'（默认）| 'or' */
  tagMode?: RecipeTagMode
  /** 排序字段，默认 updated_at */
  sortField?: RecipeSortField
  /** 排序方向，默认 desc */
  sortOrder?: RecipeSortOrder
}

/**
 * 列出菜谱（支持搜索、Tag 筛选、排序 —— 批次 3）。
 *
 * 组合规则：
 *   - `search` 与 Tag 筛选**同时生效**（AND 关系）：
 *     即"匹配搜索词" **且** "满足 Tag 筛选条件"
 *   - 不传任何参数时，等价于默认排序（最近修改倒序）
 *
 * 搜索规则：
 *   - **只匹配菜谱名称**（v0.2.0 产品决策变更）
 *     ⚠️ Tag 名称**不再**参与搜索匹配 —— Tag 只通过 `tagNames` 做筛选。
 *        搜索与筛选是两个独立能力，互不混淆。
 *   - **在应用层使用 JavaScript `includes()` 过滤**（不经过 SQL）
 *   - 搜索词经过 trim；匹配**不区分大小写**
 *   - `%`、`_` 等字符按**普通字面量**处理 ——
 *     因为当前实现**没有使用 SQL LIKE**，不存在通配符语义
 *   - 不涉及字符串拼接，因此没有 SQL 注入面
 *
 * 排序规则：
 *   - 字段与方向**白名单**校验后映射为列对象，绝不拼接原始输入
 *   - **总是附加 `id` 作为次级排序**，保证同值记录顺序稳定可测
 *   - `name` 排序使用 SQLite 默认的 BINARY 比较（与既有名称排序一致）
 */
export function listRecipes(query: RecipeListQuery = {}): RecipeSummary[] {
  const search = typeof query.search === 'string' ? query.search.trim() : ''
  const tagNames = (query.tagNames ?? []).map((t) => t.trim()).filter((t) => t.length > 0)
  const tagMode: RecipeTagMode = query.tagMode === 'or' ? 'or' : 'and'

  /* ---------- 1. 排序：白名单 → 列对象 ---------- */
  const SORT_COLUMNS = {
    updated_at: recipe.updated_at,
    created_at: recipe.created_at,
    name: recipe.name,
  } as const
  const sortField: RecipeSortField =
    query.sortField && query.sortField in SORT_COLUMNS ? query.sortField : 'updated_at'
  const sortOrder: RecipeSortOrder = query.sortOrder === 'asc' ? 'asc' : 'desc'

  const primary = sortOrder === 'asc' ? asc(SORT_COLUMNS[sortField]) : desc(SORT_COLUMNS[sortField])

  // 先按主排序取全部，再在应用层用 includes() 过滤
  // （这样能统一处理"名称命中"与"Tag 名称命中"两种匹配）
  // ⚠️ 次级排序固定 id 升序 → 同值记录顺序确定
  let rows = db.select().from(recipe).orderBy(primary, asc(recipe.id)).all()

  /* ---------- 2. Tag 筛选 ---------- */
  if (tagNames.length > 0) {
    // 预先取每个菜谱的 Tag 集合，避免 N 次重复查询关联表
    const tagSets = new Map<number, Set<string>>()
    for (const r of rows) {
      tagSets.set(r.id, new Set(loadTagsOf(r.id)))
    }

    rows = rows.filter((r) => {
      const owned = tagSets.get(r.id) ?? new Set<string>()
      return tagMode === 'and'
        ? tagNames.every((t) => owned.has(t))   // AND：拥有全部
        : tagNames.some((t) => owned.has(t))    // OR：拥有任意一个
    })
  }

  /* ---------- 3. 搜索（**只匹配菜谱名称**）----------
   *
   * ⚠️ v0.2.0 产品决策变更：Tag 名称**不再**参与搜索。
   *    Tag 仅通过上方的 tagNames / tagMode 做筛选。
   */
  if (search.length > 0) {
    const needle = search.toLowerCase()
    rows = rows.filter((r) => r.name.toLowerCase().includes(needle))
  }

  /* ---------- 4. 组装返回 ---------- */
  return rows.map((r) => {
    const ingredientCount = db
      .select({ id: recipeIngredient.id })
      .from(recipeIngredient)
      .where(eq(recipeIngredient.recipe_id, r.id))
      .all().length

    return {
      id: r.id,
      name: r.name,
      note: r.note,
      created_at: r.created_at,
      updated_at: r.updated_at,
      tags: loadTagsOf(r.id),
      ingredient_count: ingredientCount,
    }
  })
}

/**
 * 按 id 获取菜谱详情（含食材明细与 Tag）。
 *
 * ⚠️ 食材**按 sort_order 升序**返回（其次按 id，保证顺序稳定）。
 *    食材名取自 `ingredient_definition`，因此**食材改名后此处自动跟随**。
 *
 * @throws ServiceError recipeNotFoundError（菜谱不存在，错误码 RECIPE_NOT_FOUND）
 */
export function getRecipeById(id: number): RecipeDetail {
  const found = db.select().from(recipe).where(eq(recipe.id, id)).get()

  if (!found) {
    throw recipeNotFoundError(`菜谱不存在：id=${id}`)
  }

  const ingredients = db
    .select({
      id: recipeIngredient.id,
      definition_id: recipeIngredient.definition_id,
      definition_name: ingredientDefinition.name,
      quantity: recipeIngredient.quantity,
      unit: recipeIngredient.unit,
      note: recipeIngredient.note,
      sort_order: recipeIngredient.sort_order,
    })
    .from(recipeIngredient)
    .innerJoin(
      ingredientDefinition,
      eq(ingredientDefinition.id, recipeIngredient.definition_id),
    )
    .where(eq(recipeIngredient.recipe_id, id))
    .orderBy(asc(recipeIngredient.sort_order), asc(recipeIngredient.id))
    .all()

  return {
    id: found.id,
    name: found.name,
    note: found.note,
    created_at: found.created_at,
    updated_at: found.updated_at,
    tags: loadTagsOf(id),
    ingredients,
  }
}

/**
 * 列出全部 Tag（按 id 升序）。
 *
 * 供「复用已有 Tag」使用。
 */
export function listTags(): Array<{ id: number; name: string; created_at: string }> {
  return db
    .select({ id: recipeTag.id, name: recipeTag.name, created_at: recipeTag.created_at })
    .from(recipeTag)
    .orderBy(asc(recipeTag.id))
    .all()
}

/* ============================================================
 * 批次 2：写入
 * ============================================================ */

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 事务对象的类型。
 *
 * ⚠️ 不能写成 `typeof db` —— `db` 带 `$client` 属性，而事务对象没有，
 *    直接写会导致类型不兼容（实测 TS2345）。
 *    这里沿用项目既有做法（见 definitionService.ts 的 `type Tx`）。
 */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** 统一保存时的一条食材输入 */
export interface RecipeIngredientInput {
  definition_id: number
  quantity?: number | null
  unit?: string | null
  note?: string | null
}

/** 新建 / 统一保存的输入 */
export interface RecipeInput {
  name: string
  note?: string | null
  ingredients: RecipeIngredientInput[]
  /** Tag 名称列表；不存在的会被**自动创建**，已存在的**复用** */
  tags?: string[]
}

/* ------------------------------------------------------------
 * 校验工具
 * ------------------------------------------------------------ */

/** 校验并归一化菜谱名称；返回 { name, nameNormalized } */
function assertRecipeName(rawName: unknown): { name: string; nameNormalized: string } {
  if (typeof rawName !== 'string') {
    throw validationError('菜谱名称必须是字符串')
  }
  if (isBlankName(rawName)) {
    throw validationError('菜谱名称不能为空')
  }
  // ⚠️ 存 trim 后的显示名；归一化必须用全项目唯一的 normalizeName()
  return { name: rawName.trim(), nameNormalized: normalizeName(rawName) }
}

/** 校验菜谱整体备注 */
function assertRecipeNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') {
    throw validationError('菜谱备注必须是字符串或 null')
  }
  const trimmed = raw.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 校验食材数组（至少 1 条），返回规范化后的列表 */
function assertIngredients(raw: unknown): RecipeIngredientInput[] {
  if (!Array.isArray(raw)) {
    throw validationError('食材必须是数组')
  }
  if (raw.length === 0) {
    throw validationError('菜谱至少需要一个食材')
  }

  return raw.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw validationError(`第 ${index + 1} 条食材格式不正确`)
    }
    const it = item as Record<string, unknown>

    // 食材定义 ID
    const defId = it.definition_id
    if (typeof defId !== 'number' || !Number.isSafeInteger(defId) || defId <= 0) {
      throw validationError(`第 ${index + 1} 条食材的 definition_id 必须是正整数`)
    }
    // ⚠️ 必须真实存在
    const def = db
      .select({ id: ingredientDefinition.id })
      .from(ingredientDefinition)
      .where(eq(ingredientDefinition.id, defId))
      .get()
    if (!def) {
      throw validationError(`第 ${index + 1} 条食材引用的食材定义不存在：id=${defId}`)
    }

    // 数量：可空
    let quantity: number | null = null
    if (it.quantity !== undefined && it.quantity !== null) {
      if (typeof it.quantity !== 'number' || !Number.isFinite(it.quantity)) {
        throw validationError(`第 ${index + 1} 条食材的数量必须是数字或 null`)
      }
      if (it.quantity < 0) {
        throw validationError(`第 ${index + 1} 条食材的数量不能为负数`)
      }
      quantity = it.quantity
    }

    // 单位：可空；有值必须在 10 个枚举内
    let unit: string | null = null
    if (it.unit !== undefined && it.unit !== null) {
      if (typeof it.unit !== 'string') {
        throw validationError(`第 ${index + 1} 条食材的单位必须是字符串或 null`)
      }
      const trimmed = it.unit.trim()
      if (trimmed.length > 0) {
        if (!(UNITS as readonly string[]).includes(trimmed)) {
          throw validationError(
            `第 ${index + 1} 条食材的单位不合法：${trimmed}。允许：${UNITS.join('、')}`,
          )
        }
        unit = trimmed as Unit
      }
    }

    // 备注：可空
    let note: string | null = null
    if (it.note !== undefined && it.note !== null) {
      if (typeof it.note !== 'string') {
        throw validationError(`第 ${index + 1} 条食材的备注必须是字符串或 null`)
      }
      const trimmed = it.note.trim()
      note = trimmed.length === 0 ? null : trimmed
    }

    return { definition_id: defId, quantity, unit, note }
  })
}

/** 校验 Tag 名称数组，返回去重后的名称列表（保留原顺序） */
function assertTagNames(raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) {
    throw validationError('tags 必须是字符串数组')
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw validationError('tags 中的每一项都必须是字符串')
    }
    if (isBlankName(item)) {
      throw validationError('Tag 名称不能为空')
    }
    const key = normalizeName(item)
    if (seen.has(key)) continue // 同一请求内去重，避免违反 UNIQUE(recipe_id, tag_id)
    seen.add(key)
    result.push(item.trim())
  }
  return result
}

/**
 * 找出或创建 Tag，返回 Tag id 列表。
 *
 * ⚠️ 必须在**事务内**调用，传入 tx。
 */
function resolveTagIds(
  tx: Tx,
  tagNames: string[],
): number[] {
  const ids: number[] = []
  for (const name of tagNames) {
    const normalized = normalizeName(name)

    const found = tx
      .select({ id: recipeTag.id })
      .from(recipeTag)
      .where(eq(recipeTag.name_normalized, normalized))
      .get()

    if (found) {
      ids.push(found.id)
      continue
    }

    const created = tx
      .insert(recipeTag)
      .values({ name, name_normalized: normalized, created_at: nowIso() })
      .returning({ id: recipeTag.id })
      .get()
    ids.push(created.id)
  }
  return ids
}

/** 校验名称未被其他菜谱占用 */
function assertRecipeNameAvailable(nameNormalized: string, excludeId?: number): void {
  const existing = db
    .select({ id: recipe.id })
    .from(recipe)
    .where(eq(recipe.name_normalized, nameNormalized))
    .all()

  const conflict = existing.find((r) => r.id !== excludeId)
  if (conflict) {
    throw duplicateNameError(`菜谱名称已存在：${nameNormalized}`)
  }
}

/* ------------------------------------------------------------
 * 菜谱 CRUD
 * ------------------------------------------------------------ */

/**
 * 新建菜谱（含食材与 Tag，**单事务**）。
 *
 * @returns 新建菜谱的 id
 * @throws ServiceError VALIDATION_ERROR / DUPLICATE_NAME
 */
export function createRecipe(input: RecipeInput): number {
  // ① 事务外完成全部校验（避免无谓写入）
  const { name, nameNormalized } = assertRecipeName(input?.name)
  const note = assertRecipeNote(input?.note)
  const ingredients = assertIngredients(input?.ingredients)
  const tagNames = assertTagNames(input?.tags)
  assertRecipeNameAvailable(nameNormalized)

  // ② 单事务写入三部分
  return db.transaction((tx) => {
    const timestamp = nowIso()

    const created = tx
      .insert(recipe)
      .values({ name, name_normalized: nameNormalized, note, created_at: timestamp, updated_at: timestamp })
      .returning({ id: recipe.id })
      .get()

    ingredients.forEach((ing, index) => {
      tx.insert(recipeIngredient)
        .values({
          recipe_id: created.id,
          definition_id: ing.definition_id,
          quantity: ing.quantity ?? null,
          unit: ing.unit ?? null,
          note: ing.note ?? null,
          sort_order: index, // 顺序 = 数组下标
          created_at: timestamp,
          updated_at: timestamp,
        })
        .run()
    })

    for (const tagId of resolveTagIds(tx, tagNames)) {
      tx.insert(recipeTagLink)
        .values({ recipe_id: created.id, tag_id: tagId, created_at: timestamp })
        .run()
    }

    return created.id
  })
}

/**
 * 统一保存（编辑）菜谱：基本信息 + 食材关联 + Tag 关联，**同一事务**。
 *
 * ⚠️ 关联采用「**全删后重建**」策略：
 *    - 保证顺序与输入数组一致
 *    - 失败时整体回滚，不会留下部分更新
 *    - ⚠️ 因此 `recipe_ingredient.id` / `recipe_tag_link.id` **不保证稳定**，
 *      调用方不要把它们当作长期标识
 *
 * @throws ServiceError RECIPE_NOT_FOUND / VALIDATION_ERROR / DUPLICATE_NAME
 */
export function saveRecipeFull(id: number, input: RecipeInput): void {
  // 菜谱必须存在
  const existing = db.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, id)).get()
  if (!existing) {
    throw recipeNotFoundError(`菜谱不存在：id=${id}`)
  }

  // ① 事务外校验
  const { name, nameNormalized } = assertRecipeName(input?.name)
  const note = assertRecipeNote(input?.note)
  const ingredients = assertIngredients(input?.ingredients)
  const tagNames = assertTagNames(input?.tags)
  assertRecipeNameAvailable(nameNormalized, id)

  // ② 单事务：三部分一起提交
  db.transaction((tx) => {
    const timestamp = nowIso()

    // 2.1 基本信息
    tx.update(recipe)
      .set({ name, name_normalized: nameNormalized, note, updated_at: timestamp })
      .where(eq(recipe.id, id))
      .run()

    // 2.2 食材关联：全删后按数组顺序重建
    tx.delete(recipeIngredient).where(eq(recipeIngredient.recipe_id, id)).run()
    ingredients.forEach((ing, index) => {
      tx.insert(recipeIngredient)
        .values({
          recipe_id: id,
          definition_id: ing.definition_id,
          quantity: ing.quantity ?? null,
          unit: ing.unit ?? null,
          note: ing.note ?? null,
          sort_order: index,
          created_at: timestamp,
          updated_at: timestamp,
        })
        .run()
    })

    // 2.3 Tag 关联：全删后重建
    tx.delete(recipeTagLink).where(eq(recipeTagLink.recipe_id, id)).run()
    for (const tagId of resolveTagIds(tx, tagNames)) {
      tx.insert(recipeTagLink)
        .values({ recipe_id: id, tag_id: tagId, created_at: timestamp })
        .run()
    }

    // ⚠️ 测试专用故障注入点：此处三部分均已写入。
    //    未设置 HOME_CHEF_FAULT_INJECT 时是空操作，生产行为不受影响。
    faultPoint('recipe_full_save_after_links')
  })
}

/**
 * 删除菜谱。
 *
 * ⚠️ 只删除菜谱本身及其关联（食材关联、Tag 关联由 FK CASCADE 清理），
 *    **不删除**任何食材定义，**也不删除** Tag 本身。
 *
 * @throws ServiceError RECIPE_NOT_FOUND
 */
export function deleteRecipe(id: number): void {
  const existing = db.select({ id: recipe.id }).from(recipe).where(eq(recipe.id, id)).get()
  if (!existing) {
    throw recipeNotFoundError(`菜谱不存在：id=${id}`)
  }

  // 食材关联与 Tag 关联由外键 ON DELETE CASCADE 自动清理
  db.delete(recipe).where(eq(recipe.id, id)).run()
}

/* ------------------------------------------------------------
 * Tag CRUD
 * ------------------------------------------------------------ */

/**
 * 新建 Tag。
 *
 * @throws ServiceError VALIDATION_ERROR / DUPLICATE_NAME
 */
export function createTag(name: unknown): number {
  if (typeof name !== 'string') {
    throw validationError('Tag 名称必须是字符串')
  }
  if (isBlankName(name)) {
    throw validationError('Tag 名称不能为空')
  }

  const normalized = normalizeName(name)
  const existing = db
    .select({ id: recipeTag.id })
    .from(recipeTag)
    .where(eq(recipeTag.name_normalized, normalized))
    .get()
  if (existing) {
    throw duplicateNameError(`Tag 名称已存在：${normalized}`)
  }

  const created = db
    .insert(recipeTag)
    .values({ name: name.trim(), name_normalized: normalized, created_at: nowIso() })
    .returning({ id: recipeTag.id })
    .get()
  return created.id
}

/**
 * 删除 Tag。
 *
 * ⚠️ 只删除 Tag 及其菜谱关联，**保留菜谱本身**。
 *
 * @throws ServiceError TAG_NOT_FOUND
 */
export function deleteTag(id: number): void {
  const existing = db.select({ id: recipeTag.id }).from(recipeTag).where(eq(recipeTag.id, id)).get()
  if (!existing) {
    throw tagNotFoundError(`Tag 不存在：id=${id}`)
  }

  // recipe_tag_link 由外键 ON DELETE CASCADE 自动清理
  db.delete(recipeTag).where(eq(recipeTag.id, id)).run()
}

/** 按 id 列表批量校验食材定义存在（供测试与后续批次复用） */
export function existingDefinitionIds(ids: number[]): number[] {
  if (ids.length === 0) return []
  return db
    .select({ id: ingredientDefinition.id })
    .from(ingredientDefinition)
    .where(inArray(ingredientDefinition.id, ids))
    .all()
    .map((r) => r.id)
}
