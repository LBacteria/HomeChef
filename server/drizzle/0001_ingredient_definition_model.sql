-- HomeChef 重构：食材定义 + 多库存记录模型
--
-- 从 v0.1 的「单一库存记录 + 直接名称」升级为
-- 「稳定食材定义 ID + 默认名称/别名 + 多库存记录」。
--
-- 迁移策略（SQLite 标准做法）：
--   1. 新建 ingredient_definition（食材库）
--   2. 新建 ingredient_definition_unit（允许单位）
--   3. 从 standard_ingredient 搬迁名称 → ingredient_definition（**沿用原 id**）
--   4. 重建 ingredient_alias，外键改指 ingredient_definition
--   5. 重建 standard_ingredient，移除 name/name_normalized，新增 definition_id 等
--
-- 关键：第 3 步沿用原 id，因此别名外键值无需重新映射。
-- drizzle-kit 会把这个文件包在一个事务里执行（见 migrate.ts）。

/* ============================================================
 * 1. ingredient_definition —— 食材定义（食材库）
 * ============================================================ */

CREATE TABLE `ingredient_definition` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_normalized` text NOT NULL,
	`estimated_shelf_life_days` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "shelf_life_non_negative" CHECK("ingredient_definition"."estimated_shelf_life_days" is null or "ingredient_definition"."estimated_shelf_life_days" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_definition_name_normalized_unique` ON `ingredient_definition` (`name_normalized`);--> statement-breakpoint

/* ============================================================
 * 2. ingredient_definition_unit —— 允许单位
 * ============================================================ */

CREATE TABLE `ingredient_definition_unit` (
	`id` integer PRIMARY KEY NOT NULL,
	`definition_id` integer NOT NULL,
	`unit` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "definition_unit_in_enum" CHECK("ingredient_definition_unit"."unit" in ('个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_definition_unit_unique` ON `ingredient_definition_unit` (`definition_id`,`unit`);--> statement-breakpoint
CREATE INDEX `ingredient_definition_unit_definition_id_idx` ON `ingredient_definition_unit` (`definition_id`);--> statement-breakpoint

/* ============================================================
 * 3. 数据搬迁：standard_ingredient 的名称 → ingredient_definition
 *    ⚠️ 显式插入 id，沿用原 standard_ingredient.id
 *       这样别名外键值无需重新映射
 * ============================================================ */

INSERT INTO `ingredient_definition` (`id`, `name`, `name_normalized`, `estimated_shelf_life_days`, `created_at`, `updated_at`)
SELECT `id`, `name`, `name_normalized`, NULL, `created_at`, `updated_at` FROM `standard_ingredient`;--> statement-breakpoint

/* ============================================================
 * 4. 重建 ingredient_alias：外键改指 ingredient_definition
 * ============================================================ */

CREATE TABLE `ingredient_alias_new` (
	`id` integer PRIMARY KEY NOT NULL,
	`definition_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_normalized` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint

-- 搬迁别名：旧 ingredient_id 的值 = 旧的 standard_ingredient.id
-- 而第 3 步已让 definition.id = standard_ingredient.id，所以值可直接沿用
INSERT INTO `ingredient_alias_new` (`id`, `definition_id`, `alias`, `alias_normalized`, `created_at`)
SELECT `id`, `ingredient_id`, `alias`, `alias_normalized`, `created_at` FROM `ingredient_alias`;--> statement-breakpoint

DROP TABLE `ingredient_alias`;--> statement-breakpoint
ALTER TABLE `ingredient_alias_new` RENAME TO `ingredient_alias`;--> statement-breakpoint
CREATE UNIQUE INDEX `ingredient_alias_alias_normalized_unique` ON `ingredient_alias` (`alias_normalized`);--> statement-breakpoint
CREATE INDEX `ingredient_alias_definition_id_idx` ON `ingredient_alias` (`definition_id`);--> statement-breakpoint

/* ============================================================
 * 5. 重建 standard_ingredient：库存记录
 *    - 移除 name / name_normalized（已搬到 definition）
 *    - 新增 definition_id（1:N，**无 UNIQUE**）
 *    - 新增 production_date / expiry_date_source / storage_method
 *    - purchase_date 改为 NOT NULL（用 created_at 日期回填）
 * ============================================================ */

CREATE TABLE `standard_ingredient_new` (
	`id` integer PRIMARY KEY NOT NULL,
	`definition_id` integer NOT NULL,
	`quantity` real DEFAULT 0 NOT NULL,
	`unit` text NOT NULL,
	`purchase_date` text NOT NULL,
	`production_date` text,
	`expiry_date` text,
	`expiry_date_source` text,
	`storage_method` text DEFAULT '常温' NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "quantity_non_negative" CHECK("standard_ingredient_new"."quantity" >= 0),
	CONSTRAINT "inventory_unit_in_enum" CHECK("standard_ingredient_new"."unit" in ('个', '克', '千克', '毫升', '升', '包', '袋', '瓶', '盒', '罐')),
	CONSTRAINT "storage_method_in_enum" CHECK("standard_ingredient_new"."storage_method" in ('常温', '冷藏', '冷冻')),
	CONSTRAINT "expiry_source_pairing" CHECK(case
        when "standard_ingredient_new"."expiry_date" is null
          then case when "standard_ingredient_new"."expiry_date_source" is null then 1 else 0 end
        else case
          when "standard_ingredient_new"."expiry_date_source" is null then 0
          when "standard_ingredient_new"."expiry_date_source" in ('estimated', 'manual') then 1
          else 0
        end
      end),
	CONSTRAINT "production_not_after_purchase" CHECK("standard_ingredient_new"."production_date" is null or "standard_ingredient_new"."production_date" <= "standard_ingredient_new"."purchase_date"),
	CONSTRAINT "manual_expiry_not_before_purchase" CHECK(case
        when "standard_ingredient_new"."expiry_date" is null then 1
        when "standard_ingredient_new"."expiry_date_source" = 'estimated' then 1
        when "standard_ingredient_new"."expiry_date" >= "standard_ingredient_new"."purchase_date" then 1
        else 0
      end)
);
--> statement-breakpoint

-- 搬迁库存记录：
--   definition_id = 原 id（因为 definition 沿用了原 id）
--   purchase_date 为 NULL 时用 created_at 的日期部分回填（入库日期的最近似值）
--   expiry_date 有值 → source = 'manual'（v0.1 的日期都是用户填的，不是系统估算的）
--   storage_method 默认 '常温'
INSERT INTO `standard_ingredient_new`
  (`id`, `definition_id`, `quantity`, `unit`, `purchase_date`, `production_date`, `expiry_date`, `expiry_date_source`, `storage_method`, `note`, `created_at`, `updated_at`)
SELECT
  `id`,
  `id`,
  `quantity`,
  `unit`,
  COALESCE(`purchase_date`, substr(`created_at`, 1, 10)),
  NULL,
  `expiry_date`,
  CASE WHEN `expiry_date` IS NULL THEN NULL ELSE 'manual' END,
  '常温',
  `note`,
  `created_at`,
  `updated_at`
FROM `standard_ingredient`;--> statement-breakpoint

DROP TABLE `standard_ingredient`;--> statement-breakpoint
ALTER TABLE `standard_ingredient_new` RENAME TO `standard_ingredient`;--> statement-breakpoint
CREATE INDEX `standard_ingredient_definition_id_idx` ON `standard_ingredient` (`definition_id`);
