-- HomeChef v0.1.2：应用设置
--
-- 单行设置表：整个应用只有一行（id = 1）。
--
-- 为什么用单行而不是 key-value：
--   - 本批次只有 3 个设置，字段类型明确（enum / number / boolean）
--   - key-value 会把类型信息丢进字符串，需要额外解析与校验
--   - 单行表的 CHECK 约束能直接表达业务规则（模式枚举、阈值范围、单位一致性）
--
-- SQLite 没有原生 BOOLEAN：用 INTEGER 0/1 存储，CHECK 限制取值。
--
-- ⚠️ 本迁移**只建表，不插入数据**。
--    首次读取时若表为空，Service 返回代码中的默认值，
--    不依赖"迁移插入初始行"（避免已有数据库升级时被强行写值）。

CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`expiry_warning_mode` text NOT NULL,
	`expiry_warning_threshold` real NOT NULL,
	`allow_expired_for_recipe` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK("app_settings"."id" = 1),
	CONSTRAINT "expiry_warning_mode_in_enum" CHECK("app_settings"."expiry_warning_mode" in ('days', 'percentage')),
	CONSTRAINT "expiry_warning_threshold_non_negative" CHECK("app_settings"."expiry_warning_threshold" >= 0),
	CONSTRAINT "expiry_warning_threshold_percentage_range" CHECK(case
        when "app_settings"."expiry_warning_mode" = 'percentage'
          then case when "app_settings"."expiry_warning_threshold" <= 100 then 1 else 0 end
        else 1
      end),
	CONSTRAINT "allow_expired_for_recipe_boolean" CHECK("app_settings"."allow_expired_for_recipe" in (0, 1))
);
