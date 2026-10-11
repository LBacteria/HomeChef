-- HomeChef v0.2.0 Phase 3：菜谱模块（批次 1）
--
-- 目标：
--   新增 4 张表，支撑菜谱管理及其与食材定义、Tag 的关系。
--
--   recipe             —— 菜谱主表
--   recipe_ingredient  —— 菜谱与食材定义的关系
--   recipe_tag         —— Tag 表
--   recipe_tag_link    —— 菜谱与 Tag 的关系
--
-- ⚠️ 本 migration **只新增表**：
--    - 不重建任何已有表
--    - 不修改任何已有列
--    - 不触碰任何现有数据（ingredient_definition / standard_ingredient /
--      category / app_settings 等一律不动）
--
-- ⚠️⚠️ 关键设计：`recipe_ingredient` **故意没有**
--      UNIQUE(recipe_id, definition_id) 约束 ——
--      同一道菜谱**允许重复添加同一种食材**（每条独立保存数量/单位/备注/顺序）。
--
-- ⚠️ 单位枚举与现有系统完全一致（10 个），未新增「勺」等单位。
--
-- ⚠️ 不修改任何旧 migration。

/* ============================================================
 * 1. recipe —— 菜谱主表
 * ============================================================ */

CREATE TABLE `recipe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_name_normalized_unique` ON `recipe` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `recipe_name_normalized_idx` ON `recipe` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `recipe_updated_at_idx` ON `recipe` (`updated_at`);--> statement-breakpoint

/* ============================================================
 * 2. recipe_ingredient —— 菜谱与食材定义的关系
 *
 *    ⚠️ 无 UNIQUE(recipe_id, definition_id)：允许重复关联同一食材
 * ============================================================ */

CREATE TABLE `recipe_ingredient` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`definition_id` integer NOT NULL,
	`quantity` real,
	`unit` text,
	`note` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "recipe_ingredient_quantity_non_negative" CHECK("recipe_ingredient"."quantity" is null or "recipe_ingredient"."quantity" >= 0),
	CONSTRAINT "recipe_ingredient_unit_in_enum" CHECK(case
        when "recipe_ingredient"."unit" is null then 1
        when "recipe_ingredient"."unit" in ('个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐') then 1
        else 0
      end)
);
--> statement-breakpoint
CREATE INDEX `recipe_ingredient_recipe_id_idx` ON `recipe_ingredient` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_ingredient_definition_id_idx` ON `recipe_ingredient` (`definition_id`);--> statement-breakpoint

/* ============================================================
 * 3. recipe_tag —— Tag 表
 * ============================================================ */

CREATE TABLE `recipe_tag` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_tag_name_normalized_unique` ON `recipe_tag` (`name_normalized`);--> statement-breakpoint
CREATE INDEX `recipe_tag_name_normalized_idx` ON `recipe_tag` (`name_normalized`);--> statement-breakpoint

/* ============================================================
 * 4. recipe_tag_link —— 菜谱与 Tag 的关系
 * ============================================================ */

CREATE TABLE `recipe_tag_link` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `recipe_tag`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_tag_link_unique` ON `recipe_tag_link` (`recipe_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `recipe_tag_link_recipe_id_idx` ON `recipe_tag_link` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_tag_link_tag_id_idx` ON `recipe_tag_link` (`tag_id`);
