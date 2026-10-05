/**
 * Phase 5 审查：针对 findBatchMatch 的 IS NULL-safe 语义做直接验证
 *
 * 只读性质：使用独立临时库，验证后关闭连接。
 * 不修改项目任何文件（本脚本本身是审查产物，保持内容只读）。
 */
import Database from 'better-sqlite3'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const dbPath = resolve(process.cwd(), 'data', `p5-review-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const db = new Database(dbPath)
db.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()) {
  const sql = readFileSync(resolve(drizzleDir, f), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

console.log('=== 1. SQLite IS 运算符语义（底层确认）===')
const isNull = db.prepare("select (null is null) as a, (null is 'x') as b, ('x' is 'x') as c, ('x' is 'y') as d, (null = null) as e").get() as Record<string, number>
console.log(`  null IS null  = ${isNull.a}  (期望 1)`)
console.log(`  null IS 'x'   = ${isNull.b}  (期望 0)`)
console.log(`  'x' IS 'x'    = ${isNull.c}  (期望 1)`)
console.log(`  'x' IS 'y'    = ${isNull.d}  (期望 0)`)
console.log(`  null = null   = ${isNull.e}  (期望 null，证明 = 不可用)`)
ok('IS 是 NULL-safe 相等', isNull.a === 1 && isNull.b === 0 && isNull.c === 1 && isNull.d === 0)
ok('= 对 NULL 返回 NULL（不可用）', isNull.e === null)

console.log('')
console.log('=== 2. Drizzle sql 模板绑定 null 是否生成 IS NULL ===')
// 建最小数据
const now = new Date().toISOString()
db.prepare("insert into ingredient_definition (name,name_normalized,estimated_shelf_life_days,created_at,updated_at) values ('X','x',null,?,?)").run(now, now)
db.prepare("insert into ingredient_definition_unit (definition_id,unit,created_at) values (1,'克',?)").run(now)
db.prepare("insert into standard_ingredient (definition_id,quantity,unit,purchase_date,expiry_date,storage_method,created_at,updated_at) values (1,10,'克','2026-01-01',null,'常温',?,?)").run(now, now)
db.prepare("insert into standard_ingredient (definition_id,quantity,unit,purchase_date,expiry_date,expiry_date_source,storage_method,created_at,updated_at) values (1,20,'克','2026-01-01','2026-02-01','manual','常温',?,?)").run(now, now)

// 模拟 findBatchMatch 生成的条件（与 Service 相同写法）
const { drizzle } = await import('drizzle-orm/better-sqlite3')
const { and, eq, sql } = await import('drizzle-orm')
const schema = await import('./src/db/schema.js')
const d = drizzle(db, { schema })

async function findMatch(defId: number, purchase: string, storage: string, unit: string, expiry: string | null) {
  return d
    .select()
    .from(schema.standardIngredient)
    .where(
      and(
        eq(schema.standardIngredient.definition_id, defId),
        eq(schema.standardIngredient.purchase_date, purchase),
        eq(schema.standardIngredient.storage_method, storage),
        eq(schema.standardIngredient.unit, unit),
        sql`${schema.standardIngredient.expiry_date} IS ${expiry}`,
      ),
    )
    .all()
}

const mNull = await findMatch(1, '2026-01-01', '常温', '克', null)
ok('expiry=NULL 能匹配到 NULL 记录', mNull.length === 1 && mNull[0].quantity === 10, `${mNull.length} 条`)

const mDate = await findMatch(1, '2026-01-01', '常温', '克', '2026-02-01')
ok('expiry=日期 能匹配到该日期记录', mDate.length === 1 && mDate[0].quantity === 20, `${mDate.length} 条`)

const mNoMatch = await findMatch(1, '2026-01-01', '常温', '克', '2030-01-01')
ok('expiry=其他日期 无匹配', mNoMatch.length === 0, `${mNoMatch.length} 条`)

// 关键：NULL 查询不应意外匹配到非 NULL 记录
ok('NULL 查询未误匹配非 NULL 记录', mNull.every((r) => r.expiry_date === null))

console.log('')
console.log('=== 3. 生成的实际 SQL（确认用了 IS 而非 =）===')
const q = d
  .select()
  .from(schema.standardIngredient)
  .where(sql`${schema.standardIngredient.expiry_date} IS ${null}`)
  .toSQL()
console.log(`  SQL: ${q.sql}`)
console.log(`  参数: ${JSON.stringify(q.params)}`)
ok('SQL 含 IS', /\bIS\b/.test(q.sql))
ok('SQL 不含 expiry_date = ', !/expiry_date\s*=/.test(q.sql))

db.close()
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

console.log('')
console.log(`===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
