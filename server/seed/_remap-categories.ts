/**
 * 一次性脚本：把 builtin-ingredients.ts 的分类重映射到 v0.1.3 的 19 个新分类。
 *
 * 规则（用户已确认）：
 *   畜肉 → 按 key 前缀拆分为 猪肉 / 牛肉 / 羊肉 / 其他畜肉
 *   禽肉 → 按 key 前缀拆分为 鸡肉 / 鸭肉 / 鹅肉 / 其他禽肉
 *   食用油 → 调味品
 *   特殊：grain.wonton → 冷冻食品
 *         dairy.ice_cream → 冷冻食品
 *         soy.fermented_tofu → 调味品
 *         seafood.seaweed_roll → 冷冻食品
 *
 * ⚠️ 只改 category 字段，不动 name / aliases / units / shelfLife / key。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const file = resolve(process.cwd(), 'seed', 'builtin-ingredients.ts')
let src = readFileSync(file, 'utf8')

/** key 前缀 → 畜肉细分 */
const PORK = ['pork.']
const BEEF = ['beef.']
const LAMB = ['lamb.']

/** key 前缀 → 禽肉细分 */
const CHICKEN = ['poultry.chicken', 'poultry.chicken_']
const DUCK = ['poultry.duck']
const GOOSE = ['poultry.goose']

/** 特殊调整（用户明确指定） */
const SPECIAL: Record<string, string> = {
  'grain.wonton': '冷冻食品',
  'dairy.ice_cream': '冷冻食品',
  'soy.fermented_tofu': '调味品',
  'seafood.seaweed_roll': '冷冻食品',
}

let changed = 0
const report: Array<{ key: string; from: string; to: string }> = []

// 逐行处理（每行一个食材对象）
src = src
  .split('\n')
  .map((line) => {
    const keyMatch = line.match(/key:\s*'([^']+)'/)
    const catMatch = line.match(/category:\s*'([^']+)'/)
    if (!keyMatch || !catMatch) return line

    const key = keyMatch[1]
    const oldCat = catMatch[1]
    let newCat = oldCat

    // 1. 特殊调整优先
    if (SPECIAL[key]) {
      newCat = SPECIAL[key]
    }
    // 2. 畜肉细分
    else if (oldCat === '畜肉') {
      if (PORK.some((p) => key.startsWith(p))) newCat = '猪肉'
      else if (BEEF.some((p) => key.startsWith(p))) newCat = '牛肉'
      else if (LAMB.some((p) => key.startsWith(p))) newCat = '羊肉'
      else newCat = '其他畜肉'
    }
    // 3. 禽肉细分
    else if (oldCat === '禽肉') {
      if (DUCK.some((p) => key.startsWith(p))) newCat = '鸭肉'
      else if (GOOSE.some((p) => key.startsWith(p))) newCat = '鹅肉'
      else if (CHICKEN.some((p) => key.startsWith(p))) newCat = '鸡肉'
      else newCat = '其他禽肉'
    }
    // 4. 食用油 → 调味品
    else if (oldCat === '食用油') {
      newCat = '调味品'
    }

    if (newCat !== oldCat) {
      changed++
      report.push({ key, from: oldCat, to: newCat })
      return line.replace(`category: '${oldCat}'`, `category: '${newCat}'`)
    }
    return line
  })
  .join('\n')

writeFileSync(file, src, 'utf8')

console.log(`已修改 ${changed} 条`)
console.log('')
console.log('按 旧→新 汇总：')
const byPair = new Map<string, number>()
for (const r of report) {
  const k = `${r.from} → ${r.to}`
  byPair.set(k, (byPair.get(k) ?? 0) + 1)
}
for (const [k, v] of [...byPair.entries()].sort()) {
  console.log(`  ${k} : ${v}`)
}
console.log('')
console.log('特殊调整明细：')
for (const key of Object.keys(SPECIAL)) {
  const r = report.find((x) => x.key === key)
  if (r) console.log(`  ${key} : ${r.from} → ${r.to}`)
  else console.log(`  ${key} : (已是目标分类或未找到)`)
}
