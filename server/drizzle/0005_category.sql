-- HomeChef v0.1.3：食材分类体系
--
-- 目标：
--   1. 新建 category 表（内置分类与用户自定义分类使用**完全相同**的结构）
--   2. 为 ingredient_definition 增加 category_id（可空外键 → category.id）
--   3. 播种 18 个默认分类
--
-- ⚠️ 不创建第二套分类机制（无 ingredient_type / seasoning_type / builtin_category）。
--    分类统一由 category 表 + ingredient_definition.category_id 表达。
--
-- ⚠️ 关于 category_id 的可空性：
--    设为 NULL 允许，是为了让「已有 definition 尚未回填分类」这一中间状态合法。
--    实际数据会在 seed 阶段全部回填；新建 definition 时由 Service 要求必填。
--
-- ⚠️ 关于外键 ON DELETE：
--    使用 RESTRICT —— 只要仍有 definition 引用该分类，数据库层就拒绝删除。
--    Service 会先检查并返回 409 CATEGORY_IN_USE（更友好的错误信息），
--    数据库约束作为最后一道防线。
--
-- ⚠️ SQLite 无法 ALTER 加外键约束列，因此采用「建新表 → 搬数据 → 换名」标准做法。
--    必须在迁移期间临时关闭外键，避免 DROP TABLE 触发子表 CASCADE
--    （见 0002 迁移踩过的坑）。

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

/* ============================================================
 * 1. category —— 食材分类
 * ============================================================ */

CREATE TABLE `category` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`sort_order` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_name_normalized_unique` ON `category` (`name_normalized`);--> statement-breakpoint

/* ============================================================
 * 2. 重建 ingredient_definition，增加 category_id
 *
 *    原样搬迁所有列与 id，保证已有 definition ID 不变。
 * ============================================================ */

CREATE TABLE `ingredient_definition_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`estimated_shelf_life_days` integer,
	`category_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `category`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "shelf_life_non_negative" CHECK("ingredient_definition_new"."estimated_shelf_life_days" is null or "ingredient_definition_new"."estimated_shelf_life_days" >= 0)
);
--> statement-breakpoint

-- 原样搬迁（category_id 先为 NULL，稍后由 seed 回填）
INSERT INTO `ingredient_definition_new` (`id`, `name`, `name_normalized`, `estimated_shelf_life_days`, `category_id`, `created_at`, `updated_at`)
SELECT `id`, `name`, `name_normalized`, `estimated_shelf_life_days`, NULL, `created_at`, `updated_at`
FROM `ingredient_definition`;--> statement-breakpoint

-- 让 sqlite_sequence 记录当前最大 id（与 0002 迁移同样的处理）
UPDATE `sqlite_sequence` SET `seq` = (SELECT COALESCE(MAX(`id`), 0) FROM `ingredient_definition_new`)
WHERE `name` = 'ingredient_definition_new';--> statement-breakpoint

DROP TABLE `ingredient_definition`;--> statement-breakpoint
ALTER TABLE `ingredient_definition_new` RENAME TO `ingredient_definition`;--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_definition_name_normalized_unique` ON `ingredient_definition` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `ingredient_definition_category_id_idx` ON `ingredient_definition` (`category_id`);--> statement-breakpoint

/* ============================================================
 * 3. 播种 18 个默认分类
 *
 *    sort_order 决定 UI 中的显示顺序，与产品定义的顺序一致。
 *    使用 INSERT OR IGNORE + 唯一索引，保证迁移可重复执行不会重复插入。
 * ============================================================ */

INSERT OR IGNORE INTO `category` (`name`, `name_normalized`, `sort_order`, `created_at`, `updated_at`) VALUES
	('蔬菜', '蔬菜', 1, datetime('now'), datetime('now')),
	('水果', '水果', 2, datetime('now'), datetime('now')),
	('猪肉', '猪肉', 3, datetime('now'), datetime('now')),
	('牛肉', '牛肉', 4, datetime('now'), datetime('now')),
	('羊肉', '羊肉', 5, datetime('now'), datetime('now')),
	('其他畜肉', '其他畜肉', 6, datetime('now'), datetime('now')),
	('鸡肉', '鸡肉', 7, datetime('now'), datetime('now')),
	('鸭肉', '鸭肉', 8, datetime('now'), datetime('now')),
	('鹅肉', '鹅肉', 9, datetime('now'), datetime('now')),
	('其他禽肉', '其他禽肉', 10, datetime('now'), datetime('now')),
	('水产', '水产', 11, datetime('now'), datetime('now')),
	('蛋类', '蛋类', 12, datetime('now'), datetime('now')),
	('豆制品', '豆制品', 13, datetime('now'), datetime('now')),
	('乳制品', '乳制品', 14, datetime('now'), datetime('now')),
	('主食/谷物', '主食/谷物', 15, datetime('now'), datetime('now')),
	('干货/菌菇', '干货/菌菇', 16, datetime('now'), datetime('now')),
	('冷冻食品', '冷冻食品', 17, datetime('now'), datetime('now')),
	('调味品', '调味品', 18, datetime('now'), datetime('now')),
	('其他/饮品', '其他/饮品', 19, datetime('now'), datetime('now'));
--> statement-breakpoint

-- 恢复外键约束
PRAGMA foreign_keys = ON;
