/**
 * 执行 migration。
 *
 * 用法：npm run db:migrate --workspace server
 *
 * migration SQL 文件位于 server/drizzle/
 * 数据库文件由 `HOME_CHEF_DB_PATH` 决定，未设置时回退 `server/data/homechef.db`。
 *
 * ============================================================
 * ⚠️⚠️ 为什么本文件使用**动态导入**
 * ============================================================
 *
 * `./index.js` 是「**导入即连接**」：它的模块顶层就执行
 * `new Database(databasePath)`（见 db/index.ts 第 34 行）。
 *
 * 而 `databasePath` 的解析规则是：
 *   HOME_CHEF_DB_PATH 已设置 → resolve(该值)
 *   未设置                   → <serverRoot>/data/homechef.db   ← 真实库
 *
 * 因此**只要静态 import 了 ./index.js，数据库就已经被打开**，
 * 任何事后检查都为时已晚 —— 一旦环境变量缺失或路径打偏，
 * 迁移会直接在真实库上执行 DDL。
 *
 * 所以本文件必须在**导入数据库模块之前**完成路径校验，
 * 校验不通过时**立即以非零状态退出**，绝不触碰任何数据库文件。
 *
 * ⚠️ 严禁把 `./index.js` 改回静态 import —— 那会绕过上面全部保护。
 */

import { resolve } from 'node:path'

/* ============================================================
 * ① 路径预检查（★ 必须早于任何数据库模块的导入）
 * ============================================================ */

/** `server/` 目录：src/db/ → 上溯两级 */
const serverRoot = resolve(import.meta.dirname, '..', '..')

const rawPath = process.env.HOME_CHEF_DB_PATH

if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
  console.error(
    '[migrate] 拒绝执行：未设置 HOME_CHEF_DB_PATH。\n' +
      '          未设置时迁移会指向真实数据库 <server>/data/homechef.db。\n' +
      '          请显式指定一个**绝对路径**的临时数据库，例如：\n' +
      '            $env:HOME_CHEF_DB_PATH = "C:\\Temp\\hc-<GUID>\\test.db"',
  )
  process.exit(1)
}

/**
 * 解析为明确的绝对路径。
 *
 * ⚠️ 基准必须是 **`process.cwd()`**，与 `db/index.ts` L25 的
 *    `resolve(process.env.HOME_CHEF_DB_PATH)` **完全一致**。
 *
 *    这样「本文件校验的路径」与「数据库模块实际打开的路径」
 *    在**同一基准**下解析，杜绝相对路径导致的两者分歧。
 *    （`assertSafeDbPath` 内部会再次 `resolve(serverRoot, ...)`，
 *      但因为这里传入的已是绝对路径，`resolve` 会原样返回它，
 *      因此两次解析结果必然相同。）
 */
const absolutePath = resolve(rawPath)

/** 校验通过后的最终路径 */
let databasePath = ''

/*
 * ⚠️ 迁移真实库的唯一入口：必须显式设置 HOME_CHEF_ALLOW_REAL_DB=1。
 *
 * 设计要点（**不得放宽**）：
 *   - 默认关闭：未设置时行为与之前**完全一致**（拒绝真实库）
 *   - 只放行**真实库本身**，不放行 server/data/ 下的其他文件
 *   - 不提供"任意路径绕过"能力 —— 开关与路径必须**同时**满足
 *   - 这是给 `db:migrate` 专用的一次性授权，harness / verify 脚本
 *     一律走默认值，行为不变
 */
const allowRealDb = process.env.HOME_CHEF_ALLOW_REAL_DB === '1'

try {
  // 复用既有安全校验：拒绝指向真实库及其 -wal / -shm
  // ⚠️ 从同目录模块导入（而非 harness）——harness 位于 rootDir 之外，
  //    从 src/ 内导入它会触发 TS6059
  const { assertSafeDbPath } = await import('./safe-db-path.js')
  assertSafeDbPath(absolutePath, serverRoot, { allowRealDb })
  databasePath = absolutePath
} catch (e) {
  console.error(
    `[migrate] 拒绝执行：数据库路径未通过安全校验。\n` +
      `          路径：${absolutePath}\n` +
      `          原因：${e instanceof Error ? e.message : String(e)}`,
  )
  process.exit(1)
}

// ⚠️ 额外兜底：即便上面的校验被改动，也绝不允许落到 server/data/ 下 ——
//    **唯一例外**是已显式授权的真实库本身
const forbiddenReal = resolve(serverRoot, 'data').toLowerCase()
const realDbPath = resolve(serverRoot, 'data', 'homechef.db').toLowerCase()
const insideServerData =
  databasePath.toLowerCase() === forbiddenReal ||
  databasePath.toLowerCase().startsWith(`${forbiddenReal}\\`) ||
  databasePath.toLowerCase().startsWith(`${forbiddenReal}/`)

if (insideServerData && !(allowRealDb && databasePath.toLowerCase() === realDbPath)) {
  console.error(
    `[migrate] 拒绝执行：解析后的路径位于受保护的 server/data/ 目录内。\n` +
      `          路径：${databasePath}\n` +
      `          （仅当 HOME_CHEF_ALLOW_REAL_DB=1 且目标恰为 homechef.db 时才放行）`,
  )
  process.exit(1)
}

console.log(`数据库文件：${databasePath}`)

/* ============================================================
 * ② 校验通过后，才导入数据库模块并执行迁移
 * ============================================================ */

const { db, sqlite } = await import('./index.js')
const { migrate } = await import('drizzle-orm/better-sqlite3/migrator')

// 执行前确认外键约束处于开启状态。
// 见 DATABASE_DESIGN.md 第 13.1 节。
const foreignKeys = sqlite.pragma('foreign_keys', { simple: true })
console.log(`foreign_keys = ${foreignKeys}`)

if (foreignKeys !== 1) {
  console.error('错误：foreign_keys 未开启，ON DELETE CASCADE 将不生效。')
  process.exit(1)
}

migrate(db, { migrationsFolder: './drizzle' })

console.log('migration 执行完成。')

// 列出数据库中的表，便于确认结果
const tables = sqlite
  .prepare(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  )
  .all() as Array<{ name: string }>

console.log(`表：${tables.map((t) => t.name).join(', ')}`)

sqlite.close()
