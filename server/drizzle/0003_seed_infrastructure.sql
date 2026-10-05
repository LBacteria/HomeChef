-- HomeChef v0.1.1：内置食材 seed 基础设施
--
-- 本迁移**只建表，不插入任何食材数据**。
--
-- 为什么不把 180 个食材放进 migration：
--   migration 是结构变更，每个数据库只执行一次。若把数据写进 migration，
--   已有数据的用户库会在升级时被强制灌入食材，这是不可接受的副作用。
--   食材数据放在 seed 脚本里，可重跑、可跳过、与结构解耦。
--
-- 两张表：
--   seed_history          —— seed 执行记录（仅用于统计/诊断，不作为跳过整个 seed 的唯一依据）
--   seed_ingredient_map   —— 每个 (seed_name, seed_key) 的幂等单元
--
-- ⚠️⚠️ 关键设计：seed_ingredient_map.definition_id 使用 ON DELETE SET NULL，
--       绝不能使用 CASCADE。
--
--   使用 CASCADE 的后果：
--     用户删除内置食材 → map 行被级联删除 → seed_key 记录消失
--     → 下次 seed 认为"从未 seed 过" → **复活用户已删除的食材**
--
--   使用 SET NULL 的正确行为：
--     用户删除内置食材 → definition 删除 → map 保留，definition_id = NULL
--     → 下次 seed 发现 seed_key 已存在 → 跳过 → **永久尊重用户的删除**

CREATE TABLE `seed_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seed_name` text NOT NULL,
	`version` text NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seed_history_seed_name_unique` ON `seed_history` (`seed_name`);--> statement-breakpoint

CREATE TABLE `seed_ingredient_map` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`seed_name` text NOT NULL,
	`seed_key` text NOT NULL,
	`definition_id` integer,
	`status` text NOT NULL,
	`seeded_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "seed_map_status_in_enum" CHECK("seed_ingredient_map"."status" in ('created', 'conflict'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `seed_ingredient_map_name_key_unique` ON `seed_ingredient_map` (`seed_name`,`seed_key`);--> statement-breakpoint
CREATE INDEX `seed_ingredient_map_definition_id_idx` ON `seed_ingredient_map` (`definition_id`);
