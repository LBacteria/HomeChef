import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * HomeChef 数据库 schema —— 食材定义 + 多库存记录模型
 *
 * 模型要点（本次重构）：
 *   - ingredient_definition 是食材的稳定身份（ID 不变、删除后不复用）
 *   - 名称与别名是可修改的显示/搜索属性
 *   - ingredient_definition → standard_ingredient 是 1:N（**无 UNIQUE**）
 *   - 每条库存记录可有自己的单位、日期、储存方式
 *
 * 严格遵循既有设计：
 *   - 主键 INTEGER PRIMARY KEY，不使用 AUTOINCREMENT
 *   - 日期 TEXT / ISO 8601（YYYY-MM-DD），字典序即时间序
 *   - 数量 REAL，集中 round/clamp
 *   - 无单位换算、无消耗历史、无批次号
 */

/* ============================================================
 * 固定枚举
 * ============================================================ */

/** 单位枚举（10 个固定值） */
export const UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const

export type Unit = (typeof UNITS)[number]

/** 储存方式枚举（库存记录属性，暂不影响保质期） */
export const STORAGE_METHODS = ['常温', '冷藏', '冷冻'] as const

export type StorageMethod = (typeof STORAGE_METHODS)[number]

/** 到期日期来源枚举 */
export const EXPIRY_DATE_SOURCES = ['estimated', 'manual'] as const

export type ExpiryDateSource = (typeof EXPIRY_DATE_SOURCES)[number]

/** 把字符串数组拼成 SQL 字面量列表（CHECK 约束不能用绑定参数） */
function sqlLiteralList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ')
}

/* ============================================================
 * ingredient_definition —— 食材定义（食材库）
 * ============================================================ */

/**
 * 食材定义。
 *
 * 这是食材的**稳定身份**：
 * - id 由数据库生成，创建后不因改名而改变
 * - 删除后 id 不复用（SQLite rowid 行为 + 不手动编号）
 * - 所有业务关联使用 id，**不允许依赖名称**
 */
export const ingredientDefinition = sqliteTable(
  'ingredient_definition',
  {
    // ⚠️ 必须使用 AUTOINCREMENT。
    //
    // ingredient_definition.id 是食材的**稳定身份**，要求「删除后 ID 永不复用」。
    //
    // 普通 `INTEGER PRIMARY KEY`（rowid 别名）**不能**保证这一点：
    // SQLite 分配新 rowid 的算法是「当前最大 rowid + 1」，
    // 若删除了最大 ID 的那一行，下一行会**重新使用**该 ID。
    //
    // AUTOINCREMENT 会创建 sqlite_sequence 表记录历史最大 ID，
    // 保证新 ID 严格递增、永不复用。
    //
    // 代价：多一张 sqlite_sequence 表 + 每次插入一次额外查找。
    // 对「ID 即身份、绝不复用」的要求而言，这个代价是必须付的。
    //
    // 注意：其他三张表（alias / unit / stock）不需要这个保证，
    // 它们的 ID 只是行标识，不复用没有业务含义 —— 保持普通主键即可。
    id: integer('id').primaryKey({ autoIncrement: true }),

    // 默认名称（display + search 属性，可修改）
    name: text('name').notNull(),

    // 归一化名称：trim + toLowerCase，全局唯一
    name_normalized: text('name_normalized').notNull().unique(),

    // 默认预估保质期（天）。
    // NULL = 不估算；0 = 当天到期（允许）。
    // 仅用于**新建库存记录**时估算到期日期，绝不会自动修改已有记录。
    estimated_shelf_life_days: integer('estimated_shelf_life_days'),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // 保质期必须 >= 0（NULL 放行）。暂不设人为上限。
    check(
      'shelf_life_non_negative',
      sql`${table.estimated_shelf_life_days} is null or ${table.estimated_shelf_life_days} >= 0`,
    ),
  ],
)

/* ============================================================
 * ingredient_alias —— 别名（绑定到 definition）
 * ============================================================ */

/**
 * 食材别名。
 *
 * 绑定到 ingredient_definition（**不是** standard_ingredient）。
 * 这样删除库存记录不会影响别名。
 */
export const ingredientAlias = sqliteTable(
  'ingredient_alias',
  {
    id: integer('id').primaryKey(),

    // 外键 → ingredient_definition.id
    // ON DELETE CASCADE：删除定义时别名级联删除
    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    alias: text('alias').notNull(),

    // 全局唯一：一个别名只能属于一个食材定义
    alias_normalized: text('alias_normalized').notNull().unique(),

    created_at: text('created_at').notNull(),
  },
  (table) => [
    index('ingredient_alias_definition_id_idx').on(table.definition_id),
  ],
)

/* ============================================================
 * ingredient_definition_unit —— 允许单位
 * ============================================================ */

/**
 * 食材定义允许使用的单位。
 *
 * 规则：每个 definition **至少有一个** allowed unit。
 * 库存记录的 unit 必须属于其 definition 的 allowed units。
 */
export const ingredientDefinitionUnit = sqliteTable(
  'ingredient_definition_unit',
  {
    id: integer('id').primaryKey(),

    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    unit: text('unit').notNull(),

    created_at: text('created_at').notNull(),
  },
  (table) => [
    // 同一食材不重复声明同一单位
    uniqueIndex('ingredient_definition_unit_unique').on(table.definition_id, table.unit),

    // CHECK：单位必须是 10 个枚举值之一
    check('definition_unit_in_enum', sql`${table.unit} in (${sql.raw(sqlLiteralList(UNITS))})`),

    index('ingredient_definition_unit_definition_id_idx').on(table.definition_id),
  ],
)

/* ============================================================
 * standard_ingredient —— 库存记录
 * ============================================================ */

/**
 * 库存记录。
 *
 * 一条记录 = 一批实际存在的食材：
 *   - 自己的数量与单位（可能是「3 个」或「1 袋」）
 *   - 自己的入库日期、生产日期、到期日期
 *   - 自己的储存方式、备注
 *
 * 与 definition 是 1:N。**definition_id 上没有 UNIQUE**，
 * 因此同一食材可以有多条库存记录，且不自动合并。
 */
export const standardIngredient = sqliteTable(
  'standard_ingredient',
  {
    id: integer('id').primaryKey(),

    // 外键 → ingredient_definition.id
    // ⚠️ 普通 NOT NULL FK，**没有 UNIQUE**（1:N）
    // ⚠️ 不带 ON DELETE CASCADE：删除定义不会自动删库存，
    //    Service 层会在有库存时拒绝删除定义。
    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    quantity: real('quantity').notNull().default(0),

    unit: text('unit').notNull(),

    // 入库日期：NOT NULL，用户不填时默认今天
    purchase_date: text('purchase_date').notNull(),

    // 生产日期：nullable。
    // ⚠️ 绝不根据其他日期反推生产日期。
    production_date: text('production_date'),

    // 到期日期：nullable
    expiry_date: text('expiry_date'),

    // 到期日期来源：estimated / manual / NULL
    expiry_date_source: text('expiry_date_source'),

    // 储存方式：常温 / 冷藏 / 冷冻
    storage_method: text('storage_method').notNull().default('常温'),

    note: text('note'),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // CHECK：不允许负库存
    check('quantity_non_negative', sql`${table.quantity} >= 0`),

    // CHECK：单位必须是枚举值之一
    check('inventory_unit_in_enum', sql`${table.unit} in (${sql.raw(sqlLiteralList(UNITS))})`),

    // CHECK：储存方式必须是枚举值之一
    check(
      'storage_method_in_enum',
      sql`${table.storage_method} in (${sql.raw(sqlLiteralList(STORAGE_METHODS))})`,
    ),

    // CHECK：expiry_date 与 expiry_date_source 必须成对出现
    //
    //   expiry IS NULL      → source IS NULL
    //   expiry IS NOT NULL  → source IN ('estimated','manual')
    //
    // ⚠️ 写法注意（踩过的坑）：
    //    SQLite 的 CHECK 只在结果为 **FALSE(0)** 时拒绝，结果为 **NULL** 时**放行**。
    //    因此绝对不能写成：
    //      `(expiry is null and source is null) or (expiry is not null and source in (...))`
    //    或
    //      `case when expiry is null then source is null else source in (...) end`
    //    当 expiry 有值而 source 为 NULL 时，`NULL in (...)` 求值为 NULL，
    //    整体结果既非 TRUE 也非 FALSE 而是 NULL → **约束被绕过**。
    //
    //    正确做法：所有分支都必须显式返回 0/1，不依赖 `in` 的 NULL 传播。
    check(
      'expiry_source_pairing',
      sql`case
        when ${table.expiry_date} is null
          then case when ${table.expiry_date_source} is null then 1 else 0 end
        else case
          when ${table.expiry_date_source} is null then 0
          when ${table.expiry_date_source} in (${sql.raw(sqlLiteralList(EXPIRY_DATE_SOURCES))}) then 1
          else 0
        end
      end`,
    ),

    // CHECK：生产日期不能晚于入库日期
    check(
      'production_not_after_purchase',
      sql`${table.production_date} is null or ${table.production_date} <= ${table.purchase_date}`,
    ),

    // CHECK：**manual** 到期日期不能早于入库日期。
    //
    // ⚠️ 关键：estimated 的到期日期**允许**早于入库日期。
    //    例：生产 9/28、入库 10/2、保质期 2 天 → estimated 到期 9/30 < 入库 10/2。
    //    这表示"按默认保质期估算，入库时已超过预计日期"，是合法且有意义的。
    //    因此这里**不能**用统一的 expiry >= purchase 约束，
    //    否则会错误地阻止上述场景。
    //
    // 同样使用 case 避免 NULL 三值逻辑（见上方说明）。
    check(
      'manual_expiry_not_before_purchase',
      sql`case
        when ${table.expiry_date} is null then 1
        when ${table.expiry_date_source} = 'estimated' then 1
        when ${table.expiry_date} >= ${table.purchase_date} then 1
        else 0
      end`,
    ),

    // 外键列索引：按 definition 查库存记录
    index('standard_ingredient_definition_id_idx').on(table.definition_id),
  ],
)

/* ============================================================
 * v0.1.1 seed 基础设施
 *
 * 只增加两张辅助表，**不修改任何现有表结构**。
 * 内置食材在数据库中就是普通的 ingredient_definition / alias / unit，
 * 因此没有 is_system / is_builtin 之类的字段。
 * ============================================================ */

/** seed map 的状态枚举 */
export const SEED_MAP_STATUSES = ['created', 'conflict'] as const

export type SeedMapStatus = (typeof SEED_MAP_STATUSES)[number]

/**
 * seed_history —— seed 执行记录。
 *
 * 仅用于统计与诊断（"这批 seed 跑过没有、什么版本"）。
 * ⚠️ **它不是跳过整个 seed 的唯一依据**：幂等的真正单元是
 *    seed_ingredient_map 的 (seed_name, seed_key)，
 *    这样未来 1.0.1 版本可以只追加新的 seed_key 而不重做已完成的。
 */
export const seedHistory = sqliteTable(
  'seed_history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    seed_name: text('seed_name').notNull().unique(),

    version: text('version').notNull(),

    applied_at: text('applied_at').notNull(),
  },
)

/**
 * seed_ingredient_map —— 每个内置食材的幂等单元。
 *
 * 一条记录 = 一个 (seed_name, seed_key)，代表"这条 seed 已经处理过了"。
 *
 * ⚠️⚠️ definition_id 必须 **ON DELETE SET NULL**，绝不能 CASCADE：
 *    - SET NULL：用户删除食材后，map 行保留 → 下次 seed 跳过 → **不复活**
 *    - CASCADE：map 行被删 → seed_key 消失 → 下次 seed **复活已删食材**
 */
export const seedIngredientMap = sqliteTable(
  'seed_ingredient_map',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    seed_name: text('seed_name').notNull(),

    /** seed 数据自己的稳定键，例如 'vegetable.tomato'。永不用中文名。 */
    seed_key: text('seed_key').notNull(),

    /**
     * 关联的食材定义。
     * NULL 表示两种情况之一，用 status 区分：
     *   - status='conflict'：首次 seed 时名称冲突，从未创建
     *   - status='created' 且 definition_id 为 NULL：创建过，但后来被用户删除
     */
    definition_id: integer('definition_id').references(() => ingredientDefinition.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),

    /** created / conflict */
    status: text('status').notNull(),

    seeded_at: text('seeded_at').notNull(),

    /** 用户删除该食材时由 Service 之外检测；当前仅作预留记录 */
    deleted_at: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('seed_ingredient_map_name_key_unique').on(table.seed_name, table.seed_key),

    check(
      'seed_map_status_in_enum',
      sql`${table.status} in (${sql.raw(sqlLiteralList(SEED_MAP_STATUSES))})`,
    ),

    index('seed_ingredient_map_definition_id_idx').on(table.definition_id),
  ],
)

/* ============================================================
 * v0.1.2 应用设置
 *
 * 单行设置表（id 恒为 1）。
 * 本批次只有 3 个设置，字段类型明确，因此不使用 key-value 结构。
 * ============================================================ */

/** 临期判断模式 */
export const EXPIRY_WARNING_MODES = ['days', 'percentage'] as const

export type ExpiryWarningMode = (typeof EXPIRY_WARNING_MODES)[number]

/** 临期状态（**动态计算**，绝不存库） */
export const EXPIRY_STATUSES = ['no_expiry', 'normal', 'expiring', 'expired'] as const

export type ExpiryStatus = (typeof EXPIRY_STATUSES)[number]

/**
 * 应用设置。
 *
 * ⚠️ 只有一行（id = 1），由 CHECK 约束强制。
 * ⚠️ allow_expired_for_recipe 用 INTEGER 0/1 存储（SQLite 无原生 BOOLEAN）。
 */
export const appSettings = sqliteTable(
  'app_settings',
  {
    id: integer('id').primaryKey(),

    /** days | percentage */
    expiry_warning_mode: text('expiry_warning_mode').notNull(),

    /**
     * 临期阈值。
     *   days 模式：整数天数，>= 0
     *   percentage 模式：百分比，0–100
     *
     * 用 REAL 存储以同时兼容两种模式（days 模式下 Service 强制为整数）。
     */
    expiry_warning_threshold: real('expiry_warning_threshold').notNull(),

    /** 是否允许食谱推荐考虑已过期食材。0 / 1 */
    allow_expired_for_recipe: integer('allow_expired_for_recipe').notNull(),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // 单行约束
    check('app_settings_single_row', sql`${table.id} = 1`),

    // 模式枚举
    check(
      'expiry_warning_mode_in_enum',
      sql`${table.expiry_warning_mode} in (${sql.raw(sqlLiteralList(EXPIRY_WARNING_MODES))})`,
    ),

    // 阈值非负
    check(
      'expiry_warning_threshold_non_negative',
      sql`${table.expiry_warning_threshold} >= 0`,
    ),

    // percentage 模式阈值 0–100。
    // ⚠️ 用显式 CASE 返回 0/1，避免 SQL 三值逻辑绕过
    //    （见 standard_ingredient 的 expiry_source_pairing 教训）。
    check(
      'expiry_warning_threshold_percentage_range',
      sql`case
        when ${table.expiry_warning_mode} = 'percentage'
          then case when ${table.expiry_warning_threshold} <= 100 then 1 else 0 end
        else 1
      end`,
    ),

    // 布尔字段只能是 0/1
    check(
      'allow_expired_for_recipe_boolean',
      sql`${table.allow_expired_for_recipe} in (0, 1)`,
    ),
  ],
)

/* ============================================================
 * 类型导出
 * ============================================================ */

export type IngredientDefinition = typeof ingredientDefinition.$inferSelect
export type NewIngredientDefinition = typeof ingredientDefinition.$inferInsert
export type IngredientAlias = typeof ingredientAlias.$inferSelect
export type NewIngredientAlias = typeof ingredientAlias.$inferInsert
export type IngredientDefinitionUnit = typeof ingredientDefinitionUnit.$inferSelect
export type NewIngredientDefinitionUnit = typeof ingredientDefinitionUnit.$inferInsert
export type StandardIngredient = typeof standardIngredient.$inferSelect
export type NewStandardIngredient = typeof standardIngredient.$inferInsert
export type SeedHistory = typeof seedHistory.$inferSelect
export type NewSeedHistory = typeof seedHistory.$inferInsert
export type SeedIngredientMap = typeof seedIngredientMap.$inferSelect
export type NewSeedIngredientMap = typeof seedIngredientMap.$inferInsert
export type AppSettings = typeof appSettings.$inferSelect
export type NewAppSettings = typeof appSettings.$inferInsert
