-- HomeChef v0.2.1：烹饪闭环（B2 阶段一）
--
-- 目标：
--   1. 新增 6 张表，支撑「烹饪会话 → 多道菜 → 步骤进度 → 跳过确认 → 结算」。
--   2. 给 `recipe` 增加 `content_revision`（菜谱内容版本号）。
--
-- ⚠️ 本 migration **只新增**：
--    - 不重建任何已有表
--    - 不修改任何已有列（recipe 只追加 1 列）
--    - 不触碰任何现有数据
--
-- ⚠️⚠️ 严禁出现 `PRAGMA` / `BEGIN` / `COMMIT`：
--    Drizzle 迁移器把**全部待应用迁移**包在同一个事务里
--    （见 drizzle-orm/sqlite-core/dialect.js 的 SQLiteSyncDialect.migrate），
--    一旦出现上述语句会提前结束事务，破坏「失败整体回滚」的保证。
--
-- ⚠️ 所有 CHECK 约束必须**显式返回 0/1**，绝不用 `in (...)` 的 NULL 传播：
--    SQLite 的 CHECK 只在结果为 FALSE(0) 时拒绝，结果为 NULL 时**放行**。
--    详见 src/db/schema.ts 中 standard_ingredient 的 expiry_source_pairing 教训。
--
-- ⚠️ 不修改任何旧 migration。

/* ============================================================
 * 1. recipe_step —— 菜谱步骤
 *
 *    一条记录 = 一道菜谱的一个有序步骤。
 *    step_no 从 1 开始，UNIQUE(recipe_id, step_no) 保证不重号。
 * ============================================================ */

CREATE TABLE `recipe_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`step_no` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "recipe_step_no_positive" CHECK("recipe_step"."step_no" >= 1),
	CONSTRAINT "recipe_step_content_not_blank" CHECK(length(trim("recipe_step"."content")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_step_recipe_id_step_no_unique` ON `recipe_step` (`recipe_id`,`step_no`);--> statement-breakpoint
CREATE INDEX `recipe_step_recipe_id_idx` ON `recipe_step` (`recipe_id`);--> statement-breakpoint

/* ============================================================
 * 2. cooking_session —— 烹饪会话
 *
 *    status 流转：
 *      active → cooking → awaiting_settlement → settled   【终态】
 *      active/cooking/awaiting_settlement → abandoned     【终态】
 *
 *    ⚠️ recipe_revision：会话内菜品所依据的菜谱内容版本。
 *       菜谱内容变化时（在 saveRecipeFull 的同一事务内）递增，
 *       使该会话已保存的跳过确认整体失效。
 * ============================================================ */

CREATE TABLE `cooking_session` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`recipe_revision` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`settled_at` text,
	`abandoned_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "cooking_session_status_in_enum" CHECK(case
        when "cooking_session"."status" in ('active', 'cooking', 'awaiting_settlement', 'settled', 'abandoned') then 1
        else 0
      end)
);
--> statement-breakpoint
CREATE INDEX `cooking_session_status_idx` ON `cooking_session` (`status`);--> statement-breakpoint

/* ============================================================
 * 3. cooking_session_dish —— 会话中的菜品行
 *
 *    ⚠️ UNIQUE(session_id, recipe_id)：同一会话重复添加同一菜谱 → 合并份数。
 *    ⚠️ recipe_id 用 ON DELETE RESTRICT：被烹饪会话引用的菜谱不能直接删除
 *       （与 recipe_ingredient 的既有做法一致，Service 层返回 409）。
 *
 *    confirmed_revision 语义（★ 派生值，不是「是否写过确认」）：
 *      0                        = 该菜品的必需跳过项**尚未确认齐全**
 *      = session.recipe_revision = **已齐全且版本一致**
 *    必需跳过项 = NULL 用量 或 单位不匹配 的原始需求行。
 * ============================================================ */

CREATE TABLE `cooking_session_dish` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`recipe_id` integer NOT NULL,
	`servings` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`current_step_no` integer,
	`confirmed_revision` integer DEFAULT 0 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cooking_session`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipe`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "cooking_dish_servings_positive" CHECK("cooking_session_dish"."servings" > 0),
	CONSTRAINT "cooking_dish_status_in_enum" CHECK(case
        when "cooking_session_dish"."status" in ('pending', 'done') then 1
        else 0
      end),
	CONSTRAINT "cooking_dish_current_step_positive" CHECK("cooking_session_dish"."current_step_no" is null or "cooking_session_dish"."current_step_no" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cooking_session_dish_session_recipe_unique` ON `cooking_session_dish` (`session_id`,`recipe_id`);--> statement-breakpoint
CREATE INDEX `cooking_session_dish_session_id_idx` ON `cooking_session_dish` (`session_id`);--> statement-breakpoint

/* ============================================================
 * 4. cooking_settlement —— 结算凭证（★ 幂等核心）
 *
 *    ⚠️⚠️ UNIQUE(session_id) 是「防止重复结算」的**数据库级最终防线**：
 *        结算事务第一步就是 INSERT 本表，唯一冲突即表示已结算，
 *        不依赖应用层「先查后插」，并发下也只有一者能成功。
 * ============================================================ */

CREATE TABLE `cooking_settlement` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`settled_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cooking_session`(`id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cooking_settlement_session_id_unique` ON `cooking_settlement` (`session_id`);--> statement-breakpoint

/* ============================================================
 * 5. cooking_settlement_item —— 结算明细（含跳过项）
 *
 *    一条记录 = 一条原始需求的最终处理结果。
 *    outcome 区分：
 *      consumed              —— 已扣减
 *      skipped_null_quantity —— 因 NULL 用量（适量）被用户确认跳过
 *      skipped_unit_mismatch —— 因单位与库存不匹配被用户确认跳过
 *      skipped_user          —— 用户主动选择跳过（可扣但不想扣）
 *      insufficient          —— 仅用于预览判定，**失败结算不写入本表**
 *
 *    ⚠️ 正式凭证只记录成功结算的最终结果；insufficient 不落库。
 *    ⚠️ dish_id 用 RESTRICT：结算明细引用的菜品行不得被删除。
 *    ⚠️ line_key 冗余保存，便于审计对齐到原始需求行。
 * ============================================================ */

CREATE TABLE `cooking_settlement_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`settlement_id` integer NOT NULL,
	`dish_id` integer NOT NULL,
	`line_key` text,
	`definition_id` integer NOT NULL,
	`unit` text,
	`required_quantity` real,
	`consumed_quantity` real DEFAULT 0 NOT NULL,
	`outcome` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`settlement_id`) REFERENCES `cooking_settlement`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`dish_id`) REFERENCES `cooking_session_dish`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "settlement_item_outcome_in_enum" CHECK(case
        when "cooking_settlement_item"."outcome" in ('consumed', 'skipped_null_quantity', 'skipped_unit_mismatch', 'skipped_user', 'insufficient') then 1
        else 0
      end),
	CONSTRAINT "settlement_item_consumed_non_negative" CHECK("cooking_settlement_item"."consumed_quantity" >= 0)
);
--> statement-breakpoint
CREATE INDEX `cooking_settlement_item_settlement_id_idx` ON `cooking_settlement_item` (`settlement_id`);--> statement-breakpoint
CREATE INDEX `cooking_settlement_item_definition_id_idx` ON `cooking_settlement_item` (`definition_id`);--> statement-breakpoint

/* ============================================================
 * 6. cooking_session_dish_skip —— 跳过确认（逐项持久化）
 *
 *    ⚠️⚠️ UNIQUE(dish_id, line_key)：每个确认精确对应**一条原始需求行**，
 *        因此「同一菜谱中同食材同单位的多条需求」也不会确认错项。
 *        （不能改用 (dish_id, definition_id, unit)，
 *          那无法区分同食材同单位的多条需求行。）
 *
 *    ⚠️ line_key 指向 recipe_ingredient.line_key，
 *       但因为 line_key 不是主键/唯一键的 FK 目标之外的一般列，
 *       这里**不建外键**，由应用层保证一致性 ——
 *       否则菜谱全删重建时会引发意外的级联行为。
 *
 *    reason：
 *      null_quantity  —— 该需求行用量为 NULL（必须确认跳过）
 *      unit_mismatch  —— 该需求行单位与库存不匹配（必须确认跳过）
 *      user_choice    —— 用户对**可扣项**的额外跳过（不参与完整性判定）
 * ============================================================ */

CREATE TABLE `cooking_session_dish_skip` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`dish_id` integer NOT NULL,
	`line_key` text NOT NULL,
	`definition_id` integer NOT NULL,
	`unit_key` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`confirmed_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `cooking_session`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`dish_id`) REFERENCES `cooking_session_dish`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`definition_id`) REFERENCES `ingredient_definition`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "dish_skip_reason_in_enum" CHECK(case
        when "cooking_session_dish_skip"."reason" in ('null_quantity', 'unit_mismatch', 'user_choice') then 1
        else 0
      end)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cooking_session_dish_skip_dish_line_unique` ON `cooking_session_dish_skip` (`dish_id`,`line_key`);--> statement-breakpoint
CREATE INDEX `cooking_session_dish_skip_session_id_idx` ON `cooking_session_dish_skip` (`session_id`);--> statement-breakpoint

/* ============================================================
 * 7. recipe.content_revision —— 菜谱内容版本号（追加列）
 *
 *    ⚠️ 使用 ALTER TABLE ADD COLUMN —— SQLite 的**原地**操作：
 *       - 不重建表
 *       - 不动任何现有列
 *       - 不触碰任何现有数据行（只追加列）
 *       - 已有行自动获得 DEFAULT 0，**无需回填**
 *
 *    语义：菜谱名称 / 备注 / 食材 / 步骤的任何**实际内容变化**时 +1。
 *          内容完全相同的重复保存**不递增**。
 * ============================================================ */

ALTER TABLE `recipe` ADD COLUMN `content_revision` integer DEFAULT 0 NOT NULL;
