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
  /** 至少一个 */
  units: string[]
  aliases?: string[]
  estimated_shelf_life_days?: number | null
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
}

/** 创建库存记录 */
export interface CreateInventoryInput {
  definition_id: number
  quantity: number
  unit: string
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
