/**
 * v0.2.4 验证：标签体系迁移 `0014_tag_taxonomy`
 *
 * 覆盖（全部隔离临时库，不触碰 server/data）：
 *   - 只删 4 条明确的系统时段标签（scene.*）及其关联；
 *   - 自定义 meal_scene 标签**不删**，只改 category = NULL；
 *   - 新预设 `INSERT OR IGNORE`：已有同名自定义标签**保留原样**，不被改成系统；
 *   - `app_settings.recipe_selected_tags` 同一迁移内清理，非法 JSON → `[]`；
 *   - 菜谱及其它标签关联不受影响。
 *
 * 运行（在 server/ 目录下）：
 *   $env:HOME_CHEF_TEST_DB_DIR = '<系统 tmp 或 work 目录>'
 *   npx tsx verify-v024-tag-taxonomy.ts
 */

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

import { assertSafeDbPath } from './src/db/safe-db-path.js'
import { RECIPE_TAG_CATEGORIES, PRESET_RECIPE_TAGS } from './src/services/tagConfig.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.error(`  ✗ ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

const serverRoot = process.cwd()
const baseRoot = process.env.HOME_CHEF_TEST_DB_DIR
  ? resolve(process.env.HOME_CHEF_TEST_DB_DIR)
  : tmpdir()
const runRoot = join(baseRoot, `hc-v024-tags-${randomUUID()}`)
const drizzleDir = resolve(serverRoot, 'drizzle')
const realDataDir = resolve(serverRoot, 'data')

function abort(msg: string): never {
  console.error(`ABORT: ${msg}`)
  process.exit(1)
}

if (!resolve(runRoot).startsWith(resolve(baseRoot))) abort('运行目录不在基础目录内')

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const oldMigrations = migrations.filter((f) => f < '0014')
const newMigration = migrations.find((f) => f.startsWith('0014'))
if (!newMigration) abort('找不到 0014_tag_taxonomy.sql')

function applyMigrations(db: InstanceType<typeof Database>, files: string[]) {
  for (const file of files) {
    const sql = readFileSync(resolve(drizzleDir, file), 'utf8')
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const t = stmt.trim()
      if (t) db.exec(t)
    }
  }
}

function openDb(name: string): InstanceType<typeof Database> {
  const dbPath = resolve(runRoot, `${name}.db`)
  try {
    assertSafeDbPath(dbPath, serverRoot)
  } catch (e: any) {
    abort(`assertSafeDbPath 拒绝：${String(e?.message ?? e)}`)
  }
  if (dbPath.toLowerCase().startsWith(resolve(realDataDir).toLowerCase())) {
    abort('测试库路径落在 server/data 内')
  }
  for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  return db
}

const now = new Date().toISOString()

try {
  mkdirSync(runRoot, { recursive: true })

  /* ============================================================
   * 场景 1：正常迁移
   * ============================================================ */
  console.log('\n[A] 0014 数据迁移')

  const db = openDb('tags-main')
  applyMigrations(db, oldMigrations)

  // 基础菜谱（只需要能被关联）
  db.prepare(
    'insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)',
  ).run(1, '测试菜', '测试菜', now, now)

  const tagIdByName = (name: string) =>
    (db.prepare('select id from recipe_tag where name_normalized = ?').get(name) as
      | { id: number }
      | undefined)?.id

  const dinnerId = tagIdByName('晚餐')
  const lunchId = tagIdByName('午餐')
  ok('A0 前置：0012 已播种「晚餐」「午餐」系统标签', dinnerId !== undefined && lunchId !== undefined)

  // 自定义 meal_scene 标签（不得被删）
  db.prepare(
    'insert into recipe_tag (name, name_normalized, category, code, is_system, sort_order, created_at) values (?,?,?,?,?,?,?)',
  ).run('夜宵加餐', '夜宵加餐', 'meal_scene', null, 0, 0, now)
  const customId = tagIdByName('夜宵加餐')!

  // 与未来预设同名的**自定义**标签（INSERT OR IGNORE 不得把它改成系统）
  db.prepare(
    'insert into recipe_tag (name, name_normalized, category, code, is_system, sort_order, created_at) values (?,?,?,?,?,?,?)',
  ).run('川菜', '川菜', null, null, 0, 0, now)
  const customSichuanId = tagIdByName('川菜')!

  // 关联：餐谱挂「晚餐」（系统）+「夜宵加餐」（自定义）
  db.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(
    1,
    dinnerId!,
    now,
  )
  db.prepare('insert into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)').run(
    1,
    customId,
    now,
  )

  // 筛选设置：含将被删的「晚餐」、需保留的自定义、以及已不存在的名称
  db.prepare(
    `insert into app_settings (id, expiry_warning_mode, expiry_warning_threshold, allow_expired_for_recipe, recipe_selected_tags, created_at, updated_at)
     values (1, 'days', 3, 0, ?, ?, ?)`,
  ).run(JSON.stringify(['晚餐', '夜宵加餐', '已经不存在的标签']), now, now)

  applyMigrations(db, [newMigration])

  const sceneCodes = (
    db
      .prepare(
        "select code from recipe_tag where code in ('scene.breakfast','scene.lunch','scene.dinner','scene.supper')",
      )
      .all() as Array<{ code: string }>
  ).map((r) => r.code)
  ok('A1 四条系统时段标签已删除', sceneCodes.length === 0, JSON.stringify(sceneCodes))

  const sceneLinks = (
    db
      .prepare('select count(*) as c from recipe_tag_link where tag_id in (?,?)')
      .get(dinnerId, lunchId) as { c: number }
  ).c
  ok('A2 它们的菜谱关联一并删除', sceneLinks === 0)

  const custom = db
    .prepare('select category, is_system from recipe_tag where id = ?')
    .get(customId) as { category: string | null; is_system: number }
  ok(
    'A3 自定义 meal_scene 标签保留、只改为未分类（NULL）',
    custom.category === null && custom.is_system === 0,
  )
  ok(
    'A4 自定义标签与菜谱的关联保留',
    (db
      .prepare('select count(*) as c from recipe_tag_link where tag_id = ? and recipe_id = 1')
      .get(customId) as { c: number }).c === 1,
  )

  const sichuanRows = db
    .prepare('select id, is_system, category, code from recipe_tag where name_normalized = ?')
    .all('川菜') as Array<{ id: number; is_system: number; category: string | null; code: string | null }>
  ok(
    'A5 与预设同名的自定义标签：仍只有一行、仍是自定义（未被改成系统）',
    sichuanRows.length === 1 &&
      sichuanRows[0].id === customSichuanId &&
      sichuanRows[0].is_system === 0 &&
      sichuanRows[0].code === null,
    JSON.stringify(sichuanRows),
  )

  const presetCount = (
    db.prepare('select count(*) as c from recipe_tag where is_system = 1').get() as { c: number }
  ).c
  /**
   * ⚠️ 本场景里「川菜」被用户自建标签占用了名字，
   *    预设按 `INSERT OR IGNORE` 被保留原行 → 系统预设比清单少 1 条。
   *    这正是「不偷改用户标签」的预期结果。
   */
  ok(
    'A6 系统预设 = 清单数量 − 1（「川菜」被同名自定义标签占用）',
    presetCount === PRESET_RECIPE_TAGS.length - 1,
    `db=${presetCount} config=${PRESET_RECIPE_TAGS.length}`,
  )
  const cuisineCount = (
    db
      .prepare("select count(*) as c from recipe_tag where is_system = 1 and category = 'cuisine'")
      .get() as { c: number }
  ).c
  ok(
    'A6b 13 条菜系预设已插入（含西式家常，川菜冲突除外）',
    cuisineCount === 13 &&
      db.prepare("select id from recipe_tag where code = 'cuisine.western_home' and category = 'cuisine' and is_system = 1").get() !== undefined,
    String(cuisineCount),
  )
  ok(
    'A7 分类字典已改为 cuisine（不再有 meal_scene）',
    RECIPE_TAG_CATEGORIES.includes('cuisine') &&
      !(RECIPE_TAG_CATEGORIES as readonly string[]).includes('meal_scene'),
  )

  const selected = JSON.parse(
    (db.prepare('select recipe_selected_tags from app_settings where id = 1').get() as {
      recipe_selected_tags: string
    }).recipe_selected_tags,
  ) as string[]
  ok(
    'A8 筛选设置：删除已不存在的名称，保留仍存在的自定义标签',
    Array.isArray(selected) &&
      !selected.includes('晚餐') &&
      !selected.includes('已经不存在的标签') &&
      selected.includes('夜宵加餐'),
    JSON.stringify(selected),
  )

  ok(
    'A9 菜谱本身未被改动',
    (db.prepare('select count(*) as c from recipe').get() as { c: number }).c === 1,
  )

  db.close()

  /* ============================================================
   * 场景 2：筛选设置是非法 JSON
   * ============================================================ */
  console.log('\n[B] 非法 JSON 保守处理')

  const db2 = openDb('tags-invalid-json')
  applyMigrations(db2, oldMigrations)
  db2
    .prepare(
      `insert into app_settings (id, expiry_warning_mode, expiry_warning_threshold, allow_expired_for_recipe, recipe_selected_tags, created_at, updated_at)
       values (1, 'days', 3, 0, ?, ?, ?)`,
    )
    .run('这不是 JSON', now, now)
  applyMigrations(db2, [newMigration])

  const invalidSelected = (
    db2.prepare('select recipe_selected_tags from app_settings where id = 1').get() as {
      recipe_selected_tags: string
    }
  ).recipe_selected_tags
  ok('B1 非法 JSON → 保守清空为 []', invalidSelected === '[]', invalidSelected)
  db2.close()
} catch (e: any) {
  fail++
  console.error(`\n[FATAL] ${String(e?.message ?? e)}`)
} finally {
  try {
    const resolvedRun = resolve(runRoot)
    if (resolvedRun.toLowerCase() === resolve(realDataDir).toLowerCase()) {
      console.error(`[WARN] 拒绝清理：目录等于 server/data —— ${resolvedRun}`)
    } else if (!resolvedRun.startsWith(resolve(baseRoot))) {
      console.error(`[WARN] 拒绝清理：不在基础目录内 —— ${resolvedRun}`)
    } else if (!basename(resolvedRun).startsWith('hc-v024-tags-')) {
      console.error(`[WARN] 拒绝清理：目录名前缀不符 —— ${resolvedRun}`)
    } else {
      rmSync(resolvedRun, { recursive: true, force: true })
      console.log(`[INFO] 已清理本次运行目录：${resolvedRun}`)
    }
  } catch (e: any) {
    console.error(`[WARN] 清理失败需人工处理 —— ${resolve(runRoot)}：${String(e?.message ?? e)}`)
  }
}

console.log(`\n===== 结果 =====\nPASS=${pass} FAIL=${fail}`)
process.exit(fail === 0 ? 0 : 1)
