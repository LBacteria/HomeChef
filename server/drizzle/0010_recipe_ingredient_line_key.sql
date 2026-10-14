-- HomeChef v0.2.1：菜谱食材行的稳定标识（B2 阶段一）
--
-- 目标：
--   给 `recipe_ingredient` 增加 `line_key` —— 一条菜谱食材需求的**稳定身份**。
--
-- 背景（为什么需要它）
-- ──────────────────
-- `saveRecipeFull` 对食材关联采用「**全删后重建**」策略
-- （见 src/services/recipeService.ts），因此 `recipe_ingredient.id`
-- 在每次保存后都会变化，**不能**作为跳过确认的长期标识。
-- `line_key` 由应用层在保存时按规则沿用，是唯一能跨重建存活的标识。
--
-- ⚠️⚠️ 严禁出现 `PRAGMA` / `BEGIN` / `COMMIT`：
--    Drizzle 迁移器把**全部待应用迁移**包在同一个事务里，
--    出现上述语句会提前结束事务，破坏「失败整体回滚」的保证。
--
-- ⚠️ 不修改任何旧 migration。

/* ============================================================
 * 步骤 1 —— 追加可空列
 *
 * ⚠️ SQLite 的 ADD COLUMN **不能携带 UNIQUE 约束**，
 *    因此唯一性必须靠下面的「步骤 2 回填 + 步骤 3 建唯一索引」实现。
 * ============================================================ */

ALTER TABLE `recipe_ingredient` ADD COLUMN `line_key` text;
--> statement-breakpoint

/* ============================================================
 * 步骤 2 —— 回填全部历史行
 *
 * `randomblob(16)` 是 SQLite 核心内建函数，返回 16 字节随机二进制；
 * `hex()` 转为 32 位十六进制字符串。
 *
 * ⚠️ 必须是**单条 UPDATE 覆盖全部行**：
 *    SQLite 对 UPDATE 的每一行**独立求值**右侧表达式，
 *    因此天然保证行间取值不同（128 位随机，碰撞概率可忽略），
 *    不需要循环、不需要逐行脚本。
 *
 * ⚠️ `WHERE line_key IS NULL` 使本语句**幂等**：
 *    重复执行不会覆盖已赋值的行。
 *
 * ⚠️ 执行后必须不存在 line_key IS NULL 的行，
 *    否则步骤 3 的唯一索引会「静默成功」——
 *    SQLite 的 UNIQUE 索引**允许多个 NULL**，会把问题推迟到运行时。
 * ============================================================ */

UPDATE `recipe_ingredient` SET `line_key` = lower(hex(randomblob(16))) WHERE `line_key` IS NULL;
--> statement-breakpoint

/* ============================================================
 * 步骤 3 —— 建立唯一索引
 *
 * ⚠️ 必须在回填**之后**执行。
 * ⚠️ `IF NOT EXISTS` 只保证本语句自身幂等，
 *    并不能让整个迁移幂等 —— 真正的回滚由迁移器的事务保证。
 * ============================================================ */

CREATE UNIQUE INDEX IF NOT EXISTS `recipe_ingredient_line_key_unique` ON `recipe_ingredient` (`line_key`);
