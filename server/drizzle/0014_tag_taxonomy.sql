-- HomeChef v0.2.4：标签体系调整（**纯数据迁移，不改表结构**）
--
-- 目标
-- ────
--   ① 移除「用餐场景」四类系统预设：早餐 / 午餐 / 晚餐 / 夜宵
--      —— 只认 `is_system = 1` 且 code 恰好为
--      `scene.breakfast` / `scene.lunch` / `scene.dinner` / `scene.supper` 的四条，
--      **绝不**按 `LIKE 'scene.%'` 批量删（避免误删未来或用户自建的标签）。
--   ② 用户自建的 `meal_scene` 标签**不删除**，改为「未分类」（category = NULL），
--      由用户自行归类；它们与菜谱的关联原样保留。
--   ③ 新增「菜系风格」预设（cuisine）与扩充的口味 / 烹饪方式 / 菜品特点预设。
--      `INSERT OR IGNORE`：同名（name_normalized UNIQUE）或同 code 已存在时
--      **保留既有行**，不会把用户自建的同名标签偷偷改成系统标签。
--   ④ 清理 `app_settings.recipe_selected_tags`：只保留仍然存在的标签名；
--      非法 JSON 保守视为 `[]`；与标签变更在**同一个迁移事务**内完成。
--
-- 兼容说明
-- ────────
--   - `recipe_tag.category` 本来就没有数据库 CHECK（见 0012 注释），
--     所以换分类 code 只动数据，**不重建表**。
--   - 菜谱本身、配料、历史、库存、备份**一律不动**。
--   - 0012 不修改；本迁移不提供回滚（未验证的回滚比没有更危险）。
--
-- ⚠️⚠️ 严禁 `PRAGMA` / `BEGIN` / `COMMIT`：Drizzle 迁移器把全部待应用迁移
--   包在同一个事务里。

-- ① 先删关联（只针对四类明确的系统时段标签）
DELETE FROM `recipe_tag_link`
WHERE `tag_id` IN (
  SELECT `id` FROM `recipe_tag`
  WHERE `is_system` = 1
    AND `code` IN ('scene.breakfast', 'scene.lunch', 'scene.dinner', 'scene.supper')
);
--> statement-breakpoint
-- ② 再删这四条系统标签本身
DELETE FROM `recipe_tag`
WHERE `is_system` = 1
  AND `code` IN ('scene.breakfast', 'scene.lunch', 'scene.dinner', 'scene.supper');
--> statement-breakpoint
-- ③ 自定义 meal_scene 标签：只改分类，不删除、不断关联
UPDATE `recipe_tag`
SET `category` = NULL
WHERE `category` = 'meal_scene';
--> statement-breakpoint
-- ④ 新预设（同名/同 code 已存在 → 保留既有行）
INSERT OR IGNORE INTO `recipe_tag`
  (`name`, `name_normalized`, `category`, `code`, `is_system`, `sort_order`, `created_at`)
VALUES
  ('主食',       '主食',       'dish_type',      'dish_type.staple',          1, 10,  datetime('now')),
  ('荤菜',       '荤菜',       'dish_type',      'dish_type.meat',            1, 20,  datetime('now')),
  ('素菜',       '素菜',       'dish_type',      'dish_type.vegetable',       1, 30,  datetime('now')),
  ('半荤半素',   '半荤半素',   'dish_type',      'dish_type.mixed',           1, 40,  datetime('now')),
  ('汤',         '汤',         'dish_type',      'dish_type.soup',            1, 50,  datetime('now')),
  ('凉菜',       '凉菜',       'dish_type',      'dish_type.cold',            1, 60,  datetime('now')),
  ('甜点',       '甜点',       'dish_type',      'dish_type.dessert',         1, 70,  datetime('now')),

  ('辣',         '辣',         'flavor',         'flavor.spicy',              1, 10,  datetime('now')),
  ('麻辣',       '麻辣',       'flavor',         'flavor.numbing_spicy',      1, 20,  datetime('now')),
  ('酸甜',       '酸甜',       'flavor',         'flavor.sweet_sour',         1, 30,  datetime('now')),
  ('清淡',       '清淡',       'flavor',         'flavor.light',              1, 40,  datetime('now')),
  ('咸鲜',       '咸鲜',       'flavor',         'flavor.savory',             1, 50,  datetime('now')),
  ('蒜香',       '蒜香',       'flavor',         'flavor.garlic',             1, 60,  datetime('now')),
  ('五香',       '五香',       'flavor',         'flavor.five_spice',         1, 70,  datetime('now')),
  ('香辣',       '香辣',       'flavor',         'flavor.fragrant_spicy',     1, 80,  datetime('now')),
  ('酱香',       '酱香',       'flavor',         'flavor.soy_aroma',          1, 90,  datetime('now')),

  ('炒',         '炒',         'cooking_method', 'method.stir_fry',           1, 10,  datetime('now')),
  ('煎',         '煎',         'cooking_method', 'method.pan_fry',            1, 20,  datetime('now')),
  ('蒸',         '蒸',         'cooking_method', 'method.steam',              1, 30,  datetime('now')),
  ('炖',         '炖',         'cooking_method', 'method.stew',               1, 40,  datetime('now')),
  ('烤',         '烤',         'cooking_method', 'method.roast',              1, 50,  datetime('now')),
  ('煮',         '煮',         'cooking_method', 'method.boil',               1, 60,  datetime('now')),
  ('炸',         '炸',         'cooking_method', 'method.deep_fry',           1, 70,  datetime('now')),
  ('凉拌',       '凉拌',       'cooking_method', 'method.cold_dress',         1, 80,  datetime('now')),
  ('焖',         '焖',         'cooking_method', 'method.braise',             1, 90,  datetime('now')),
  ('煲',         '煲',         'cooking_method', 'method.simmer',             1, 100, datetime('now')),
  ('卤',         '卤',         'cooking_method', 'method.marinate_stew',      1, 110, datetime('now')),

  ('家常中式',   '家常中式',   'cuisine',        'cuisine.homestyle',         1, 10,  datetime('now')),
  ('川菜',       '川菜',       'cuisine',        'cuisine.sichuan',           1, 20,  datetime('now')),
  ('粤菜',       '粤菜',       'cuisine',        'cuisine.cantonese',         1, 30,  datetime('now')),
  ('湘菜',       '湘菜',       'cuisine',        'cuisine.hunan',             1, 40,  datetime('now')),
  ('鲁菜',       '鲁菜',       'cuisine',        'cuisine.shandong',          1, 50,  datetime('now')),
  ('江浙菜',     '江浙菜',     'cuisine',        'cuisine.jiangzhe',          1, 60,  datetime('now')),
  ('闽菜',       '闽菜',       'cuisine',        'cuisine.fujian',            1, 70,  datetime('now')),
  ('东北菜',     '东北菜',     'cuisine',        'cuisine.northeast',         1, 80,  datetime('now')),
  ('西北菜',     '西北菜',     'cuisine',        'cuisine.northwest',         1, 90,  datetime('now')),
  ('意式',       '意式',       'cuisine',        'cuisine.italian',           1, 110, datetime('now')),
  ('美式',       '美式',       'cuisine',        'cuisine.american',          1, 120, datetime('now')),
  ('法式',       '法式',       'cuisine',        'cuisine.french',            1, 130, datetime('now')),
  ('地中海',     '地中海',     'cuisine',        'cuisine.mediterranean',     1, 140, datetime('now')),
  ('西式家常',   '西式家常',   'cuisine',        'cuisine.western_home',      1, 150, datetime('now')),

  ('快手菜',     '快手菜',     'feature',        'feature.quick',             1, 10,  datetime('now')),
  ('低脂',       '低脂',       'feature',        'feature.low_fat',           1, 20,  datetime('now')),
  ('高蛋白',     '高蛋白',     'feature',        'feature.high_protein',      1, 30,  datetime('now')),
  ('高纤维',     '高纤维',     'feature',        'feature.high_fiber',        1, 40,  datetime('now')),
  ('下饭',       '下饭',       'feature',        'feature.rice_friendly',     1, 50,  datetime('now')),
  ('一锅出',     '一锅出',     'feature',        'feature.one_pot',           1, 60,  datetime('now')),
  ('便当',       '便当',       'feature',        'feature.bento',             1, 70,  datetime('now')),
  ('家常',       '家常',       'feature',        'feature.homely',            1, 80,  datetime('now')),
  ('酥脆',       '酥脆',       'feature',        'feature.crispy',            1, 90,  datetime('now'));
--> statement-breakpoint
-- ⑤ 清理筛选设置：只保留仍然存在的标签名；非法 JSON → []；同一事务内完成
UPDATE `app_settings`
SET `recipe_selected_tags` = (
  SELECT COALESCE(json_group_array(value), '[]')
  FROM json_each(
    CASE
      WHEN json_valid(`app_settings`.`recipe_selected_tags`) THEN `app_settings`.`recipe_selected_tags`
      ELSE '[]'
    END
  )
  WHERE value IN (SELECT `name` FROM `recipe_tag`)
)
WHERE `recipe_selected_tags` IS NOT NULL;
