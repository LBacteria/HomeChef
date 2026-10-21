/**
 * v0.2.3 —— **演示 / 体验用隔离种子脚本**（全新临时库专用）。
 *
 * 用途：生成一个**内容足够体验 v0.2.3 全部新特性**的临时库：
 *   - 五大分类标签（系统预设 + 自定义 + 未分类各一组）
 *   - 单菜点赞 / 点踩（喜欢一道、不喜欢一道）
 *   - 烹饪历史（今天 / 3 天前 / 10 天前各自的已完成整餐；另有一个**放弃会话**用于验证不惩罚）
 *   - 临期与过期库存各一项（演示临期提权与"过期不可用"）
 *   - 库存部分充足 / 部分不足（演示 ready 与缺料、缺口清单、利用率）
 *
 * 用法（**必须传绝对路径**，且目标文件**必须不存在**）：
 *   cd D:\HomeChef\server
 *   node --import tsx seed/seed-v023-demo.ts "$env:TEMP\homechef-v023-demo\demo.db"
 *
 * 安全（与 `seed-v022-demo.ts` 同一套保护，**不得放宽**）：
 *   ① 只认**绝对路径**，且先过 `assertSafeDbPath`；
 *   ② **拒绝覆盖**已存在的数据库文件；
 *   ③ 显式拒绝真实库 `server/data/homechef.db`（含大小写归一比较）；
 *   ④ 父目录必须已存在（不静默创建）；
 *   ⑤ **绝不设置** `HOME_CHEF_ALLOW_REAL_DB`；
 *   ⑥ **不启动任何服务、不打开浏览器**。
 *
 * ⚠️ 真实库有自己的数据与迁移状态，**绝不能**为了演示去迁移或写入真实库。
 */

import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertSafeDbPath } from '../src/db/safe-db-path.js'
import { addDays, todayDateString } from '../src/services/dates.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(here, '..')

const rawPath = process.argv[2]
if (!rawPath || !isAbsolute(rawPath)) {
  console.error(
    '用法：node --import tsx seed/seed-v023-demo.ts <绝对路径的**全新**临时库>\n' +
      '示例：node --import tsx seed/seed-v023-demo.ts "$env:TEMP\\homechef-v023-demo\\demo.db"',
  )
  process.exit(1)
}

const dbPath = resolve(rawPath)

// ① 路径安全校验（**早于**任何文件创建 / 写入）
assertSafeDbPath(dbPath, serverRoot)

// ② 拒绝覆盖
if (existsSync(dbPath)) {
  console.error(`拒绝执行：演示库必须是不存在的新文件（不覆盖已有数据库）—— ${dbPath}`)
  process.exit(1)
}

// ③ 显式拒绝真实库（双保险，assertSafeDbPath 已覆盖）
const realDb = resolve(serverRoot, 'data', 'homechef.db')
if (dbPath.toLowerCase() === realDb.toLowerCase()) {
  console.error(`拒绝执行：目标指向真实库 —— ${dbPath}`)
  process.exit(1)
}

// ④ 父目录必须存在
if (!existsSync(dirname(dbPath))) {
  console.error(`拒绝执行：父目录不存在（请先自行创建）—— ${dirname(dbPath)}`)
  process.exit(1)
}

const sqlite = new Database(dbPath)
sqlite.pragma('foreign_keys = ON')

/* ============================================================
 * 1) 建表：复用 drizzle/ 下的全部迁移（与 db:migrate 同一批 SQL）
 * ============================================================ */
const drizzleDir = resolve(serverRoot, 'drizzle')
for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(join(drizzleDir, file), 'utf8')
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim()
    if (trimmed) sqlite.exec(trimmed)
  }
}

/* ============================================================
 * 2) 基础数据
 * ============================================================ */
const now = new Date().toISOString()
const day = (offset: number): string => addDays(todayDateString(), offset)
/** N 天前的 ISO 时刻（烹饪历史用；与「本地日历天数」一致） */
const isoDaysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString()

const catRows = sqlite.prepare('select id, name from category').all() as Array<{
  id: number
  name: string
}>
const catId = new Map(catRows.map((c) => [c.name, c.id]))
function needCat(name: string): number {
  const id = catId.get(name)
  if (id === undefined) throw new Error(`缺少分类（迁移未建全？）：${name}`)
  return id
}

const definitions: Array<[number, string, string]> = [
  [1, '番茄', '蔬菜'],
  [2, '鸡蛋', '蛋类'],
  [3, '盐', '调味品'],
  [4, '土豆', '蔬菜'],
  [5, '牛奶', '乳制品'],
  [6, '猪肉', '猪肉'],
  [7, '青椒', '蔬菜'],
]

type DemoLine = [number, number | null, string | null]
const recipes: Array<{ id: number; name: string; lines: DemoLine[]; tags: string[] }> = [
  {
    id: 1,
    name: '番茄炒蛋',
    lines: [
      [1, 2, '个'],
      [2, 3, '个'],
      [3, 2, '克'],
    ],
    tags: ['荤菜', '炒', '快手菜'],
  },
  {
    id: 2,
    name: '青椒炒蛋',
    lines: [
      [7, 2, '个'],
      [2, 2, '个'],
      [3, 2, '克'],
    ],
    tags: ['半荤半素', '炒', '快手菜'],
  },
  {
    id: 3,
    name: '土豆炖肉',
    lines: [
      [4, 3, '个'],
      [6, 300, '克'],
      [3, 3, '克'],
    ],
    tags: ['荤菜', '炖'],
  },
  {
    id: 4,
    name: '牛奶蒸蛋',
    lines: [
      [2, 2, '个'],
      [5, 200, '毫升'],
    ],
    tags: ['甜点', '蒸', '高蛋白'],
  },
  {
    id: 5,
    name: '醋溜土豆丝',
    lines: [
      [4, 2, '个'],
      [7, 1, '个'],
    ],
    tags: ['素菜', '炒'],
  },
  {
    id: 6,
    name: '番茄蛋汤',
    lines: [
      [1, 1, '个'],
      [2, 1, '个'],
    ],
    tags: ['汤', '煮', '低脂'],
  },
]

/**
 * 库存：含**临期**（鸡蛋、猪肉）与**已过期**（牛奶）各若干，
 * 以及部分不足的食材（青椒只够一道菜），用于演示缺口清单。
 */
const stock: Array<[number, number, string, string | null, string | null]> = [
  // definition, quantity, unit, expiry, source
  [3, 0, '个', null, null], // 调味品哨兵：数量 0 = 「家里有」
  [1, 5, '个', day(5), 'manual'],
  [2, 10, '个', day(2), 'manual'], // 临期（默认阈值 3 天）
  [4, 4, '个', null, null],
  [6, 500, '克', day(4), 'manual'],
  [7, 1, '个', null, null], // 偏少 → 容易出现"缺料/缺口"
  [5, 500, '毫升', day(-3), 'manual'], // 已过期 → 推荐时不计入可用
]

/**
 * 自定义标签（演示「与预设同等可增改删」）：一个带分类、一个未分类。
 * ⚠️ v0.2.4：`meal_scene` 已不存在，这里改用 `feature`。
 */
const customTags: Array<{ name: string; category: string | null }> = [
  { name: '减脂餐', category: 'feature' },
  { name: '妈妈的味道', category: null },
]
/** 自定义标签挂到菜谱上 */
const customLinks: Array<[number, string]> = [
  [6, '减脂餐'],
  [1, '妈妈的味道'],
]

/** 单菜偏好：喜欢一道、不喜欢一道（**不排除**，只影响软评分） */
const preferences: Array<[number, 'like' | 'dislike']> = [
  [6, 'like'],
  [3, 'dislike'],
]

/**
 * 烹饪历史：只统计「会话 settled 且菜品 done」。
 * ⚠️ 最后一个会话是 **abandoned**，用于验证「放弃的会话不惩罚」。
 */
const sessions: Array<{
  id: number
  status: 'settled' | 'abandoned'
  daysAgo: number
  dishes: Array<[number, 'done' | 'pending']>
}> = [
  { id: 1, status: 'settled', daysAgo: 0, dishes: [[1, 'done'], [6, 'done']] },
  { id: 2, status: 'settled', daysAgo: 3, dishes: [[5, 'done']] },
  { id: 3, status: 'settled', daysAgo: 10, dishes: [[3, 'done']] },
  { id: 4, status: 'abandoned', daysAgo: 0, dishes: [[4, 'done']] },
]

sqlite.transaction(() => {
  const insDef = sqlite.prepare(
    'insert into ingredient_definition (id, name, name_normalized, category_id, created_at, updated_at) values (?,?,?,?,?,?)',
  )
  for (const [id, name, cat] of definitions) insDef.run(id, name, name, needCat(cat), now, now)

  const insRecipe = sqlite.prepare(
    'insert into recipe (id, name, name_normalized, created_at, updated_at) values (?,?,?,?,?)',
  )
  const insLine = sqlite.prepare(
    'insert into recipe_ingredient (recipe_id, definition_id, quantity, unit, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?)',
  )
  for (const r of recipes) {
    insRecipe.run(r.id, r.name, r.name, now, now)
    r.lines.forEach(([defId, qty, unit], i) => insLine.run(r.id, defId, qty, unit, i, now, now))
  }

  /* ---------- 标签：自定义两个（预设已由迁移 0012 播种） ---------- */
  const insTag = sqlite.prepare(
    'insert into recipe_tag (name, name_normalized, category, is_system, sort_order, created_at) values (?,?,?,?,?,?)',
  )
  for (const t of customTags) {
    insTag.run(t.name, t.name.toLowerCase(), t.category, 0, 0, now)
  }

  const findTag = sqlite.prepare('select id from recipe_tag where name_normalized = ?')
  const insLink = sqlite.prepare(
    'insert or ignore into recipe_tag_link (recipe_id, tag_id, created_at) values (?,?,?)',
  )
  function linkTag(recipeId: number, tagName: string): void {
    const row = findTag.get(tagName.toLowerCase()) as { id: number } | undefined
    if (row === undefined) {
      throw new Error(`演示数据依赖的标签不存在（迁移 0012 未生效？）：${tagName}`)
    }
    insLink.run(recipeId, row.id, now)
  }
  for (const r of recipes) for (const t of r.tags) linkTag(r.id, t)
  for (const [recipeId, tagName] of customLinks) linkTag(recipeId, tagName)

  /* ---------- 偏好 ---------- */
  const insPref = sqlite.prepare(
    'insert into recipe_preference (recipe_id, value, created_at, updated_at) values (?,?,?,?)',
  )
  for (const [recipeId, value] of preferences) insPref.run(recipeId, value, now, now)

  /* ---------- 库存 ---------- */
  const insStock = sqlite.prepare(
    'insert into standard_ingredient (definition_id, quantity, unit, purchase_date, expiry_date, expiry_date_source, storage_method, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)',
  )
  for (const [defId, qty, unit, expiry, source] of stock) {
    insStock.run(defId, qty, unit, day(-10), expiry, source, '常温', now, now)
  }

  /* ---------- 烹饪历史 ---------- */
  const insSession = sqlite.prepare(
    'insert into cooking_session (id, status, recipe_revision, started_at, finished_at, settled_at, created_at, updated_at) values (?,?,?,?,?,?,?,?)',
  )
  const insDish = sqlite.prepare(
    'insert into cooking_session_dish (session_id, recipe_id, status, confirmed_revision, sort_order, created_at, updated_at) values (?,?,?,?,?,?,?)',
  )
  for (const s of sessions) {
    const at = isoDaysAgo(s.daysAgo)
    const settledAt = s.status === 'settled' ? at : null
    insSession.run(s.id, s.status, 0, at, settledAt, settledAt, now, now)
    s.dishes.forEach(([recipeId, status], i) => {
      insDish.run(s.id, recipeId, status, 0, i, now, now)
    })
  }
})()

/* ============================================================
 * 3) 结果摘要
 * ============================================================ */
const count = (table: string): number =>
  (sqlite.prepare(`select count(*) c from "${table}"`).get() as { c: number }).c
const one = (sql: string): number => (sqlite.prepare(sql).get() as { c: number }).c

const defCount = count('ingredient_definition')
const recipeCount = count('recipe')
const stockCount = count('standard_ingredient')
const tagTotal = count('recipe_tag')
const tagPreset = one('select count(*) c from recipe_tag where is_system = 1')
const tagCustom = one('select count(*) c from recipe_tag where is_system = 0')
const tagUnclassified = one('select count(*) c from recipe_tag where category is null')
const prefLike = one("select count(*) c from recipe_preference where value = 'like'")
const prefDislike = one("select count(*) c from recipe_preference where value = 'dislike'")
const settledSessions = one("select count(*) c from cooking_session where status = 'settled'")
const abandonedSessions = one("select count(*) c from cooking_session where status = 'abandoned'")
/** 只统计**会被推荐计入**的完成菜品：settled 会话 + done 菜品 */
const doneInSettled = one(
  'select count(*) c from cooking_session_dish d join cooking_session s on s.id = d.session_id ' +
    "where s.status = 'settled' and d.status = 'done'",
)
const expiring = one(
  "select count(*) c from standard_ingredient where expiry_date is not null and expiry_date >= date('now','localtime')",
)
const expired = one(
  "select count(*) c from standard_ingredient where expiry_date is not null and expiry_date < date('now','localtime')",
)

sqlite.close()

console.log(`[seed-v023-demo] 完成：${dbPath}`)
console.log(`  食材定义 ${defCount} · 菜谱 ${recipeCount} · 库存 ${stockCount}`)
console.log(
  `  标签 ${tagTotal}（预设 ${tagPreset} / 自定义 ${tagCustom} / 未分类 ${tagUnclassified}）`,
)
console.log(`  偏好：喜欢 ${prefLike} · 不喜欢 ${prefDislike}`)
console.log(
  `  历史：settled ${settledSessions} 个会话 / 计入完成的菜品 ${doneInSettled} 道` +
    `（另有 ${abandonedSessions} 个**放弃**会话，按规则**不惩罚**）`,
)
console.log(`  库存有效期：未过期 ${expiring} 项 · 已过期 ${expired} 项`)
console.log('')
console.log('下一步（**用户自行执行**，DSH 不代劳、也不会碰真实库）：')
console.log('  # 窗口1：用这个临时库启动一个隔离后端（不要用正式端口/正式库）')
console.log(`  cd ${serverRoot}`)
console.log(`  $env:HOME_CHEF_DB_PATH = '${dbPath}'`)
console.log('  $env:PORT = \'3010\'')
console.log('  Remove-Item Env:HOME_CHEF_ALLOW_REAL_DB -ErrorAction SilentlyContinue')
console.log('  node --import tsx src/server.ts')
console.log('')
console.log('  # 窗口2：隔离前端指向该后端')
console.log('  cd D:\\HomeChef\\client')
console.log('  $env:HOME_CHEF_API_TARGET = \'http://127.0.0.1:3010\'')
console.log('  npm run dev -- --host 127.0.0.1 --port 5180 --strictPort')
console.log('')
console.log('  打开 http://127.0.0.1:5180/ 体验；体验完直接删除整个临时目录即可。')
console.log('  ⚠️ 全程**不要**对真实库执行迁移，也不要设置 HOME_CHEF_ALLOW_REAL_DB。')
