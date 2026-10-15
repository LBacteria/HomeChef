import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

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
 *
 * ⚠️ **解析失败必须抛错，绝不静默回退**：
 *    若 `realpathSync` 失败却仍返回「未解析的路径」，后续的
 *    `forbidden.includes(actual)` 比对就会基于**不可靠的路径**进行，
 *    可能在真实库存在软链接/junction 时**误判为安全**。
 *    宁可拒绝（抛错 → 调用方退出），也不放行一个未经验证的路径。
 *
 * @throws Error 当存在祖先无法被 realpath 解析时
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

  // ⚠️ 走到根仍不存在 → 无法可靠解析
  if (!existsSync(cur)) {
    throw new Error(
      `[safe-db-path] 无法解析路径的最近存在祖先（已上溯至根）：${String(target)}`,
    )
  }

  // ⚠️ realpath 失败 → 抛错，绝不回退到未解析路径
  let base: string
  try {
    base = realpathSync(cur)
  } catch (e) {
    throw new Error(
      `[safe-db-path] realpath 解析失败，拒绝继续（不回退未验证路径）：${cur}\n` +
        `             原因：${e instanceof Error ? e.message : String(e)}`,
    )
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
 * @param options    `allowRealDb: true` 时**仅**放行真实库路径（默认拒绝）
 */
export function assertSafeDbPath(
  rawPath: string,
  serverRoot: string,
  options: { allowRealDb?: boolean } = {},
): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error(
      '[safe-db-path] dbPath 为空或纯空白 —— 拒绝打开（空值会让服务回退到真实数据库）',
    )
  }

  /*
   * ⚠️⚠️ 解析基准一致性（本函数最关键的不变式）
   *
   * `db/index.ts` L24–26 的实际解析规则是：
   *     HOME_CHEF_DB_PATH 已设置 → resolve(该值)      ← 基准是 **process.cwd()**
   *     未设置                   → <serverRoot>/data/homechef.db
   *
   * 而本函数若用 `resolve(serverRoot, rawPath)` 解析**相对路径**，
   * 基准是 serverRoot —— 两者**不一致**。
   *
   * 后果：相对路径 `data/homechef.db` 在本函数中解析为
   *   <serverRoot>/data/homechef.db（被正确拒绝），
   * 但 `db/index.ts` 会把它解析为 <cwd>/data/homechef.db（可能是**别的**库）。
   * 即「校验的路径」与「实际打开的路径」可能不是同一个 —— 校验形同虚设。
   *
   * ✅ 解决方式：**要求调用方传入绝对路径**，使两种基准下解析结果一致。
   *    这是唯一能同时满足「校验可靠」与「不改动 db/index.ts」的做法。
   */
  if (!isAbsolute(rawPath)) {
    throw new Error(
      `[safe-db-path] 必须是**绝对路径**（相对路径在 db/index.ts 中以 cwd 为基准解析，` +
        `与本函数以 serverRoot 为基准不一致，会导致校验与实际连接指向不同位置）：${rawPath}`,
    )
  }

  const resolved = resolve(serverRoot, rawPath)

  const realDb = resolve(serverRoot, 'data', 'homechef.db')
  const forbidden = [realDb, `${realDb}-wal`, `${realDb}-shm`].map((p) =>
    normCase(realpathOfNearestExisting(p)),
  )

  const actual = normCase(realpathOfNearestExisting(resolved))
  if (forbidden.includes(actual)) {
    /*
     * ⚠️⚠️ 这里是唯一的"放行真实库"入口，且必须由调用方**显式**传入
     *      allowRealDb: true 才会走到。默认拒绝。
     *
     *     只有 `db:migrate` 在用户明确设置 HOME_CHEF_ALLOW_REAL_DB=1
     *     时才会传入该选项；其余所有调用方（含 harness/verify 脚本）
     *     一律使用默认值 → 行为完全不变。
     */
    if (options.allowRealDb === true && actual === normCase(realpathOfNearestExisting(realDb))) {
      return resolved
    }

    throw new Error(
      `[safe-db-path] dbPath 解析后指向真实数据库：${actual}\n` +
        '拒绝打开（这会造成真实数据被读写）。请改用独立的临时目录。',
    )
  }

  return resolved
}
