/** Isolated HTTP acceptance test; never opens server/data. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'

const directory = mkdtempSync(join(tmpdir(), 'homechef-starter-'))
process.env.HOME_CHEF_DB_PATH = join(directory, 'test.db')
const { sqlite, db } = await import('./src/db/index.js')
const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')
const { registerContentRoutes } = await import('./src/routes/content.js')
const { registerDefinitionRoutes } = await import('./src/routes/definitions.js')
const { registerIngredientRoutes } = await import('./src/routes/ingredients.js')
const { registerErrorHandler } = await import('./src/routes/errorHandler.js')
const { importContentV024 } = await import('./src/content/v024/importer.js')
const { generateContent } = await import('./src/content/v024/recipes.js')
const app = Fastify({ logger: false, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } })
const checks: string[] = []
const check = (ok: unknown, name: string) => { assert.ok(ok, name); checks.push(name) }
try {
  migrate(db, { migrationsFolder: resolve(import.meta.dirname, 'drizzle') })
  registerErrorHandler(app)
  registerContentRoutes(app)
  registerDefinitionRoutes(app)
  registerIngredientRoutes(app)
  const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
  const snapshot = () => JSON.stringify(tables.map(table => [table, sqlite.prepare(`SELECT * FROM "${table}"`).all()]))
  const initial = snapshot()
  let writes = 0
  const faulty = { prepare(sql: string) {
    const statement = sqlite.prepare(sql)
    return { all: (...args: unknown[]) => statement.all(...args), get: (...args: unknown[]) => statement.get(...args),
      run(...args: unknown[]) { if (++writes === 60) throw Error('content-write-fault'); return statement.run(...args) } }
  } }
  assert.throws(() => sqlite.transaction(() => importContentV024(faulty as any, generateContent(), { dryRun: false })).immediate(), /content-write-fault/)
  check(snapshot() === initial, '中途故障整批回滚')
  const post = async (url: string, payload: object, status = 200) => {
    const response = await app.inject({ method: 'POST', url, payload })
    assert.equal(response.statusCode, status, response.body)
    return response.json()
  }
  await post('/api/content/starter', { pack: 'unknown' }, 400)
  await post('/api/content/starter', { pack: 'v024', extra: true }, 400)
  check(snapshot() === initial, '严格校验且非法请求不写入')
  const first = await post('/api/content/starter', { pack: 'v024' })
  check(first.inserted_recipes === 1211 && first.inserted_definitions === 103 && first.skipped_invalid === 0, '原版HTTP完整导入103种食材及1211道菜谱')
  check((sqlite.prepare('SELECT count(*) n FROM standard_ingredient').get() as any).n === 0, '导入不生成库存')
  const populated = snapshot()
  const repeats = await Promise.all([post('/api/content/starter', { pack: 'v024' }), post('/api/content/starter', { pack: 'v024' })])
  check(repeats.every(result => result.inserted_definitions === 0 && result.inserted_recipes === 0) && snapshot() === populated, '并发重复请求零新增且数据不变')
  const custom = await post('/api/definitions', { name: '用户自录食材', units: ['盒'], estimated_shelf_life_days: 77 }, 201)
  await post('/api/ingredients', { definition_id: custom.id, quantity: 7, unit: '盒', storage_method: '冷藏' }, 201)
  const stock = JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all())
  const definition = JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition WHERE id=?').get(custom.id))
  const candidate = sqlite.prepare("SELECT ri.recipe_id,ri.definition_id,ri.unit FROM recipe_ingredient ri JOIN ingredient_definition d ON d.id=ri.definition_id JOIN category c ON c.id=d.category_id WHERE ri.quantity>0 AND ri.unit IS NOT NULL AND c.name!='调味品' ORDER BY ri.recipe_id LIMIT 1").get() as any
  const other = sqlite.prepare('SELECT id FROM recipe WHERE id!=? LIMIT 1').get(candidate.recipe_id) as any
  sqlite.prepare('UPDATE recipe SET note=? WHERE id=?').run('用户自己的笔记', other.id)
  sqlite.prepare('UPDATE ingredient_definition SET estimated_shelf_life_days=88 WHERE id=?').run(candidate.definition_id)
  sqlite.prepare('DELETE FROM ingredient_definition_unit WHERE definition_id=?').run(candidate.definition_id)
  const unit = candidate.unit === '盒' ? '罐' : '盒'
  sqlite.prepare('INSERT INTO ingredient_definition_unit(definition_id,unit,created_at) VALUES(?,?,?)').run(candidate.definition_id, unit, new Date().toISOString())
  sqlite.prepare('DELETE FROM recipe WHERE id=?').run(candidate.recipe_id)
  const conflict = await post('/api/content/starter', { pack: 'v024' })
  check(conflict.inserted_recipes === 0 && conflict.skipped_invalid === 1 && conflict.unit_rejections.length > 0, '单位冲突整条菜谱跳过并报告')
  check(JSON.stringify(sqlite.prepare('SELECT * FROM ingredient_definition WHERE id=?').get(custom.id)) === definition && (sqlite.prepare('SELECT note FROM recipe WHERE id=?').get(other.id) as any).note === '用户自己的笔记', '用户食材和菜谱不覆盖')
  check((sqlite.prepare('SELECT estimated_shelf_life_days n FROM ingredient_definition WHERE id=?').get(candidate.definition_id) as any).n === 88 && (sqlite.prepare('SELECT unit FROM ingredient_definition_unit WHERE definition_id=?').get(candidate.definition_id) as any).unit === unit, '已有保质期和单位不改写')
  check(JSON.stringify(sqlite.prepare('SELECT * FROM standard_ingredient').all()) === stock, '已有库存不改变')
  check(sqlite.pragma('integrity_check', { simple: true }) === 'ok' && (sqlite.pragma('foreign_key_check') as unknown[]).length === 0, '数据库及外键完整')
  console.log(JSON.stringify({ passed: checks.length, checks }))
} finally {
  await app.close()
  sqlite.close()
  // Delete only the exact temporary directory created by this test.
  if (!resolve(directory).startsWith(resolve(tmpdir(), 'homechef-starter-'))) throw Error('Unexpected temporary path')
  rmSync(directory, { recursive: true, force: true })
}
