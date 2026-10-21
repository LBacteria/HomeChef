/**
 * v0.2.4 内容扩充包 —— **确定性生成器**（测试内容，人工规则整理，非权威来源）。
 *
 * 硬规则：
 *   - 只用允许搭配白名单，不是笛卡尔积；
 *   - 名称归一后唯一；**不靠切丝/切片/切末这种形态改名凑数**（形态只在同菜不同刀工时用）；
 *   - 每条菜谱：至少一个 quantity>0 且单位合法的非调味主料；
 *   - 做法 / 标签 / 配料 / 步骤必须一致（蒜蓉要有蒜、干煸要有干辣椒、白灼是水煮）；
 *   - 肉禽鱼虾以「熟透」为终点；蛋类打散；生米先煮成饭再下锅。
 */

import { ALL_INGREDIENTS, BY_NAME } from './catalog.js'

export interface GenIngredient {
  definition: string
  quantity: number | null
  unit: string | null
}

export interface GenRecipe {
  name: string
  cuisine: string | null
  dish_type: string
  flavor: string
  method: string
  features: string[]
  servings_note: string
  ingredients: GenIngredient[]
  steps: string[]
  provenance: 'curated-test'
  note: string
}

const TEST_NOTE = '测试菜谱：按家常做法规则整理，非逐条权威来源。'

export interface GenDefinition {
  name: string
  category: string
  allowed_units: string[]
  aliases?: string[]
}

export interface GeneratedContent {
  content_version: string
  provenance: 'curated-test'
  recipe_count: number
  definitions: GenDefinition[]
  recipes: GenRecipe[]
}

/* ============================================================
 * 白名单
 * ============================================================ */

type VegFamily = 'leafy' | 'pepper' | 'root' | 'gourd' | 'bean' | 'mushroom' | 'fruit'

const VEG_FAMILY: Record<string, VegFamily> = {
  青椒: 'pepper', 尖椒: 'pepper', 洋葱: 'pepper',
  土豆: 'root', 胡萝卜: 'root', 白萝卜: 'root', 莲藕: 'root', 山药: 'root', 莴笋: 'root',
  茄子: 'gourd', 黄瓜: 'gourd', 冬瓜: 'gourd', 南瓜: 'gourd', 西葫芦: 'gourd', 苦瓜: 'gourd', 丝瓜: 'gourd',
  豆角: 'bean', 四季豆: 'bean', 豌豆: 'bean', 秋葵: 'bean',
  西兰花: 'leafy', 花菜: 'leafy', 大白菜: 'leafy', 小白菜: 'leafy', 菠菜: 'leafy',
  油菜: 'leafy', 生菜: 'leafy', 芦笋: 'leafy', 韭菜: 'leafy', 芹菜: 'leafy',
  木耳: 'mushroom', 香菇: 'mushroom', 金针菇: 'mushroom', 平菇: 'mushroom', 杏鲍菇: 'mushroom',
  番茄: 'fruit', 玉米: 'fruit',
}

const VEG_PROTEIN_ALLOW: Record<VegFamily, string[]> = {
  pepper: ['猪肉', '牛肉', '鸡肉', '羊肉', '鸡蛋', '豆干', '虾仁'],
  root: ['牛肉', '牛腩', '猪肉', '鸡肉', '鸡腿', '羊肉', '猪排骨'],
  gourd: ['猪肉', '鸡蛋', '虾仁', '豆腐', '鸡肉'],
  bean: ['猪肉', '牛肉', '鸡腿'],
  leafy: ['猪肉', '鸡肉', '虾仁', '豆腐', '鸡蛋'],
  mushroom: ['猪肉', '鸡肉', '鸡蛋', '豆腐', '虾仁'],
  fruit: ['鸡蛋', '牛肉', '豆腐', '虾仁', '猪肉'],
}

const PROTEIN_FORMS: Record<string, string[]> = {
  猪肉: ['丝', '片'],
  牛肉: ['丝', '片'],
  鸡肉: ['丁', '片'],
  羊肉: ['片'],
  虾仁: [''],
  豆干: ['丝', '片'],
  豆腐: [''],
  鸡腿: ['块'],
  牛腩: ['块'],
  猪排骨: ['块'],
}

/** 刀工变体：切法与火候必须真的不同，否则不生成第二条 */
const FORM_TIPS: Record<string, { cut: string; heat: string }> = {
  '丝': { cut: '切细丝', heat: '大火快炒 1–2 分钟至完全熟透' },
  '片': { cut: '切薄片', heat: '中火翻炒 2–3 分钟至完全熟透' },
  '丁': { cut: '切 1.5 厘米丁', heat: '中大火滑炒至完全熟透' },
  '块': { cut: '切块', heat: '中火翻炒后加盖焖 2 分钟至熟透' },
  '': { cut: '切小块', heat: '中火炒至完全熟透' },
}
const VARIANT_NOTE = '（家常刀工变体：切法与火候不同）'

const MEAT_PROTEINS = new Set(['猪肉', '牛肉', '鸡肉', '羊肉', '鸡腿', '牛腩', '猪排骨', '五花肉', '鸡翅'])
const FISH = ['草鱼', '鲈鱼', '带鱼', '鳕鱼']
const STEW_PROTEINS = ['牛腩', '牛肉', '猪肉', '五花肉', '鸡腿', '鸡翅', '羊肉', '猪排骨']
const STEW_VEGS = ['土豆', '白萝卜', '胡萝卜', '冬瓜', '山药', '番茄', '豆角', '玉米', '莲藕', '南瓜', '大白菜', '西葫芦']
const SOUP_PROTEINS = ['猪排骨', '鸡肉', '牛腩', '鸡蛋', '豆腐', '虾仁', '羊肉']
const SOUP_VEGS = ['冬瓜', '白萝卜', '番茄', '玉米', '山药', '金针菇', '菠菜', '小白菜']
const STEAM_PROTEINS = ['鲈鱼', '草鱼', '带鱼', '虾仁', '猪排骨', '豆腐']
const COLD_VEG = ['黄瓜', '木耳', '莲藕', '金针菇', '豆腐', '菠菜', '豆干', '小白菜', '山药', '莴笋', '苦瓜', '秋葵', '芹菜', '花生米']
const POT_PROTEINS = ['鸡腿', '鸡翅', '牛腩', '猪排骨', '五花肉', '虾仁']
const POT_VEGS = ['土豆', '莲藕', '花菜', '豆角', '冬瓜', '香菇', '玉米', '白萝卜']

const REGIONAL: Array<{
  name: string; cuisine: string; dish_type: string; flavor: string; method: string
  ing: Array<[string, number | null, string | null]>; steps: string[]
}> = [
  { name: '麻婆豆腐', cuisine: '川菜', dish_type: '半荤半素', flavor: '麻辣', method: '炒', ing: [['豆腐', 400, '克'], ['牛肉', 80, '克'], ['豆瓣酱', null, null], ['花椒', null, null]], steps: ['豆腐切 2 厘米方块，入淡盐水焯 1 分钟捞出。', '牛肉剁末，小火煸干水汽。', '下豆瓣酱炒出红油，加水烧开，轻轻推入豆腐。', '中火烧 3 分钟，勾薄芡，撒花椒面出锅。'] },
  { name: '宫保鸡丁', cuisine: '川菜', dish_type: '荤菜', flavor: '香辣', method: '炒', ing: [['鸡肉', 300, '克'], ['花生米', 60, '克'], ['干辣椒', null, null], ['香醋', null, null]], steps: ['鸡肉切 1.5 厘米丁，加生抽、料酒抓匀腌 10 分钟。', '糖、醋、生抽调成料汁。', '热锅凉油滑散鸡丁至完全熟透。', '下干辣椒段爆香，倒料汁翻匀，撒花生米出锅。'] },
  { name: '鱼香肉丝', cuisine: '川菜', dish_type: '荤菜', flavor: '酸甜', method: '炒', ing: [['猪里脊', 300, '克'], ['木耳', 50, '克'], ['胡萝卜', 80, '克'], ['豆瓣酱', null, null]], steps: ['里脊切丝上浆；木耳、胡萝卜切丝。', '热锅滑油，肉丝炒散至熟透盛出。', '下豆瓣酱炒香，放配菜翻炒。', '倒回肉丝，淋糖醋汁快速收汁。'] },
  { name: '剁椒蒸鱼头', cuisine: '湘菜', dish_type: '荤菜', flavor: '香辣', method: '蒸', ing: [['草鱼', 600, '克'], ['剁椒', null, null], ['姜', null, null]], steps: ['鱼头劈开洗净，用料酒和姜片腌 10 分钟。', '铺上剁椒，水开后大火蒸 10 分钟至熟透。', '倒掉盘中汤汁，撒葱花。', '淋一勺热油激香即可。'] },
  { name: '白切鸡', cuisine: '粤菜', dish_type: '荤菜', flavor: '清淡', method: '煮', ing: [['鸡腿', 500, '克'], ['姜', null, null], ['葱', null, null]], steps: ['鸡腿冷水下锅，加姜葱煮开。', '转小火保持微沸 18 分钟，关火焖 10 分钟至熟透。', '捞出立刻过冰水，皮更爽脆。', '斩件配姜葱油食用。'] },
  { name: '糖醋排骨', cuisine: '江浙菜', dish_type: '荤菜', flavor: '酸甜', method: '炖', ing: [['猪排骨', 500, '克'], ['香醋', null, null], ['白糖', null, null]], steps: ['排骨冷水下锅焯去血沫。', '加姜片、料酒小火煮 20 分钟至熟。', '另起锅放糖熬色，下排骨翻炒上色。', '烹醋、加少许煮排骨的汤收至浓稠。'] },
  { name: '葱烧豆腐', cuisine: '鲁菜', dish_type: '素菜', flavor: '咸鲜', method: '焖', ing: [['豆腐', 400, '克'], ['葱', null, null], ['生抽', null, null]], steps: ['豆腐切厚片，两面煎至微黄。', '大葱切段小火煸出香味。', '加生抽和少量水，放入豆腐。', '小火烧 5 分钟收汁。'] },
  { name: '地三鲜', cuisine: '东北菜', dish_type: '素菜', flavor: '咸鲜', method: '炒', ing: [['土豆', 200, '克'], ['茄子', 200, '克'], ['青椒', 80, '克']], steps: ['土豆、茄子切滚刀块，青椒切块。', '土豆煎至金黄，茄子煎软。', '下青椒略炒。', '倒回土豆茄子，加生抽翻匀出锅。'] },
  { name: '西红柿鸡蛋面', cuisine: '家常中式', dish_type: '主食', flavor: '咸鲜', method: '煮', ing: [['面条', 200, '克'], ['番茄', 200, '克'], ['鸡蛋', 2, '个']], steps: ['番茄切块，鸡蛋打散炒成块盛出。', '番茄炒出汁，加水烧开。', '下面条煮至断生。', '倒回鸡蛋，加盐调味。'] },
  { name: '扬州炒饭', cuisine: '江浙菜', dish_type: '主食', flavor: '咸鲜', method: '炒', ing: [['大米', 300, '克'], ['鸡蛋', 2, '个'], ['虾仁', 80, '克'], ['豌豆', 50, '克']], steps: ['大米按 1:1.2 加水煮成米饭，放凉打散。', '鸡蛋打散炒成块，下虾仁、豌豆炒熟。', '倒入米饭中火翻炒。', '加盐和葱花炒匀出锅。'] },
  { name: '回锅肉', cuisine: '川菜', dish_type: '荤菜', flavor: '香辣', method: '炒', ing: [['五花肉', 300, '克'], ['蒜苗', 100, '克'], ['豆瓣酱', null, null]], steps: ['五花肉冷水下锅煮 20 分钟至八成熟，放凉切薄片。', '蒜苗切段。', '锅中少油煸炒肉片至微卷出油。', '下豆瓣酱炒香，加蒜苗翻炒至肉片完全熟透。'] },
  { name: '酸菜鱼', cuisine: '川菜', dish_type: '荤菜', flavor: '香辣', method: '煮', ing: [['草鱼', 500, '克'], ['酸菜', 200, '克'], ['泡椒', null, null]], steps: ['草鱼片成薄片，用盐和淀粉抓匀腌 10 分钟。', '酸菜切段，与泡椒一起炒香。', '加水烧开煮 5 分钟出味。', '下鱼片煮 1–2 分钟至完全变白熟透即可。'] },
  { name: '西湖醋鱼', cuisine: '江浙菜', dish_type: '荤菜', flavor: '酸甜', method: '煮', ing: [['草鱼', 500, '克'], ['香醋', null, null], ['白糖', null, null]], steps: ['草鱼处理干净，两面划刀。', '水开下锅，小火煮 6–8 分钟至完全熟透，捞出装盘。', '锅中留少量鱼汤，加香醋、糖和少许生抽烧开。', '勾薄芡后浇在鱼身上。'] },
  { name: '蚝油生菜', cuisine: '粤菜', dish_type: '素菜', flavor: '咸鲜', method: '煮', ing: [['生菜', 300, '克'], ['蚝油', null, null], ['蒜', null, null]], steps: ['生菜洗净掰大块。', '水开加少许油，下生菜焯 30 秒捞出。', '蒜末炒香，加蚝油和少量水烧开。', '把蚝油汁淋在生菜上。'] },
  { name: '小炒黄牛肉', cuisine: '湘菜', dish_type: '荤菜', flavor: '香辣', method: '炒', ing: [['牛肉', 300, '克'], ['芹菜', 100, '克'], ['泡椒', null, null]], steps: ['牛肉切薄片，加生抽、淀粉抓匀。', '芹菜切段，泡椒切碎。', '大火热锅，牛肉下锅快炒至完全熟透盛出。', '下芹菜、泡椒炒香，倒回牛肉翻匀出锅。'] },
  { name: '葱爆羊肉', cuisine: '鲁菜', dish_type: '荤菜', flavor: '咸鲜', method: '炒', ing: [['羊肉', 300, '克'], ['洋葱', 150, '克'], ['生抽', null, null]], steps: ['羊肉切薄片，加生抽、料酒抓匀。', '洋葱切粗丝。', '大火热锅，羊肉快速滑炒至完全熟透。', '下洋葱大火翻炒 1 分钟，加盐出锅。'] },
]

/* ============================================================
 * 工具
 * ============================================================ */

function pickUnit(name: string): { qty: number; unit: string } {
  if (name === '鸡蛋') return { qty: 2, unit: '个' }
  if (name === '牛奶' || name === '酸奶') return { qty: 250, unit: '毫升' }
  const item = BY_NAME.get(name)
  if (item !== undefined && item.units.includes('个')) return { qty: 1, unit: '个' }
  return { qty: 200, unit: '克' }
}

const ing = (n: string, q: number | null, u: string | null): GenIngredient => ({ definition: n, quantity: q, unit: u })

function pIng(name: string): GenIngredient {
  const p = pickUnit(name)
  return ing(name, p.qty, p.unit)
}

/** 调味品只记有无，不写数量 */
function anyIng(name: string): GenIngredient {
  const item = BY_NAME.get(name)
  if (item !== undefined && item.kind === 'other') return ing(name, null, null)
  return pIng(name)
}

/** 合并同名食材（避免「鸡蛋」既当主料又当辅料重复出现） */
function mergeIngredients(list: GenIngredient[]): GenIngredient[] {
  const map = new Map<string, GenIngredient>()
  for (const item of list) {
    const key = item.definition.trim().toLowerCase()
    const prev = map.get(key)
    if (prev === undefined) {
      map.set(key, { ...item })
      continue
    }
    if (prev.quantity !== null && item.quantity !== null && prev.unit === item.unit) {
      prev.quantity = Math.round((prev.quantity + item.quantity) * 100) / 100
    }
  }
  return [...map.values()]
}

function makeRecipe(partial: Omit<GenRecipe, 'servings_note' | 'provenance' | 'note'>): GenRecipe {
  return { ...partial, servings_note: '按两人份家常参考量整理', provenance: 'curated-test', note: TEST_NOTE }
}

/** 蛋白对应的菜型与熟度提示 */
function proteinDishType(protein: string): string {
  if (protein === '豆腐' || protein === '豆干') return '素菜'
  if (protein === '鸡蛋') return '半荤半素'
  return '荤菜'
}

function doneness(protein: string): string {
  if (protein === '虾仁') return '虾仁变粉红卷曲即可（约 1 分钟）'
  if (MEAT_PROTEINS.has(protein)) return `${protein}完全熟透、中心不见血水`
  if (protein === '豆腐' || protein === '豆干') return `${protein}热透入味`
  return `${protein}熟透`
}

/* ============================================================
 * 中式家族
 * ============================================================ */

function stirFry(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const veg of Object.keys(VEG_FAMILY)) {
    for (const protein of VEG_PROTEIN_ALLOW[VEG_FAMILY[veg]]) {
      if (protein === '鸡蛋') {
        const v = pickUnit(veg)
        out.push(makeRecipe({
          name: `${veg}炒蛋`,
          cuisine: '家常中式', dish_type: '半荤半素', flavor: '咸鲜', method: '炒', features: ['家常', '快手菜'],
          ingredients: mergeIngredients([ing('鸡蛋', 2, '个'), ing(veg, v.qty, v.unit), ing('盐', null, null)]),
          steps: [
            '鸡蛋打散，加一小撮盐搅匀。',
            `${veg}洗净切好。`,
            `热锅下油，先炒${veg}至断生。`,
            '倒入蛋液，待底部凝固后翻匀、完全凝固出锅。',
          ],
        }))
        continue
      }
      for (const form of PROTEIN_FORMS[protein] ?? ['']) {
        const v = pickUnit(veg)
        const tip = FORM_TIPS[form] ?? FORM_TIPS['']
        const recipe = makeRecipe({
          name: `${veg}炒${protein}${form}`,
          cuisine: '家常中式', dish_type: proteinDishType(protein), flavor: '咸鲜', method: '炒',
          features: ['家常', '下饭'],
          ingredients: mergeIngredients([pIng(protein), ing(veg, v.qty, v.unit), ing('生抽', null, null), ing('盐', null, null)]),
          steps: [
            `${protein}${tip.cut}，加生抽、料酒抓匀腌 10 分钟。`,
            `${veg}洗净切${VEG_FAMILY[veg] === 'leafy' ? '段' : '片'}，沥干水分。`,
            `热锅凉油，下${protein}${tip.heat}后盛出。`,
            `余油下${veg}大火翻炒，倒回${protein}，加盐调味，确认${doneness(protein)}出锅。`,
          ],
        })
        if (form !== '') recipe.note += VARIANT_NOTE
        out.push(recipe)
      }
    }
  }
  return out
}

function vegDishes(): GenRecipe[] {
  const styles: Array<{
    prefix: string; flavor: string; method: string; extras: Array<[string, number | null, string | null]>
    step: string; leafyOnly?: boolean; noLeafy?: boolean
  }> = [
    { prefix: '清炒', flavor: '清淡', method: '炒', extras: [['盐', null, null]], step: '大火快炒 1–2 分钟，加盐立刻出锅。' },
    { prefix: '蒜蓉', flavor: '蒜香', method: '炒', extras: [['蒜', null, null], ['盐', null, null]], step: '蒜末小火煸香，再下主料大火翻炒。' },
    { prefix: '蚝油', flavor: '咸鲜', method: '炒', extras: [['蚝油', null, null], ['蒜', null, null]], step: '主料炒软后加蚝油，翻匀即出锅（蚝油不宜久炒）。' },
    { prefix: '干煸', flavor: '香辣', method: '炒', extras: [['干辣椒', null, null], ['花椒', null, null]], step: '中火煸至表皮微皱，加干辣椒段和花椒炒香。', noLeafy: true },
    { prefix: '白灼', flavor: '清淡', method: '煮', extras: [['蒸鱼豉油', null, null], ['盐', null, null]], step: '水开后下锅焯 40–60 秒，捞出淋蒸鱼豉油。', leafyOnly: true },
    { prefix: '醋溜', flavor: '酸甜', method: '炒', extras: [['香醋', null, null], ['白糖', null, null]], step: '起锅前沿锅边烹醋，加糖翻匀。', noLeafy: true },
  ]
  const out: GenRecipe[] = []
  for (const veg of Object.keys(VEG_FAMILY)) {
    for (const style of styles) {
      if (style.noLeafy === true && VEG_FAMILY[veg] === 'leafy') continue
      if (style.leafyOnly === true && VEG_FAMILY[veg] !== 'leafy') continue
      const v = pickUnit(veg)
      out.push(makeRecipe({
        name: `${style.prefix}${veg}`,
        cuisine: '家常中式', dish_type: '素菜', flavor: style.flavor, method: style.method, features: ['家常'],
        ingredients: mergeIngredients([ing(veg, v.qty, v.unit), ...style.extras.map(([n, q, u]) => ing(n, q, u))]),
        steps: [
          `${veg}洗净切${VEG_FAMILY[veg] === 'leafy' ? '段' : '片'}。`,
          style.method === '煮' ? '锅中水烧开，加少许盐。' : '锅中放油烧热。',
          style.step,
          '装盘趁热吃。',
        ],
      }))
    }
  }
  return out
}

function stews(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const protein of STEW_PROTEINS) {
    for (const veg of STEW_VEGS) {
      for (const verb of ['炖', '焖', '烧'] as const) {
        const v = pickUnit(veg)
        out.push(makeRecipe({
          name: `${veg}${verb}${protein}`,
          cuisine: '家常中式', dish_type: '荤菜', flavor: '酱香',
          method: verb === '烧' ? '焖' : verb,
          features: ['家常', '一锅出'], // 下饭
          ingredients: mergeIngredients([pIng(protein), ing(veg, v.qty, v.unit), ing('生抽', null, null), ing('姜', null, null)]),
          steps: [
            `${protein}切块，冷水下锅焯去血沫。`,
            '锅中少油煸香姜片，下肉翻炒上色。',
            `加生抽和热水没过食材，小火${verb === '炖' ? '炖 40 分钟' : verb === '焖' ? '焖 30 分钟' : '烧 30 分钟'}。`,
            `下${veg}继续${verb === '炖' ? '炖 15 分钟' : '焖 12 分钟'}，收汁至${protein}完全熟透。`,
          ],
        }))
      }
    }
    const pair = ['土豆', '胡萝卜'] as const
    const v1 = pickUnit(pair[0])
    const v2 = pickUnit(pair[1])
    out.push(makeRecipe({
      name: `${pair[0]}${pair[1]}炖${protein}`,
      cuisine: '家常中式', dish_type: '荤菜', flavor: '酱香', method: '炖', features: ['家常', '一锅出'],
      ingredients: mergeIngredients([pIng(protein), ing(pair[0], v1.qty, v1.unit), ing(pair[1], v2.qty, v2.unit), ing('生抽', null, null)]),
      steps: [
        `${protein}切块焯水。`,
        `${pair[0]}、${pair[1]}切滚刀块。`,
        '锅中下肉煸炒上色，加生抽和热水炖 40 分钟。',
        `下两种蔬菜再炖 15 分钟，至${protein}完全熟透。`,
      ],
    }))
  }
  return out
}

function soups(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const protein of SOUP_PROTEINS) {
    for (const veg of SOUP_VEGS) {
      const v = pickUnit(veg)
      out.push(makeRecipe({
        name: `${veg}${protein}汤`,
        cuisine: '家常中式', dish_type: '汤', flavor: '清淡', method: '煮', features: ['家常', '一锅出'],
        ingredients: mergeIngredients([pIng(protein), ing(veg, v.qty, v.unit), ing('姜', null, null), ing('盐', null, null)]),
        steps: [
          protein === '鸡蛋' ? '鸡蛋打散备用。' : `${protein}处理干净，冷水下锅焯去浮沫。`,
          protein === '虾仁' ? '锅中加水烧开，下姜片。' : '加姜片和足量清水，大火烧开转小火煮 25 分钟。',
          protein === '鸡蛋'
            ? `下${veg}煮 2 分钟，关火淋入蛋液。`
            : protein === '虾仁'
              ? `下${veg}煮 3 分钟，最后放虾仁煮 1 分钟至变红卷曲。`
              : `下${veg}再煮 8 分钟，至${protein}熟透。`,
          '加盐调味，撒葱花。',
        ],
      }))
    }
    for (const pair of [['番茄', '豆腐'], ['冬瓜', '玉米'], ['菠菜', '鸡蛋']] as const) {
      const v1 = pickUnit(pair[0])
      const v2 = pair[1] === '鸡蛋' ? { qty: 2, unit: '个' } : pickUnit(pair[1])
      out.push(makeRecipe({
        name: `${pair[0]}${pair[1]}${protein}汤`,
        cuisine: '家常中式', dish_type: '汤', flavor: '清淡', method: '煮', features: ['家常', '快手菜'],
        ingredients: mergeIngredients([pIng(protein), ing(pair[0], v1.qty, v1.unit), ing(pair[1], v2.qty, v2.unit)]),
        steps: [
          `${pair[0]}、${pair[1]}切好备用。`,
          protein === '鸡蛋' ? '锅中加水烧开。' : `锅中加水，放入${protein}先煮至八成熟。`,
          '下蔬菜煮 5–8 分钟。',
          protein === '鸡蛋' ? '关火淋入蛋液，加盐出锅。' : '加盐调味，至全部主料熟透出锅。',
        ],
      }))
    }
  }
  return out
}

function staples(): GenRecipe[] {
  const out: GenRecipe[] = []
  const riceVegs = ['番茄', '土豆', '青椒', '豆角', '胡萝卜', '洋葱']
  const riceProteins = ['鸡蛋', '猪肉', '牛肉', '虾仁', '鸡腿']
  for (const veg of riceVegs) {
    for (const protein of riceProteins) {
      const v = pickUnit(veg)
      out.push(makeRecipe({
        name: `${veg}${protein}盖饭`,
        cuisine: '家常中式', dish_type: '主食', flavor: '咸鲜', method: '炒', features: ['家常', '便当'],
        ingredients: mergeIngredients([ing('大米', 150, '克'), pIng(protein), ing(veg, v.qty, v.unit)]),
        steps: [
          '大米淘洗后按 1:1.2 加水煮成米饭，盛入碗中。',
          protein === '鸡蛋' ? '鸡蛋打散炒成块。' : `${protein}切小块炒至变色。`,
          `下${veg}翻炒，加生抽和少许水烧 3 分钟至${doneness(protein)}。`,
          '连汁浇在米饭上。',
        ],
      }))
    }
  }
  for (const veg of ['番茄', '青椒', '小白菜', '菠菜']) {
    const v = pickUnit(veg)
    out.push(makeRecipe({
      name: `${veg}鸡蛋面`,
      cuisine: '家常中式', dish_type: '主食', flavor: '咸鲜', method: '煮', features: ['快手菜', '家常'],
      ingredients: mergeIngredients([ing('面条', 100, '克'), ing(veg, v.qty, v.unit), ing('鸡蛋', 2, '个')]),
      steps: ['鸡蛋打散炒成块盛出。', `${veg}切好下锅炒软，加水烧开。`, '下面条煮至断生。', '倒回鸡蛋，加盐调味。'],
    }))
  }
  for (const protein of ['猪肉', '牛肉', '鸡肉', '虾仁']) {
    out.push(makeRecipe({
      name: `${protein}饺子`,
      cuisine: '家常中式', dish_type: '主食', flavor: '咸鲜', method: '煮', features: ['家常'],
      ingredients: mergeIngredients([ing('饺子皮', 150, '克'), pIng(protein), ing('大白菜', 100, '克')]),
      steps: [
        `${protein}剁碎，白菜切碎挤干水。`,
        '加生抽、姜末顺一个方向搅上劲。',
        '包入饺子皮，捏紧封口。',
        '水开下锅，点两次凉水，浮起后再煮 1 分钟至馅熟透。',
      ],
    }))
  }
  for (const protein of ['鸡蛋', '虾仁', '牛肉']) {
    out.push(makeRecipe({
      name: `${protein}炒饭`,
      cuisine: '家常中式', dish_type: '主食', flavor: '咸鲜', method: '炒', features: ['快手菜', '便当'],
      ingredients: mergeIngredients([ing('大米', 150, '克'), pIng(protein), ing('青椒', 50, '克')]),
      steps: [
        '大米先煮成米饭，放凉后打散（隔夜饭最佳）。',
        protein === '鸡蛋' ? '鸡蛋打散炒成块。' : `${protein}切小粒炒至熟透。`,
        '下米饭中火翻炒至粒粒分明。',
        '加盐和葱花炒匀。',
      ],
    }))
  }
  return out
}

function coldDishes(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const veg of COLD_VEG) {
    for (const style of ['凉拌', '麻酱', '泡椒'] as const) {
      const v = pickUnit(veg)
      const extras: GenIngredient[] =
        style === '麻酱' ? [ing('芝麻酱', null, null), ing('蒜', null, null)]
          : style === '泡椒' ? [ing('泡椒', null, null), ing('香醋', null, null)]
            : [ing('香醋', null, null), ing('蒜', null, null), ing('盐', null, null)]
      out.push(makeRecipe({
        name: `${style}${veg}`,
        cuisine: '家常中式', dish_type: '凉菜', flavor: style === '麻酱' ? '咸鲜' : style === '泡椒' ? '香辣' : '蒜香',
        method: '凉拌', features: ['家常', '快手菜'],
        ingredients: mergeIngredients([ing(veg, v.qty, v.unit), ...extras]),
        steps: [
          `${veg}处理干净，沸水焯 1 分钟后过凉。`,
          style === '麻酱' ? '芝麻酱用温水少量多次澥开。' : style === '泡椒' ? '泡椒切碎，加香醋调成汁。' : '蒜切末，加香醋、盐调汁。',
          `把调味汁淋在${veg}上。`,
          '拌匀后冷藏 10 分钟更入味。',
        ],
      }))
    }
  }
  return out
}

function steamed(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const protein of STEAM_PROTEINS) {
    out.push(makeRecipe({
      name: `清蒸${protein}`,
      cuisine: '家常中式', dish_type: proteinDishType(protein), flavor: '清淡', method: '蒸', features: ['家常'],
      ingredients: mergeIngredients([pIng(protein), ing('葱', null, null), ing('姜', null, null), ing('蒸鱼豉油', null, null)]),
      steps: [
        `${protein}处理干净，用姜片和料酒腌 10 分钟去腥。`,
        '水开后上锅，大火蒸 8–10 分钟至完全熟透。',
        '倒掉盘中腥水，铺上葱丝。',
        '淋一勺热油和蒸鱼豉油即可。',
      ],
    }))
  }
  for (const veg of ['茄子', '豆腐', '金针菇', '南瓜', '山药', '丝瓜']) {
    const v = pickUnit(veg)
    out.push(makeRecipe({
      name: `蒜蓉蒸${veg}`,
      cuisine: '家常中式', dish_type: '素菜', flavor: '蒜香', method: '蒸', features: ['家常'],
      ingredients: mergeIngredients([ing(veg, v.qty, v.unit), ing('蒜', null, null), ing('生抽', null, null)]),
      steps: [
        `${veg}切块或切片，摆入盘中。`,
        '蒜末用少许热油激香，铺在食材上。',
        '水开后蒸 8 分钟至熟透。',
        '淋生抽，撒葱花。',
      ],
    }))
  }
  return out
}

function fishDishes(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const fish of FISH) {
    out.push(makeRecipe({
      name: `红烧${fish}`,
      cuisine: '家常中式', dish_type: '荤菜', flavor: '酱香', method: '焖', features: ['家常', '下饭'],
      ingredients: mergeIngredients([pIng(fish), ing('生抽', null, null), ing('姜', null, null), ing('葱', null, null)]),
      steps: [
        `${fish}处理干净，两面划刀，用料酒和姜片腌 10 分钟。`,
        '锅中少油，将鱼两面煎至微黄。',
        '加生抽、糖和热水，小火烧 12 分钟。',
        '大火收汁，浇在鱼身上，确保鱼肉完全熟透。',
      ],
    }))
    out.push(makeRecipe({
      name: `香煎${fish}`,
      cuisine: '家常中式', dish_type: '荤菜', flavor: '咸鲜', method: '煎', features: ['家常'],
      ingredients: mergeIngredients([pIng(fish), ing('盐', null, null), ing('黑胡椒', null, null)]),
      steps: [
        `${fish}擦干水分，用盐和黑胡椒腌 10 分钟。`,
        '平底锅烧热放油。',
        '下鱼中小火煎至一面定型再翻面。',
        '两面金黄、鱼肉完全熟透后出锅。',
      ],
    }))
  }
  return out
}

function eggDishes(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const veg of ['番茄', '青椒', '韭菜', '洋葱', '菠菜']) {
    const v = pickUnit(veg)
    out.push(makeRecipe({
      name: `${veg}蛋饼`,
      cuisine: '家常中式', dish_type: '半荤半素', flavor: '咸鲜', method: '煎', features: ['快手菜', '家常'],
      ingredients: mergeIngredients([ing('鸡蛋', 3, '个'), ing(veg, v.qty, v.unit), ing('面粉', 50, '克')]),
      steps: [
        `${veg}切碎。`,
        '鸡蛋打散，加面粉和少量水调成糊，拌入蔬菜。',
        '平底锅薄油，倒入蛋糊摊平。',
        '小火煎至两面凝固、内部熟透。',
      ],
    }))
  }
  out.push(makeRecipe({
    name: '虾仁蒸蛋',
    cuisine: '家常中式', dish_type: '半荤半素', flavor: '清淡', method: '蒸', features: ['家常'],
    ingredients: mergeIngredients([ing('鸡蛋', 2, '个'), ing('虾仁', 60, '克')]),
    steps: ['鸡蛋打散，加 1.5 倍温水搅匀过筛。', '倒入碗中，盖保鲜膜扎孔。', '水开后中小火蒸 8 分钟。', '放上虾仁再蒸 3 分钟至虾仁变红熟透。'],
  }))
  return out
}

function hotPots(): GenRecipe[] {
  const out: GenRecipe[] = []
  for (const protein of POT_PROTEINS) {
    for (const veg of POT_VEGS) {
      const v = pickUnit(veg)
      out.push(makeRecipe({
        name: `干锅${veg}${protein}`,
        cuisine: '川菜', dish_type: '荤菜', flavor: '香辣', method: '焖', features: ['下饭', '一锅出'],
        ingredients: mergeIngredients([pIng(protein), ing(veg, v.qty, v.unit), ing('干辣椒', null, null), ing('豆瓣酱', null, null)]),
        steps: [
          `${protein}切块，用料酒腌 10 分钟。`,
          `${veg}切条，过油或干煸至微软。`,
          '锅中下豆瓣酱、干辣椒炒香，放入肉块翻炒。',
          `加${veg}和少量水，小火焖 8 分钟至${protein}完全熟透收汁。`,
        ],
      }))
    }
  }
  return out
}

/* ============================================================
 * 西式（合法形态/酱汁/蛋白/蔬菜白名单）
 * ============================================================ */

function western(): GenRecipe[] {
  const out: GenRecipe[] = []

  const sauces: Array<[string, string[], string]> = [
    ['番茄肉酱', ['番茄', '牛肉', '洋葱'], '意式'],
    ['奶油蘑菇', ['奶油', '香菇', '牛奶'], '意式'],
    ['蒜香橄榄油', ['蒜', '橄榄油', '西兰花'], '意式'],
    ['青酱鸡肉', ['罗勒', '鸡胸', '奶酪'], '意式'],
    ['番茄虾仁', ['番茄', '虾仁', '蒜'], '意式'],
    ['芝士培根', ['奶酪', '培根', '洋葱'], '意式'],
    ['辣味茄汁', ['番茄', '尖椒', '牛肉'], '意式'],
    ['蘑菇鸡肉', ['香菇', '鸡胸', '奶油'], '意式'],
  ]
  const shapes = ['意大利面', '通心粉', '螺旋面', '宽面', '细面', '意面管', '蝴蝶面', '贝壳面']

  /** 每种酱汁的真实步骤（不再「处理所有食材炒香」一刀切） */
  const sauceSteps: Record<string, string[]> = {
    番茄肉酱: ['牛肉剁末，中火炒散至完全熟透。', '下番茄、洋葱炒软出汁。', '加番茄酱和少许水，小火炖 10 分钟成肉酱。'],
    奶油蘑菇: ['香菇切片，黄油煸至出水收干。', '倒入奶油与牛奶，小火煮 3 分钟（不要大火滚）。', '加盐和黑胡椒调成酱汁。'],
    蒜香橄榄油: ['蒜切片，用橄榄油小火煸香（不要焦）。', '西兰花焯水 1 分钟后沥干。', '把蒜油、西兰花与煮面水拌成酱汁。'],
    青酱鸡肉: ['罗勒、奶酪、橄榄油打成青酱。', '鸡胸煎至完全熟透，放凉切片。', '面条拌入青酱，铺上鸡肉片。'],
    番茄虾仁: ['虾仁去虾线，煎至变红卷曲（约 1 分钟）。', '番茄炒出汁，加蒜末炒香。', '下虾仁翻匀，加盐调味。'],
    芝士培根: ['培根切条煎出油。', '洋葱炒软，加奶酪小火融化。', '加少量煮面水调成顺滑酱汁。'],
    辣味茄汁: ['牛肉末炒至完全熟透。', '加尖椒、番茄炒软出汁。', '加番茄酱小火煮 5 分钟。'],
    蘑菇鸡肉: ['鸡胸切条煎至完全熟透。', '香菇煸香，加奶油和牛奶小火煮 3 分钟。', '加奶酪调稠。'],
  }

  for (const [sauce, items, cuisine] of sauces) {
    for (const shape of shapes) {
      out.push(makeRecipe({
        name: `${sauce}${shape}`,
        cuisine, dish_type: '主食', flavor: '咸鲜', method: '煮', features: ['家常'],
        // ⚠️ 配料用**真实面型**，不是所有形状都写「意大利面」
        ingredients: mergeIngredients([ing(shape, 100, '克'), ...items.map(anyIng)]),
        steps: [
          `水烧开加盐，下${shape}按包装建议时间煮至有嚼劲，捞出留一勺煮面水。`,
          ...(sauceSteps[sauce] ?? [`另起锅处理${items.join('、')}，炒香并确保肉类熟透。`]),
          `把${shape}与酱汁拌匀，用煮面水调整浓稠度后装盘。`,
        ],
      }))
    }
  }

  const mains: Array<[string, string[]]> = [
    ['牛排', ['土豆', '芦笋', '西兰花', '洋葱']],
    ['鸡胸', ['西兰花', '土豆', '芦笋', '番茄']],
    ['三文鱼', ['芦笋', '土豆', '菠菜', '黄瓜']],
    ['猪排', ['番茄', '土豆', '洋葱', '胡萝卜']],
    ['羊排', ['南瓜', '土豆', '芦笋', '洋葱']],
    ['鳕鱼', ['土豆', '西兰花', '番茄', '菠菜']],
  ]
  for (const [main, sides] of mains) {
    for (const side of sides) {
      for (const method of ['煎', '烤'] as const) {
        for (const herb of ['黑胡椒', '百里香'] as const) {
          const s = pickUnit(side)
          out.push(makeRecipe({
            name: `${herb}${method}${main}配${side}`,
            cuisine: herb === '百里香' && method === '煎' ? '法式' : herb === '黑胡椒' ? '美式' : '西式家常',
            dish_type: '荤菜', flavor: '咸鲜', method, features: ['家常'],
            ingredients: mergeIngredients([pIng(main), ing(side, s.qty, s.unit), ing(herb, null, null), ing('橄榄油', null, null)]),
            steps: [
              `${main}擦干水分，用盐和${herb}腌 10 分钟。`,
              `${side}切块，拌橄榄油和盐。`,
              method === '煎' ? '平底锅大火煎至两面上色，转小火到完全熟透。' : '烤箱 200℃ 烤 15 分钟至熟透。',
              `${side}同锅或同盘做熟，一起装盘。`,
            ],
          }))
        }
      }
    }
  }

  const salads: Array<[string, string[], string]> = [
    ['凯撒沙拉', ['生菜', '面包', '奶酪'], '美式'],
    ['希腊沙拉', ['黄瓜', '番茄', '奶酪'], '地中海'],
    ['金枪鱼沙拉', ['生菜', '玉米', '金枪鱼'], '西式家常'],
    ['鸡胸沙拉', ['生菜', '鸡胸', '番茄'], '西式家常'],
    ['土豆沙拉', ['土豆', '鸡蛋', '黄瓜'], '西式家常'],
    ['番茄奶酪沙拉', ['番茄', '奶酪', '罗勒'], '地中海'],
    ['玉米鸡蛋沙拉', ['玉米', '鸡蛋', '生菜'], '西式家常'],
    ['烤蔬菜沙拉', ['茄子', '番茄', '洋葱'], '地中海'],
  ]
  /** 每种沙拉的真实处理步骤（不写「需要熟制的先煮熟」这种糊弄话） */
  const saladSteps: Record<string, string[]> = {
    凯撒沙拉: ['生菜撕小片洗净沥干。', '面包切块，烤箱 180℃ 烤 8 分钟至脆。', '所有材料放入大碗。', '淋橄榄油、撒奶酪碎和黑胡椒拌匀。'],
    希腊沙拉: ['黄瓜、番茄切块。', '奶酪掰成小块。', '全部放入碗中。', '淋橄榄油、撒黑胡椒拌匀。'],
    金枪鱼沙拉: ['金枪鱼罐头沥干水分，用叉子拨散。', '玉米煮熟放凉，生菜洗净撕片。', '全部放入碗中。', '淋橄榄油、加盐拌匀。'],
    鸡胸沙拉: ['鸡胸用盐和黑胡椒腌 10 分钟。', '平底锅煎至完全熟透，静置 5 分钟后切片。', '生菜、番茄洗净切好。', '摆上鸡胸片，淋橄榄油拌匀。'],
    土豆沙拉: ['土豆切块煮软（约 12 分钟），沥干放凉。', '鸡蛋煮熟切碎，黄瓜切片。', '全部放入碗中。', '加少许盐和橄榄油拌匀。'],
    番茄奶酪沙拉: ['番茄与奶酪切薄片，交替摆盘。', '罗勒叶洗净撕小片撒上。', '淋橄榄油。', '撒盐和黑胡椒即可。'],
    玉米鸡蛋沙拉: ['玉米煮熟取粒，鸡蛋煮熟切块。', '生菜洗净撕小片。', '全部放入碗中。', '加盐和橄榄油拌匀。'],
    烤蔬菜沙拉: ['茄子、番茄、洋葱切块，拌橄榄油和盐。', '烤箱 200℃ 烤 20 分钟至软。', '放凉后放入碗中。', '撒黑胡椒拌匀。'],
  }
  for (const [name, items, cuisine] of salads) {
    out.push(makeRecipe({
      name, cuisine, dish_type: '凉菜', flavor: '清淡', method: '凉拌', features: ['快手菜'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: saladSteps[name] ?? ['食材洗净切好。', '按需煮熟放凉。', '放入大碗。', '淋橄榄油拌匀。'],
    }))
  }

  const soups: Array<[string, string[]]> = [
    ['奶油蘑菇汤', ['奶油', '香菇', '牛奶']],
    ['番茄浓汤', ['番茄', '洋葱', '奶油']],
    ['南瓜浓汤', ['南瓜', '牛奶', '黄油']],
    ['玉米鸡蓉汤', ['玉米', '鸡胸', '牛奶']],
    ['蔬菜清汤', ['胡萝卜', '芹菜', '洋葱']],
    ['土豆培根汤', ['土豆', '培根', '牛奶']],
  ]
  for (const [name, items] of soups) {
    out.push(makeRecipe({
      name, cuisine: '西式家常', dish_type: '汤', flavor: '咸鲜', method: '煮', features: ['家常'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: ['食材切小块。', '黄油或橄榄油炒香洋葱类配料。', '加水或牛奶煮 15 分钟至软烂。', '搅拌或略收汁，加盐和黑胡椒。'],
    }))
  }

  const sandwiches: Array<[string, string[]]> = [
    ['火腿奶酪三明治', ['面包', '奶酪', '五花肉', '生菜']],
    ['鸡胸三明治', ['面包', '鸡胸', '生菜', '番茄']],
    ['金枪鱼三明治', ['面包', '鸡蛋', '生菜', '黄瓜']],
    ['牛肉汉堡', ['面包', '牛肉', '奶酪', '生菜']],
    ['鸡肉汉堡', ['面包', '鸡胸', '生菜', '番茄']],
    ['蔬菜卷饼', ['面粉', '生菜', '胡萝卜', '黄瓜']],
    ['鸡蛋早餐卷', ['面粉', '鸡蛋', '生菜']],
    ['奶酪吐司', ['面包', '奶酪', '黄油']],
  ]
  for (const [name, items] of sandwiches) {
    out.push(makeRecipe({
      name, cuisine: '美式', dish_type: '主食', flavor: '咸鲜', method: '煎', features: ['快手菜', '便当'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: ['面包或饼皮略烤/烙热。', '肉类煎至完全熟透。', '依次铺上配料。', '合上或卷起，压紧切半。'],
    }))
  }

  const breakfasts: Array<[string, string[]]> = [
    ['培根煎蛋', ['五花肉', '鸡蛋', '面包']],
    ['牛奶燕麦粥', ['牛奶', '面粉']],
    ['法式吐司', ['面包', '鸡蛋', '牛奶', '黄油']],
    ['蔬菜蛋卷', ['鸡蛋', '洋葱', '番茄']],
    ['酸奶水果杯', ['酸奶', '玉米']],
    ['奶酪煎蛋卷', ['鸡蛋', '奶酪', '黄油']],
    ['烤面包配黄油', ['面包', '黄油']],
    ['番茄鸡蛋开放三明治', ['面包', '番茄', '鸡蛋']],
  ]
  for (const [name, items] of breakfasts) {
    out.push(makeRecipe({
      name, cuisine: '西式家常', dish_type: '主食', flavor: '咸鲜', method: '煎', features: ['快手菜'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: ['准备并切配食材。', '平底锅中小火加热。', '按易熟程度依次下锅。', '蛋类完全凝固、肉类熟透即可。'],
    }))
  }

  const roasted: Array<[string, string[]]> = [
    ['烤土豆角', ['土豆', '橄榄油']],
    ['烤南瓜', ['南瓜', '橄榄油']],
    ['烤西兰花', ['西兰花', '橄榄油', '蒜']],
    ['烤芦笋', ['芦笋', '橄榄油']],
    ['烤茄子', ['茄子', '橄榄油', '番茄']],
    ['烤甜椒', ['青椒', '橄榄油', '洋葱']],
    ['烤蘑菇', ['香菇', '橄榄油']],
    ['烤胡萝卜', ['胡萝卜', '橄榄油', '百里香']],
  ]
  for (const [name, items] of roasted) {
    out.push(makeRecipe({
      name, cuisine: '西式家常', dish_type: '素菜', flavor: '咸鲜', method: '烤', features: ['家常'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: ['蔬菜切块，拌橄榄油、盐和香草。', '烤箱 200℃ 预热。', '平铺烤盘，烤 20 分钟。', '中途翻面，烤至边缘焦香。'],
    }))
  }

  const baked: Array<[string, string[]]> = [
    ['香草烤鸡腿', ['鸡腿', '土豆', '百里香']],
    ['烤三文鱼', ['三文鱼', '芦笋', '黑胡椒']],
    ['奶酪焗意面', ['意大利面', '奶酪', '牛奶']],
    ['焗土豆泥', ['土豆', '牛奶', '黄油']],
    ['烤鸡翅', ['鸡翅', '黑胡椒', '橄榄油']],
    ['番茄烤面包', ['面包', '番茄', '奶酪']],
    ['烤玉米', ['玉米', '黄油']],
    ['焗蘑菇', ['香菇', '奶酪', '奶油']],
    ['香草烤羊排', ['羊排', '百里香', '土豆']],
    ['柠檬烤鳕鱼', ['鳕鱼', '柠檬', '橄榄油']],
    ['奶油焗花菜', ['花菜', '奶油', '奶酪']],
    ['烤时蔬拼盘', ['西葫芦', '茄子', '青椒']],
  ]
  for (const [name, items] of baked) {
    out.push(makeRecipe({
      name, cuisine: '西式家常', dish_type: '荤菜', flavor: '咸鲜', method: '烤', features: ['家常'],
      ingredients: mergeIngredients(items.map(anyIng)),
      steps: ['食材切配，拌盐和橄榄油。', '烤箱 200℃ 预热。', '入烤箱烤 20–25 分钟。', '肉类中心完全熟透后取出静置 5 分钟。'],
    }))
  }

  return out
}

/* ============================================================
 * 汇总
 * ============================================================ */

function roundRobin(families: GenRecipe[][], limit: number, seen: Set<string>): GenRecipe[] {
  const out: GenRecipe[] = []
  const cursors = families.map(() => 0)
  let progressed = true
  while (out.length < limit && progressed) {
    progressed = false
    for (let f = 0; f < families.length; f++) {
      if (out.length >= limit) break
      const list = families[f]
      while (cursors[f] < list.length) {
        const r = list[cursors[f]++]
        const key = r.name.trim().toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(r)
        progressed = true
        break
      }
    }
  }
  return out
}

export interface GenerateOptions {
  chinese?: number
  western?: number
}

export function generateContent(options: GenerateOptions = {}): GeneratedContent {
  const chineseTarget = options.chinese ?? 1050
  const westernTarget = options.western ?? 210
  const seen = new Set<string>()

  const regional = REGIONAL.map((r) => makeRecipe({
    name: r.name, cuisine: r.cuisine, dish_type: r.dish_type, flavor: r.flavor, method: r.method,
    features: ['家常'], ingredients: r.ing.map(([n, q, u]) => ing(n, q, u)), steps: r.steps,
  }))
  // 地方菜先占名额（计入中式目标）
  const recipes: GenRecipe[] = []
  for (const r of regional) {
    const key = r.name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    recipes.push(r)
  }

  const chineseFamilies = [
    stirFry(), stews(), soups(), vegDishes(), staples(),
    coldDishes(), hotPots(), steamed(), fishDishes(), eggDishes(),
  ]
  const chineseRemaining = Math.max(0, chineseTarget - recipes.length)
  recipes.push(...roundRobin(chineseFamilies, chineseRemaining, seen))
  recipes.push(...roundRobin([western()], westernTarget, seen))

  return {
    content_version: 'v024-curated-2',
    provenance: 'curated-test',
    recipe_count: recipes.length,
    definitions: ALL_INGREDIENTS.map((i) => ({
      name: i.name,
      category: i.category,
      allowed_units: [...i.units],
      ...(i.aliases === undefined ? {} : { aliases: [...i.aliases] }),
    })),
    recipes,
  }
}
