/**
 * 内容包导入 **CLI + 兼容再导出**（薄封装，无独立导入逻辑）
 *
 * ⚠️⚠️ v0.2.3 统一实现：唯一导入实现是 `./importer.ts` 的
 *    `importRecipeContent(db, options)`。此前本文件曾有一份**独立重复实现**，
 *    两套实现会让"真实导入"产生行为分歧（键名、note/line_key、dry-run 口径、
 *    别名/单位校验都可能不同），故已收敛为薄封装。
 *
 * 保留的兼容面（既有调用方无需改动）：
 *   · `importRecipeContent`（再导出；同时接受 better-sqlite3 与 drizzle 实例）
 *   · `loadContentPack`、`DEFAULT_CONTENT_PATH`、`ContentPack` / `ContentDefinition` /
 *     `ContentIngredient` / `ContentRecipe` / `ImportOptions` / `ImportStats` 类型
 *
 * CLI 契约（与改造前一致）：
 *   · 默认 **dry-run**（零写入）；真实写入必须显式 `--apply`
 *   · `--db <绝对路径>`（缺省或非绝对路径 → 退出码 2；**绝不默认任何库，尤其不默认真实库**）
 *   · `--dry-run`、`--db=`、`--content=` 等价写法；`--content` 可重复（多包依次导入）
 *   · 路径经 `assertSafeDbPath(..., { allowRealDb: false })` 校验
 *   · 不启动服务，不导入 `src/db/index.js`
 */
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  importRecipeContent as importRecipeContentCore,
  type ContentDefinition,
  type ContentIngredient,
  type ContentPackage,
  type ContentRecipe,
  type ImportOptions,
  type ImportStats,
} from './importer.js'

export type { ContentDefinition, ContentIngredient, ContentRecipe, ImportOptions, ImportStats }
/** 兼容旧名：`ContentPack` 即 `ContentPackage` */
export type ContentPack = ContentPackage

const CONTENT_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = resolve(CONTENT_DIR, '..', '..')
export const DEFAULT_CONTENT_PATH = resolve(CONTENT_DIR, 'content.json')

/** 兼容：better-sqlite3 实例或 drizzle 实例都能用 */
export type ContentDb =
  | Database.Database
  | { $client: Database.Database }
  | { client: Database.Database }

function toSqlite(db: ContentDb): Database.Database {
  const anyDb = db as unknown as { prepare?: unknown; $client?: Database.Database; client?: Database.Database }
  if (typeof anyDb.prepare === 'function') return db as Database.Database
  if (anyDb.$client !== undefined) return anyDb.$client
  if (anyDb.client !== undefined) return anyDb.client
  throw new Error('[v023-content] 无法从传入的 db 解析出 better-sqlite3 实例')
}

/**
 * 幂等导入（**唯一实现**在 `./importer.ts`）。
 * 调用方建议用事务包裹：`db.transaction(() => importRecipeContent(db, {...}))()`。
 */
export function importRecipeContent(db: ContentDb, options: ImportOptions = {}): ImportStats {
  /**
   * 保留子代理原入口语义：**不传 `content` / `contentPath` 时默认导入
   * `content.json`**（`DEFAULT_CONTENT_PATH`）。否则调用方会拿到
   * 「需要 content 或 contentPath」这种对默认用法不友好的报错。
   */
  const hasSource = options.content !== undefined || options.contentPath !== undefined
  const effective: ImportOptions = hasSource
    ? options
    : { ...options, contentPath: DEFAULT_CONTENT_PATH }
  return importRecipeContentCore(toSqlite(db), effective)
}

/** 读取并做基础结构校验（不做数据库访问） */
export function loadContentPack(path: string): ContentPackage {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ContentPackage
  const defs = raw.ingredients ?? raw.definitions
  if (!Array.isArray(defs) || !Array.isArray(raw.recipes)) {
    throw new Error(`[v023-content] 内容包结构不合法：${path}`)
  }
  for (const r of raw.recipes) {
    if (typeof r.name !== 'string' || r.name.trim().length === 0) {
      throw new Error(`[v023-content] 菜谱缺少合法 name：${path}`)
    }
  }
  return raw
}

/* ============================================================
 * CLI
 * ============================================================ */

interface CliArgs {
  dbPath: string | null
  apply: boolean
  contents: string[]
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dbPath: null, apply: false, contents: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--dry-run') args.apply = false
    else if (a === '--db') args.dbPath = argv[++i] ?? null
    else if (a.startsWith('--db=')) args.dbPath = a.slice('--db='.length)
    else if (a === '--content') args.contents.push(argv[++i] ?? '')
    else if (a.startsWith('--content=')) args.contents.push(a.slice('--content='.length))
  }
  return args
}

async function main(): Promise<number> {
  const { dbPath, apply, contents } = parseCliArgs(process.argv.slice(2))

  if (dbPath === null || dbPath.trim().length === 0) {
    console.error(
      '[v023-content] 必须用 --db <绝对路径> 指定目标数据库。\n' +
        '             本 CLI 不会自动连接 server/data/homechef.db。',
    )
    return 2
  }
  if (!isAbsolute(dbPath)) {
    console.error(`[v023-content] --db 必须是绝对路径：${dbPath}`)
    return 2
  }

  // ⚠️ 复用项目既有的路径安全校验：默认拒绝真实库及其 -wal/-shm
  const { assertSafeDbPath } = await import('../../src/db/safe-db-path.js')
  let safePath: string
  try {
    safePath = assertSafeDbPath(dbPath, SERVER_ROOT, { allowRealDb: false })
  } catch (e) {
    console.error(`[v023-content] 拒绝执行：${e instanceof Error ? e.message : String(e)}`)
    return 2
  }

  const targets =
    contents.filter((c) => c.trim() !== '').length > 0
      ? contents.filter((c) => c.trim() !== '').map((c) => (isAbsolute(c) ? c : resolve(c)))
      : [DEFAULT_CONTENT_PATH]

  const dryRun = !apply
  console.log(`[v023-content] 模式：${dryRun ? 'DRY-RUN（零写入）' : 'APPLY（写库）'}`)
  console.log(`[v023-content] 目标库：${safePath}`)
  console.log(`[v023-content] 内容包：${targets.join(' , ')}`)

  const db = new Database(safePath)
  db.pragma('foreign_keys = ON')
  try {
    /**
     * 前置检查：目标库必须**已经迁移到含内容表的版本**。
     * 否则只会抛出难以理解的 `no such table`；这里给出明确指引并拒绝执行。
     */
    const hasSchema =
      db
        .prepare(
          "select count(*) c from sqlite_master where type='table' and name in ('ingredient_definition','recipe','recipe_ingredient')",
        )
        .get() as { c: number }
    if (hasSchema.c < 3) {
      console.error(
        `[v023-content] 拒绝执行：目标库尚未迁移（缺少 ingredient_definition/recipe/recipe_ingredient）。\n` +
          `             请先对该库应用 server/drizzle/*.sql，再运行本 CLI。`,
      )
      return 2
    }
    for (const contentPath of targets) {
      // 结构先校验一次（缺键/缺名直接报错，不静默 0 导入）
      loadContentPack(contentPath)
      const stats = importRecipeContent(db, { contentPath, dryRun })
      console.log(
        `[v023-content] ${contentPath}\n` +
          `  定义 +${stats.definitions_added}（复用 ${stats.definitions_reused}，跳过 ${stats.definitions_skipped.length}）` +
          `｜别名 +${stats.aliases_added}（跳过 ${stats.aliases_skipped.length}）｜单位 +${stats.units_added}\n` +
          `  菜谱 +${stats.recipes_added}（跳过 ${stats.recipes_skipped.length}）｜配料 +${stats.ingredients_added}` +
          `｜步骤 +${stats.steps_added}｜标签关联 +${stats.tags_linked}（缺标签 ${stats.tags_missing.length}）`,
      )
      if (stats.recipes_skipped.length > 0) {
        console.log(`  跳过菜谱：${JSON.stringify(stats.recipes_skipped.slice(0, 8))}`)
      }
      if (stats.definitions_skipped.length > 0) {
        console.log(`  跳过定义：${JSON.stringify(stats.definitions_skipped.slice(0, 8))}`)
      }
    }
  } finally {
    db.close()
  }
  return 0
}

const invokedDirectly =
  process.argv[1] !== undefined && /import-v023-content\.(ts|js)$/.test(process.argv[1])
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[v023-content] 导入失败：${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    })
}
