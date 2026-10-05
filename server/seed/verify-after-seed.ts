/**
 * 验证 seed 之后用户数据未被覆盖（Test 3 复核 + Test 4 复核）
 */

import { eq } from 'drizzle-orm'

import { db, sqlite } from '../src/db/index.js'
import { ingredientAlias, ingredientDefinition, seedIngredientMap } from '../src/db/schema.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

console.log('=== Test 3 复核：三次 seed 后用户修改仍然保留 ===')

const tomatoMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'vegetable.tomato'))
  .get()

const tomato = tomatoMap && tomatoMap.definition_id !== null
  ? db.select().from(ingredientDefinition).where(eq(ingredientDefinition.id, tomatoMap.definition_id)).get()
  : undefined

if (tomato) {
  console.log(`  番茄 name=${tomato.name} shelf=${tomato.estimated_shelf_life_days}`)
  ok('用户改的名称未被覆盖', tomato.name === '用户改的番茄', tomato.name)
  ok('用户改的保质期未被覆盖', tomato.estimated_shelf_life_days === 999, `${tomato.estimated_shelf_life_days}`)

  const aliases = db
    .select()
    .from(ingredientAlias)
    .where(eq(ingredientAlias.definition_id, tomato.id))
    .all()
  const names = aliases.map((a) => a.alias)
  console.log(`  aliases=${names.join(',')}`)
  ok('用户加的别名仍在', names.includes('用户加的别名'))
  ok('用户删的别名未被恢复', !names.includes('西红柿'), names.join(','))
} else {
  ok('番茄仍存在', false)
}

console.log('')
console.log('=== Test 4 复核：用户删除的食材未被复活 ===')

const duckMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'egg.duck_egg'))
  .get()

ok('鸭蛋 seed map 仍存在', duckMap !== undefined)
ok('鸭蛋 definition_id 仍为 NULL', duckMap?.definition_id === null)

const duckName = '鸭蛋'
const duckRows = db
  .select()
  .from(ingredientDefinition)
  .where(eq(ingredientDefinition.name_normalized, duckName))
  .all()
ok('鸭蛋未被重新创建', duckRows.length === 0, `找到 ${duckRows.length} 条`)

console.log('')
console.log('=== Test 5 复核：冲突条目已记录，不会重复尝试 ===')

const potatoMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'vegetable.potato'))
  .get()

ok('potato seed map 已写入', potatoMap !== undefined)
ok('status = conflict', potatoMap?.status === 'conflict', `${potatoMap?.status}`)
ok('definition_id = NULL', potatoMap?.definition_id === null)

const potatoes = db
  .select()
  .from(ingredientDefinition)
  .where(eq(ingredientDefinition.name_normalized, '土豆'))
  .all()
ok('全库只有一个土豆', potatoes.length === 1, `${potatoes.length}`)

console.log('')
console.log(`===== 结果：PASS=${pass} FAIL=${fail} =====`)

sqlite.close()
process.exit(fail === 0 ? 0 : 1)
