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
