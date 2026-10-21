/**
 * v0.2.3 食谱 Tag —— **五大固定分类**与系统预设。
 *
 * 设计原则：
 *   1. **固定五类**：菜品类型 / 口味 / 烹饪方式 / 菜系风格 / 菜品特点。
 *      ⚠️ v0.2.4：原「用餐场景」（`meal_scene`，早餐/午餐/晚餐/夜宵）已移除，
 *      改为「菜系风格」（`cuisine`）—— 用户反馈「麻婆豆腐贴晚餐很怪」。
 *      分类本身不可由用户新增（不做任意维度管理），只维护分类下的 Tag。
 *   2. **稳定 code**：分类用英文 code 落库，界面用中文别名字典渲染；
 *      系统预设 Tag 另有 `code`（如 `dish_type.staple`），
 *      **结构语义一律按 code 判定**，用户重命名预设 Tag 不会让搭配逻辑悄悄失效。
 *   3. **名称全局归一唯一**：沿用 v0.2.0 的 `name_normalized` UNIQUE，
 *      跨分类也不允许同名（最简单、最稳定，不引入分类内唯一的分叉规则）。
 *   4. **旧标签不丢**：v0.2.2 及更早创建的 Tag 没有分类，
 *      `category IS NULL` 即「未分类」，界面单列一组，可编辑归类，**不做任何回填覆盖**。
 */

/** 五大分类 code（落库值、API 值、筛选值统一使用它） */
export const RECIPE_TAG_CATEGORIES = [
  'dish_type',
  'flavor',
  'cooking_method',
  'cuisine',
  'feature',
] as const

export type RecipeTagCategory = (typeof RECIPE_TAG_CATEGORIES)[number]

/** 分类中文别名（后端唯一字典） */
export const RECIPE_TAG_CATEGORY_LABELS: Record<RecipeTagCategory, string> = {
  dish_type: '菜品类型',
  flavor: '口味',
  cooking_method: '烹饪方式',
  cuisine: '菜系风格',
  feature: '菜品特点',
}

/**
 * 「未分类」在 API 里**不是**一个分类 code，而是一个展示分组：
 *   - 落库值：`category = NULL`
 *   - 展示分组键：`unclassified`
 *
 * ⚠️ 它**不参与**分类写入校验（不能通过 POST/PATCH 把 Tag 显式设为未分类以外的含义；
 *    清空分类请传 `category: null`）。
 */
export const RECIPE_TAG_UNCLASSIFIED = 'unclassified'

/** 判断是否为合法分类 code */
export function isRecipeTagCategory(value: unknown): value is RecipeTagCategory {
  return typeof value === 'string' && (RECIPE_TAG_CATEGORIES as readonly string[]).includes(value)
}

/**
 * 分类字典（**后端唯一来源**，供 `GET /api/tag-categories` 与前端展示）。
 *
 * ⚠️ 前端**不得**另写一份中文分类字典：分类是固定的五类，
 *    顺序与文案都必须由后端给出，避免两边漂移。
 * ⚠️ 「未分类」不是一个分类 code（落库为 NULL），但它同样需要展示标题，
 *    因此由后端一并下发，前端不要写死中文。
 */
export function listRecipeTagCategories(): {
  categories: Array<{ code: RecipeTagCategory; label: string }>
  unclassified: { code: typeof RECIPE_TAG_UNCLASSIFIED; label: string }
} {
  return {
    categories: RECIPE_TAG_CATEGORIES.map((code) => ({
      code,
      label: RECIPE_TAG_CATEGORY_LABELS[code],
    })),
    unclassified: { code: RECIPE_TAG_UNCLASSIFIED, label: RECIPE_TAG_UNCLASSIFIED_LABEL },
  }
}

/** 「未分类」分组的展示标题（后端字典，前端不要写死） */
export const RECIPE_TAG_UNCLASSIFIED_LABEL = '未分类'

/* ============================================================
 * 结构语义（菜品类型 / 菜品特点）
 * ============================================================ */

/** 菜品类型在「一餐结构」里的角色 */
export const DISH_ROLES = [
  'staple',
  'meat',
  'vegetable',
  'mixed',
  'soup',
  'cold',
  'dessert',
] as const
export type DishRole = (typeof DISH_ROLES)[number]

/** 角色中文别名（仅用于理由文案） */
export const DISH_ROLE_LABELS: Record<DishRole, string> = {
  staple: '主食',
  meat: '荤菜',
  vegetable: '素菜',
  mixed: '半荤半素',
  soup: '汤',
  cold: '凉菜',
  dessert: '甜点',
}

/** 预设 code → 结构角色（首选，重命名不影响） */
export const DISH_ROLE_BY_CODE: Readonly<Record<string, DishRole>> = {
  'dish_type.staple': 'staple',
  'dish_type.meat': 'meat',
  'dish_type.vegetable': 'vegetable',
  'dish_type.mixed': 'mixed',
  'dish_type.soup': 'soup',
  'dish_type.cold': 'cold',
  'dish_type.dessert': 'dessert',
}

/**
 * 名称 → 结构角色（**兼容回退**）。
 *
 * ⚠️ 仅当 Tag 没有 code（用户自建、或预设被删后重建的同名 Tag）时启用。
 *    这是「明确配置」的兜底，不是主要路径；主要路径始终是 `DISH_ROLE_BY_CODE`。
 */
export const DISH_ROLE_BY_NAME: Readonly<Record<string, DishRole>> = {
  主食: 'staple',
  荤菜: 'meat',
  素菜: 'vegetable',
  半荤半素: 'mixed',
  汤: 'soup',
  凉菜: 'cold',
  甜点: 'dessert',
}

/**
 * 解析一个 Tag 的结构角色；解析不出返回 null（标签不完整时正常降级）。
 *
 * 判定顺序（**不可颠倒**）：
 *   1. **先要求 `category === 'dish_type'`** —— 分类是用户可见的归属，
 *      一旦它不再是「菜品类型」（改成别的分类或清空成未分类），
 *      界面就已经不把它当菜品类型，算法必须**同步停止**按类型加分，
 *      否则会出现「看不见的隐形类型」。
 *   2. 分类仍是 `dish_type` 时，优先按**稳定 `code`** 判定
 *      → 用户**重命名**预设 Tag 不会影响结果（这正是 code 存在的意义）。
 *   3. 分类仍是 `dish_type` 但没有 code（用户自建）→ 按名称回退（明确配置的兜底）。
 *
 * ⚠️ 与「无 tag_refs 的旧调用」的区别：`rolesOfDish` 在完全没有 `tag_refs`
 *    时仍会按名称直接回退（那是纯函数单测/兼容路径，没有分类信息可用），
 *    与本函数的「分类优先」规则不冲突。
 */
export function resolveDishRole(tag: {
  code?: string | null
  name: string
  category?: string | null
}): DishRole | null {
  // ① 分类必须先落在 dish_type，否则一律不解析（迁类 = 明确放弃类型语义）
  if (tag.category !== 'dish_type') return null

  // ② 稳定 code 优先（重命名不影响）
  if (typeof tag.code === 'string' && tag.code.length > 0) {
    const byCode = DISH_ROLE_BY_CODE[tag.code]
    if (byCode !== undefined) return byCode
  }

  // ③ 无 code 时按名称回退
  const byName = DISH_ROLE_BY_NAME[tag.name.trim()]
  return byName ?? null
}

/* ============================================================
 * 系统预设 Tag
 * ============================================================ */

export interface PresetTag {
  name: string
  category: RecipeTagCategory
  /** 稳定身份 code（重命名后仍可判定结构语义） */
  code: string
  /** 预设展示顺序（同分类内升序） */
  sort_order: number
}

/**
 * 系统预设 Tag 清单。
 *
 * ⚠️ 预设与自定义 Tag **同等可增改删**：本清单只在迁移时播种一次
 *    （`INSERT OR IGNORE`，绝不覆盖用户已有同名 Tag），
 *    之后用户改名 / 改分类 / 删除都不会被回滚。
 */
export const PRESET_RECIPE_TAGS: readonly PresetTag[] = [
  /* ---- 菜品类型 ---- */
  { name: '主食', category: 'dish_type', code: 'dish_type.staple', sort_order: 10 },
  { name: '荤菜', category: 'dish_type', code: 'dish_type.meat', sort_order: 20 },
  { name: '素菜', category: 'dish_type', code: 'dish_type.vegetable', sort_order: 30 },
  { name: '半荤半素', category: 'dish_type', code: 'dish_type.mixed', sort_order: 40 },
  { name: '汤', category: 'dish_type', code: 'dish_type.soup', sort_order: 50 },
  { name: '凉菜', category: 'dish_type', code: 'dish_type.cold', sort_order: 60 },
  { name: '甜点', category: 'dish_type', code: 'dish_type.dessert', sort_order: 70 },

  /* ---- 口味 ---- */
  { name: '辣', category: 'flavor', code: 'flavor.spicy', sort_order: 10 },
  { name: '麻辣', category: 'flavor', code: 'flavor.numbing_spicy', sort_order: 20 },
  { name: '酸甜', category: 'flavor', code: 'flavor.sweet_sour', sort_order: 30 },
  { name: '清淡', category: 'flavor', code: 'flavor.light', sort_order: 40 },
  { name: '咸鲜', category: 'flavor', code: 'flavor.savory', sort_order: 50 },
  { name: '蒜香', category: 'flavor', code: 'flavor.garlic', sort_order: 60 },
  { name: '五香', category: 'flavor', code: 'flavor.five_spice', sort_order: 70 },
  { name: '香辣', category: 'flavor', code: 'flavor.fragrant_spicy', sort_order: 80 },
  { name: '酱香', category: 'flavor', code: 'flavor.soy_aroma', sort_order: 90 },

  /* ---- 烹饪方式 ---- */
  { name: '炒', category: 'cooking_method', code: 'method.stir_fry', sort_order: 10 },
  { name: '煎', category: 'cooking_method', code: 'method.pan_fry', sort_order: 20 },
  { name: '蒸', category: 'cooking_method', code: 'method.steam', sort_order: 30 },
  { name: '炖', category: 'cooking_method', code: 'method.stew', sort_order: 40 },
  { name: '烤', category: 'cooking_method', code: 'method.roast', sort_order: 50 },
  { name: '煮', category: 'cooking_method', code: 'method.boil', sort_order: 60 },
  { name: '炸', category: 'cooking_method', code: 'method.deep_fry', sort_order: 70 },
  { name: '凉拌', category: 'cooking_method', code: 'method.cold_dress', sort_order: 80 },
  { name: '焖', category: 'cooking_method', code: 'method.braise', sort_order: 90 },
  { name: '煲', category: 'cooking_method', code: 'method.simmer', sort_order: 100 },
  { name: '卤', category: 'cooking_method', code: 'method.marinate_stew', sort_order: 110 },

  /* ---- 菜系风格（v0.2.4 取代「用餐场景」） ---- */
  { name: '家常中式', category: 'cuisine', code: 'cuisine.homestyle', sort_order: 10 },
  { name: '川菜', category: 'cuisine', code: 'cuisine.sichuan', sort_order: 20 },
  { name: '粤菜', category: 'cuisine', code: 'cuisine.cantonese', sort_order: 30 },
  { name: '湘菜', category: 'cuisine', code: 'cuisine.hunan', sort_order: 40 },
  { name: '鲁菜', category: 'cuisine', code: 'cuisine.shandong', sort_order: 50 },
  { name: '江浙菜', category: 'cuisine', code: 'cuisine.jiangzhe', sort_order: 60 },
  { name: '闽菜', category: 'cuisine', code: 'cuisine.fujian', sort_order: 70 },
  { name: '东北菜', category: 'cuisine', code: 'cuisine.northeast', sort_order: 80 },
  { name: '西北菜', category: 'cuisine', code: 'cuisine.northwest', sort_order: 90 },
  { name: '意式', category: 'cuisine', code: 'cuisine.italian', sort_order: 110 },
  { name: '美式', category: 'cuisine', code: 'cuisine.american', sort_order: 120 },
  { name: '法式', category: 'cuisine', code: 'cuisine.french', sort_order: 130 },
  { name: '地中海', category: 'cuisine', code: 'cuisine.mediterranean', sort_order: 140 },
  { name: '西式家常', category: 'cuisine', code: 'cuisine.western_home', sort_order: 150 },

  /* ---- 菜品特点 ---- */
  { name: '快手菜', category: 'feature', code: 'feature.quick', sort_order: 10 },
  { name: '低脂', category: 'feature', code: 'feature.low_fat', sort_order: 20 },
  { name: '高蛋白', category: 'feature', code: 'feature.high_protein', sort_order: 30 },
  { name: '高纤维', category: 'feature', code: 'feature.high_fiber', sort_order: 40 },
  { name: '下饭', category: 'feature', code: 'feature.rice_friendly', sort_order: 50 },
  { name: '一锅出', category: 'feature', code: 'feature.one_pot', sort_order: 60 },
  { name: '便当', category: 'feature', code: 'feature.bento', sort_order: 70 },
  { name: '家常', category: 'feature', code: 'feature.homely', sort_order: 80 },
  { name: '酥脆', category: 'feature', code: 'feature.crispy', sort_order: 90 },
]
