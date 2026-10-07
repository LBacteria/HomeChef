import { BUILTIN_INGREDIENTS, countByCategory } from './builtin-ingredients.js'

const c = countByCategory()
let total = 0
console.log('===== v0.1.3 新分类统计 =====')
for (const [k, v] of Object.entries(c)) {
  console.log(`  ${k} : ${v}`)
  total += v
}
console.log(`  ---- 合计 : ${total}`)
console.log(`分类数: ${Object.keys(c).length}`)

const EXPECTED = ['蔬菜','水果','猪肉','牛肉','羊肉','其他畜肉','鸡肉','鸭肉','鹅肉','其他禽肉','水产','蛋类','豆制品','乳制品','主食/谷物','干货/菌菇','冷冻食品','调味品','其他/饮品']

console.log('')
console.log('===== 与预期 19 分类对比 =====')
for (const e of EXPECTED) {
  const n = c[e] ?? 0
  console.log(`  ${n > 0 ? 'OK ' : '!! '} ${e} : ${n}`)
}
const extra = Object.keys(c).filter((k) => !EXPECTED.includes(k))
console.log(extra.length === 0 ? '  无多余分类' : `  !! 多余分类：${extra.join(',')}`)
