/**
 * 与后端 API 对应的类型定义。
 *
 * ⚠️ 核心区分（不可混淆）：
 *
 *   IngredientDefinition.id  → 食材身份（definition_id）
 *   InventoryRecord.id       → 某一条库存记录（standard_ingredient.id）
 *
 * 库存操作（编辑/删除/消耗）一律使用 **inventory.id**。
 * 食材定义操作（改名、别名、单位、保质期、删除定义）使用 **definition.id**。
 */

/* ============================================================
 * 枚举
 * ============================================================ */

/** 固定单位枚举（与后端 UNITS 一致） */
export const UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const
export type Unit = (typeof UNITS)[number]

/** 储存方式枚举（与后端 STORAGE_METHODS 一致） */
export const STORAGE_METHODS = ['常温', '冷藏', '冷冻'] as const
export type StorageMethod = (typeof STORAGE_METHODS)[number]

/** 到期日期来源 */
export const EXPIRY_DATE_SOURCES = ['estimated', 'manual'] as const
export type ExpiryDateSource = (typeof EXPIRY_DATE_SOURCES)[number]

/* ============================================================
 * 食材定义（Definition）
 * ============================================================ */

/** 别名 */
export interface Alias {
  id: number
  definition_id: number
  alias: string
  alias_normalized: string
  created_at: string
}

/** 允许单位（后端以字符串数组返回，此类型用于文档说明） */
export type AllowedUnit = Unit

/** 食材定义 */
export interface IngredientDefinition {
  id: number
  /** 默认名称 */
  name: string
  name_normalized: string
  /** 默认预估保质期（天）；null 表示不估算 */
  estimated_shelf_life_days: number | null
  /** 所属分类 id（v0.1.3）；null 表示尚未设置分类 */
  category_id: number | null
  created_at: string
  updated_at: string
}

/**
 * 带关联数据的食材定义。
 *
 * 后端 GET /api/definitions 与 GET /api/definitions/:id
 * 会附带 aliases 与 allowed_units。
 */
export interface IngredientDefinitionDetail extends IngredientDefinition {
  aliases: Alias[]
  allowed_units: string[]
}

/** 创建食材定义 */
export interface CreateDefinitionInput {
  name: string
  /** 至少一个；**调味品允许为空数组** */
  units: string[]
  aliases?: string[]
  estimated_shelf_life_days?: number | null
  /** 所属分类（v0.1.3） */
  category_id?: number | null
}

/** 更新食材定义 */
export interface UpdateDefinitionInput {
  name?: string
  estimated_shelf_life_days?: number | null
  /** 所属分类（v0.1.4）；null = 清空分类。跨类切换由后端判定 */
  category_id?: number | null
}

/* ============================================================
 * 库存记录（Inventory）
 * ============================================================ */

/**
 * 库存记录（后端 standard_ingredient 行）。
 *
 * ⚠️ 注意：本结构**不含** name —— 食材名在 definition 上。
 *    definition_id 是关联键，需要前端用 definitions 列表映射出名称。
 */
export interface InventoryRecord {
  /** ⚠️ 这是 inventory record 的 ID，不是 definition ID */
  id: number
  /** 指向食材定义 */
  definition_id: number
  quantity: number
  unit: string
  /** 入库日期，YYYY-MM-DD，非空 */
  purchase_date: string
  /** 生产日期，YYYY-MM-DD，可为 null */
  production_date: string | null
  /** 到期日期，YYYY-MM-DD，可为 null */
  expiry_date: string | null
  /** 到期日期来源：estimated / manual / null */
  expiry_date_source: ExpiryDateSource | null
  storage_method: string
  note: string | null
  created_at: string
  updated_at: string

  /* ------------------------------------------------------------
   * 以下字段由后端**动态计算**，不存数据库。
   * 前端只负责展示，绝不自行计算临期状态。
   * ------------------------------------------------------------ */

  /** 临期状态 */
  expiry_status: ExpiryStatus
  /** 距到期日剩余天数（可为负）；no_expiry 时为 null */
  days_remaining: number | null
  /** 剩余保质期百分比；无法计算时为 null */
  remaining_percentage: number | null
  /** 食材默认名称（后端随列表返回，便于按名称排序与展示） */
  definition_name?: string
  /** 所属分类 id（v0.1.3） */
  category_id?: number | null
  /**
   * 是否为调味品（v0.1.3，后端计算）。
   *
   * ⚠️ 调味品库存只表示「有」，前端应隐藏数量/单位/日期/储存方式，
   *    并且不提供「消耗」操作。
   */
  is_seasoning?: boolean
}

/**
 * 库存排序字段（与后端白名单一致）。
 *
 * ⚠️ 仅用于组装查询参数；**排序计算完全在后端**。
 */
export type SortField = 'default' | 'expiry' | 'purchase_date' | 'name' | 'quantity'

/** 排序方向（与后端白名单一致） */
export type SortOrder = 'asc' | 'desc'

/* ============================================================
 * 食材库排序（v0.1.2 Batch 3）
 *
 * ⚠️ 与库存排序是**两个独立功能**，类型也分开定义。
 * ============================================================ */

/** 食材库允许的排序字段（只有名称） */
export type DefinitionSortField = 'name'

/**
 * 食材库排序方向。
 *   asc  → 名称 A → Z
 *   desc → 名称 Z → A
 */
export type DefinitionSortOrder = 'asc' | 'desc'

/* ============================================================
 * 食材分类（v0.1.3）
 *
 * ⚠️ 只有一套分类：内置分类与用户自定义分类结构完全相同。
 * ============================================================ */

/** 食材分类 */
export interface Category {
  id: number
  name: string
  name_normalized: string
  sort_order: number
  /** 分类颜色（v0.1.4），格式 #RRGGBB。用于库存列表的分类标签 */
  color: string
  created_at: string
  updated_at: string
}

/** 创建分类 */
export interface CreateCategoryInput {
  name: string
}

/**
 * 调味品分类名。
 *
 * ⚠️ 调味品特殊行为**只依据分类名**判断，不使用 type 字段。
 *    与后端 SEASONING_CATEGORY_NAME 保持一致。
 */
export const SEASONING_CATEGORY_NAME = '调味品'

/** 创建库存记录 */
export interface CreateInventoryInput {
  definition_id: number
  /**
   * 数量。
   * ⚠️ 调味品**不需要**（后端用哨兵值填充）；普通食材必须提供。
   */
  quantity?: number
  /** 单位。调味品不需要；普通食材必须提供且属于允许单位 */
  unit?: string
  purchase_date?: string | null
  production_date?: string | null
  /** 提供则为 manual；不提供则由后端估算 */
  expiry_date?: string | null
  storage_method?: string
  note?: string | null
}

/**
 * 更新库存记录。
 *
 * ⚠️ expiry_date 的"是否出现"具有业务含义：
 *   - 出现且为 null  → 用户主动清空（后端清空 source，不重算）
 *   - 完全不出现      → 后端按当前 source 决定是否重算
 *   因此这里用可选属性，调用方需显式决定是否传该字段。
 */
export interface UpdateInventoryInput {
  /**
   * 更换该库存记录所属的食材。
   *
   * 不传则保持原定义不变；传则后端校验新定义存在、
   * 且**最终 unit** 在新定义的允许单位内。更换不会重算日期。
   */
  definition_id?: number
  quantity?: number
  unit?: string
  purchase_date?: string | null
  production_date?: string | null
  expiry_date?: string | null
  storage_method?: string
  note?: string | null
}

/** 消耗库存 */
export interface ConsumeInventoryInput {
  amount: number
}

/* ============================================================
 * 应用设置
 * ============================================================ */

/** 临期判断模式 */
export type ExpiryWarningMode = 'days' | 'percentage'

/** 临期状态（后端动态计算） */
export type ExpiryStatus = 'no_expiry' | 'normal' | 'expiring' | 'expired'

/**
 * 应用设置。
 *
 * ⚠️ 默认值由**后端**决定，前端不得自行假定默认值。
 *    首次读取时直接使用后端返回值即可。
 */
export interface AppSettings {
  expiry_warning_mode: ExpiryWarningMode
  /** days 模式为整数天数；percentage 模式为 0–100 的百分比 */
  expiry_warning_threshold: number
  /**
   * 是否允许食谱推荐考虑已过期食材。
   * v0.1.2 仅保存该设置，食谱功能尚未实现。
   */
  allow_expired_for_recipe: boolean
}

/** 更新设置（部分更新） */
export interface UpdateSettingsInput {
  expiry_warning_mode?: ExpiryWarningMode
  expiry_warning_threshold?: number
  allow_expired_for_recipe?: boolean
}

/* ============================================================
 * 菜谱模块（v0.2.0 Phase 3）
 *
 * ⚠️ 与库存的 SortField / 食材库的 DefinitionSortField 都是**独立功能**，
 *    因此菜谱排序字段单独定义，不复用上面任何一个。
 * ============================================================ */

/** 菜谱列表排序字段（与后端白名单一致） */
export type RecipeSortField = 'updated_at' | 'created_at' | 'name'

/** 菜谱列表排序方向（与后端白名单一致） */
export type RecipeSortOrder = 'asc' | 'desc'

/** Tag 多选筛选模式 */
export type RecipeTagMode = 'and' | 'or'

/**
 * 菜谱列表项（GET /api/recipes 的元素）。
 *
 * ⚠️ 列表项有 `ingredient_count`，但**详情没有**。
 */
export interface RecipeSummary {
  id: number
  name: string
  note: string | null
  created_at: string
  updated_at: string
  /** 该菜谱的 Tag 名称列表 */
  tags: string[]
  /** 食材记录条数（同一食材重复添加会重复计数） */
  ingredient_count: number
}

/**
 * 详情中的一条食材记录。
 *
 * ⚠️ `id` 是数据库关联记录的 ID —— 统一保存采用「全删后重建」，
 *    该 ID **不保证稳定**，前端**不得**用它作为 React key。
 */
export interface RecipeIngredientDetail {
  id: number
  definition_id: number
  /** 食材定义的当前名称（由后端 join 提供，改名后自动跟随） */
  definition_name: string
  quantity: number | null
  unit: string | null
  /** 食材备注（与菜谱整体备注相互独立） */
  note: string | null
  /** 展示顺序，等于添加顺序 */
  sort_order: number
  /**
   * 稳定标识（v0.2.1）。
   *
   * ⚠️ 后端 `saveRecipeFull` 采用「全删后重建」，`id` 会变化，
   *    因此**跳过确认必须用它**而不是 `id`。
   */
  line_key: string | null
}

/** 菜谱步骤（v0.2.1） */
export interface RecipeStepDetail {
  id: number
  /** 从 1 开始 */
  step_no: number
  content: string
}

/** 菜谱详情（GET /api/recipes/:id） */
export interface RecipeDetail {
  id: number
  name: string
  note: string | null
  /** 菜谱内容版本号（v0.2.1）；内容变化时递增 */
  content_revision: number
  created_at: string
  updated_at: string
  tags: string[]
  ingredients: RecipeIngredientDetail[]
  /** 烹饪步骤（v0.2.1） */
  steps: RecipeStepDetail[]
}

/**
 * 统一保存时的单条食材输入。
 *
 * ⚠️ 数量 / 单位 / 备注三者相互独立，均允许为 null。
 */
export interface RecipeIngredientInput {
  definition_id: number
  quantity?: number | null
  unit?: string | null
  note?: string | null
  /**
   * 稳定标识（v0.2.1）。
   *
   * ⚠️ 编辑既有菜谱时应**回传**后端给出的 `line_key`，
   *    否则该行会被视为新增并换新标识，导致相关跳过确认失效。
   *    仅当 `definition_id` 或 `unit` 变化时后端才会换新值。
   */
  line_key?: string | null
}

/**
 * 新建 / 统一保存的请求体（POST 与 PATCH /:id/full 共用）。
 *
 * ⚠️ `tags` 传的是 **Tag 名称**；后端会自动创建不存在的 Tag、复用已存在的。
 */
export interface RecipeInput {
  name: string
  note?: string | null
  /** 至少一条；允许重复引用同一个 definition_id */
  ingredients: RecipeIngredientInput[]
  tags?: string[]
  /** 步骤列表（v0.2.1）；序号由数组顺序决定，不传 = 无步骤 */
  steps?: string[]
}

/** 列表查询参数（GET /api/recipes） */
export interface RecipeListQuery {
  search?: string
  /** Tag 名称列表；**用重复参数传递**，不拼逗号 */
  tags?: string[]
  tagMode?: RecipeTagMode
  sortField?: RecipeSortField
  sortOrder?: RecipeSortOrder
}

/**
 * Tag（GET /api/tags 的元素）。
 *
 * v0.2.3：新增五大分类与稳定身份。
 *   - `category` 五大分类 code，或 `null`（未分类，旧标签即为此）
 *   - `code`     系统预设的稳定身份；自定义为 null
 *   - `is_system` true = 系统预设
 *   - `recipe_count` 被多少菜谱引用（删除前提示用）
 *
 * ⚠️ 中文分类别名**不在这里**：由 `GET /api/tag-categories` 下发，
 *    前端不得自行维护一份分类字典。
 */
export interface RecipeTagItem {
  id: number
  name: string
  category: RecipeTagCategoryCode | null
  code: string | null
  is_system: boolean
  sort_order: number
  recipe_count: number
  created_at: string
}

/** 五大固定分类 code */
export type RecipeTagCategoryCode =
  | 'dish_type'
  | 'flavor'
  | 'cooking_method'
  /** v0.2.4：原 `meal_scene`（用餐场景）已由「菜系风格」取代 */
  | 'cuisine'
  | 'feature'

/** 分类字典（GET /api/tag-categories）——**后端是唯一来源** */
export interface TagCategoryDict {
  categories: Array<{ code: RecipeTagCategoryCode; label: string }>
  /** 「未分类」不是分类 code（落库为 null），但需要展示标题 */
  unclassified: { code: 'unclassified'; label: string }
}

/** 新建 Tag 的请求体（category 省略/null = 未分类） */
export interface CreateTagInput {
  name: string
  category?: RecipeTagCategoryCode | null
}

/** 修改 Tag 的请求体（部分更新，至少一个字段） */
export interface UpdateTagInput {
  name?: string
  category?: RecipeTagCategoryCode | null
}

/* ============================================================
 * v0.2.3 单菜偏好（点赞 / 点踩）
 * ============================================================ */

export type RecipePreferenceValue = 'like' | 'dislike'

/** 一条偏好记录（GET /api/recipe-preferences 的元素） */
export interface RecipePreferenceItem {
  recipe_id: number
  value: RecipePreferenceValue
  created_at: string
  updated_at: string
}

/** 偏好的读写结果（value 为 null 表示已取消） */
export interface RecipePreferenceState {
  recipe_id: number
  value: RecipePreferenceValue | null
}

/**
 * 菜谱列表设置（GET / PATCH /api/recipe-list-settings）。
 *
 * ⚠️ `selected_tags` 存的是 **Tag 名称**，不是 ID。
 */
export interface RecipeListSettings {
  sort_field: RecipeSortField
  sort_order: RecipeSortOrder
  tag_mode: RecipeTagMode
  selected_tags: string[]
}

/** 列表设置的部分更新输入（必须至少传一个字段） */
export interface UpdateRecipeListSettingsInput {
  sort_field?: RecipeSortField
  sort_order?: RecipeSortOrder
  tag_mode?: RecipeTagMode
  selected_tags?: string[]
}

/* ============================================================
 * 烹饪会话（v0.2.1）
 *
 * ⚠️ 以下类型严格对应后端 `cookingService.ts` / `settlementService.ts`
 *    的实际响应结构，不得凭空增删字段。
 * ============================================================ */

/** 会话状态（后端 cooking_session.status 的 CHECK 枚举） */
export type CookingSessionStatus =
  | 'active'
  | 'cooking'
  | 'awaiting_settlement'
  | 'settled'
  | 'abandoned'

/** 会话内菜品状态 */
export type CookingDishStatus = 'pending' | 'done'

/** 跳过确认原因 */
export type DishSkipReason = 'null_quantity' | 'unit_mismatch' | 'user_choice'

/** 结算明细的处理结果（后端 SETTLEMENT_OUTCOMES） */
export type SettlementOutcome =
  | 'consumed'
  | 'skipped_null_quantity'
  | 'skipped_unit_mismatch'
  | 'skipped_user'
  | 'insufficient'

/** 会话列表项（GET /api/cooking/sessions） */
export interface CookingSessionSummary {
  id: number
  status: CookingSessionStatus
  /**
   * 自定义名称（v0.2.1.1）。
   *
   * `null` = 未自定义 → 前端按 `started_at`（无法解析时回退 `created_at`）
   * 在**本地时区**渲染默认名 `YYYY-MM-DD-HH:mm`，例如 `2026-10-15-21:30`。
   */
  name: string | null
  recipe_revision: number
  started_at: string
  dish_count: number
  created_at: string
  updated_at: string
}

/**
 * 批量删除结果（POST /api/cooking/sessions/batch-delete）。
 *
 * ⚠️ 只有**整批成功**才会返回本结构。任一 id 不存在时后端返回 404
 *    并**不删除任何行**，因此**不存在「部分成功」**状态。
 */
export interface CookingSessionsDeleteResult {
  deleted_ids: number[]
}

/** 会话中的一道菜（GET /api/cooking/sessions/:id 的 dishes[]） */
export interface CookingDishDetail {
  id: number
  recipe_id: number
  recipe_name: string
  servings: number
  status: CookingDishStatus
  /** 当前步骤序号；null = 未开始 */
  current_step_no: number | null
  confirmed_revision: number
  sort_order: number
  /** 该菜谱当前步骤总数（后端提供，供进度上界校验） */
  step_count: number
  /** 已确认齐全且版本一致 */
  confirmed: boolean
}

/** 会话详情 */
export interface CookingSessionDetail {
  id: number
  status: CookingSessionStatus
  /** 自定义名称；`null` = 使用默认名（同 CookingSessionSummary.name） */
  name: string | null
  recipe_revision: number
  started_at: string
  finished_at: string | null
  settled_at: string | null
  abandoned_at: string | null
  created_at: string
  updated_at: string
  dishes: CookingDishDetail[]
}

/** 跳过确认记录（GET /api/cooking/sessions/:id/skips） */
export interface CookingSkipRecord {
  id: number
  dish_id: number
  line_key: string
  definition_id: number
  definition_name: string
  unit_key: string
  reason: DishSkipReason
  confirmed_at: string
}

/** 保存跳过确认的请求项 */
export interface SkipConfirmationInput {
  dish_id: number
  line_key: string
  reason: DishSkipReason
}

/* ---------- 结算 ---------- */

/**
 * 派生确认原因。
 *
 * ⚠️ v0.2.4 起 `seasoning_presence` **不再产生**（调味品免确认），
 *    保留该取值仅用于兼容旧响应/旧数据的类型判断。
 */
export type DerivedSkipReason = DishSkipReason | 'seasoning_presence'

/** 结算预览中的一项（GET .../settle/preview） */
export interface SettlementPreviewItem {
  dish_id: number
  line_key: string | null
  definition_id: number
  definition_name: string
  /**
   * v0.2.4：调味品行只做**备料提醒**。
   *
   * ⚠️ 不计库存、不扣量、不需要确认：`required_reason` / `confirm_reason` 恒为 null，
   *    `skipped` 为 true 但**不代表**用户选择跳过（`available_quantity` 也不代表库存）。
   */
  is_seasoning: boolean
  unit: string | null
  required_quantity: number | null
  /**
   * v0.2.3（R4）：处理到**本行时**该（食材 + 单位）的**剩余**可用总量。
   *
   * ⚠️ 已扣掉前面需求占用的部分 —— 不再是"每行都显示全量可用"。
   */
  available_quantity: number
  /** 后端判定的必需确认原因（**派生**；`seasoning_presence` 不会落库） */
  required_reason: DerivedSkipReason | null
  /**
   * 确认时应**回传**的持久化原因。
   *
   * ⚠️ `seasoning_presence` → `user_choice`；数据库 CHECK 只允许 `DishSkipReason`。
   */
  confirm_reason: DishSkipReason | null
  /** 该需求是否已有有效确认（仅指 `null_quantity` / `unit_mismatch` 两类必需确认） */
  confirmed: boolean
  /** 是否确实能按真实顺序扣到所需量（结合总计判定） */
  can_consume: boolean
  /** v0.2.3（R4）：本行会被**跳过且不扣库存**（用量未指定 / 已确认跳过） */
  skipped: boolean
}

/** 结算预览响应 */
export interface SettlementPreview {
  session_id: number
  status: CookingSessionStatus
  items: SettlementPreviewItem[]
  needing_confirmation: number
  /** ⚠️ 语义是「**待确认项为 0**」，**不是**「库存充足」 */
  ready: boolean
  /**
   * v0.2.3（R4）：所有会扣减的行**都真的能扣到**（库存**总量**足够）。
   *
   * ⚠️ 与 `ready` 是**两件事**：两个需求各 2、库存 3 时，
   *    `ready` 可能为 true（无需确认），但 `stock_sufficient` 为 false（总量不够）。
   */
  stock_sufficient: boolean
}

/** 结算结果中的一项 */
export interface SettlementItemResult {
  dish_id: number
  line_key: string | null
  definition_id: number
  definition_name: string
  unit: string | null
  required_quantity: number | null
  consumed_quantity: number
  outcome: SettlementOutcome
}

/** 结算执行结果（POST .../settle） */
export interface SettlementResult {
  settlement_id: number
  session_id: number
  settled_at: string
  items: SettlementItemResult[]
  summary: Record<SettlementOutcome, number>
}

/* ============================================================
 * v0.2.2 整餐推荐
 * ============================================================ */

export type RecommendationLevel = 'ready' | 'nearly' | 'missing'

export type RecommendationRequirementStatus =
  | 'ok'
  | 'insufficient'
  | 'unit_mismatch'
  | 'unknown_quantity'
  /** ⚠️ v0.2.4 起不再产生（仅兼容旧数据） */
  | 'seasoning_missing'
  /** v0.2.4：调味品中性提醒（自行准备，不计库存） */
  | 'seasoning_reminder'

/** 合并后的一条整餐需求（同食材同单位已合并） */
export interface RecommendationRequirement {
  definition_id: number
  definition_name: string
  unit: string | null
  required_quantity: number | null
  available_quantity: number
  missing_quantity: number | null
  status: RecommendationRequirementStatus
  is_seasoning: boolean
  used_expiring: boolean
  expired_excluded_quantity: number
  /** 后端生成的中文说明 */
  note: string
}

/** 每道菜**缩放后**的一条配料（可直接照着备料） */
export interface RecommendationDishIngredient {
  definition_id: number
  definition_name: string
  /** 已按份数倍数缩放；未指定用量时为 null */
  quantity: number | null
  unit: string | null
  note: string | null
  is_seasoning: boolean
}

export interface RecommendationDishStep {
  step_no: number
  content: string
}

export interface RecommendationDish {
  recipe_id: number
  recipe_name: string
  /**
   * v0.2.4：本餐中的角色。**后端是唯一权威**，前端只渲染，不自行推断。
   */
  role_in_meal: 'main' | 'side'
  /** 份数倍数（人数 ÷ 基准人数），可直接用于进入烹饪 */
  servings: number
  tags: string[]
  content_revision: number
  ingredients: RecommendationDishIngredient[]
  steps: RecommendationDishStep[]
}

/** 评分分项（v0.2.3：每套方案都能解释「分数从哪来」） */
export interface RecommendationScoreBreakdown {
  ready_bonus: number
  coverage: number
  utilization: number
  expiring: number
  structure: number
  shared: number
  diversity: number
  missing_penalty: number
  seasoning_penalty: number
  unknown_penalty: number
  /** 库存侧小计（不含软信号） */
  stock_total: number
  preference: number
  history: number
  rotation: number
  /** 最终总分 */
  total: number
}

/** 软信号明细（偏好 / 历史 / 轮换） */
export interface RecommendationSignals {
  preference: number
  history: number
  rotation: number
  liked: number[]
  disliked: number[]
  cooked_recently: number[]
  repeated_meal: boolean
}

/** 一条明确缺口（v0.2.3：不足方案逐项标明缺什么） */
export interface RecommendationShortage {
  definition_id: number
  definition_name: string
  unit: string | null
  required_quantity: number | null
  available_quantity: number
  missing_quantity: number | null
  status: 'insufficient' | 'unit_mismatch' | 'seasoning_missing'
  is_seasoning: boolean
  note: string
}

export interface RecommendationPlan {
  plan_id: string
  /** v0.2.4：本套方案唯一的主菜锚点（对应 dishes 里 role_in_meal==='main' 的那道） */
  main_dish_recipe_id: number
  /** 用户确认时的服务端快照指纹；apply 必须原样回传 */
  snapshot_id: string
  level: RecommendationLevel
  score: number
  /** 评分分项（v0.2.3） */
  score_breakdown: RecommendationScoreBreakdown
  /** 软信号明细（v0.2.3） */
  signals: RecommendationSignals
  /** 缺口清单（v0.2.3；无缺口时为空数组） */
  shortages: RecommendationShortage[]
  dishes: RecommendationDish[]
  requirements: RecommendationRequirement[]
  summary: {
    required_count: number
    satisfied_count: number
    missing_count: number
    main_missing_count: number
    seasoning_missing_count: number
    unknown_count: number
    expiring_used_count: number
    expired_excluded_count: number
    coverage: number
    /** 需求满足比例（0–1，排序用，v0.2.3） */
    quantity_coverage: number
    /** 可用库存消耗比例（0–1，减少浪费，v0.2.3） */
    utilization: number
    /** 临期可实耗比例（0–1，v0.2.3） */
    expiring_ratio: number
    /** 被 ≥2 道菜共享的食材项数（v0.2.3） */
    shared_requirement_count: number
    /** 结构搭配得分（标签层面粗略搭配，非营养数值，v0.2.3） */
    structure_score: number
    /** 本餐涉及的菜品类型角色（v0.2.3） */
    dish_roles: string[]
    /** 本餐涉及的「菜品特点」标签（v0.2.3） */
    feature_tags: string[]
    categories_used: string[]
    tags_used: string[]
  }
  reasons: string[]
}

/** 整餐推荐结果（POST /api/recommendation/meal-plans） */
export interface MealPlanResult {
  people: number
  base_servings: number
  multiplier: number
  dish_count: number
  candidate_recipe_count: number
  considered_recipe_count: number
  candidate_truncated: boolean
  combinations_evaluated: number
  truncated: boolean
  today: string
  /** v0.2.3：本次标签筛选回显 */
  tag_filter: {
    tags: string[]
    tag_mode: RecipeTagMode
    matched_recipe_count: number
  }
  /** v0.2.3：命中的烹饪历史概览 */
  history: {
    window_days: number
    settled_meals: number
    cooked_recipes: number
  }
  plans: RecommendationPlan[]
  notes: string[]
}

/** 进入烹饪结果（POST /api/recommendation/apply） */
export interface ApplyPlanResult {
  session_id: number
  dish_count: number
  people: number
  expected_multiplier: number
  snapshot_id: string
  /** 同一 request_id 重放时由服务端标注 */
  idempotent_replay?: boolean
}

/* ============================================================
 * 错误
 * ============================================================ */

/** 后端统一错误响应体 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
  }
}

/**
 * 前端使用的 API 错误对象。
 *
 * 保留后端 code 与 message，便于按 code 做特殊 UI
 * （如 INSUFFICIENT_STOCK、HAS_STOCK、UNIT_IN_USE）。
 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}
