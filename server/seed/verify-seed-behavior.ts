/**
 * v0.1.1 seed 行为验证（临时测试脚本，验证后保留亦可）
 *
 * 覆盖 Test 3（用户修改不被覆盖）、Test 4（用户删除不被复活）、
 * Test 5（名称冲突）、Test 6（别名冲突）
 *
 * 使用 HOME_CHEF_DB_PATH 指向临时库，绝不触碰正式库。
 */

import { eq } from 'drizzle-orm'

import { db, sqlite } from '../src/db/index.js'
import { ingredientAlias, ingredientDefinition, seedIngredientMap } from '../src/db/schema.js'
import {
  addAlias,
  deleteAlias,
  deleteDefinition,
  getDefinitionById,
  listAllowedUnits,
  listDefinitionAliases,
  updateDefinition,
} from '../src/services/definitionService.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

console.log('=== Test 3: 用户修改不被覆盖 ===')

// 找到番茄（seed key vegetable.tomato）
const tomatoMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'vegetable.tomato'))
  .get()

if (!tomatoMap || tomatoMap.definition_id === null) {
  console.log('  [SKIP] 未找到番茄 seed map，请先执行 seed')
  process.exit(1)
}

const tomatoId = tomatoMap.definition_id
const before = getDefinitionById(tomatoId)
const beforeAliases = listDefinitionAliases(tomatoId)
const beforeUnits = listAllowedUnits(tomatoId)

console.log(`  番茄 id=${tomatoId} name=${before.name} shelf=${before.estimated_shelf_life_days}`)
console.log(`  aliases=${beforeAliases.map((a) => a.alias).join(',')} units=${beforeUnits.join(',')}`)

// --- 用户修改 ---
updateDefinition(tomatoId, { name: '用户改的番茄', estimated_shelf_life_days: 999 })

// 删掉一个 alias（西红柿）
const xihongshi = beforeAliases.find((a) => a.alias === '西红柿')
if (xihongshi) deleteAlias(xihongshi.id)

// 加一个新 alias
addAlias(tomatoId, '用户加的别名')

const afterEdit = getDefinitionById(tomatoId)
const afterAliases = listDefinitionAliases(tomatoId)

ok('改名成功', afterEdit.name === '用户改的番茄')
ok('保质期改成 999', afterEdit.estimated_shelf_life_days === 999)
ok('别名数 = 1（原 1 删 1 加 1）', afterAliases.length === 1, `${afterAliases.length}`)
ok('新别名存在', afterAliases.some((a) => a.alias === '用户加的别名'))
ok('旧别名已删除', !afterAliases.some((a) => a.alias === '西红柿'))

// 导出给 shell 用
console.log(`  AFTER_EDIT_NAME=${afterEdit.name}`)
console.log(`  AFTER_EDIT_SHELF=${afterEdit.estimated_shelf_life_days}`)
console.log(`  AFTER_EDIT_ALIASES=${afterAliases.map((a) => a.alias).join(',')}`)
console.log(`  AFTER_EDIT_UNITS=${listAllowedUnits(tomatoId).join(',')}`)

console.log('')
console.log('=== Test 4: 用户删除不被复活 ===')

// 找一个没有被库存引用的食材来删除：用 seed key egg.duck_egg（鸭蛋）
const duckMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'egg.duck_egg'))
  .get()

if (duckMap && duckMap.definition_id !== null) {
  const duckId = duckMap.definition_id
  console.log(`  删除鸭蛋 id=${duckId}`)
  deleteDefinition(duckId)

  const existsAfterDelete = db
    .select()
    .from(ingredientDefinition)
    .where(eq(ingredientDefinition.id, duckId))
    .get()
  ok('鸭蛋 definition 已删除', existsAfterDelete === undefined)

  // map 行应该保留，definition_id 变为 NULL
  const mapAfterDelete = db
    .select()
    .from(seedIngredientMap)
    .where(eq(seedIngredientMap.seed_key, 'egg.duck_egg'))
    .get()
  ok('seed map 行仍保留', mapAfterDelete !== undefined)
  ok('definition_id 已变为 NULL', mapAfterDelete?.definition_id === null, `${mapAfterDelete?.definition_id}`)
  ok('status 仍为 created', mapAfterDelete?.status === 'created')
} else {
  console.log('  [SKIP] 未找到鸭蛋')
}

console.log('')
console.log('=== Test 5/6 准备：制造名称冲突 ===')

// 创建一个与 seed 冲突的名称：'番茄' 已被用户改名，因此现在 '番茄' 是空闲的
// 我们手动创建一个名为 '土豆' 的定义？不行，土豆已存在。
// 改用一个尚未 seed 的名称：先删除某 seed 项并重建同名
// 更直接：创建别名 '马铃薯' 占用 potato 的 alias

const potatoMap = db
  .select()
  .from(seedIngredientMap)
  .where(eq(seedIngredientMap.seed_key, 'vegetable.potato'))
  .get()

if (potatoMap && potatoMap.definition_id !== null) {
  const potatoId = potatoMap.definition_id
  const potato = getDefinitionById(potatoId)
  console.log(`  土豆 id=${potatoId} name=${potato.name}`)

  // 删除土豆的 seed map 行，模拟"从未 seed 过"
  db.delete(seedIngredientMap).where(eq(seedIngredientMap.seed_key, 'vegetable.potato')).run()
  console.log('  已删除 potato 的 seed map 行（模拟首次 seed 时名称冲突）')
  console.log('  注意：土豆 definition 仍然存在，因此下次 seed 会冲突')
}

sqlite.close()

console.log('')
console.log(`===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
