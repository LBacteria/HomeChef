/**
 * v0.1.3 Final Review —— 分类语义与功能完整性核对（只读）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const src = readFileSync(resolve(process.cwd(), 'seed', 'builtin-ingredients.ts'), 'utf8')

interface Item { key: string; name: string; category: string }
const items: Item[] = []
for (const line of src.split('\n')) {
  const k = line.match(/key:\s*'([^']+)'/)
  const n = line.match(/name:\s*'([^']+)'/)
  const c = line.match(/category:\s*'([^']+)'/)
  if (k && n && c) items.push({ key: k[1], name: n[1], category: c[1] })
}

console.log(`===== seed 总数: ${items.length} =====`)
console.log('')

const byCat = new Map<string, Item[]>()
for (const i of items) {
  if (!byCat.has(i.category)) byCat.set(i.category, [])
  byCat.get(i.category)!.push(i)
}

const EXPECTED = ['蔬菜','水果','猪肉','牛肉','羊肉','其他畜肉','鸡肉','鸭肉','鹅肉','其他禽肉','水产','蛋类','豆制品','乳制品','主食/谷物','干货/菌菇','冷冻食品','调味品','其他/饮品']

console.log('===== 分类分布 =====')
for (const e of EXPECTED) {
  const list = byCat.get(e) ?? []
  console.log(`  ${e}: ${list.length}`)
}
const extra = [...byCat.keys()].filter((k) => !EXPECTED.includes(k))
console.log(extra.length === 0 ? '  无多余分类 ✅' : `  ⚠️ 多余分类: ${extra.join(',')}`)
console.log(`  分类总数: ${byCat.size}`)
console.log('')

console.log('===== 冻冻食品语义（应仅为本身冷冻的成品/半成品）=====')
for (const i of byCat.get('冷冻食品') ?? []) console.log(`  ${i.name} (${i.key})`)
console.log('')

console.log('===== 调味品清单 =====')
for (const i of byCat.get('调味品') ?? []) console.log(`  ${i.name} (${i.key})`)
console.log('')

console.log('===== 肉类细分抽查 =====')
for (const cat of ['猪肉','牛肉','羊肉','鸡肉','鸭肉','鹅肉','其他畜肉','其他禽肉']) {
  const list = byCat.get(cat) ?? []
  console.log(`  ${cat}: ${list.map((x) => x.name).join(', ') || '(空)'}`)
}
console.log('')

console.log('===== 关键断言 =====')
const has = (name: string, cat: string) => {
  const it = items.find((x) => x.name === name)
  const ok = it?.category === cat
  console.log(`  ${ok ? 'OK ' : '!! '} ${name} → ${it?.category ?? '未找到'} (期望 ${cat})`)
}
has('花生油', '调味品')
has('菜籽油', '调味品')
has('橄榄油', '调味品')
has('牛腩', '牛肉')
has('五花肉', '猪肉')
has('鸡胸肉', '鸡肉')
has('鸭腿', '鸭肉')
has('馄饨', '冷冻食品')
has('冰淇淋', '冷冻食品')
has('鱼丸', '冷冻食品')
has('腐乳', '调味品')
console.log('')
console.log('===== 食用油分类是否已废弃 =====')
console.log(`  存在「食用油」分类: ${byCat.has('食用油') ? '⚠️ 是' : '否 ✅'}`)
console.log(`  存在「畜肉」分类: ${byCat.has('畜肉') ? '⚠️ 是' : '否 ✅'}`)
console.log(`  存在「禽肉」分类: ${byCat.has('禽肉') ? '⚠️ 是' : '否 ✅'}`)
