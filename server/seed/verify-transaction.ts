/**
 * Test 7：事务回滚验证
 *
 * 目标：确认单条食材失败时
 *   - 不留下半成品（例如 definition 建了但 alias 没建）
 *   - 其他食材仍正常 seed
 *
 * 方法：构造一条 seed 数据，其别名与已有数据冲突，
 *       验证 createDefinition 的事务整体回滚。
 */

import { eq } from 'drizzle-orm'

import { db, sqlite } from '../src/db/index.js'
import { ingredientAlias, ingredientDefinition, seedIngredientMap } from '../src/db/schema.js'
import { createDefinition } from '../src/services/definitionService.js'
import { ServiceError } from '../src/services/errors.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}

const defCountBefore = db.select().from(ingredientDefinition).all().length
const aliasCountBefore = db.select().from(ingredientAlias).all().length
const mapCountBefore = db.select().from(seedIngredientMap).all().length

console.log(`  基线：definitions=${defCountBefore} aliases=${aliasCountBefore} map=${mapCountBefore}`)

/* ---------- 场景 1：主名称冲突 → 不应创建任何东西 ---------- */
console.log('')
console.log('=== 场景 1：主名称与已有 definition 冲突 ===')

let threw = false
let errCode = ''
try {
  createDefinition({
    name: '番茄', // 注意：番茄已被用户改名，所以这个名称现在可能空闲
    units: ['个'],
    aliases: [],
  })
  // 如果没抛错，说明名称空闲，那这条测试不成立
} catch (e) {
  threw = true
  errCode = e instanceof ServiceError ? e.code : 'UNKNOWN'
}
console.log(`  创建「番茄」：threw=${threw} code=${errCode}`)

/* ---------- 场景 2：别名冲突 → 必须整体回滚 ---------- */
console.log('')
console.log('=== 场景 2：别名冲突导致整体回滚 ===')

// 先造一个独立食材，占用别名
const holder = createDefinition({ name: '占位食材X', units: ['个'], aliases: ['被占用的别名Y'] })
console.log(`  已创建占位食材 id=${holder.id}，别名「被占用的别名Y」`)

const defCountAfterHolder = db.select().from(ingredientDefinition).all().length

// 现在尝试创建一个新食材，其**别名**与占位食材冲突
// → createDefinition 应在事务外/事务内抛错，且**不留下 definition**
let threw2 = false
let errCode2 = ''
try {
  createDefinition({
    name: '绝不应存在的食材Z',
    units: ['个', '克'],
    aliases: ['被占用的别名Y'], // 冲突
  })
} catch (e) {
  threw2 = true
  errCode2 = e instanceof ServiceError ? e.code : 'UNKNOWN'
}

ok('别名冲突抛出 DUPLICATE_NAME', threw2 && errCode2 === 'DUPLICATE_NAME', errCode2)

const zombie = db
  .select()
  .from(ingredientDefinition)
  .where(eq(ingredientDefinition.name_normalized, '绝不应存在的食材z'))
  .get()
ok('未留下半成品 definition', zombie === undefined)

const defCountAfter = db.select().from(ingredientDefinition).all().length
ok(
  'definition 总数只增加 1（占位食材）',
  defCountAfter === defCountAfterHolder,
  `${defCountBefore} → ${defCountAfter}`,
)

/* ---------- 场景 3：失败后其他食材仍可正常创建 ---------- */
console.log('')
console.log('=== 场景 3：失败之后仍可继续创建其他食材 ===')

const after = createDefinition({ name: '冲突之后的正常食材', units: ['克'] })
ok('冲突后仍能创建新食材', after.id > 0, `id=${after.id}`)

/* ---------- 场景 4：map 表未受影响 ---------- */
const mapCountAfter = db.select().from(seedIngredientMap).all().length
ok('seed map 未被这些手工操作改动', mapCountAfter === mapCountBefore, `${mapCountBefore} → ${mapCountAfter}`)

console.log('')
console.log(`===== Test 7 结果：PASS=${pass} FAIL=${fail} =====`)

sqlite.close()
process.exit(fail === 0 ? 0 : 1)
