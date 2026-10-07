import { readFileSync } from 'node:fs'

const t = readFileSync('client/src/pages/InventoryPage.tsx', 'utf8')

console.log('===== InventoryPage.tsx 重点复查 =====')
console.log('  行数:', t.split('\n').length)
console.log('  无 U+FFFD:', !t.includes('\uFFFD'))
console.log('  中文正常（含「库存」）:', t.includes('库存'))
console.log('  中文正常（含「调味品」）:', t.includes('调味品'))
console.log('  中文正常（含「临期」）:', t.includes('临期'))
console.log("  单引号正常（含 'expired'）:", t.includes("'expired'"))
console.log('  JSX 正常（含 </section>）:', t.includes('</section>'))
console.log('  v0.1.3 标记 is_seasoning:', t.includes('is_seasoning'))
console.log('  v0.1.3 标记 CategoryFilter:', t.includes('CategoryFilter'))
console.log('  v0.1.3 标记 listCategories:', t.includes('listCategories'))

// 检查是否存在被吞掉的换行（乱码事故的特征）
const suspiciousLines = t
  .split('\n')
  .filter((l) => /[a-zA-Z0-9)\]]\s{0,2}(\/\/|\/\*)/.test(l) === false && l.includes('  //'))
console.log('')
console.log('  可疑粘连行数:', suspiciousLines.length)
