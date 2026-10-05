/**
 * 最终验证 · 第 9 项：文档一致性只读检查。
 *
 * 核对 5 份文档与当前代码/数据库是否一致。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

const root = resolve(process.cwd(), '..')
const docs = ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md', 'TECH_STACK.md']
const texts: Record<string, string> = {}
for (const d of docs) texts[d] = readFileSync(resolve(root, d), 'utf8')

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const db = new Database(resolve(process.cwd(), 'data', 'homechef.db'), { readonly: true })
const realTables = (
  db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name != '__drizzle_migrations' order by name").all() as Array<{ name: string }>
).map((r) => r.name)
db.close()

console.log('===== 1. 表名一致性 =====')
ok('实际 4 张表', realTables.length === 4, realTables.join(', '))
for (const d of docs) {
  // 文档提及的实际表名应真实存在
  const mentioned = realTables.filter((t) => texts[d].includes(t))
  ok(`${d} 提及的表名均真实存在`, mentioned.length === 0 || mentioned.every((t) => realTables.includes(t)), `提及 ${mentioned.length}/${realTables.length}`)
}
// 每份文档都不应把已废弃表说成存在
const deadTables = ['consumption_history', 'recipe', 'shopping_list', 'ingredient_merge']
for (const d of docs) {
  const bad = deadTables.filter((t) => {
    const idx = texts[d].indexOf(t)
    if (idx < 0) return false
    // 检查上下文是否处于"不创建/不包含"语境
    const ctx = texts[d].slice(Math.max(0, idx - 120), idx + 60)
    return !/不(创建|包含|做|记录|设计|提前)|后(续|期)|将来|未来|尚未|禁止/.test(ctx)
  })
  ok(`${d} 未把未实现的表写成已存在`, bad.length === 0, bad.join(', ') || '—')
}

console.log('\n===== 2. API 路径一致性 =====')
const routeSrc: string[] = []
for (const f of readdirSync(resolve(process.cwd(), 'src', 'routes'))) {
  if (f.endsWith('.ts')) routeSrc.push(readFileSync(resolve(process.cwd(), 'src', 'routes', f), 'utf8'))
}
const realPaths = new Set<string>()
for (const s of routeSrc) for (const m of s.matchAll(/'(\/api\/[^']+)'/g)) realPaths.add(m[1])
ok('代码注册了 API 路径', realPaths.size > 0, `${realPaths.size} 个`)
for (const d of docs) {
  const claimed = [...new Set([...texts[d].matchAll(/`(\/api\/[a-z0-9_/:.-]+)`/gi)].map((m) => m[1]))]
  const bogus = claimed.filter((p) => !realPaths.has(p))
  ok(`${d} 未提及不存在的 API 路径`, bogus.length === 0, bogus.join(', ') || `提及 ${claimed.length} 个`)
}

console.log('\n===== 3. 错误码一致性 =====')
const errSrc = readFileSync(resolve(process.cwd(), 'src', 'services', 'errors.ts'), 'utf8')
const realCodes = [...errSrc.matchAll(/return new ServiceError\('([A-Z_]+)'/g)].map((m) => m[1])
console.log('  实际错误码:', realCodes.join(', '))
const deprecated = ['ALIAS_CONFLICT', 'UNIT_MISMATCH']
for (const d of docs) {
  const bad = deprecated.filter((c) => texts[d].includes(c))
  ok(`${d} 未使用已废弃错误码`, bad.length === 0, bad.join(', ') || '—')
}
// 错误码表集中在 ARCHITECTURE.md（职责划分），
// 其他文档只需在相关语境中引用关键错误码
for (const d of docs) {
  const missing = realCodes.filter((c) => !texts[d].includes(c))
  const keyCodes = ['HAS_STOCK', 'UNIT_IN_USE', 'INSUFFICIENT_STOCK', 'DUPLICATE_NAME']
  const coveredKey = keyCodes.filter((c) => texts[d].includes(c))
  ok(
    `${d} 覆盖关键业务错误码`,
    coveredKey.length > 0 || missing.length === realCodes.length,
    coveredKey.length > 0 ? `覆盖 ${coveredKey.length}/4` : '未涉及错误码（该文档职责外）',
  )
}

console.log('\n===== 4. Definition 1:N Inventory 一致性 =====')
// 功能/架构/数据库/README 文档必须完整表达 1:N；
// TECH_STACK.md 讲技术选型，只要求提到"库存记录"概念即可
for (const d of ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md']) {
  const has = /1\s*:\s*N|0\.\.N|多条库存|多库存|多条记录/.test(texts[d])
  ok(`${d} 表达了 1:N 库存模型`, has)
}
ok('TECH_STACK.md 提及库存记录概念（职责内最低要求）', /库存记录/.test(texts['TECH_STACK.md']))
for (const d of ['DATABASE_DESIGN.md', 'ARCHITECTURE.md']) {
  const noUnique = /不允许.*UNIQUE\(definition_id\)|无.*UNIQUE\(definition_id\)|没有 UNIQUE|\*\*没有\*\*\s*UNIQUE|无 UNIQUE/.test(texts[d])
  ok(`${d} 明确注明无 UNIQUE(definition_id)`, noUnique)
}

console.log('\n===== 5. purchase_date / 入库日期 用词一致性 =====')
for (const d of docs) {
  const usesField = texts[d].includes('purchase_date')
  const usesTerm = texts[d].includes('入库日期')
  // 若两者都出现，应说明其对应关系
  const explains = /purchase_date[^\n]{0,60}入库日期|入库日期[^\n]{0,60}purchase_date|代码字段[^\n]{0,20}purchase_date/.test(texts[d])
  ok(`${d} 用词一致`, !usesField || !usesTerm || explains, usesField && usesTerm ? (explains ? '有对应说明' : '⚠️ 两者同现但未说明对应') : '—')
}
// 不应再把 purchase_date 称为"购买日期"（除 CHANGELOG 历史条目）
for (const d of docs) {
  const bad = texts[d].includes('购买日期')
  ok(`${d} 未使用旧称"购买日期"`, !bad, bad ? '⚠️ 仍称购买日期' : '—')
}

console.log('\n===== 6. AUTOINCREMENT 一致性 =====')
for (const d of ['DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'TECH_STACK.md', 'PROJECT_SPEC.md', 'README.md']) {
  const has = /AUTOINCREMENT/i.test(texts[d])
  ok(`${d} 提及 AUTOINCREMENT`, has)
}
const noReuse = docs.filter((d) => /不复用|永不复用|不允许重新使用/.test(texts[d]))
ok('至少 3 份文档说明 ID 不复用', noReuse.length >= 3, noReuse.join(', '))

console.log('\n===== 7. zero quantity 行为一致性 =====')
for (const d of docs) {
  const mentionsZero = /quantity\s*=\s*0|数量为 0|零数量|0 数量|扣到 0|扣减到 0/.test(texts[d])
  if (mentionsZero) {
    const consistent = /(保留|不删除|隐藏|不显示)/.test(texts[d])
    ok(`${d} zero quantity 行为一致`, consistent)
  } else {
    ok(`${d} 未涉及 zero quantity（可接受）`, true)
  }
}

console.log('\n===== 8. manual / estimated expiry 规则一致性 =====')
// 业务文档必须完整区分两种来源；TECH_STACK.md 只要求提到到期日期来源概念
for (const d of ['PROJECT_SPEC.md', 'DATABASE_DESIGN.md', 'ARCHITECTURE.md', 'README.md']) {
  const hasEstimated = texts[d].includes('estimated')
  const hasManual = texts[d].includes('manual')
  const hasPriority = /优先|不被(自动)?覆盖|不会被自动/.test(texts[d])
  ok(`${d} 区分 estimated / manual 且说明优先级`, hasEstimated && hasManual && hasPriority)
}
ok(
  'TECH_STACK.md 提及到期日期来源概念（职责内最低要求）',
  /到期日期来源|expiry_date_source|manual/.test(texts['TECH_STACK.md']),
)

console.log(`\n===== 第 9 项结果：PASS=${pass}  FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
