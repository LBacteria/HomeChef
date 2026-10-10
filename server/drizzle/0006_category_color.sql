-- HomeChef v0.1.4：分类颜色
--
-- 目标：
--   为 category 表增加 color 字段，用于库存列表的分类颜色标签。
--
-- ⚠️ 使用 ALTER TABLE ADD COLUMN —— SQLite 的**原地**操作：
--    - 不重建表
--    - 不动任何现有列
--    - 不触碰任何现有数据行（只追加一列）
--    - 已有分类自动获得 DEFAULT 值
--
-- ⚠️ 颜色格式固定为 #RRGGBB（7 字符）。
--    默认值 '#9E9E9E' 是中性灰，作为未能命中默认色表时的兜底。
--    服务端会另行校验格式（见 categoryService.assertValidColor）。
--
-- ⚠️ 不修改任何旧 migration。

ALTER TABLE `category` ADD COLUMN `color` text NOT NULL DEFAULT '#9E9E9E';
