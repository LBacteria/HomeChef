/**
 * 诊断 P2-9：只改 quantity 时 expiry 是否被重算。
 * 使用独立临时库，验证后删除。
 */
import Database from 'better-sqlite3'
import { rmSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = resolve(process.cwd(), 'data', 'diag-p29.db')
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}
db.close()

process.env.HOME_CHEF_DB_PATH = dbPath

const def = await import('./src/services/definitionService.js')
const stock = await import('./src/services/standardIngredientService.js')

// 建定义（保质期 5 天）
const d = def.createDefinition({ name: 'P29测试', units: ['个'], estimated_shelf_life_days: 5 })
console.log('定义 id:', d.id, ' 保质期:', d.estimated_shelf_life_days)

// 建库存（应得 estimated = purchase + 5）
const s = stock.createStock({
  definition_id: d.id,
  quantity: 1,
  unit: '个',
  purchase_date: '2026-10-02',
})
console.log('\n创建后:')
console.log('  quantity          =', s.quantity)
console.log('  expiry_date       =', s.expiry_date, '(期望 2026-10-07)')
console.log('  expiry_date_source=', s.expiry_date_source)

// 只改 quantity
const updated = stock.updateStock(s.id, { quantity: 9 })
console.log('\n只改 quantity 后:')
console.log('  quantity          =', updated.quantity, '(期望 9)')
console.log('  expiry_date       =', updated.expiry_date)
console.log('  expiry_date_source=', updated.expiry_date_source)
console.log('  updated_at 变化    =', updated.updated_at !== s.updated_at)

console.log('\n判定:')
console.log('  创建前 expiry:', JSON.stringify(s.expiry_date), '/ source:', JSON.stringify(s.expiry_date_source))
console.log('  更新后 expiry:', JSON.stringify(updated.expiry_date), '/ source:', JSON.stringify(updated.expiry_date_source))
if (s.expiry_date === updated.expiry_date && s.expiry_date_source === updated.expiry_date_source) {
  console.log('  ✅ expiry 未被改动 —— 符合设计')
} else {
  console.log('  ❌ expiry 被改动了 —— 不符合设计')
}

for (const x of ['', '-shm', '-wal']) rmSync(`${dbPath}${x}`, { force: true })
