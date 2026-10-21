/**
 * v0.2.4 内容扩充包 —— **人工整理的食材目录**（测试内容，非权威来源）。
 *
 * 设计：
 *   - 只用真实存在的中式/西式家常食材，名称与菜市场叫法一致；
 *   - `units` 是新定义时登记的允许单位（既有定义以数据库为准，不覆盖）；
 *   - `gramsPerUnit` 仅用于把「1 个」换算成合理克数写进步骤说明，**不写入数据库**；
 *   - 不在此处声明保质期（默认保质期规则不改）。
 */

export type IngredientKind = 'protein' | 'vegetable' | 'staple' | 'dairy' | 'other'

export interface CatalogIngredient {
  name: string
  kind: IngredientKind
  /** 数据库已有分类名（迁移 0005 预置） */
  category: string
  /** 新定义时登记的允许单位；既有定义不会受影响 */
  units: string[]
  /** 一般单件重量（克）；没有则视为按克计量 */
  gramsPerUnit?: number
  aliases?: string[]
}

/** 蛋白质（肉/禽/水产/蛋/豆制品） */
export const PROTEINS: CatalogIngredient[] = [
  { name: '猪肉', kind: 'protein', category: '猪肉', units: ['克', '千克'] },
  { name: '五花肉', kind: 'protein', category: '猪肉', units: ['克', '千克'] },
  { name: '猪里脊', kind: 'protein', category: '猪肉', units: ['克', '千克'] },
  { name: '猪排骨', kind: 'protein', category: '猪肉', units: ['克', '千克'] },
  { name: '牛肉', kind: 'protein', category: '牛肉', units: ['克', '千克'] },
  { name: '牛腩', kind: 'protein', category: '牛肉', units: ['克', '千克'] },
  { name: '羊肉', kind: 'protein', category: '羊肉', units: ['克', '千克'] },
  { name: '鸡肉', kind: 'protein', category: '鸡肉', units: ['克', '千克'] },
  { name: '鸡腿', kind: 'protein', category: '鸡肉', units: ['克', '千克'] },
  { name: '鸡翅', kind: 'protein', category: '鸡肉', units: ['克', '千克'] },
  { name: '鸡蛋', kind: 'protein', category: '蛋类', units: ['个', '克'], gramsPerUnit: 50 },
  { name: '虾仁', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '草鱼', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '鲈鱼', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '带鱼', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '豆腐', kind: 'protein', category: '豆制品', units: ['克', '盒', '千克'], gramsPerUnit: 300 },
  { name: '豆干', kind: 'protein', category: '豆制品', units: ['克', '袋'] },
  { name: '鸡胸', kind: 'protein', category: '鸡肉', units: ['克', '千克'] },
  { name: '猪排', kind: 'protein', category: '猪肉', units: ['克', '千克'] },
  { name: '牛排', kind: 'protein', category: '牛肉', units: ['克', '千克'] },
  { name: '羊排', kind: 'protein', category: '羊肉', units: ['克', '千克'] },
  { name: '三文鱼', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '鳕鱼', kind: 'protein', category: '水产', units: ['克', '千克'] },
  { name: '花生米', kind: 'other', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '金枪鱼', kind: 'protein', category: '水产', units: ['克', '罐'] },
  { name: '培根', kind: 'protein', category: '猪肉', units: ['克', '袋'] },
]

/** 蔬菜 */
export const VEGETABLES: CatalogIngredient[] = [
  { name: '青椒', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 80 },
  { name: '尖椒', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 40 },
  { name: '土豆', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 150 },
  { name: '茄子', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 200 },
  { name: '豆角', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '四季豆', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '西兰花', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 300 },
  { name: '花菜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 400 },
  { name: '大白菜', kind: 'vegetable', category: '蔬菜', units: ['克', '个'], gramsPerUnit: 800 },
  { name: '小白菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '菠菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '油菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '生菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '黄瓜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 200 },
  { name: '冬瓜', kind: 'vegetable', category: '蔬菜', units: ['克', '千克'] },
  { name: '南瓜', kind: 'vegetable', category: '蔬菜', units: ['克', '千克'] },
  { name: '西葫芦', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 300 },
  { name: '莲藕', kind: 'vegetable', category: '蔬菜', units: ['克', '个'], gramsPerUnit: 400 },
  { name: '山药', kind: 'vegetable', category: '蔬菜', units: ['克', '千克'] },
  { name: '木耳', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '香菇', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '金针菇', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '韭菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '蒜苗', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '酸菜', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '芹菜', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '莴笋', kind: 'vegetable', category: '蔬菜', units: ['克', '个'], gramsPerUnit: 300 },
  { name: '苦瓜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 200 },
  { name: '丝瓜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 200 },
  { name: '平菇', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '杏鲍菇', kind: 'vegetable', category: '干货/菌菇', units: ['克', '袋'] },
  { name: '秋葵', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '番茄', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 150 },
  { name: '洋葱', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 180 },
  { name: '胡萝卜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 120 },
  { name: '白萝卜', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 500 },
  { name: '玉米', kind: 'vegetable', category: '蔬菜', units: ['个', '克'], gramsPerUnit: 200 },
  { name: '豌豆', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
]

/** 主食 / 乳制品 / 其它 */
export const STAPLES: CatalogIngredient[] = [
  { name: '大米', kind: 'staple', category: '主食/谷物', units: ['克', '千克'] },
  { name: '面条', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '面粉', kind: 'staple', category: '主食/谷物', units: ['克', '千克'] },
  { name: '馒头', kind: 'staple', category: '主食/谷物', units: ['个', '袋'], gramsPerUnit: 100 },
  { name: '饺子皮', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '意大利面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '通心粉', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '螺旋面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '宽面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '细面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '意面管', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '蝴蝶面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '贝壳面', kind: 'staple', category: '主食/谷物', units: ['克', '袋'] },
  { name: '柠檬', kind: 'other', category: '水果', units: ['个', '克'], gramsPerUnit: 100 },
  { name: '芦笋', kind: 'vegetable', category: '蔬菜', units: ['克', '袋'] },
  { name: '面包', kind: 'staple', category: '主食/谷物', units: ['个', '袋'], gramsPerUnit: 30 },
  { name: '牛奶', kind: 'dairy', category: '乳制品', units: ['毫升', '升', '盒'] },
  { name: '黄油', kind: 'dairy', category: '乳制品', units: ['克', '盒'] },
  { name: '奶酪', kind: 'dairy', category: '乳制品', units: ['克', '袋'] },
  { name: '酸奶', kind: 'dairy', category: '乳制品', units: ['毫升', '盒'] },
]

/** 调味品（presence-only，不按量扣减） */
export const SEASONINGS: CatalogIngredient[] = [
  { name: '盐', kind: 'other', category: '调味品', units: [] },
  { name: '生抽', kind: 'other', category: '调味品', units: [] },
  { name: '老抽', kind: 'other', category: '调味品', units: [] },
  { name: '料酒', kind: 'other', category: '调味品', units: [] },
  { name: '白糖', kind: 'other', category: '调味品', units: [] },
  { name: '香醋', kind: 'other', category: '调味品', units: [] },
  { name: '蚝油', kind: 'other', category: '调味品', units: [] },
  { name: '豆瓣酱', kind: 'other', category: '调味品', units: [] },
  { name: '干辣椒', kind: 'other', category: '调味品', units: [] },
  { name: '花椒', kind: 'other', category: '调味品', units: [] },
  { name: '黑胡椒', kind: 'other', category: '调味品', units: [] },
  { name: '橄榄油', kind: 'other', category: '调味品', units: [] },
  { name: '蒜', kind: 'other', category: '调味品', units: [] },
  { name: '姜', kind: 'other', category: '调味品', units: [] },
  { name: '葱', kind: 'other', category: '调味品', units: [] },
  { name: '罗勒', kind: 'other', category: '调味品', units: [] },
  { name: '百里香', kind: 'other', category: '调味品', units: [] },
  { name: '奶油', kind: 'other', category: '调味品', units: [] },
  { name: '番茄酱', kind: 'other', category: '调味品', units: [] },
  { name: '咖喱粉', kind: 'other', category: '调味品', units: [] },
  { name: '剁椒', kind: 'other', category: '调味品', units: [] },
  { name: '芝麻酱', kind: 'other', category: '调味品', units: [] },
  { name: '泡椒', kind: 'other', category: '调味品', units: [] },
  { name: '蒸鱼豉油', kind: 'other', category: '调味品', units: [] },
  { name: '淀粉', kind: 'other', category: '调味品', units: [] },
]

export const ALL_INGREDIENTS: CatalogIngredient[] = [
  ...PROTEINS,
  ...VEGETABLES,
  ...STAPLES,
  ...SEASONINGS,
]

/** 名称 → 目录项（生成器内部用） */
export const BY_NAME: ReadonlyMap<string, CatalogIngredient> = new Map(
  ALL_INGREDIENTS.map((i) => [i.name, i]),
)
