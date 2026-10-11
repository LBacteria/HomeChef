-- HomeChef v0.2.0 Phase 3：菜谱列表设置（批次 3）
--
-- 目标：
--   在现有 `app_settings` 单行表上新增 4 个 **可空** 列，
--   用于持久化菜谱列表的排序与 Tag 筛选条件。
--
-- ⚠️ 复用 app_settings 而非新建独立表 ——
--    该表已是「应用级单行设置」的既定位置（CHECK id = 1），语义一致。
--
-- ⚠️ 使用 ALTER TABLE ADD COLUMN —— SQLite 的**原地**操作：
--    - 不重建表
--    - 不动任何现有列
--    - 不触碰任何现有数据行（只追加列）
--    - 已有行自动获得 NULL
--
-- ⚠️ 全部为 **nullable**：NULL 表示"用户尚未设置过"，
--    Service 层会回退到默认值（最近修改倒序 + AND + 空 Tag 列表）。
--    这样既能兼容「app_settings 整行不存在」的旧库，
--    也能兼容「行存在但新列为 NULL」的升级场景。
--
-- ⚠️ 列值格式（由 Service 层负责校验，DB 不做 CHECK，保持宽松以兼容后续扩展）：
--    recipe_sort_field       TEXT  'updated_at' | 'created_at' | 'name'
--    recipe_sort_order       TEXT  'asc' | 'desc'
--    recipe_tag_mode         TEXT  'and' | 'or'
--    recipe_selected_tags    TEXT  JSON 数组字符串，如 '["家常菜","快手"]'
--
-- ⚠️ 不修改任何旧 migration。

ALTER TABLE `app_settings` ADD COLUMN `recipe_sort_field` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD COLUMN `recipe_sort_order` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD COLUMN `recipe_tag_mode` text;
--> statement-breakpoint
ALTER TABLE `app_settings` ADD COLUMN `recipe_selected_tags` text;
