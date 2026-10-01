import { sql } from 'drizzle-orm'
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * HomeChef v0.1 数据库 schema
 *
 * 严格对应 DATABASE_DESIGN.md：
 *   - 第 3 节  standard_ingredient 字段设计
 *   - 第 4 节  ingredient_alias 字段设计
 *   - 第 5 节  主键 / 外键 / UNIQUE / CHECK
 *   - 第 9 节  索引
 *
 * v0.1 只有这两张表。不创建 consumption history、recipe、
 * shopping list、user、category、unit、merge 等任何表。
 */

/**
 * 单位枚举（DATABASE_DESIGN.md 第 5.2 节）
 *
 * 10 个固定值，v0.1 不支持用户自定义单位。
 * 数据库层用 CHECK 约束限定，Service 层同样校验（为了返回友好错误码）。
 */
export const UNITS = ['个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'] as const

export type Unit = (typeof UNITS)[number]

/**
 * standard_ingredient —— 标准食材（含库存）
 *
 * 库存只挂在标准食材上，不挂在别名上。
 */
export const standardIngredient = sqliteTable(
  'standard_ingredient',
  {
    // INTEGER PRIMARY KEY（rowid 别名），不使用 AUTOINCREMENT。
    // 见 DATABASE_DESIGN.md 第 5.1 节。
    //
    // 注意：必须写 .primaryKey() 而不带 autoIncrement: true。
    // Drizzle 在 SQLite 下会把 autoIncrement: true 翻译成 AUTOINCREMENT 关键字，
    // 而设计明确要求不使用它（会创建 sqlite_sequence 表并带来额外开销）。
    id: integer('id').primaryKey(),

    // 显示用名称：保留用户输入形式（仅去掉首尾空格），不做大小写改写。
    name: text('name').notNull(),

    // 匹配用名称：归一化后的值（trim + toLowerCase），唯一性约束建在这一列上。
    name_normalized: text('name_normalized').notNull().unique(),

    // 当前库存数量。REAL（SQLite REAL = 8 字节 IEEE 754 双精度）。
    // 非负由 CHECK 保证；舍入与钳制由 Service 层负责。
    quantity: real('quantity').notNull().default(0),

    // 单位，固定枚举。取值由 CHECK 限定。
    unit: text('unit').notNull(),

    // 日期使用 TEXT / ISO 8601（YYYY-MM-DD），字典序即时间序。
    // 两个日期都可选。
    purchase_date: text('purchase_date'),
    expiry_date: text('expiry_date'),

    // 备注，可选。
    note: text('note'),

    // 时间戳使用 ISO 8601 格式（UTC）。
    created_at: text('created_at').notNull(),
    updated_at: text('updated_at').notNull(),
  },
  (table) => [
    // CHECK：不允许负库存（DATABASE_DESIGN.md 第 5.5 节，决策 9）
    check('quantity_non_negative', sql`${table.quantity} >= 0`),

    // CHECK：单位必须是 10 个枚举值之一（决策 11）
    //
    // 注意：CHECK 约束里不能使用绑定参数（会生成非法的 `unit in (?, ?)`）。
    // 因此这里必须拼成 SQL 字面量，而不是用 sql.join 的绑定形式。
    check(
      'unit_in_enum',
      sql`${table.unit} in (${sql.raw(UNITS.map((u) => `'${u}'`).join(', '))})`,
    ),

    // CHECK：过期日期不能早于购买日期（决策 14）
    // 必须包含两个 IS NULL 分支，因为两个日期都可选。
    check(
      'expiry_not_before_purchase',
      sql`${table.expiry_date} is null or ${table.purchase_date} is null or ${table.expiry_date} >= ${table.purchase_date}`,
    ),
  ],
)

/**
 * ingredient_alias —— 食材别名
 *
 * 一个标准食材可以有多个别名；
 * 一个别名只能属于一个标准食材（由 alias_normalized 的全局 UNIQUE 保证）。
 */
export const ingredientAlias = sqliteTable(
  'ingredient_alias',
  {
    // INTEGER PRIMARY KEY（rowid 别名），不使用 AUTOINCREMENT。
    id: integer('id').primaryKey(),

    // 外键 → standard_ingredient.id
    // ON DELETE CASCADE：删除标准食材时别名级联删除（决策 6）
    // ON UPDATE CASCADE：零成本保险
    ingredient_id: integer('ingredient_id')
      .notNull()
      .references(() => standardIngredient.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),

    // 别名原文：保留用户输入形式（仅去首尾空格）。
    // 注意：alias 本身不加 UNIQUE，只对 alias_normalized 加。
    alias: text('alias').notNull(),

    // 归一化后的别名。
    // 这条全局 UNIQUE 就是"一个别名只能属于一个标准食材"的落地。
    // 必须是全局唯一，而不是 (ingredient_id, alias_normalized) 复合唯一。
    alias_normalized: text('alias_normalized').notNull().unique(),

    created_at: text('created_at').notNull(),
  },
  (table) => [
    // 外键列索引（DATABASE_DESIGN.md 第 9.1 节）：
    // ① 查某食材的所有别名 ② ON DELETE CASCADE 时定位子行
    index('ingredient_alias_ingredient_id_idx').on(table.ingredient_id),
  ],
)

/** 表类型导出，供后续类型标注使用 */
export type StandardIngredient = typeof standardIngredient.$inferSelect
export type NewStandardIngredient = typeof standardIngredient.$inferInsert
export type IngredientAlias = typeof ingredientAlias.$inferSelect
export type NewIngredientAlias = typeof ingredientAlias.$inferInsert
