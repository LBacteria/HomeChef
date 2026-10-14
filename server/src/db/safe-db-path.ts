import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/**
 * 数据库路径安全校验。
 *
 * 提取到 `src/` 内的原因：`harness/server-lifecycle.ts` 位于 `tsconfig` 的
 * `rootDir`（`src`）之外，任何 `src/` 内的文件静态或动态导入它都会触发
 * TS6059。把这段**纯函数**逻辑放在 `src/` 内，迁移入口与 harness 即可
 * **共用同一份实现**，既保留完整类型检查，又不重复安全逻辑。
 *
 * ⚠️ 本模块**不依赖任何业务代码**，只有 `node:fs` / `node:path`，
 *    因此被 harness 反向导入也不会引入业务耦合或循环依赖。
 */

/** Windows 文件系统大小写不敏感，比较前统一规范化 */
function normCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * 取「最近的存在祖先」的 realpath，再拼回剩余段。
 *
 * 目的：`dbPath` 指向的文件通常**尚不存在**（测试要新建它），
 * 但它的父目录可能存在且**可能是符号链接/junction**。
 * 直接用 `realpathSync(目标)` 会因文件不存在而抛错，
 * 因此从目标向上找到第一个存在的祖先做 realpath 解析，杜绝软链接绕过。
 */
function realpathOfNearestExisting(target: string): string {
  let cur = resolve(target)
  const rest: string[] = []

  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break // 已到根
    rest.unshift(basename(cur))
    cur = parent
  }

  let base: string
  try {
    base = existsSync(cur) ? realpathSync(cur) : cur
  } catch {
    base = cur
  }
  return rest.length > 0 ? resolve(base, ...rest) : resolve(base)
}

/**
 * 校验并规范化测试数据库路径。
 *
 * 拒绝：
 *   ① 非字符串 / 空串 / 纯空白
 *   ② 规范化（含软链接解析）后**等于真实库或其 WAL/SHM 伴生文件**
 *
 * ⚠️ **不回退默认库**：不安全时**在 spawn 之前**直接抛错，
 *    绝不让测试服务悄悄连上 `server/data/homechef.db`。
 *
 * @param rawPath   调用方给出的临时库路径
 * @param serverRoot  `server/` 目录（真实库位于其 `data/` 下）
 */
export function assertSafeDbPath(rawPath: string, serverRoot: string): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error(
      '[safe-db-path] dbPath 为空或纯空白 —— 拒绝打开（空值会让服务回退到真实数据库）',
    )
  }

  /*
   * ⚠️ 解析基准必须是 **serverRoot**，而不是本进程的 `process.cwd()`。
   *
   * 原因：`dbPath` 最终作为 `HOME_CHEF_DB_PATH` 传给子进程，而子进程的 cwd
   * 被设为 `opts.cwd`（= serverRoot）。后端 `db/index.ts` 用的是
   * `resolve(process.env.HOME_CHEF_DB_PATH)` —— 即**基于子进程 cwd**。
   * 若本模块用 `process.cwd()` 校验、子进程用 `serverRoot` 执行，
   * 相对路径就可能在校验时指向 A、在实际打开时指向 B（真实库）。
   * 统一基准后两者顺序一致，杜绝对相对路径的绕过。
   */
  const resolved = resolve(serverRoot, rawPath)

  const realDb = resolve(serverRoot, 'data', 'homechef.db')
  const forbidden = [realDb, `${realDb}-wal`, `${realDb}-shm`].map((p) =>
    normCase(realpathOfNearestExisting(p)),
  )

  const actual = normCase(realpathOfNearestExisting(resolved))
  if (forbidden.includes(actual)) {
    throw new Error(
      `[safe-db-path] dbPath 解析后指向真实数据库：${actual}\n` +
        '拒绝打开（这会造成真实数据被读写）。请改用独立的临时目录。',
    )
  }

  return resolved
}
