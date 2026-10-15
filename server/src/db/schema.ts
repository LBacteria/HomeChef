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

    /**
     * 所属分类（v0.1.3）。
     *
     * 可空：允许「尚未回填分类」的中间状态（迁移期间）。
     * 新建 definition 时由 Service 要求必填。
     *
     * ON DELETE RESTRICT —— 仍有 definition 引用时，数据库层拒绝删除分类。
     */
    category_id: integer('category_id').references(() => category.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // 保质期必须 >= 0（NULL 放行）。暂不设人为上限。
    check(
      'shelf_life_non_negative',
      sql`${table.estimated_shelf_life_days} is null or ${table.estimated_shelf_life_days} >= 0`,
    ),

    index('ingredient_definition_category_id_idx').on(table.category_id),
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

    /* ---------- v0.2.0 Phase 3：菜谱列表设置（全部 nullable）----------
     *
     * ⚠️ NULL = "用户尚未设置过" → Service 层回退到默认值。
     *    这样可兼容「整行不存在」的旧库与「新列为 NULL」的升级场景。
     */

    /** 排序字段：'updated_at' | 'created_at' | 'name' */
    recipe_sort_field: text('recipe_sort_field'),

    /** 排序方向：'asc' | 'desc' */
    recipe_sort_order: text('recipe_sort_order'),

    /** Tag 筛选模式：'and' | 'or' */
    recipe_tag_mode: text('recipe_tag_mode'),

    /** 选中的 Tag 名称列表，JSON 数组字符串，如 '["家常菜","快手"]' */
    recipe_selected_tags: text('recipe_selected_tags'),

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
 * v0.2.0 Phase 3：菜谱列表设置的白名单
 *
 * ⚠️ 排序字段与方向必须走白名单校验，**绝不拼接**用户原始输入。
 * ============================================================ */

/** 菜谱列表排序字段 */
export const RECIPE_SORT_FIELDS = ['updated_at', 'created_at', 'name'] as const
export type RecipeSortField = (typeof RECIPE_SORT_FIELDS)[number]

/** 排序方向 */
export const RECIPE_SORT_ORDERS = ['asc', 'desc'] as const
export type RecipeSortOrder = (typeof RECIPE_SORT_ORDERS)[number]

/** Tag 筛选模式 */
export const RECIPE_TAG_MODES = ['and', 'or'] as const
export type RecipeTagMode = (typeof RECIPE_TAG_MODES)[number]

/* ============================================================
 * v0.1.3 食材分类
 *
 * ⚠️ 只有一套分类机制：category 表 + ingredient_definition.category_id。
 *    没有 ingredient_type / seasoning_type / builtin_category / custom_category。
 *    内置分类与用户自定义分类使用完全相同的结构。
 * ============================================================ */

/**
 * 食材分类。
 *
 * - 名称唯一（name_normalized UNIQUE）
 * - sort_order 决定 UI 显示顺序
 * - 内置分类与用户创建的分类**没有任何结构差异**
 */
export const category = sqliteTable(
  'category',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** 显示名称（保留用户输入的写法，仅 trim） */
    name: text('name').notNull(),

    /** 归一化名称：trim + toLowerCase，全局唯一 */
    name_normalized: text('name_normalized').notNull().unique(),

    /** 显示顺序（默认分类按产品定义顺序；用户新增的排在其后） */
    sort_order: integer('sort_order').notNull().default(0),

    /**
     * 分类颜色（v0.1.4），格式固定为 #RRGGBB。
     *
     * 用于库存列表的分类标签背景色。
     * 已有分类通过迁移的 DEFAULT 值自动获得兜底色。
     */
    color: text('color').notNull().default('#9E9E9E'),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [index('category_sort_order_idx').on(table.sort_order)],
)

/** 调味品分类名（用于「调味品特殊行为」判断，不引入 type 字段） */
export const SEASONING_CATEGORY_NAME = '调味品'

/* ============================================================
 * v0.2.0 Phase 3 菜谱模块
 *
 * 四张表：
 *   recipe             —— 菜谱主表
 *   recipe_ingredient  —— 菜谱与食材定义的关系（允许重复关联）
 *   recipe_tag         —— Tag 表
 *   recipe_tag_link    —— 菜谱与 Tag 的关系
 *
 * ⚠️ 本阶段只建表 + 只读 API；增删改在批次 2，搜索筛选排序在批次 3。
 * ============================================================ */

/**
 * 菜谱主表。
 *
 * - 名称唯一（`name_normalized` UNIQUE）
 * - `note` 是菜谱整体备注，可为空
 * - 制作流程 / 照片**本阶段不实现**，也不预留字段
 */
export const recipe = sqliteTable(
  'recipe',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** 显示名称（保留用户输入的写法，仅 trim） */
    name: text('name').notNull(),

    /** 归一化名称：trim + toLowerCase，全局唯一 */
    name_normalized: text('name_normalized').notNull().unique(),

    /** 菜谱整体备注，可为空 */
    note: text('note'),

    /**
     * 菜谱内容版本号（v0.2.1）。
     *
     * 名称 / 备注 / 食材 / 步骤发生**实际内容变化**时 +1；
     * 内容完全相同的重复保存**不递增**。
     *
     * 供烹饪会话检测「菜谱是否已被修改」（见 cooking_session.recipe_revision）。
     */
    content_revision: integer('content_revision').notNull().default(0),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    index('recipe_name_normalized_idx').on(table.name_normalized),
    index('recipe_updated_at_idx').on(table.updated_at),
  ],
)

/**
 * 菜谱与食材定义的关系表。
 *
 * ⚠️⚠️ **关键设计**：同一菜谱**允许重复关联同一种食材**。
 *    例如「番茄炒蛋」可以先加「鸡蛋 2 个」，再加「鸡蛋 1 个」。
 *    因此**绝不设置** `UNIQUE(recipe_id, definition_id)`。
 *
 * - 每条记录**独立**保存数量、单位、备注与顺序
 * - `quantity` / `unit` / `note` **均可为空**（三者相互独立）
 * - 食材固定按 `sort_order` 展示（本阶段不实现拖动重排）
 */
export const recipeIngredient = sqliteTable(
  'recipe_ingredient',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    // 外键 → recipe.id
    // 删除菜谱时，其食材关联记录由 ON DELETE CASCADE 自动清理
    recipe_id: integer('recipe_id')
      .notNull()
      .references(() => recipe.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // 外键 → ingredient_definition.id
    // ⚠️ RESTRICT：被菜谱引用的食材定义**不能直接删除**。
    //    Service 层会返回 409 HAS_RECIPE（批次 2 实施）。
    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    /** 用量，可为空 */
    quantity: real('quantity'),

    /** 单位，可为空；若有值必须在 10 个枚举内 */
    unit: text('unit'),

    /** 该食材的备注（例如「适量」「2 勺」「切丝」），可为空 */
    note: text('note'),

    /**
     * 稳定标识（v0.2.1）。
     *
     * `saveRecipeFull` 采用「全删后重建」，因此 `id` 每次保存都会变化，
     * **不能**作为跳过确认的长期标识。`line_key` 由应用层按规则沿用：
     *   - `definition_id` 与 `unit` 均未变 → 沿用
     *   - 新增行，或上述字段变化       → 生成新值
     *
     * 因此 `quantity` / `note` 变化**不会**改变身份。
     */
    line_key: text('line_key'),

    /** 展示顺序：按用户添加顺序 */
    sort_order: integer('sort_order').notNull().default(0),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // ⚠️ 此处**故意没有** UNIQUE(recipe_id, definition_id) —— 允许重复关联
    index('recipe_ingredient_recipe_id_idx').on(table.recipe_id),
    index('recipe_ingredient_definition_id_idx').on(table.definition_id),

    // CHECK：单位若不为空，必须在枚举内
    // ⚠️ 用显式 CASE 返回 0/1，避免 SQL 三值逻辑绕过
    check(
      'recipe_ingredient_unit_in_enum',
      sql`case
        when ${table.unit} is null then 1
        when ${table.unit} in (${sql.raw(sqlLiteralList(UNITS))}) then 1
        else 0
      end`,
    ),

    // CHECK：数量若不为空，必须非负
    check(
      'recipe_ingredient_quantity_non_negative',
      sql`${table.quantity} is null or ${table.quantity} >= 0`,
    ),
  ],
)

/**
 * Tag 表。
 *
 * - 名称唯一（`name_normalized` UNIQUE）—— 同名 Tag 不得重复创建
 * - 支持自由创建与复用
 */
export const recipeTag = sqliteTable(
  'recipe_tag',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** 显示名称 */
    name: text('name').notNull(),

    /** 归一化名称：trim + toLowerCase，全局唯一 */
    name_normalized: text('name_normalized').notNull().unique(),

    created_at: text('created_at').notNull(),
  },
  (table) => [index('recipe_tag_name_normalized_idx').on(table.name_normalized)],
)

/**
 * 菜谱与 Tag 的关联表。
 *
 * - 一个菜谱可关联多个 Tag，也可以没有 Tag
 * - 同一菜谱不重复挂同一个 Tag（UNIQUE）
 * - 删除 Tag → 关联由 CASCADE 清理，但**菜谱本身保留**
 */
export const recipeTagLink = sqliteTable(
  'recipe_tag_link',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    recipe_id: integer('recipe_id')
      .notNull()
      .references(() => recipe.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    tag_id: integer('tag_id')
      .notNull()
      .references(() => recipeTag.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    created_at: text('created_at').notNull(),
  },
  (table) => [
    // 同一菜谱不重复挂同一 Tag
    uniqueIndex('recipe_tag_link_unique').on(table.recipe_id, table.tag_id),
    index('recipe_tag_link_recipe_id_idx').on(table.recipe_id),
    index('recipe_tag_link_tag_id_idx').on(table.tag_id),
  ],
)

/* ============================================================
 * v0.2.1 烹饪闭环
 *
 * 六张表：
 *   recipe_step                 —— 菜谱步骤
 *   cooking_session             —— 烹饪会话
 *   cooking_session_dish        —— 会话中的菜品行（含份数与进度）
 *   cooking_settlement          —— 结算凭证（幂等核心）
 *   cooking_settlement_item     —— 结算明细（含跳过项）
 *   cooking_session_dish_skip   —— 跳过确认（逐项持久化）
 *
 * ⚠️ 本阶段只建表 + 同步 schema；业务逻辑在后续批次。
 * ============================================================ */

/** 会话状态枚举 */
export const COOKING_SESSION_STATUSES = [
  'active',
  'cooking',
  'awaiting_settlement',
  'settled',
  'abandoned',
] as const

export type CookingSessionStatus = (typeof COOKING_SESSION_STATUSES)[number]

/** 会话内菜品状态枚举 */
export const COOKING_DISH_STATUSES = ['pending', 'done'] as const

export type CookingDishStatus = (typeof COOKING_DISH_STATUSES)[number]

/** 结算明细的处理结果枚举 */
export const SETTLEMENT_OUTCOMES = [
  'consumed',
  'skipped_null_quantity',
  'skipped_unit_mismatch',
  'skipped_user',
  'insufficient',
] as const

export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number]

/** 跳过确认的原因枚举 */
export const DISH_SKIP_REASONS = ['null_quantity', 'unit_mismatch', 'user_choice'] as const

export type DishSkipReason = (typeof DISH_SKIP_REASONS)[number]

/**
 * 菜谱步骤。
 *
 * - `step_no` 从 1 开始，`UNIQUE(recipe_id, step_no)` 保证不重号
 * - 删除菜谱时步骤由 ON DELETE CASCADE 自动清理
 */
export const recipeStep = sqliteTable(
  'recipe_step',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    recipe_id: integer('recipe_id')
      .notNull()
      .references(() => recipe.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    /** 步骤序号，从 1 开始 */
    step_no: integer('step_no').notNull(),

    /** 步骤正文（非空白） */
    content: text('content').notNull(),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('recipe_step_recipe_id_step_no_unique').on(table.recipe_id, table.step_no),

    // CHECK：步骤序号必须 >= 1
    check('recipe_step_no_positive', sql`${table.step_no} >= 1`),

    // CHECK：步骤正文不能是空白
    check('recipe_step_content_not_blank', sql`length(trim(${table.content})) > 0`),

    index('recipe_step_recipe_id_idx').on(table.recipe_id),
  ],
)

/**
 * 烹饪会话。
 *
 * 状态流转：
 *   active → cooking → awaiting_settlement → settled   【终态】
 *   active/cooking/awaiting_settlement → abandoned     【终态】
 *
 * ⚠️ `recipe_revision`：会话内菜品所依据的菜谱内容版本。
 *    菜谱内容变化时（与保存菜谱同一事务）递增，使已保存的跳过确认整体失效。
 */
export const cookingSession = sqliteTable(
  'cooking_session',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    /** active | cooking | awaiting_settlement | settled | abandoned */
    status: text('status').notNull().default('active'),

    /**
     * 自定义记录名称（v0.2.1.1）。
     *
     * - `NULL`  = 使用**默认名称**：由 `started_at`（无法解析时回退
     *   `created_at`）在客户端按**本地时区**渲染为 `YYYY-MM-DD-HH:mm`，
     *   例如 `2026-10-15-21:30`。
     * - 非空    = 用户自定义名称，列表与详情**一致显示**。
     *
     * ⚠️ 空串 / 纯空白**不写入本列**（由 Service 层拒绝）；
     *    恢复默认名请写 `NULL`，与空白输入语义**不同**。
     * ⚠️ 改名**不影响 `started_at`**，因此不改变列表排序。
     * ⚠️ 历史行保持 `NULL`，不做批量回填（迁移 0011 不写数据）。
     */
    name: text('name'),

    /** 会话内菜品所依据的菜谱内容版本（单调递增） */
    recipe_revision: integer('recipe_revision').notNull().default(0),

    started_at: text('started_at').notNull(),

    /** 全部菜品完成时写入 */
    finished_at: text('finished_at'),

    /** 结算成功时写入 */
    settled_at: text('settled_at'),

    /** 放弃时写入 */
    abandoned_at: text('abandoned_at'),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // CHECK：状态必须显式属于枚举（用 CASE 返回 0/1，避免 NULL 三值逻辑）
    check(
      'cooking_session_status_in_enum',
      sql`case
        when ${table.status} in (${sql.raw(sqlLiteralList(COOKING_SESSION_STATUSES))}) then 1
        else 0
      end`,
    ),

    index('cooking_session_status_idx').on(table.status),
  ],
)

/**
 * 会话中的菜品行。
 *
 * ⚠️ **UNIQUE(session_id, recipe_id)**：同一会话重复添加同一菜谱 → 合并份数。
 * ⚠️ `recipe_id` 用 ON DELETE RESTRICT：被烹饪会话引用的菜谱不能直接删除。
 *
 * `confirmed_revision` 语义（**派生值**，不是「是否写过确认」）：
 *   - `0`                        = 必需跳过项**尚未确认齐全**
 *   - `= session.recipe_revision` = **已齐全且版本一致**
 */
export const cookingSessionDish = sqliteTable(
  'cooking_session_dish',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    session_id: integer('session_id')
      .notNull()
      .references(() => cookingSession.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    recipe_id: integer('recipe_id')
      .notNull()
      .references(() => recipe.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    /** 份数；实际需求量 = 菜谱用量 × 份数 */
    servings: real('servings').notNull().default(1),

    /** pending | done */
    status: text('status').notNull().default('pending'),

    /** 断点续做：当前步骤序号（NULL = 未开始） */
    current_step_no: integer('current_step_no'),

    /** 确认齐全时对应的会话 revision；0 = 未齐全 */
    confirmed_revision: integer('confirmed_revision').notNull().default(0),

    sort_order: integer('sort_order').notNull().default(0),

    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // ⚠️ 重复添加同一菜谱 → 合并份数，而不是新增行
    uniqueIndex('cooking_session_dish_session_recipe_unique').on(table.session_id, table.recipe_id),

    // CHECK：份数必须为正
    check('cooking_dish_servings_positive', sql`${table.servings} > 0`),

    // CHECK：状态枚举（CASE 显式返回 0/1）
    check(
      'cooking_dish_status_in_enum',
      sql`case
        when ${table.status} in (${sql.raw(sqlLiteralList(COOKING_DISH_STATUSES))}) then 1
        else 0
      end`,
    ),

    // CHECK：步骤序号若不为空，必须 >= 1
    check(
      'cooking_dish_current_step_positive',
      sql`${table.current_step_no} is null or ${table.current_step_no} >= 1`,
    ),

    index('cooking_session_dish_session_id_idx').on(table.session_id),
  ],
)

/**
 * 结算凭证 —— **幂等核心**。
 *
 * ⚠️⚠️ `UNIQUE(session_id)` 是防止重复结算的**数据库级最终防线**：
 *    结算事务第一步即 INSERT 本表，唯一冲突即表示已结算，
 *    不依赖应用层「先查后插」，并发下也只有一者能成功。
 */
export const cookingSettlement = sqliteTable(
  'cooking_settlement',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    session_id: integer('session_id')
      .notNull()
      .references(() => cookingSession.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    settled_at: text('settled_at').notNull(),
    created_at: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('cooking_settlement_session_id_unique').on(table.session_id),
  ],
)

/**
 * 结算明细（含跳过项）。
 *
 * ⚠️ 正式凭证**只记录成功结算的最终结果**；
 *    `insufficient` 仅用于预览判定，失败结算不写入本表。
 */
export const cookingSettlementItem = sqliteTable(
  'cooking_settlement_item',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    settlement_id: integer('settlement_id')
      .notNull()
      .references(() => cookingSettlement.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    dish_id: integer('dish_id')
      .notNull()
      .references(() => cookingSessionDish.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    /** 来源菜谱食材行的稳定标识（冗余保存，供审计对齐） */
    line_key: text('line_key'),

    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    unit: text('unit'),

    /** 聚合后的应扣量（NULL = 用量为空） */
    required_quantity: real('required_quantity'),

    consumed_quantity: real('consumed_quantity').notNull().default(0),

    /** consumed | skipped_null_quantity | skipped_unit_mismatch | skipped_user | insufficient */
    outcome: text('outcome').notNull(),

    created_at: text('created_at').notNull(),
  },
  (table) => [
    // CHECK：结果枚举（CASE 显式返回 0/1）
    check(
      'settlement_item_outcome_in_enum',
      sql`case
        when ${table.outcome} in (${sql.raw(sqlLiteralList(SETTLEMENT_OUTCOMES))}) then 1
        else 0
      end`,
    ),

    // CHECK：已扣数量非负
    check('settlement_item_consumed_non_negative', sql`${table.consumed_quantity} >= 0`),

    index('cooking_settlement_item_settlement_id_idx').on(table.settlement_id),
    index('cooking_settlement_item_definition_id_idx').on(table.definition_id),
  ],
)

/**
 * 跳过确认（逐项持久化）。
 *
 * ⚠️⚠️ `UNIQUE(dish_id, line_key)`：每个确认精确对应**一条原始需求行**，
 *    因此「同一菜谱中同食材同单位的多条需求」也不会确认错项。
 *
 * ⚠️ `line_key` **不建外键** —— 它指向 recipe_ingredient.line_key，
 *    但为避免菜谱全删重建时产生意外级联，一致性由应用层保证。
 */
export const cookingSessionDishSkip = sqliteTable(
  'cooking_session_dish_skip',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),

    session_id: integer('session_id')
      .notNull()
      .references(() => cookingSession.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    dish_id: integer('dish_id')
      .notNull()
      .references(() => cookingSessionDish.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    /** 对应的菜谱食材行稳定标识 */
    line_key: text('line_key').notNull(),

    definition_id: integer('definition_id')
      .notNull()
      .references(() => ingredientDefinition.id, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),

    /** 单位归一化键：unit ?? '' */
    unit_key: text('unit_key').notNull().default(''),

    /** null_quantity | unit_mismatch | user_choice */
    reason: text('reason').notNull(),

    confirmed_at: text('confirmed_at').notNull(),
  },
  (table) => [
    uniqueIndex('cooking_session_dish_skip_dish_line_unique').on(table.dish_id, table.line_key),

    // CHECK：原因枚举（CASE 显式返回 0/1）
    check(
      'dish_skip_reason_in_enum',
      sql`case
        when ${table.reason} in (${sql.raw(sqlLiteralList(DISH_SKIP_REASONS))}) then 1
        else 0
      end`,
    ),

    index('cooking_session_dish_skip_session_id_idx').on(table.session_id),
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
export type Category = typeof category.$inferSelect
export type NewCategory = typeof category.$inferInsert

/* ---- v0.2.0 Phase 3 菜谱模块 ---- */
export type Recipe = typeof recipe.$inferSelect
export type NewRecipe = typeof recipe.$inferInsert
export type RecipeIngredient = typeof recipeIngredient.$inferSelect
export type NewRecipeIngredient = typeof recipeIngredient.$inferInsert
export type RecipeTag = typeof recipeTag.$inferSelect
export type NewRecipeTag = typeof recipeTag.$inferInsert
export type RecipeTagLink = typeof recipeTagLink.$inferSelect
export type NewRecipeTagLink = typeof recipeTagLink.$inferInsert

/* ---- v0.2.1 烹饪闭环 ---- */
export type RecipeStep = typeof recipeStep.$inferSelect
export type NewRecipeStep = typeof recipeStep.$inferInsert
export type CookingSession = typeof cookingSession.$inferSelect
export type NewCookingSession = typeof cookingSession.$inferInsert
export type CookingSessionDish = typeof cookingSessionDish.$inferSelect
export type NewCookingSessionDish = typeof cookingSessionDish.$inferInsert
export type CookingSettlement = typeof cookingSettlement.$inferSelect
export type NewCookingSettlement = typeof cookingSettlement.$inferInsert
export type CookingSettlementItem = typeof cookingSettlementItem.$inferSelect
export type NewCookingSettlementItem = typeof cookingSettlementItem.$inferInsert
export type CookingSessionDishSkip = typeof cookingSessionDishSkip.$inferSelect
export type NewCookingSessionDishSkip = typeof cookingSessionDishSkip.$inferInsert
