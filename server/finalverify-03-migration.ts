/**
 * 最终验证 · 第 3 项：migration 在独立临时库上的完整验证。
 *
 * 只读性质：使用全新的临时数据库文件，不触碰正式库与已有测试库。
 */
import Database from 'better-sqlite3'
import { rmSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const tmpPath = resolve(process.cwd(), 'data', `finalverify-migration-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${tmpPath}${s}`, { force: true })

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const drizzleDir = resolve(process.cwd(), 'drizzle')
const files = readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()
console.log('migration 顺序:', files.join(' → '))
console.log('临时库:', tmpPath)
console.log('')

const db = new Database(tmpPath)
db.pragma('foreign_keys = ON')

/* ---- 0000 ---- */
console.log('===== 执行 0000 =====')
{
  const sql = readFileSync(resolve(drizzleDir, files[0]), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
  const t = (db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as Array<{name:string}>).map(r=>r.name)
  ok('0000 后存在 2 张表', t.length === 2, t.join(', '))
}

/* ---- 0001 ---- */
console.log('\n===== 执行 0001 =====')
{
  const sql = readFileSync(resolve(drizzleDir, files[1]), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
  const t = (db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as Array<{name:string}>).map(r=>r.name)
  ok('0001 后存在 4 张表', t.length === 4, t.join(', '))
  const ddl = (db.prepare("select sql from sqlite_master where name='ingredient_definition'").get() as {sql:string}).sql
  ok('0001 阶段 id 仍为普通主键（0002 才改）', !ddl.includes('AUTOINCREMENT'))
}

/* ---- 0002 ---- */
console.log('\n===== 执行 0002 =====')
{
  const sql = readFileSync(resolve(drizzleDir, files[2]), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const t = stmt.trim()
    if (t) db.exec(t)
  }
}

/* ---- 最终结构检查 ---- */
console.log('\n===== 最终 schema =====')
const tables = (db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as Array<{name:string}>).map(r=>r.name)
ok('业务表 = 4 张', tables.length === 4, tables.join(', '))
ok('含 ingredient_definition', tables.includes('ingredient_definition'))
ok('含 ingredient_alias', tables.includes('ingredient_alias'))
ok('含 ingredient_definition_unit', tables.includes('ingredient_definition_unit'))
ok('含 standard_ingredient', tables.includes('standard_ingredient'))

console.log('\n--- ingredient_definition.id ---')
const defDdl = (db.prepare("select sql from sqlite_master where name='ingredient_definition'").get() as {sql:string}).sql
const idLine = defDdl.split('\n').find((l) => l.includes('`id`'))?.trim()
console.log('  ' + idLine)
ok('id 为 AUTOINCREMENT', defDdl.includes('AUTOINCREMENT'))
const seq = db.prepare("select name from sqlite_master where type='table' and name='sqlite_sequence'").all()
ok('sqlite_sequence 表已创建', seq.length === 1)

console.log('\n--- 外键关系 ---')
const fkDef = db.prepare('pragma foreign_key_list(ingredient_definition)').all()
const fkAlias = db.prepare('pragma foreign_key_list(ingredient_alias)').all() as Array<Record<string,unknown>>
const fkUnit = db.prepare('pragma foreign_key_list(ingredient_definition_unit)').all() as Array<Record<string,unknown>>
const fkStock = db.prepare('pragma foreign_key_list(standard_ingredient)').all() as Array<Record<string,unknown>>

ok('definition 无外键（顶层实体）', fkDef.length === 0)
ok('alias → definition', fkAlias[0]?.table === 'ingredient_definition' && fkAlias[0]?.from === 'definition_id')
ok('alias ON DELETE CASCADE', fkAlias[0]?.on_delete === 'CASCADE', String(fkAlias[0]?.on_delete))
ok('unit → definition', fkUnit[0]?.table === 'ingredient_definition' && fkUnit[0]?.from === 'definition_id')
ok('unit ON DELETE CASCADE', fkUnit[0]?.on_delete === 'CASCADE', String(fkUnit[0]?.on_delete))
ok('stock → definition', fkStock[0]?.table === 'ingredient_definition' && fkStock[0]?.from === 'definition_id')
ok('stock ON DELETE RESTRICT（不级联删库存）', fkStock[0]?.on_delete === 'RESTRICT', String(fkStock[0]?.on_delete))

console.log('\n--- ⚠️ 关键：standard_ingredient 不得有 UNIQUE(definition_id) ---')
const stIdx = db.prepare('pragma index_list(standard_ingredient)').all() as Array<{name:string;unique:number;origin:string}>
for (const i of stIdx) console.log(`    ${i.name} unique=${i.unique} origin=${i.origin}`)
ok('standard_ingredient 无任何 UNIQUE 索引', stIdx.filter(i=>i.unique===1).length === 0)
ok('存在 definition_id 普通索引', stIdx.some(i=>i.name==='standard_ingredient_definition_id_idx' && i.unique===0))

console.log('\n--- UNIQUE 约束 ---')
const defIdx = db.prepare('pragma index_list(ingredient_definition)').all() as Array<{name:string;unique:number}>
const aliasIdx = db.prepare('pragma index_list(ingredient_alias)').all() as Array<{name:string;unique:number}>
const unitIdx = db.prepare('pragma index_list(ingredient_definition_unit)').all() as Array<{name:string;unique:number}>
ok('definition.name_normalized UNIQUE', defIdx.some(i=>i.name==='ingredient_definition_name_normalized_unique'&&i.unique===1))
ok('alias.alias_normalized UNIQUE', aliasIdx.some(i=>i.name==='ingredient_alias_alias_normalized_unique'&&i.unique===1))
ok('unit (definition_id,unit) UNIQUE', unitIdx.some(i=>i.name==='ingredient_definition_unit_unique'&&i.unique===1))

console.log('\n--- CHECK 约束 ---')
const stSql = (db.prepare("select sql from sqlite_master where name='standard_ingredient'").get() as {sql:string}).sql
for (const c of ['quantity_non_negative','inventory_unit_in_enum','storage_method_in_enum','expiry_source_pairing','production_not_after_purchase','manual_expiry_not_before_purchase']) {
  ok(`CHECK ${c}`, stSql.includes(c))
}
const unitSql = (db.prepare("select sql from sqlite_master where name='ingredient_definition_unit'").get() as {sql:string}).sql
ok('CHECK definition_unit_in_enum', unitSql.includes('definition_unit_in_enum'))
ok('CHECK shelf_life_non_negative', defDdl.includes('shelf_life_non_negative'))

console.log('\n--- id 复用防护（行为验证）---')
const now = new Date().toISOString()
const ins = db.prepare("insert into ingredient_definition (name,name_normalized,created_at,updated_at) values (?,?,?,?)")
ins.run('A','a',now,now); ins.run('B','b',now,now); ins.run('C','c',now,now)
db.prepare('delete from ingredient_definition where id = 3').run()
ins.run('D','d',now,now)
const dId = (db.prepare("select id from ingredient_definition where name='D'").get() as {id:number}).id
ok('删除最大 ID 后不复用', dId === 4, `新 id=${dId}（期望 4）`)

console.log('\n--- 1:N 行为验证 ---')
db.prepare("insert into ingredient_definition_unit (definition_id,unit,created_at) values (1,'个',?)").run(now)
const insStock = db.prepare("insert into standard_ingredient (definition_id,quantity,unit,purchase_date,storage_method,created_at,updated_at) values (?,?,?,?,?,?,?)")
insStock.run(1, 3, '个', '2026-10-02', '常温', now, now)
insStock.run(1, 1, '个', '2026-10-03', '冷藏', now, now)
insStock.run(1, 2, '个', '2026-10-04', '常温', now, now)
const cnt = (db.prepare('select count(*) c from standard_ingredient where definition_id=1').get() as {c:number}).c
ok('同一 definition 可有 3 条库存记录', cnt === 3, `实际 ${cnt}`)

console.log('\n--- 删除保护验证 ---')
let restricted = false
try { db.prepare('delete from ingredient_definition where id = 1').run() } catch { restricted = true }
ok('有库存时删定义被 FK RESTRICT 拒绝', restricted)

db.close()
for (const s of ['', '-shm', '-wal']) rmSync(`${tmpPath}${s}`, { force: true })

console.log(`\n===== 第 3 项结果：PASS=${pass}  FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
