/**
 * Phase 5 审查：seed 数据完整性（只读）
 *
 * 直接读取 builtin-ingredients.ts 的导出，检查：
 *   - units 是否都属于 10 个枚举
 *   - key 是否唯一
 *   - name / alias 内部是否重复
 *   - shelfLife 是否合法
 *   - 分类统计
 */
import { BUILTIN_INGREDIENTS, BUILTIN_SEED_NAME, BUILTIN_SEED_VERSION, countByCategory } from './seed/builtin-ingredients.js'
import { UNITS } from './src/db/schema.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

console.log('=== seed 元信息 ===')
console.log(`  seed_name   : ${BUILTIN_SEED_NAME}`)
console.log(`  seed_version: ${BUILTIN_SEED_VERSION}`)
console.log(`  条数        : ${BUILTIN_INGREDIENTS.length}`)

const ALLOWED_UNITS = new Set<string>(UNITS as readonly string[])

console.log('')
console.log('=== 1. units 合法性 ===')
const badUnits = new Map<string, string[]>()
for (const item of BUILTIN_INGREDIENTS) {
  const bad = item.units.filter((u) => !ALLOWED_UNITS.has(u))
  if (bad.length > 0) badUnits.set(item.key, bad)
}
ok('所有 units 都在 10 个枚举内', badUnits.size === 0,
  badUnits.size === 0 ? '全部合法' : [...badUnits.entries()].map(([k, v]) => `${k}:${v.join(',')}`).join(' | '))

const emptyUnits = BUILTIN_INGREDIENTS.filter((i) => i.units.length === 0)
ok('每个食材至少 1 个 unit', emptyUnits.length === 0, emptyUnits.map((i) => i.key).join(',') || '全部满足')

const dupUnitInItem = BUILTIN_INGREDIENTS.filter((i) => new Set(i.units).size !== i.units.length)
ok('单个食材内 unit 无重复', dupUnitInItem.length === 0, dupUnitInItem.map((i) => i.key).join(',') || '全部满足')

const tooManyUnits = BUILTIN_INGREDIENTS.filter((i) => i.units.length > 4)
ok('units 数量不超过 4', tooManyUnits.length === 0, tooManyUnits.map((i) => `${i.key}(${i.units.length})`).join(',') || '全部满足')

console.log('')
console.log('=== 2. key 唯一性 ===')
const keys = BUILTIN_INGREDIENTS.map((i) => i.key)
const dupKeys = keys.filter((k, idx) => keys.indexOf(k) !== idx)
ok('seed key 全局唯一', dupKeys.length === 0, dupKeys.join(',') || `全部唯一（${keys.length} 个）`)

const badKeyFormat = keys.filter((k) => !/^[a-z_]+\.[a-z_]+$/.test(k))
ok('key 格式为 category.name（全小写 ASCII）', badKeyFormat.length === 0, badKeyFormat.join(',') || '格式统一')

const chineseKeys = keys.filter((k) => /[\u4e00-\u9fa5]/.test(k))
ok('key 不含中文（符合要求）', chineseKeys.length === 0, chineseKeys.join(',') || '无中文 key')

console.log('')
console.log('=== 3. name 唯一性 ===')
const names = BUILTIN_INGREDIENTS.map((i) => i.name)
const dupNames = names.filter((n, idx) => names.indexOf(n) !== idx)
ok('默认名称无重复', dupNames.length === 0, dupNames.join(',') || `全部唯一（${names.length} 个）`)

console.log('')
console.log('=== 4. alias 唯一性（跨所有食材）===')
const allAliases: Array<{ alias: string; key: string }> = []
for (const item of BUILTIN_INGREDIENTS) {
  for (const a of item.aliases) allAliases.push({ alias: a, key: item.key })
}
const aliasNames = allAliases.map((a) => a.alias)
const dupAliases = aliasNames.filter((a, idx) => aliasNames.indexOf(a) !== idx)
ok('alias 在所有食材间无重复', dupAliases.length === 0, dupAliases.join(',') || `${allAliases.length} 个别名全部唯一`)

const aliasPerItemDup = BUILTIN_INGREDIENTS.filter((i) => new Set(i.aliases).size !== i.aliases.length)
ok('单个食材内 alias 无重复', aliasPerItemDup.length === 0, aliasPerItemDup.map((i) => i.key).join(',') || '全部满足')

// alias 与任何默认名称冲突（跨表唯一性）
const nameSet = new Set(names)
const aliasVsName = allAliases.filter((a) => nameSet.has(a.alias))
ok('alias 不与任何默认名称冲突', aliasVsName.length === 0,
  aliasVsName.map((a) => `${a.alias}(来自 ${a.key})`).join(',') || '无冲突')

// alias 与自身食材名称冲突
const selfConflict = BUILTIN_INGREDIENTS.filter((i) => i.aliases.includes(i.name))
ok('alias 不与自身默认名称相同', selfConflict.length === 0, selfConflict.map((i) => i.key).join(',') || '全部满足')

console.log('')
console.log('=== 5. shelfLife 合法性 ===')
const badShelf = BUILTIN_INGREDIENTS.filter(
  (i) => i.shelfLife !== null && (!Number.isInteger(i.shelfLife) || i.shelfLife < 0),
)
ok('shelfLife 为非负整数或 null', badShelf.length === 0, badShelf.map((i) => i.key).join(',') || '全部合法')

const nullShelf = BUILTIN_INGREDIENTS.filter((i) => i.shelfLife === null)
console.log(`  shelfLife 为 null 的条数：${nullShelf.length}`)

console.log('')
console.log('=== 6. category 合法性 ===')
const cats = new Set(BUILTIN_INGREDIENTS.map((i) => i.category))
ok('每项都有 category', BUILTIN_INGREDIENTS.every((i) => i.category.length > 0))
console.log(`  分类数：${cats.size}`)

console.log('')
console.log('=== 7. name 非空 / 无多余空格 ===')
const badName = BUILTIN_INGREDIENTS.filter((i) => i.name.trim().length === 0 || i.name !== i.name.trim())
ok('name 非空且已 trim', badName.length === 0, badName.map((i) => i.key).join(',') || '全部满足')
const badAlias = allAliases.filter((a) => a.alias.trim().length === 0 || a.alias !== a.alias.trim())
ok('alias 非空且已 trim', badAlias.length === 0, badAlias.map((a) => a.alias).join(',') || '全部满足')

console.log('')
console.log('=== 8. 分类统计 ===')
const counts = countByCategory()
for (const [c, n] of Object.entries(counts)) console.log(`  ${c}：${n}`)
const sum = Object.values(counts).reduce((a, b) => a + b, 0)
ok('分类数量之和 = 总条数', sum === BUILTIN_INGREDIENTS.length, `${sum} == ${BUILTIN_INGREDIENTS.length}`)

console.log('')
console.log(`===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
