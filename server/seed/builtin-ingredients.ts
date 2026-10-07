/**
 * HomeChef v0.1.1 —— 内置常见家庭食材数据
 *
 * 设计要点：
 *   - 这些食材在数据库中就是**普通的 ingredient_definition**，
 *     没有任何 is_system / is_builtin 标记，用户可自由修改或删除。
 *   - `key` 是 seed 自己的稳定身份，**永不用中文名**。
 *     用户改名、改别名、改保质期、改单位都不会影响 key。
 *   - `category` 目前**只存在于本文件**，不入库。
 *     未来分类系统上线后，可用它回填 category_id。
 *   - `units` 只能使用现有 10 个枚举，且顺序即 UI 下拉顺序（第一个最常用）。
 *   - `shelfLife` 是**保守的默认估算值**，不是食品安全保证。
 *     当前 storage_method 不参与保质期计算，因此这里只给单一基础值。
 */

/** seed 名称（写入 seed_history 与 seed_ingredient_map） */
export const BUILTIN_SEED_NAME = 'builtin_ingredients'

/** seed 版本 */
export const BUILTIN_SEED_VERSION = '1.0.0'

export interface BuiltinIngredient {
  /** 稳定键，永久不变，例如 'vegetable.tomato' */
  key: string
  /** 默认名称 */
  name: string
  /** 真实常用别名（不硬凑） */
  aliases: string[]
  /** 允许单位（现有 10 个枚举的子集，第一个最常用） */
  units: string[]
  /** 默认预估保质期（天）；null = 不估算 */
  shelfLife: number | null
  /** 分类，目前仅作为 metadata，不入库 */
  category: string
}

/* ============================================================
 * 保质期参考值（保守，偏短）—— 便于核对一致性
 * ============================================================ */

const D = {
  leafy: 3, // 叶菜
  veg: 7, // 一般蔬菜
  root: 30, // 根茎类
  garlic: 60, // 蒜姜
  meat: 3, // 猪牛羊鲜肉
  poultry: 2, // 禽肉
  seafood: 2, // 水产
  egg: 30, // 蛋
  milk: 7, // 牛奶
  yogurt: 14, // 酸奶
  tofu: 3, // 豆制品
  grain: 180, // 米面
  sauce: 365, // 调味品
  frozen: 180, // 冷冻食品
  dry: 180, // 干货
} as const

/* ============================================================
 * 内置食材
 * ============================================================ */

export const BUILTIN_INGREDIENTS: BuiltinIngredient[] = [
  /* ---------------- 蔬菜（45） ---------------- */
  { key: 'vegetable.tomato', name: '番茄', aliases: ['西红柿'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.potato', name: '土豆', aliases: ['马铃薯', '洋芋'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.carrot', name: '胡萝卜', aliases: ['红萝卜'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.daikon', name: '白萝卜', aliases: ['萝卜'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.onion', name: '洋葱', aliases: ['圆葱'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.garlic', name: '大蒜', aliases: ['蒜', '蒜头'], units: ['个', '克', '千克'], shelfLife: D.garlic, category: '蔬菜' },
  { key: 'vegetable.ginger', name: '姜', aliases: ['生姜'], units: ['克', '千克', '个'], shelfLife: D.garlic, category: '蔬菜' },
  { key: 'vegetable.scallion', name: '小葱', aliases: ['葱', '香葱'], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.cilantro', name: '香菜', aliases: ['芫荽'], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.napa', name: '大白菜', aliases: ['白菜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.bokchoy', name: '小白菜', aliases: ['青菜'], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.spinach', name: '菠菜', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.lettuce', name: '生菜', aliases: ['叶生菜'], units: ['个', '克', '千克'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.cabbage', name: '圆白菜', aliases: ['卷心菜', '包菜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.broccoli', name: '西兰花', aliases: ['绿花菜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.cauliflower', name: '菜花', aliases: ['花菜', '白花菜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.cucumber', name: '黄瓜', aliases: ['青瓜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.eggplant', name: '茄子', aliases: [], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.zucchini', name: '西葫芦', aliases: ['角瓜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.greenpepper', name: '青椒', aliases: ['柿子椒'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.redpepper', name: '红椒', aliases: ['甜椒'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.hotpepper', name: '辣椒', aliases: ['尖椒'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.celery', name: '芹菜', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.leek', name: '韭菜', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.beansprout', name: '豆芽', aliases: ['黄豆芽'], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.greenbean', name: '四季豆', aliases: ['豆角'], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.longbean', name: '豇豆', aliases: ['长豆角'], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.pea', name: '豌豆', aliases: ['青豆'], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.corn', name: '玉米', aliases: ['甜玉米'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.pumpkin', name: '南瓜', aliases: [], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.wintermelon', name: '冬瓜', aliases: [], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.luffa', name: '丝瓜', aliases: [], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.bittermelon', name: '苦瓜', aliases: ['凉瓜'], units: ['个', '克', '千克'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.lotusroot', name: '莲藕', aliases: ['藕'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.taro', name: '芋头', aliases: ['芋艿'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.sweetpotato', name: '红薯', aliases: ['地瓜', '番薯'], units: ['个', '克', '千克'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.yam', name: '山药', aliases: ['淮山'], units: ['克', '千克', '个'], shelfLife: D.root, category: '蔬菜' },
  { key: 'vegetable.bambooshoot', name: '竹笋', aliases: ['春笋'], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.asparagus', name: '芦笋', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.leafy, category: '蔬菜' },
  { key: 'vegetable.mushroom', name: '香菇', aliases: ['鲜香菇'], units: ['克', '千克', '盒'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.enokimushroom', name: '金针菇', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.oystermushroom', name: '平菇', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.shiitake', name: '口蘑', aliases: ['白蘑菇'], units: ['克', '千克', '盒'], shelfLife: D.veg, category: '蔬菜' },
  { key: 'vegetable.woodear', name: '木耳', aliases: ['黑木耳'], units: ['克', '千克', '袋'], shelfLife: D.dry, category: '蔬菜' },
  { key: 'vegetable.bean', name: '毛豆', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.veg, category: '蔬菜' },

  /* ---------------- 水果（25） ---------------- */
  { key: 'fruit.apple', name: '苹果', aliases: [], units: ['个', '克', '千克'], shelfLife: 30, category: '水果' },
  { key: 'fruit.banana', name: '香蕉', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.orange', name: '橙子', aliases: ['甜橙'], units: ['个', '克', '千克'], shelfLife: 30, category: '水果' },
  { key: 'fruit.mandarin', name: '橘子', aliases: ['桔子', '蜜桔'], units: ['个', '克', '千克'], shelfLife: 14, category: '水果' },
  { key: 'fruit.lemon', name: '柠檬', aliases: [], units: ['个', '克', '千克'], shelfLife: 30, category: '水果' },
  { key: 'fruit.grape', name: '葡萄', aliases: ['提子'], units: ['克', '千克', '盒'], shelfLife: 7, category: '水果' },
  { key: 'fruit.strawberry', name: '草莓', aliases: [], units: ['克', '千克', '盒'], shelfLife: 3, category: '水果' },
  { key: 'fruit.blueberry', name: '蓝莓', aliases: [], units: ['克', '盒'], shelfLife: 7, category: '水果' },
  { key: 'fruit.watermelon', name: '西瓜', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.melon', name: '哈密瓜', aliases: ['甜瓜'], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.pear', name: '梨', aliases: ['雪梨'], units: ['个', '克', '千克'], shelfLife: 14, category: '水果' },
  { key: 'fruit.peach', name: '桃', aliases: ['桃子'], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.plum', name: '李子', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.apricot', name: '杏', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.cherry', name: '樱桃', aliases: ['车厘子'], units: ['克', '千克', '盒'], shelfLife: 7, category: '水果' },
  { key: 'fruit.mango', name: '芒果', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.pineapple', name: '菠萝', aliases: ['凤梨'], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.papaya', name: '木瓜', aliases: [], units: ['个', '克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.kiwi', name: '猕猴桃', aliases: ['奇异果'], units: ['个', '克', '千克'], shelfLife: 14, category: '水果' },
  { key: 'fruit.dragonfruit', name: '火龙果', aliases: [], units: ['个', '克', '千克'], shelfLife: 14, category: '水果' },
  { key: 'fruit.persimmon', name: '柿子', aliases: [], units: ['个', '克', '千克'], shelfLife: 14, category: '水果' },
  { key: 'fruit.pomegranate', name: '石榴', aliases: [], units: ['个', '克', '千克'], shelfLife: 30, category: '水果' },
  { key: 'fruit.jujube', name: '鲜枣', aliases: ['冬枣'], units: ['克', '千克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.avocado', name: '牛油果', aliases: ['鳄梨'], units: ['个', '克'], shelfLife: 7, category: '水果' },
  { key: 'fruit.coconut', name: '椰子', aliases: [], units: ['个', '克'], shelfLife: 14, category: '水果' },

  /* ---------------- 畜肉（22） ---------------- */
  { key: 'pork.tenderloin', name: '猪里脊', aliases: ['里脊肉'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.belly', name: '五花肉', aliases: ['三层肉'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.rib', name: '猪肋排', aliases: ['排骨', '肋排'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.leg', name: '猪腿肉', aliases: ['后腿肉'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.mince', name: '猪肉馅', aliases: ['肉末', '猪肉末'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.trotter', name: '猪蹄', aliases: ['猪脚'], units: ['个', '克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.liver', name: '猪肝', aliases: [], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.kidney', name: '猪腰', aliases: ['猪肾'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'pork.hock', name: '肘子', aliases: ['猪肘'], units: ['克', '千克'], shelfLife: D.meat, category: '猪肉' },
  { key: 'beef.brisket', name: '牛腩', aliases: [], units: ['克', '千克'], shelfLife: D.meat, category: '牛肉' },
  { key: 'beef.tenderloin', name: '牛里脊', aliases: ['牛柳'], units: ['克', '千克'], shelfLife: D.meat, category: '牛肉' },
  { key: 'beef.steak', name: '牛排', aliases: [], units: ['克', '千克', '包'], shelfLife: D.meat, category: '牛肉' },
  { key: 'beef.shank', name: '牛腱子', aliases: ['牛腱'], units: ['克', '千克'], shelfLife: D.meat, category: '牛肉' },
  { key: 'beef.mince', name: '牛肉馅', aliases: ['牛肉末'], units: ['克', '千克'], shelfLife: D.meat, category: '牛肉' },
  { key: 'beef.roll', name: '肥牛卷', aliases: ['肥牛'], units: ['克', '千克', '盒'], shelfLife: D.frozen, category: '牛肉' },
  { key: 'lamb.chop', name: '羊排', aliases: [], units: ['克', '千克'], shelfLife: D.meat, category: '羊肉' },
  { key: 'lamb.leg', name: '羊腿肉', aliases: [], units: ['克', '千克'], shelfLife: D.meat, category: '羊肉' },
  { key: 'lamb.roll', name: '羊肉卷', aliases: ['羊肉片'], units: ['克', '千克', '盒'], shelfLife: D.frozen, category: '羊肉' },
  { key: 'lamb.rib', name: '羊蝎子', aliases: [], units: ['克', '千克'], shelfLife: D.meat, category: '羊肉' },
  { key: 'pork.sausage', name: '香肠', aliases: ['腊肠'], units: ['克', '千克', '袋', '包'], shelfLife: D.dry, category: '猪肉' },
  { key: 'pork.bacon', name: '培根', aliases: [], units: ['克', '袋', '包'], shelfLife: 30, category: '猪肉' },
  { key: 'pork.ham', name: '火腿', aliases: ['火腿肠'], units: ['克', '袋', '包'], shelfLife: 90, category: '猪肉' },

  /* ---------------- 禽肉（12） ---------------- */
  { key: 'poultry.chicken_breast', name: '鸡胸肉', aliases: ['鸡胸'], units: ['克', '千克', '个'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_leg', name: '鸡腿', aliases: ['鸡腿肉'], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_wing', name: '鸡翅', aliases: ['鸡翅膀'], units: ['个', '克', '千克', '袋'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_whole', name: '整鸡', aliases: ['三黄鸡'], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_thigh', name: '鸡大腿', aliases: ['琵琶腿'], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_feet', name: '鸡爪', aliases: ['凤爪'], units: ['个', '克', '千克'], shelfLife: D.frozen, category: '鸡肉' },
  { key: 'poultry.chicken_liver', name: '鸡肝', aliases: [], units: ['克', '千克'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.chicken_gizzard', name: '鸡胗', aliases: [], units: ['克', '千克'], shelfLife: D.poultry, category: '鸡肉' },
  { key: 'poultry.duck_leg', name: '鸭腿', aliases: [], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '鸭肉' },
  { key: 'poultry.duck_breast', name: '鸭胸肉', aliases: ['鸭胸'], units: ['克', '千克'], shelfLife: D.poultry, category: '鸭肉' },
  { key: 'poultry.duck_whole', name: '整鸭', aliases: [], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '鸭肉' },
  { key: 'poultry.turkey', name: '火鸡腿', aliases: [], units: ['个', '克', '千克'], shelfLife: D.poultry, category: '其他禽肉' },

  /* ---------------- 水产（18） ---------------- */
  { key: 'seafood.grass_carp', name: '草鱼', aliases: [], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.bass', name: '鲈鱼', aliases: [], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.crucian', name: '鲫鱼', aliases: [], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.salmon', name: '三文鱼', aliases: ['鲑鱼'], units: ['克', '千克', '盒'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.cod', name: '鳕鱼', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.frozen, category: '水产' },
  { key: 'seafood.hairtail', name: '带鱼', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.frozen, category: '水产' },
  { key: 'seafood.yellow_croaker', name: '黄花鱼', aliases: ['黄鱼'], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.shrimp', name: '虾', aliases: ['鲜虾'], units: ['克', '千克', '袋'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.white_shrimp', name: '基围虾', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.shrimp_meat', name: '虾仁', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.frozen, category: '水产' },
  { key: 'seafood.crab', name: '螃蟹', aliases: ['大闸蟹'], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.squid', name: '鱿鱼', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.octopus', name: '章鱼', aliases: ['八爪鱼'], units: ['克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.clam', name: '蛤蜊', aliases: ['花蛤'], units: ['克', '千克', '袋'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.oyster', name: '生蚝', aliases: ['牡蛎'], units: ['个', '克', '千克'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.mussel', name: '青口', aliases: ['淡菜'], units: ['克', '千克', '袋'], shelfLife: D.seafood, category: '水产' },
  { key: 'seafood.scallop', name: '扇贝', aliases: [], units: ['个', '克', '千克'], shelfLife: D.frozen, category: '水产' },
  { key: 'seafood.seaweed_roll', name: '鱼丸', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.frozen, category: '冷冻食品' },

  /* ---------------- 蛋类（6） ---------------- */
  { key: 'egg.chicken_egg', name: '鸡蛋', aliases: ['蛋'], units: ['个', '盒', '袋'], shelfLife: D.egg, category: '蛋类' },
  { key: 'egg.duck_egg', name: '鸭蛋', aliases: [], units: ['个', '盒'], shelfLife: D.egg, category: '蛋类' },
  { key: 'egg.quail_egg', name: '鹌鹑蛋', aliases: [], units: ['个', '盒', '袋'], shelfLife: D.egg, category: '蛋类' },
  { key: 'egg.salted_duck_egg', name: '咸鸭蛋', aliases: [], units: ['个', '盒'], shelfLife: 90, category: '蛋类' },
  { key: 'egg.century_egg', name: '皮蛋', aliases: ['松花蛋'], units: ['个', '盒'], shelfLife: 90, category: '蛋类' },
  { key: 'egg.egg_white', name: '蛋清', aliases: ['蛋白液'], units: ['毫升', '克', '盒'], shelfLife: 7, category: '蛋类' },

  /* ---------------- 豆制品（10） ---------------- */
  { key: 'soy.tofu', name: '豆腐', aliases: ['老豆腐'], units: ['个', '克', '盒'], shelfLife: D.tofu, category: '豆制品' },
  { key: 'soy.silken_tofu', name: '嫩豆腐', aliases: ['内酯豆腐'], units: ['盒', '克'], shelfLife: D.tofu, category: '豆制品' },
  { key: 'soy.dried_tofu', name: '豆干', aliases: ['香干'], units: ['克', '袋', '盒'], shelfLife: 7, category: '豆制品' },
  { key: 'soy.tofu_skin', name: '腐竹', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '豆制品' },
  { key: 'soy.tofu_sheet', name: '千张', aliases: ['豆腐皮'], units: ['克', '袋'], shelfLife: 7, category: '豆制品' },
  { key: 'soy.soy_milk', name: '豆浆', aliases: [], units: ['毫升', '升', '瓶', '袋'], shelfLife: 3, category: '豆制品' },
  { key: 'soy.yuba', name: '油豆腐', aliases: ['豆泡'], units: ['克', '袋'], shelfLife: 7, category: '豆制品' },
  { key: 'soy.fermented_tofu', name: '腐乳', aliases: ['豆腐乳'], units: ['瓶', '罐', '盒'], shelfLife: D.sauce, category: '调味品' },
  { key: 'soy.soybean', name: '黄豆', aliases: ['大豆'], units: ['克', '千克', '袋'], shelfLife: D.dry, category: '豆制品' },
  { key: 'soy.red_bean', name: '红豆', aliases: ['赤豆'], units: ['克', '千克', '袋'], shelfLife: D.dry, category: '豆制品' },

  /* ---------------- 乳制品（10） ---------------- */
  { key: 'dairy.milk', name: '牛奶', aliases: ['鲜奶'], units: ['毫升', '升', '瓶', '盒'], shelfLife: D.milk, category: '乳制品' },
  { key: 'dairy.yogurt', name: '酸奶', aliases: [], units: ['毫升', '盒', '瓶', '罐'], shelfLife: D.yogurt, category: '乳制品' },
  { key: 'dairy.butter', name: '黄油', aliases: ['奶油'], units: ['克', '盒'], shelfLife: 90, category: '乳制品' },
  { key: 'dairy.cream', name: '淡奶油', aliases: ['动物奶油'], units: ['毫升', '盒'], shelfLife: 14, category: '乳制品' },
  { key: 'dairy.cheese', name: '奶酪', aliases: ['芝士'], units: ['克', '盒', '袋'], shelfLife: 30, category: '乳制品' },
  { key: 'dairy.cheese_slice', name: '芝士片', aliases: [], units: ['盒', '包', '克'], shelfLife: 30, category: '乳制品' },
  { key: 'dairy.condensed_milk', name: '炼乳', aliases: [], units: ['罐', '瓶', '克'], shelfLife: D.sauce, category: '乳制品' },
  { key: 'dairy.milk_powder', name: '奶粉', aliases: [], units: ['克', '罐', '袋'], shelfLife: 365, category: '乳制品' },
  { key: 'dairy.ice_cream', name: '冰淇淋', aliases: ['雪糕'], units: ['盒', '个', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'dairy.sour_cream', name: '酸奶油', aliases: [], units: ['盒', '克'], shelfLife: 14, category: '乳制品' },

  /* ---------------- 主食/谷物（15） ---------------- */
  { key: 'grain.rice', name: '大米', aliases: ['米'], units: ['千克', '克', '袋', '包'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.glutinous_rice', name: '糯米', aliases: [], units: ['千克', '克', '袋'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.millet', name: '小米', aliases: [], units: ['千克', '克', '袋'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.flour', name: '面粉', aliases: ['小麦粉'], units: ['千克', '克', '袋'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.sticky_rice_flour', name: '糯米粉', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.noodle', name: '面条', aliases: ['挂面'], units: ['克', '千克', '袋', '包'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.instant_noodle', name: '方便面', aliases: ['泡面'], units: ['包', '袋', '个'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.vermicelli', name: '粉丝', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '主食/谷物' },
  { key: 'grain.rice_noodle', name: '米粉', aliases: ['米线'], units: ['克', '袋', '包'], shelfLife: D.dry, category: '主食/谷物' },
  { key: 'grain.steamed_bun', name: '馒头', aliases: [], units: ['个', '袋', '克'], shelfLife: 3, category: '主食/谷物' },
  { key: 'grain.bread', name: '面包', aliases: ['吐司'], units: ['个', '袋', '克'], shelfLife: 7, category: '主食/谷物' },
  { key: 'grain.oat', name: '燕麦', aliases: ['燕麦片'], units: ['克', '千克', '袋', '盒'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.corn_flour', name: '玉米面', aliases: [], units: ['克', '千克', '袋'], shelfLife: D.grain, category: '主食/谷物' },
  { key: 'grain.dumpling_wrapper', name: '饺子皮', aliases: ['馄饨皮'], units: ['包', '袋', '克'], shelfLife: 7, category: '主食/谷物' },
  { key: 'grain.wonton', name: '馄饨', aliases: ['云吞'], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },

  /* ---------------- 调味品（30） ---------------- */
  { key: 'condiment.salt', name: '盐', aliases: ['食盐'], units: ['袋', '包', '克', '千克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.sugar', name: '白糖', aliases: ['砂糖'], units: ['袋', '包', '克', '千克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.brown_sugar', name: '红糖', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.rock_sugar', name: '冰糖', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.soy_sauce', name: '生抽', aliases: ['酱油'], units: ['瓶', '毫升', '升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.dark_soy_sauce', name: '老抽', aliases: [], units: ['瓶', '毫升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.vinegar', name: '醋', aliases: ['陈醋', '香醋'], units: ['瓶', '毫升', '升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.rice_vinegar', name: '米醋', aliases: [], units: ['瓶', '毫升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.cooking_wine', name: '料酒', aliases: ['黄酒'], units: ['瓶', '毫升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.oyster_sauce', name: '蚝油', aliases: [], units: ['瓶', '毫升', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.sesame_oil', name: '香油', aliases: ['芝麻油'], units: ['瓶', '毫升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.doubanjiang', name: '豆瓣酱', aliases: ['郫县豆瓣'], units: ['袋', '瓶', '罐', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.sweet_bean_sauce', name: '甜面酱', aliases: [], units: ['袋', '瓶', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.soybean_paste', name: '黄豆酱', aliases: ['大酱'], units: ['袋', '瓶', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.ketchup', name: '番茄酱', aliases: ['番茄沙司'], units: ['瓶', '袋', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.chili_sauce', name: '辣椒酱', aliases: ['辣酱'], units: ['瓶', '罐', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.chili_oil', name: '辣椒油', aliases: ['红油'], units: ['瓶', '毫升'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.sesame_paste', name: '芝麻酱', aliases: ['麻酱'], units: ['瓶', '罐', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.peanut_butter', name: '花生酱', aliases: [], units: ['瓶', '罐', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.honey', name: '蜂蜜', aliases: [], units: ['瓶', '罐', '克'], shelfLife: 730, category: '调味品' },
  { key: 'condiment.sichuan_pepper', name: '花椒', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.star_anise', name: '八角', aliases: ['大料'], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.cinnamon', name: '桂皮', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.bay_leaf', name: '香叶', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.curry_powder', name: '咖喱', aliases: ['咖喱块'], units: ['盒', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.pepper_powder', name: '胡椒粉', aliases: ['黑胡椒'], units: ['瓶', '袋', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.five_spice', name: '五香粉', aliases: [], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.chicken_bouillon', name: '鸡精', aliases: ['味精'], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.starch', name: '淀粉', aliases: ['生粉'], units: ['袋', '包', '克', '千克'], shelfLife: D.sauce, category: '调味品' },
  { key: 'condiment.yeast', name: '酵母', aliases: ['酵母粉'], units: ['袋', '包', '克'], shelfLife: D.sauce, category: '调味品' },

  /* ---------------- 食用油（6） ---------------- */
  { key: 'oil.peanut', name: '花生油', aliases: [], units: ['升', '毫升', '瓶'], shelfLife: D.sauce, category: '调味品' },
  { key: 'oil.rapeseed', name: '菜籽油', aliases: ['菜油'], units: ['升', '毫升', '瓶'], shelfLife: D.sauce, category: '调味品' },
  { key: 'oil.soybean', name: '大豆油', aliases: ['豆油'], units: ['升', '毫升', '瓶'], shelfLife: D.sauce, category: '调味品' },
  { key: 'oil.corn', name: '玉米油', aliases: [], units: ['升', '毫升', '瓶'], shelfLife: D.sauce, category: '调味品' },
  { key: 'oil.olive', name: '橄榄油', aliases: [], units: ['升', '毫升', '瓶'], shelfLife: D.sauce, category: '调味品' },
  { key: 'oil.lard', name: '猪油', aliases: [], units: ['克', '罐', '盒'], shelfLife: 180, category: '调味品' },

  /* ---------------- 干货/菌菇（12） ---------------- */
  { key: 'dry.shiitake', name: '干香菇', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.wood_ear', name: '干木耳', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.white_fungus', name: '银耳', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.red_date', name: '红枣', aliases: ['大枣'], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.goji', name: '枸杞', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.seaweed', name: '紫菜', aliases: [], units: ['袋', '包', '克'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.kelp', name: '海带', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.dried_shrimp', name: '虾皮', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.lily_flower', name: '黄花菜', aliases: ['金针菜'], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.bamboo_shoot', name: '笋干', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.lotus_seed', name: '莲子', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },
  { key: 'dry.bean_thread', name: '干豆角', aliases: [], units: ['克', '袋', '包'], shelfLife: D.dry, category: '干货/菌菇' },

  /* ---------------- 冷冻食品（8） ---------------- */
  { key: 'frozen.dumpling', name: '冷冻饺子', aliases: ['速冻饺子'], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.tangyuan', name: '汤圆', aliases: ['元宵'], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.chicken_wing', name: '冷冻鸡翅', aliases: [], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.french_fries', name: '薯条', aliases: [], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.nugget', name: '鸡块', aliases: ['鸡米花'], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.steamed_bun', name: '冷冻包子', aliases: [], units: ['袋', '包', '个'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.beef_ball', name: '牛肉丸', aliases: [], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },
  { key: 'frozen.hash_brown', name: '薯饼', aliases: [], units: ['袋', '包', '克'], shelfLife: D.frozen, category: '冷冻食品' },

  /* ---------------- 其他/饮品（10） ---------------- */
  { key: 'other.tea', name: '茶叶', aliases: ['绿茶'], units: ['克', '盒', '罐', '袋'], shelfLife: 365, category: '其他/饮品' },
  { key: 'other.coffee', name: '咖啡', aliases: ['咖啡粉'], units: ['克', '盒', '罐', '袋'], shelfLife: 365, category: '其他/饮品' },
  { key: 'other.cola', name: '可乐', aliases: [], units: ['瓶', '罐', '毫升', '升'], shelfLife: 180, category: '其他/饮品' },
  { key: 'other.sprite', name: '雪碧', aliases: [], units: ['瓶', '罐', '毫升', '升'], shelfLife: 180, category: '其他/饮品' },
  { key: 'other.juice', name: '果汁', aliases: [], units: ['瓶', '盒', '毫升', '升'], shelfLife: 30, category: '其他/饮品' },
  { key: 'other.beer', name: '啤酒', aliases: [], units: ['瓶', '罐', '毫升'], shelfLife: 180, category: '其他/饮品' },
  { key: 'other.rock_sugar_syrup', name: '糖浆', aliases: [], units: ['瓶', '毫升', '克'], shelfLife: 365, category: '其他/饮品' },
  { key: 'other.cocoa', name: '可可粉', aliases: [], units: ['克', '袋', '盒'], shelfLife: 365, category: '其他/饮品' },
  { key: 'other.gelatin', name: '吉利丁片', aliases: ['明胶片'], units: ['克', '盒', '袋'], shelfLife: 365, category: '其他/饮品' },
  { key: 'other.baking_powder', name: '泡打粉', aliases: ['发酵粉'], units: ['袋', '包', '克'], shelfLife: 365, category: '其他/饮品' },
]

/** 各分类数量（便于核对） */
export function countByCategory(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const item of BUILTIN_INGREDIENTS) {
    result[item.category] = (result[item.category] ?? 0) + 1
  }
  return result
}
