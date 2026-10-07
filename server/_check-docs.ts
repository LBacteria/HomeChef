import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const files = ['PROJECT_SPEC.md', 'ARCHITECTURE.md', 'DATABASE_DESIGN.md', 'README.md', 'CHANGELOG.md', 'TECH_STACK.md']

console.log('===== Markdown 编码检查 =====')
for (const f of files) {
  const buf = readFileSync(resolve(process.cwd(), f))
  const text = buf.toString('utf8')
  const hasFffd = text.includes('\uFFFD')
  const mojibake = /锟|宸茶|涓存|鏈熷|鍒嗙被|璁剧疆/.test(text)
  const lines = text.split('\n').length
  console.log(`  ${hasFffd || mojibake ? 'BAD ' : 'OK  '} ${f.padEnd(22)} ${String(buf.length).padStart(7)} bytes  ${lines} lines`)
  if (hasFffd || mojibake) {
    console.log('       ⚠️ 检测到乱码特征')
  }
}

console.log('')
console.log('===== 关键内容抽查（PROJECT_SPEC.md）=====')
const spec = readFileSync(resolve(process.cwd(), 'PROJECT_SPEC.md'), 'utf8')
const checks = [
  ['19 个默认分类', '19 个默认分类'],
  ['调味品 presence-only', 'presence-only'],
  ['v0.1.3 已验收', 'v0.1.3 已验收'],
  ['分类筛选', '分类筛选'],
]
for (const [label, needle] of checks) {
  console.log(`  ${spec.includes(needle) ? 'OK ' : '!! '} ${label}`)
}

console.log('')
console.log('===== 矛盾描述是否已消除（DATABASE_DESIGN.md）=====')
const db = readFileSync(resolve(process.cwd(), 'DATABASE_DESIGN.md'), 'utf8')
const hasBad = db.includes('| `category` | 需求中未提出 |')
console.log(`  ${hasBad ? '!! 仍存在' : 'OK  已消除'}「| \`category\` | 需求中未提出 |」`)
console.log(`  ${db.includes('ON DELETE RESTRICT') ? 'OK ' : '!! '} 描述了 ON DELETE RESTRICT`)
console.log(`  ${db.includes('CATEGORY_IN_USE') ? 'OK ' : '!! '} 描述了 CATEGORY_IN_USE`)
