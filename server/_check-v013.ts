/**
 * 验证 v0.1.3 category 回填结果（只读）
 */
import Database from 'better-sqlite3'
import { resolve } from 'node:path'

const db = new Database(resolve(process.cwd(), 'data', 'v013-e2e.db'), { readonly: true })

console.log('===== category 表 =====')
const cats = db.prepare('select id, name, sort_order from category order by sort_order, id').all() as any[]
for (const c of cats) console.log(`  ${c.id}. ${c.name}`)
console.log(`  共 ${cats.length} 个分类`)

console.log('')
console.log('===== definition 分类分布 =====')
const dist = db.prepare(`
  select c.name as cat, count(d.id) as n
  from ingredient_definition d
  left join category c on c.id = d.category_id
  group by c.name
  order by c.sort_order
`).all() as any[]
let total = 0
for (const r of dist) {
  console.log(`  ${r.cat ?? '(NULL)'} : ${r.n}`)
  total += r.n
}
console.log(`  合计 : ${total}`)

console.log('')
console.log('===== 完整性检查 =====')
const noCat = db.prepare('select count(*) c from ingredient_definition where category_id is null').get() as any
console.log(`  category_id 为 NULL 的 definition：${noCat.c}`)
const badCat = db.prepare(`
  select count(*) c from ingredient_definition d
  left join category c on c.id = d.category_id
  where d.category_id is not null and c.id is null
`).get() as any
console.log(`  指向不存在分类的 definition：${badCat.c}`)

console.log('')
console.log('===== 4 个特殊食材确认 =====')
for (const name of ['馄饨', '冰淇淋', '腐乳', '鱼丸']) {
  const r = db.prepare(`
    select d.name, c.name as cat from ingredient_definition d
    left join category c on c.id = d.category_id
    where d.name = ?
  `).get(name) as any
  console.log(`  ${name} → ${r?.cat ?? '未找到'}`)
}

console.log('')
console.log('===== 空分类（暂无食材）=====')
const empty = db.prepare(`
  select c.name from category c
  left join ingredient_definition d on d.category_id = c.id
  group by c.id having count(d.id) = 0
`).all() as any[]
if (empty.length === 0) console.log('  无')
else for (const e of empty) console.log(`  ${e.name}`)

db.close()
