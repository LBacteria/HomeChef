/**
 * v0.2.0 Phase 3 批次 2 补充验证：SQLite 约束错误 → HTTP 映射
 *
 * 目的：
 *   证明真实 SQLite 约束异常经过**项目实际 error handler** 后，
 *   返回正确的 HTTP 状态与错误码，而不是 500。
 *
 * 手法：
 *   ① 用真实 `registerErrorHandler` 注册到最小 Fastify 应用
 *   ② 用真实 SQLite 库制造四类约束冲突（UNIQUE / FK / CHECK / NOT NULL）
 *   ③ 断言状态码与错误码
 *   ④ 同时验证**既有 ServiceError 行为未变**
 *
 * ⚠️ 独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import Fastify from 'fastify'

import { registerErrorHandler } from './src/routes/errorHandler.js'
import {
  hasRecipeError,
  hasStockError,
  recipeNotFoundError,
  tagNotFoundError,
} from './src/services/errors.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') => console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)
const section = (t: string) => console.log(`\n===== ${t} =====`)

/* ---------- 用真实 migration 建临时库 ---------- */
const dbPath = resolve(process.cwd(), 'data', `sqlite-err-${Date.now()}.db`)
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const drizzleDir = resolve(process.cwd(), 'drizzle')
const migrationFiles = readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()

const sqlite = new Database(dbPath)
sqlite.pragma('foreign_keys = ON')
for (const f of migrationFiles) {
  for (const stmt of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = stmt.trim(); if (t) sqlite.exec(t)
  }
}
info('临时库', dbPath)

/* ---------- 最小 Fastify 应用 + 真实 errorHandler ---------- */
const app = Fastify({ logger: false })
registerErrorHandler(app)

const now = new Date().toISOString()

/** 每个路由制造一类真实约束冲突 */
app.post('/unique', async () => {
  sqlite.prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run('唯一菜', '唯一菜', now, now)
  sqlite.prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run('唯一菜', '唯一菜', now, now)   // ← UNIQUE 冲突
  return { ok: true }
})

app.post('/fk', async () => {
  // recipe_ingredient.definition_id → ingredient_definition.id（RESTRICT）
  sqlite.prepare('insert into recipe_ingredient (recipe_id, definition_id, sort_order, created_at, updated_at) values (?,?,?,?,?)')
    .run(1, 999999, 0, now, now)   // ← FK 冲突（定义不存在）
  return { ok: true }
})

app.post('/check', async () => {
  // recipe_ingredient_unit_in_enum：单位必须在 10 枚举内
  const rid = sqlite.prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run('CHECK菜', `check菜${Date.now()}`, now, now).lastInsertRowid
  const did = sqlite.prepare('insert into ingredient_definition (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run(`检查食材${Date.now()}`, `检查食材${Date.now()}`, now, now).lastInsertRowid
  sqlite.prepare('insert into recipe_ingredient (recipe_id, definition_id, unit, sort_order, created_at, updated_at) values (?,?,?,?,?,?)')
    .run(rid, did, '勺', 0, now, now)   // ← CHECK 冲突
  return { ok: true }
})

app.post('/notnull', async () => {
  sqlite.prepare('insert into recipe (name, name_normalized, created_at, updated_at) values (?,?,?,?)')
    .run(null as any, `null菜${Date.now()}`, now, now)   // ← NOT NULL 冲突
  return { ok: true }
})

app.post('/other', async () => {
  throw new Error('一个普通的未预期异常')
})

/* ---------- 既有 ServiceError 行为（应保持不变）---------- */
app.get('/svc/has-recipe', async () => { throw hasRecipeError('该食材已被菜谱引用') })
app.get('/svc/has-stock', async () => { throw hasStockError('该食材还有库存') })
app.get('/svc/recipe-404', async () => { throw recipeNotFoundError('菜谱不存在') })
app.get('/svc/tag-404', async () => { throw tagNotFoundError('Tag 不存在') })

await app.ready()

const inject = async (url: string) => {
  const res = await app.inject({ method: 'POST', url })
  let body: any
  try { body = JSON.parse(res.body) } catch { body = undefined }
  return { status: res.statusCode, body }
}
const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url })
  let body: any
  try { body = JSON.parse(res.body) } catch { body = undefined }
  return { status: res.statusCode, body }
}

/* ============================================================
 * 1. UNIQUE 冲突 → 409 DUPLICATE_NAME
 * ============================================================ */
section('1. UNIQUE 约束冲突 → 409 DUPLICATE_NAME')

const uniq = await inject('/unique')
ok('HTTP 状态 = 409', uniq.status === 409, `${uniq.status}`)
ok('★ 错误码 = DUPLICATE_NAME', uniq.body?.error?.code === 'DUPLICATE_NAME', `${uniq.body?.error?.code}`)
ok('★ 不是 500', uniq.status !== 500, `${uniq.status}`)
info('响应消息', `${uniq.body?.error?.message}`)
ok('★ 消息不泄露表名/列名',
  typeof uniq.body?.error?.message === 'string' &&
  !uniq.body.error.message.includes('recipe') &&
  !uniq.body.error.message.includes('name_normalized'),
  `${uniq.body?.error?.message}`)

/* ============================================================
 * 2. 外键冲突 → 409 CONSTRAINT_VIOLATION（**不是** DUPLICATE_NAME）
 * ============================================================ */
section('2. 外键约束冲突 → 409 CONSTRAINT_VIOLATION')

const fk = await inject('/fk')
ok('HTTP 状态 = 409', fk.status === 409, `${fk.status}`)
ok('★★ 错误码 = CONSTRAINT_VIOLATION', fk.body?.error?.code === 'CONSTRAINT_VIOLATION', `${fk.body?.error?.code}`)
ok('★★ **不**误报为 DUPLICATE_NAME', fk.body?.error?.code !== 'DUPLICATE_NAME', `${fk.body?.error?.code}`)
ok('  不是 500', fk.status !== 500, `${fk.status}`)
info('响应消息', `${fk.body?.error?.message}`)

/* ============================================================
 * 3. CHECK 冲突 → 400 VALIDATION_ERROR
 * ============================================================ */
section('3. CHECK 约束冲突 → 400 VALIDATION_ERROR')

const chk = await inject('/check')
ok('HTTP 状态 = 400', chk.status === 400, `${chk.status}`)
ok('★ 错误码 = VALIDATION_ERROR', chk.body?.error?.code === 'VALIDATION_ERROR', `${chk.body?.error?.code}`)
ok('  不是 409', chk.status !== 409, `${chk.status}`)
ok('  不是 500', chk.status !== 500, `${chk.status}`)
info('响应消息', `${chk.body?.error?.message}`)
ok('★ 消息不泄露 CHECK 约束名',
  typeof chk.body?.error?.message === 'string' &&
  !chk.body.error.message.includes('recipe_ingredient_unit_in_enum') &&
  !chk.body.error.message.includes('CHECK'),
  `${chk.body?.error?.message}`)

/* ============================================================
 * 4. NOT NULL 冲突 → 400 VALIDATION_ERROR
 * ============================================================ */
section('4. NOT NULL 约束冲突 → 400 VALIDATION_ERROR')

const nn = await inject('/notnull')
ok('HTTP 状态 = 400', nn.status === 400, `${nn.status}`)
ok('★ 错误码 = VALIDATION_ERROR', nn.body?.error?.code === 'VALIDATION_ERROR', `${nn.body?.error?.code}`)
ok('  不是 500', nn.status !== 500, `${nn.status}`)

/* ============================================================
 * 5. 未识别异常仍为 500
 * ============================================================ */
section('5. 未识别的普通异常 → 仍为 500')

const other = await inject('/other')
ok('HTTP 状态 = 500', other.status === 500, `${other.status}`)
ok('★ 错误码 = INTERNAL_ERROR', other.body?.error?.code === 'INTERNAL_ERROR', `${other.body?.error?.code}`)

/* ============================================================
 * 6. 既有 ServiceError 行为未变
 * ============================================================ */
section('6. 既有 ServiceError 行为保持')

const hr = await get('/svc/has-recipe')
ok('HAS_RECIPE → 409', hr.status === 409, `${hr.status}`)
ok('  错误码 = HAS_RECIPE', hr.body?.error?.code === 'HAS_RECIPE', `${hr.body?.error?.code}`)
ok('  消息透传', hr.body?.error?.message === '该食材已被菜谱引用', `${hr.body?.error?.message}`)

const hs = await get('/svc/has-stock')
ok('HAS_STOCK → 409', hs.status === 409, `${hs.status}`)
ok('  错误码 = HAS_STOCK', hs.body?.error?.code === 'HAS_STOCK', `${hs.body?.error?.code}`)

const r4 = await get('/svc/recipe-404')
ok('RECIPE_NOT_FOUND → 404', r4.status === 404, `${r4.status}`)
ok('  错误码 = RECIPE_NOT_FOUND', r4.body?.error?.code === 'RECIPE_NOT_FOUND', `${r4.body?.error?.code}`)

const t4 = await get('/svc/tag-404')
ok('TAG_NOT_FOUND → 404', t4.status === 404, `${t4.status}`)
ok('  错误码 = TAG_NOT_FOUND', t4.body?.error?.code === 'TAG_NOT_FOUND', `${t4.body?.error?.code}`)

/* ============================================================
 * 7. 数据库状态：失败操作未留下脏数据
 * ============================================================ */
section('7. 失败操作未留下脏数据')

ok('唯一菜只成功写入 1 条',
  (sqlite.prepare('select count(*) c from recipe where name_normalized = ?').get('唯一菜') as any).c === 1)
ok('FK 失败的食材关联未写入',
  (sqlite.prepare('select count(*) c from recipe_ingredient where definition_id = 999999').get() as any).c === 0)
ok('CHECK 失败的行未写入',
  (sqlite.prepare("select count(*) c from recipe_ingredient where unit = '勺'").get() as any).c === 0)

await app.close()
sqlite.close()
for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

console.log(`\n===== SQLite 约束映射结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
