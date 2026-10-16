-- HomeChef v0.2.3：Tag 五大分类 + 单菜偏好（点赞 / 点踩）
--
-- 目标
-- ────
--   ① `recipe_tag` 增加分类与稳定身份：
--        `category`   五大固定分类 code，或 NULL（未分类）
--        `code`       系统预设的稳定身份（如 `dish_type.staple`），自定义为 NULL
--        `is_system`  1 = 迁移播种的系统预设，0 = 用户自建
--        `sort_order` 预设展示顺序（同分类内升序）
--   ② 新增 `recipe_preference`：单道菜谱的 like / dislike（**取消 = 删行**）。
--   ③ 播种系统预设 Tag（`INSERT OR IGNORE`，**绝不覆盖**用户已有同名 Tag）。
--
-- 语义与兼容
-- ──────────
--   - **旧标签不丢**：v0.2.2 及更早的 Tag 保持原 `id` / 原 `name` / 原关联，
--     `category` 落 NULL（界面显示为「未分类」），用户可自行归类。
--     本次迁移**不回填、不重命名、不删除**任何旧 Tag。
--   - 名称仍然**全局归一唯一**（`name_normalized` UNIQUE，跨分类也不允许同名）。
--   - `code` 只有系统预设才有；用户自建为 NULL。
--     SQLite 的 UNIQUE 允许多行 NULL，因此自定义 Tag 不受影响。
--   - 预设与自定义 Tag **同等可增改删**：本文件只在首次迁移时播种，
--     之后用户改名 / 改分类 / 删除都不会被回滚。
--   - `recipe_preference` 只记录**单道菜谱**的偏好，不支持整餐评价；
--     `value` 仅允许 `like` / `dislike`，取消偏好直接删除该行（不留 `none` 记录）。
--
-- ⚠️⚠️ 严禁出现 `PRAGMA` / `BEGIN` / `COMMIT`
--   Drizzle 迁移器把**全部待应用迁移**包在同一个事务里，
--   上述语句会提前结束事务，破坏「失败整体回滚」的保证。
--
-- ⚠️ 本迁移**不提供回滚指令**
-- ────────────────────────────
--   早先的草稿里写过一段 `ALTER TABLE ... DROP COLUMN` 的「回滚 SQL」，
--   但它在真实库上**从未验证过**，且顺序不安全（SQLite 会因
--   `recipe_tag_category_idx` / `recipe_tag_code_unique` 仍引用该列而报错，
--   或留下一半状态）。**未经验证的回滚步骤比没有更危险**，因此整段删除。
--   确实需要回退时，请单独设计并**在临时库上完整验证**后再执行。
--
-- ⚠️ `category` 不在数据库层做枚举 CHECK
-- ──────────────────────────────────────
--   本次采用 **Service 层校验**（`assertTagCategory`）：分类只有五类 code 或 NULL，
--   规则写在服务层便于与接口、前端字典共用同一份实现，避免两处漂移。
--   `is_system` / `sort_order` / `code` 的非空、默认值与唯一约束
--   与 drizzle schema **保持一致**（见 `src/db/schema.ts` 的 `recipeTag` 定义）。
--
-- ⚠️ 不修改任何旧 migration。

ALTER TABLE `recipe_tag` ADD COLUMN `category` text;
--> statement-breakpoint
ALTER TABLE `recipe_tag` ADD COLUMN `code` text;
--> statement-breakpoint
ALTER TABLE `recipe_tag` ADD COLUMN `is_system` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `recipe_tag` ADD COLUMN `sort_order` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX `recipe_tag_category_idx` ON `recipe_tag` (`category`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_tag_code_unique` ON `recipe_tag` (`code`);
--> statement-breakpoint
CREATE TABLE `recipe_preference` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`value` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `recipe_preference_value_in_enum` CHECK (`recipe_preference`.value in ('like','dislike')),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_preference_recipe_id_unique` ON `recipe_preference` (`recipe_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `recipe_tag` (`name`, `name_normalized`, `category`, `code`, `is_system`, `sort_order`, `created_at`) VALUES
	('主食', '主食', 'dish_type', 'dish_type.staple', 1, 10, '2026-10-16T00:00:00.000Z'),
	('荤菜', '荤菜', 'dish_type', 'dish_type.meat', 1, 20, '2026-10-16T00:00:00.000Z'),
	('素菜', '素菜', 'dish_type', 'dish_type.vegetable', 1, 30, '2026-10-16T00:00:00.000Z'),
	('半荤半素', '半荤半素', 'dish_type', 'dish_type.mixed', 1, 40, '2026-10-16T00:00:00.000Z'),
	('汤', '汤', 'dish_type', 'dish_type.soup', 1, 50, '2026-10-16T00:00:00.000Z'),
	('凉菜', '凉菜', 'dish_type', 'dish_type.cold', 1, 60, '2026-10-16T00:00:00.000Z'),
	('甜点', '甜点', 'dish_type', 'dish_type.dessert', 1, 70, '2026-10-16T00:00:00.000Z'),
	('辣', '辣', 'flavor', 'flavor.spicy', 1, 10, '2026-10-16T00:00:00.000Z'),
	('麻辣', '麻辣', 'flavor', 'flavor.numbing_spicy', 1, 20, '2026-10-16T00:00:00.000Z'),
	('酸甜', '酸甜', 'flavor', 'flavor.sweet_sour', 1, 30, '2026-10-16T00:00:00.000Z'),
	('清淡', '清淡', 'flavor', 'flavor.light', 1, 40, '2026-10-16T00:00:00.000Z'),
	('咸鲜', '咸鲜', 'flavor', 'flavor.savory', 1, 50, '2026-10-16T00:00:00.000Z'),
	('蒜香', '蒜香', 'flavor', 'flavor.garlic', 1, 60, '2026-10-16T00:00:00.000Z'),
	('五香', '五香', 'flavor', 'flavor.five_spice', 1, 70, '2026-10-16T00:00:00.000Z'),
	('炒', '炒', 'cooking_method', 'method.stir_fry', 1, 10, '2026-10-16T00:00:00.000Z'),
	('煎', '煎', 'cooking_method', 'method.pan_fry', 1, 20, '2026-10-16T00:00:00.000Z'),
	('蒸', '蒸', 'cooking_method', 'method.steam', 1, 30, '2026-10-16T00:00:00.000Z'),
	('炖', '炖', 'cooking_method', 'method.stew', 1, 40, '2026-10-16T00:00:00.000Z'),
	('烤', '烤', 'cooking_method', 'method.roast', 1, 50, '2026-10-16T00:00:00.000Z'),
	('煮', '煮', 'cooking_method', 'method.boil', 1, 60, '2026-10-16T00:00:00.000Z'),
	('炸', '炸', 'cooking_method', 'method.deep_fry', 1, 70, '2026-10-16T00:00:00.000Z'),
	('凉拌', '凉拌', 'cooking_method', 'method.cold_dress', 1, 80, '2026-10-16T00:00:00.000Z'),
	('焖', '焖', 'cooking_method', 'method.braise', 1, 90, '2026-10-16T00:00:00.000Z'),
	('煲', '煲', 'cooking_method', 'method.simmer', 1, 100, '2026-10-16T00:00:00.000Z'),
	('早餐', '早餐', 'meal_scene', 'scene.breakfast', 1, 10, '2026-10-16T00:00:00.000Z'),
	('午餐', '午餐', 'meal_scene', 'scene.lunch', 1, 20, '2026-10-16T00:00:00.000Z'),
	('晚餐', '晚餐', 'meal_scene', 'scene.dinner', 1, 30, '2026-10-16T00:00:00.000Z'),
	('夜宵', '夜宵', 'meal_scene', 'scene.supper', 1, 40, '2026-10-16T00:00:00.000Z'),
	('快手菜', '快手菜', 'feature', 'feature.quick', 1, 10, '2026-10-16T00:00:00.000Z'),
	('低脂', '低脂', 'feature', 'feature.low_fat', 1, 20, '2026-10-16T00:00:00.000Z'),
	('高蛋白', '高蛋白', 'feature', 'feature.high_protein', 1, 30, '2026-10-16T00:00:00.000Z'),
	('高纤维', '高纤维', 'feature', 'feature.high_fiber', 1, 40, '2026-10-16T00:00:00.000Z');
