/**
 * verify 脚本的**测试服务生命周期**统一实现。
 *
 * ============================================================
 * 为什么不用 `spawn('npx', ['tsx', 'src/server.ts'], { shell: true })`
 * ============================================================
 *
 * Windows 下 `shell: true` 会插入一层 `cmd.exe`：
 *
 *   npx-cli.js  →  cmd.exe /d /s /c  →  tsx cli.mjs  →  node(preflight) src/server.ts
 *      (L1)             (L2)                (L3)                  (L4)
 *
 * 而脚本持有的 `proc` 句柄指向 **L1**，`proc.kill()` **只终止 L1 自身**，
 * L2–L4 全部逃逸成为孤儿。实测证据（2026-10-12）：
 *   - 一次「全绿」的 18 脚本回归残留 **17 组 × 4 层 = 68 个孤儿进程**；
 *   - 每组 L1 的父进程已死，而孙子进程仍在监听 127.0.0.1 高位端口。
 *
 * ============================================================
 * 现在的做法：直接启动 Node，不经过任何 shell
 * ============================================================
 *
 *   node --require <tsx>/dist/preflight.cjs --import <tsx>/dist/loader.mjs src/server.ts
 *
 * 于是 `proc.pid` **就是真正的服务进程**，`proc.kill()` 立即生效。
 * 这与 `npx tsx` 最终实际执行的命令**逐参数一致**（已由进程命令行核实），
 * 因此行为、环境变量、工作目录与退出码语义保持不变。
 *
 * ⚠️ 本模块**不引入** PowerShell Job Object —— 项目里那套（`scripts/homechef-job-holder.ps1`）
 *    是为长驻的 `Start-HomeChef.bat` 设计的，与短生命周期的 verify 脚本跨语言协作
 *    成本远高于收益。同一时刻只保留**一套**进程管理机制。
 *
 * ⚠️ 本模块**只**通过 `ChildProcess` 句柄操作**自己 spawn 的**子进程：
 *    全部清理动作都限定在已记录的 PID 上，绝不按进程名/命令行/端口模糊匹配。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

/* ============================================================
 * tsx 挂钩解析
 * ============================================================ */

/**
 * 解析 tsx 的 Node 挂钩文件绝对路径。
 *
 * ⚠️ 不硬编码 `dist/...` 路径，而是通过包解析取得：
 *    `require.resolve('tsx')` 命中 package.json 的 `"."` 导出 → `dist/loader.mjs`，
 *    `preflight.cjs` 与之同目录。
 */
export function resolveTsxHooks(): { preflight: string; loader: string } {
  const loader = require.resolve('tsx')
  const preflight = join(dirname(loader), 'preflight.cjs')
  return { preflight, loader }
}

/* ============================================================
 * dbPath 安全校验
 * ============================================================ */

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
      '[server-lifecycle] dbPath 为空或纯空白 —— 拒绝启动（空值会让服务回退到真实数据库）',
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
      `[server-lifecycle] dbPath 解析后指向真实数据库：${actual}\n` +
        '拒绝启动测试服务（这会造成真实数据被读写）。请改用独立的临时目录。',
    )
  }

  return resolved
}

/* ============================================================
 * 进程登记与全局清理
 * ============================================================ */

/** 已启动、尚待回收的进程（供 exit / signal 兜底使用） */
const liveProcesses = new Set<ChildProcess>()

let exitHookInstalled = false
let signalHandlersInstalled = false

/** 停止所有在册进程（供信号处理使用）。幂等；单个失败不影响其他。 */
async function stopAll(): Promise<void> {
  const procs = [...liveProcesses]
  await Promise.all(
    procs.map(async (p) => {
      try {
        await terminateProcess(p)
      } catch {
        /* 清理路径不应再抛错 */
      }
    }),
  )
  liveProcesses.clear()
}

/** 同步兜底（仅用于 `process.on('exit')`，那里不能 await） */
function syncKill(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 已退出则忽略 */
  }
  // 兜底：**只**对本进程自己 spawn 的 PID 做树杀
  if (process.platform === 'win32' && proc.pid !== undefined) {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 安装 `exit` 同步兜底。
 *
 * ⚠️ `process.on('exit')` **不能 await**，因此这里只做同步强杀；
 *    真正的异步优雅停止由 `stopAll()`（信号处理）与各脚本的 `finally` 负责。
 */
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const proc of liveProcesses) syncKill(proc)
    liveProcesses.clear()
  })
}

/**
 * 安装 SIGINT / SIGTERM 处理器：**等待异步清理完成**后再退出。
 *
 * ⚠️ 不使用「`process.exit()` 后指望 `exit` 事件里做异步清理」的写法 ——
 *    `exit` 处理器无法 await，那样会在清理完成前强制终止父进程。
 *
 * ⚠️ `handling` 标志确保**重复信号不会触发并发清理**；
 *    第二次同信号在首次清理完成前被直接忽略。
 */
function installSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true

  let handling = false

  const onSignal = (signal: NodeJS.Signals): void => {
    if (handling) return // 并发清理保护
    handling = true

    void (async () => {
      try {
        await stopAll()
      } finally {
        // 128 + 信号号：SIGINT=2 → 130，SIGTERM=15 → 143
        const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1
        process.exit(code)
      }
    })()
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

/* ============================================================
 * startServer
 * ============================================================ */

export interface StartServerOptions {
  /** 启动服务的工作目录（应为 `server/`，因为入口是 `src/server.ts`） */
  cwd: string
  /** 监听端口 */
  port: number
  /** 临时数据库路径（通过 HOME_CHEF_DB_PATH 注入，**绝不应指向真实库**） */
  dbPath: string
  /**
   * 标准输出模式：
   *   - `'ignore'`（默认）—— 与既有脚本一致，不读输出
   *   - `'pipe'` —— 捕获输出，用于启动失败时给出诊断
   */
  stdio?: 'ignore' | 'pipe'
  /**
   * 覆盖被测服务的入口文件（**仅用于负向测试**，例如验证 spawn 失败）。
   * 生产调用不应传此项。
   */
  entryFile?: string
  /** 覆盖 node 可执行文件（**仅用于负向测试**）。 */
  execPath?: string
}

export interface ServerHandle {
  /** 真正的服务进程（不是 shell 外壳） */
  proc: ChildProcess
  port: number
  /** 幂等的停止函数；重复调用安全 */
  stop: () => Promise<void>
  /**
   * 进程是否已「结束」——包括**正常退出、被信号终止、以及 spawn 失败**。
   * 供 `waitForReady` 判定「提前结束」。
   */
  hasExited: () => boolean
  /** spawn 失败时的错误（无失败则为 null） */
  spawnError: () => Error | null
  /** 已捕获的输出（仅 stdio: 'pipe' 时非空） */
  output: () => string
  /** 收集到的最近 stderr（用于失败诊断） */
  stderr: () => string
}

const KILL_GRACE_MS = 5000
const TERMINATE_GRACE_MS = 2000

/** 单个进程的终止流程（供 stop 与信号清理共用） */
async function terminateProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    liveProcesses.delete(proc)
    return
  }

  // ① 温和终止
  try {
    proc.kill()
  } catch {
    /* 已退出则忽略 */
  }
  if (await waitForExit(proc, KILL_GRACE_MS)) {
    liveProcesses.delete(proc)
    return
  }

  // ② 强杀
  try {
    proc.kill('SIGKILL')
  } catch {
    /* 忽略 */
  }
  if (await waitForExit(proc, TERMINATE_GRACE_MS)) {
    liveProcesses.delete(proc)
    return
  }

  // ③ 最后手段：树杀 —— 但**仅当进程仍未退出**且 PID 仍属于它时才执行，
  //    避免 PID 复用导致误杀无关进程。
  if (process.platform === 'win32' && proc.pid !== undefined) {
    const pid = proc.pid
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        /* 忽略 */
      }
      await waitForExit(proc, TERMINATE_GRACE_MS)
    }
  }

  liveProcesses.delete(proc)
}

/**
 * 启动测试服务。
 *
 * `stop()` 是**幂等**的：进程已退出时调用不会抛错。
 * 启动前的安全校验失败会**同步抛错**，不会留下任何子进程。
 */
export function startServer(opts: StartServerOptions): ServerHandle {
  installExitHook()
  installSignalHandlers()

  const cwd = resolve(opts.cwd)

  // ① 安全校验必须在 spawn **之前**
  const safeDbPath = assertSafeDbPath(opts.dbPath, cwd)

  const { preflight, loader } = resolveTsxHooks()
  const execPath = opts.execPath ?? process.execPath
  const entryFile = opts.entryFile ?? 'src/server.ts'

  const proc = spawn(
    execPath,
    ['--require', preflight, '--import', pathToFileURL(loader).href, entryFile],
    {
      cwd,
      env: {
        ...process.env,
        PORT: String(opts.port),
        HOME_CHEF_DB_PATH: safeDbPath,
      },
      stdio: opts.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'ignore',
      windowsHide: true,
    },
  )

  liveProcesses.add(proc)

  // ② spawn 失败（ENOENT / EACCES 等）会走 error 事件而非 exit 事件 —— 必须记录
  let spawnError: Error | null = null
  proc.on('error', (err: Error) => {
    spawnError = err
  })

  let outBuf = ''
  let errBuf = ''
  if (opts.stdio === 'pipe') {
    proc.stdout?.on('data', (d) => {
      outBuf += String(d)
      if (outBuf.length > 200_000) outBuf = outBuf.slice(-100_000)
    })
    proc.stderr?.on('data', (d) => {
      errBuf += String(d)
      if (errBuf.length > 200_000) errBuf = errBuf.slice(-100_000)
    })
  }

  let stopPromise: Promise<void> | null = null

  /** 结束 = 正常退出 | 被信号终止 | spawn 失败 */
  const hasExited = (): boolean =>
    spawnError !== null || proc.exitCode !== null || proc.signalCode !== null

  async function stop(): Promise<void> {
    if (stopPromise !== null) return stopPromise // 幂等
    stopPromise = terminateProcess(proc)
    return stopPromise
  }

  return {
    proc,
    port: opts.port,
    stop,
    hasExited,
    spawnError: () => spawnError,
    output: () => outBuf,
    stderr: () => errBuf,
  }
}

/* ============================================================
 * 等待退出（带监听器/定时器清理）
 * ============================================================ */

/** 等待进程退出，返回是否在超时前退出 */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)

  return new Promise<boolean>((resolvePromise) => {
    let settled = false

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      proc.removeListener('error', onError)
      resolvePromise(ok)
    }

    const onExit = (): void => finish(true)
    const onError = (): void => finish(true) // spawn 失败同样视为「已结束」
    const timer = setTimeout(() => finish(false), timeoutMs)

    proc.once('exit', onExit)
    proc.once('error', onError)
  })
}

/* ============================================================
 * waitForReady
 * ============================================================ */

export interface WaitForReadyOptions {
  /** 例如 `http://127.0.0.1:12345/health` */
  url: string
  /** **绝对**超时（毫秒），必须设置；到期后抛错 */
  timeoutMs: number
  /** 轮询间隔（默认 300ms，与既有脚本一致） */
  intervalMs?: number
  /** 所属服务句柄：用于检测「服务提前结束」 */
  handle?: ServerHandle
}

export class ServerStartupError extends Error {
  constructor(
    message: string,
    readonly detail = '',
  ) {
    super(message)
    this.name = 'ServerStartupError'
  }
}

/** 单次就绪探测的超时上限（即使端口被 DROP 也不会挂死） */
function probeTimeoutMs(intervalMs: number): number {
  return Math.max(300, Math.min(intervalMs * 2, 2000))
}

/**
 * 等待服务就绪。
 *
 * 失败路径**全部**抛 `ServerStartupError`，绝不无限等待：
 *   ① spawn 失败（ENOENT 等）—— 立即失败
 *   ② 服务进程提前退出 —— 立即失败，并附带输出摘要
 *   ③ 就绪探测持续被拒或单次请求挂起 —— 受 deadline 约束
 *
 * 就绪判定与既有脚本一致：HTTP 可达即为就绪（接受 2xx/404）。
 */
export async function waitForReady(opts: WaitForReadyOptions): Promise<void> {
  const interval = opts.intervalMs ?? 300
  const deadline = Date.now() + opts.timeoutMs
  const probeMs = probeTimeoutMs(interval)
  let lastErr = ''

  while (Date.now() < deadline) {
    // ① spawn 本身失败 → 立刻报错（不白等超时）
    const se = opts.handle?.spawnError()
    if (se) {
      throw new ServerStartupError(`服务进程启动失败：${se.message}`, se.stack ?? '')
    }

    // ② 服务已死 → 立刻报错
    if (opts.handle?.hasExited()) {
      const err = opts.handle.stderr().slice(-1500)
      const out = opts.handle.output().slice(-800)
      throw new ServerStartupError(
        '服务进程在就绪前已退出',
        [err && `stderr:\n${err}`, out && `stdout:\n${out}`].filter(Boolean).join('\n'),
      )
    }

    // ③ 单次探测必须有独立超时，避免 fetch 挂起拖死整个 deadline
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const thisTimeout = Math.min(probeMs, remaining)

    try {
      const res = await fetch(opts.url, {
        signal: AbortSignal.timeout(thisTimeout),
      })
      if (res.ok || res.status === 404) return
      lastErr = `HTTP ${res.status}`
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }

    // 剩余时间不足一轮时不再空转
    if (Date.now() + interval > deadline) break
    await sleep(interval)
  }

  const detail = opts.handle?.stderr().slice(-1500) ?? ''
  throw new ServerStartupError(
    `服务在 ${opts.timeoutMs}ms 内未就绪（最后错误：${lastErr}）`,
    detail,
  )
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
