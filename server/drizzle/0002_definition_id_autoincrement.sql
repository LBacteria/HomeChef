-- 修正 ingredient_definition.id 为 AUTOINCREMENT
--
-- 背景：ingredient_definition.id 是食材的**稳定内部身份**，
-- 要求「删除后 ID 永不复用」。
--
-- 普通 INTEGER PRIMARY KEY（rowid 别名）不提供这个保证：
-- SQLite 用「当前最大 rowid + 1」分配新 ID，
-- 删除最大 ID 的行后，新行会复用该 ID。
--
-- 本迁移把主键改为 INTEGER PRIMARY KEY AUTOINCREMENT，
-- 它会创建 sqlite_sequence 表记录历史最大 ID，保证 ID 严格递增且永不复用。
--
-- ⚠️ 不修改任何已存在的 definition ID（原样搬迁）。
-- ⚠️ SQLite 无法 ALTER 主键，因此采用「建新表 → 搬数据 → 换名」标准做法。
--
-- ⚠️⚠️ 关键：DROP TABLE ingredient_definition 会触发子表
--      （ingredient_alias / ingredient_definition_unit）的 ON DELETE CASCADE，
--      把关联数据全部删掉！因此必须在迁移期间**临时关闭外键约束**。
--      migrate.ts 在连接上开启了 PRAGMA foreign_keys = ON，
--      这里显式关掉，迁移结束再打开（同一连接内生效）。

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

CREATE TABLE `ingredient_definition_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`estimated_shelf_life_days` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shelf_life_non_negative" CHECK("ingredient_definition_new"."estimated_shelf_life_days" is null or "ingredient_definition_new"."estimated_shelf_life_days" >= 0)
);
--> statement-breakpoint

-- 原样搬迁所有行（含 id），保证已有 definition ID 不变
INSERT INTO `ingredient_definition_new` (`id`, `name`, `name_normalized`, `estimated_shelf_life_days`, `created_at`, `updated_at`)
SELECT `id`, `name`, `name_normalized`, `estimated_shelf_life_days`, `created_at`, `updated_at`
FROM `ingredient_definition`;--> statement-breakpoint

-- 让 sqlite_sequence 记录当前最大 id，
-- 否则新插入可能从 1 开始而撞上已有 ID。
UPDATE `sqlite_sequence` SET `seq` = (SELECT COALESCE(MAX(`id`), 0) FROM `ingredient_definition_new`)
WHERE `name` = 'ingredient_definition_new';--> statement-breakpoint

DROP TABLE `ingredient_definition`;--> statement-breakpoint
ALTER TABLE `ingredient_definition_new` RENAME TO `ingredient_definition`;--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_definition_name_normalized_unique` ON `ingredient_definition` (`name_normalized`);--> statement-breakpoint

-- 恢复外键约束（迁移期间关闭，避免 CASCADE 误删关联数据）
PRAGMA foreign_keys = ON;
