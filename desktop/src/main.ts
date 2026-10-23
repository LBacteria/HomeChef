import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type BetterSqlite3 from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'

import {
  HOMECHEF_APPLICATION_ID,
  applyRestore,
  confirmPendingRestore,
  inspectDatabaseFile,
  isActiveDatabasePath,
  resolvePendingRestore,
  rollbackPendingRestore,
} from './database-maintenance.js'

/**
 * HomeChef 桌面客户端主进程。
 *
 * 设计要点：
 *   1. 不要求用户单独安装 Node：Electron 自带运行时，Fastify 与 better-sqlite3
 *      都跑在本进程内，前端静态文件也由同一个 Fastify 实例托管。
 *   2. 数据库在用户目录，与仓库里的 server/data 完全隔离。
 *   3. 退出时显式关闭 Fastify 与 SQLite；单实例锁防止并发写同一个库。
 *   4. 备份 / 恢复的真正逻辑在 database-maintenance.ts（不依赖 electron），
 *      这里只负责对话框、互斥、关闭连接与重启。
 */

const APP_NAME = 'HomeChef'
const APP_VERSION = '0.2.5'
const IS_DEV = !app.isPackaged

// 主进程用 CommonJS：Electron 对 CJS 入口支持最稳，
// 而 ESM 入口在解析 electron 的命名导出时会失败。
const hereDir = __dirname

/* ------------------------------------------------------------------ */
/* 用户数据位置                                                         */
/* ------------------------------------------------------------------ */

const dataDirOverride = process.env.HOME_CHEF_DATA_DIR
const dataDir =
  dataDirOverride !== undefined && dataDirOverride.trim() !== ''
    ? path.resolve(dataDirOverride)
    : path.join(app.getPath('appData'), APP_NAME)

// Chromium 自己的缓存/存储也收进同一个目录。
app.setPath('userData', path.join(dataDir, 'chromium'))

const databaseDir = path.join(dataDir, 'data')
const databasePath = path.join(databaseDir, 'homechef.db')
const backupDir = path.join(dataDir, 'backups')
const logFilePath = path.join(dataDir, 'logs', 'main.log')

function log(message: string): void {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n'
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
    fs.appendFileSync(logFilePath, line)
  } catch {
    // 日志写入失败不能影响主流程
  }
  if (IS_DEV) {
    process.stdout.write(line)
  }
}

process.on('uncaughtException', (error) => {
  log('未捕获异常：' + (error instanceof Error ? (error.stack ?? error.message) : String(error)))
})
process.on('unhandledRejection', (reason) => {
  log('未处理的 Promise 拒绝：' + String(reason))
})

/* ------------------------------------------------------------------ */
/* 资源路径                                                            */
/* ------------------------------------------------------------------ */

function serverDistDir(): string {
  return IS_DEV
    ? path.resolve(hereDir, '..', '..', 'server', 'dist')
    : path.join(app.getAppPath(), 'server-dist')
}

function webRootDir(): string {
  return IS_DEV
    ? path.resolve(hereDir, '..', '..', 'client', 'dist')
    : path.join(process.resourcesPath, 'web')
}

function migrationsDir(): string {
  return IS_DEV
    ? path.resolve(hereDir, '..', '..', 'server', 'drizzle')
    : path.join(process.resourcesPath, 'drizzle')
}

function toFileUrl(...segments: string[]): string {
  return pathToFileURL(path.join(...segments)).href
}

/* ------------------------------------------------------------------ */
/* 后端服务                                                            */
/* ------------------------------------------------------------------ */

interface ServerContext {
  fastify: FastifyInstance
  sqlite: BetterSqlite3.Database
  origin: string
}

let serverContext: ServerContext | null = null
let mainWindow: BrowserWindow | null = null
let shuttingDown = false
let maintenanceBusy = false

function closeDatabaseQuietly(sqlite: BetterSqlite3.Database | null): void {
  if (!sqlite) {
    return
  }
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    log('checkpoint 失败：' + String(error))
  }
  try {
    sqlite.close()
  } catch (error) {
    log('关闭数据库失败：' + String(error))
  }
}

async function startServer(): Promise<ServerContext> {
  fs.mkdirSync(databaseDir, { recursive: true })

  // 上一次恢复还没被确认：按文件状态做幂等恢复。
  // blocked 必须拒绝启动——绝不能在「有标记、但库不可用」时新建空库。
  const recovery = resolvePendingRestore({ databasePath, migrationsDir: migrationsDir() })
  if (recovery.kind === 'blocked') {
    throw new Error(recovery.detail)
  }
  if (recovery.kind !== 'none') {
    log('启动期恢复：' + recovery.kind + ' — ' + recovery.detail)
  }

  // server/src/db/index.ts 是“导入即连接”，数据库位置由该变量决定，
  // 必须在导入它之前设置。
  process.env.HOME_CHEF_DB_PATH = databasePath

  const serverDist = serverDistDir()

  const dbModule = (await import(toFileUrl(serverDist, 'db', 'index.js'))) as {
    db: unknown
    sqlite: BetterSqlite3.Database
    databasePath: string
  }

  const { migrate } = (await import('drizzle-orm/better-sqlite3/migrator')) as {
    migrate: (db: never, config: { migrationsFolder: string }) => void
  }

  try {
    migrate(dbModule.db as never, { migrationsFolder: migrationsDir() })
  } catch (error) {
    // ⚠️ 必须先关闭连接：Windows 上 SQLite 打开的文件不能被 rename / delete，
    //    否则回滚会 EPERM 失败，把「自动回滚」变成「启动失败」。
    closeDatabaseQuietly(dbModule.sqlite)

    let rolledBack = false
    try {
      rolledBack = rollbackPendingRestore(databasePath)
    } catch (rollbackError) {
      log('迁移失败后的回滚也失败：' + String(rollbackError))
    }
    if (rolledBack) {
      log('迁移失败，已回滚到恢复前的数据库：' + String(error))
      app.relaunch()
      app.exit(0)
    }
    throw error
  }

  // 迁移通过只说明结构就绪；恢复的「确认」要等后端与窗口都真正可用。
  try {
    dbModule.sqlite.pragma('application_id = ' + String(HOMECHEF_APPLICATION_ID))
    const echoed = dbModule.sqlite.pragma('application_id', { simple: true }) as number
    if (echoed !== HOMECHEF_APPLICATION_ID) {
      log('警告：application_id 回读不一致（' + String(echoed) + '）')
    }
  } catch (error) {
    log('设置 application_id 失败：' + String(error))
  }
  log('迁移完成：' + dbModule.databasePath)

  const { createApp } = (await import(toFileUrl(serverDist, 'app.js'))) as {
    createApp: (options?: { logger?: boolean }) => FastifyInstance
  }
  const fastify = createApp({ logger: false })

  // @fastify/static 10.1.7 的类型声明与 fastify 5.12.5 的泛型对不齐，
  // 属于纯类型问题；这里局部断言，避免把类型噪音扩散到整个文件。
  const staticPlugin = (await import('@fastify/static')).default
  await fastify.register(staticPlugin as never, {
    root: webRootDir(),
    index: ['index.html'],
  })

  // 端口 0 = 系统分配可用端口，避免占用 3001/5173。
  await fastify.listen({ port: 0, host: '127.0.0.1' })

  const address = fastify.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('无法确定服务监听端口')
  }

  const origin = 'http://127.0.0.1:' + String(address.port)
  log('服务已启动：' + origin)
  return { fastify, sqlite: dbModule.sqlite, origin }
}

async function shutdownServer(): Promise<void> {
  const ctx = serverContext
  serverContext = null
  if (!ctx) {
    return
  }
  try {
    // 有超时：长连接或挂住的请求不能让进程永远退不掉。
    await Promise.race([
      ctx.fastify.close(),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('关闭 Fastify 超时')), 3000)
        timer.unref?.()
      }),
    ])
  } catch (error) {
    log('关闭 Fastify 失败：' + String(error))
  }
  closeDatabaseQuietly(ctx.sqlite)
  log('服务与数据库已关闭，端口已释放')
}

/* ------------------------------------------------------------------ */
/* 备份 / 恢复（界面层）                                                */
/* ------------------------------------------------------------------ */

function timestamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  )
}

/** 备份 / 恢复互斥：同一时刻只允许一个维护操作。 */
async function runMaintenance(label: string, task: () => Promise<void>): Promise<void> {
  if (maintenanceBusy) {
    await dialog.showMessageBox({
      type: 'info',
      message: '另一个备份操作正在进行',
      detail: '请等当前操作结束后再试。',
    })
    return
  }
  maintenanceBusy = true
  buildMenu()
  try {
    await task()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(label + '失败：' + detail)
    await dialog.showMessageBox({ type: 'error', message: label + '失败', detail })
  } finally {
    maintenanceBusy = false
    buildMenu()
  }
}

async function exportBackup(): Promise<void> {
  const ctx = serverContext
  if (!ctx) {
    return
  }
  await runMaintenance('导出备份', async () => {
    const result = await dialog.showSaveDialog({
      title: '导出 HomeChef 备份',
      defaultPath: path.join(app.getPath('documents'), 'homechef-backup-' + timestamp() + '.db'),
      filters: [{ name: 'HomeChef 备份', extensions: ['db'] }],
    })
    if (result.canceled || result.filePath === undefined || result.filePath === '') {
      return
    }

    if (isActiveDatabasePath(result.filePath, databasePath)) {
      await dialog.showMessageBox({
        type: 'error',
        message: '不能导出到正在使用的数据库路径',
        detail: '请换一个文件名或目录。',
      })
      return
    }

    // 用 better-sqlite3 的在线备份 API：一次拿到一致快照，
    // 不需要先 checkpoint，也不受 WAL 状态影响。
    await ctx.sqlite.backup(result.filePath)

    const verdict = inspectDatabaseFile(result.filePath, { migrationsDir: migrationsDir() })
    await dialog.showMessageBox({
      type: verdict.ok ? 'info' : 'error',
      message: verdict.ok ? '备份已导出' : '备份校验失败',
      detail: verdict.ok ? result.filePath + '\n' + verdict.message : verdict.message,
    })
    log('导出备份：' + result.filePath + ' / ' + verdict.message)
  })
}

async function importBackup(): Promise<void> {
  const ctx = serverContext
  if (!ctx) {
    return
  }
  await runMaintenance('恢复备份', async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择 HomeChef 备份文件',
      properties: ['openFile'],
      filters: [{ name: 'HomeChef 备份', extensions: ['db'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return
    }
    const source = picked.filePaths[0]

    if (isActiveDatabasePath(source, databasePath)) {
      await dialog.showMessageBox({
        type: 'error',
        message: '不能选择正在使用的数据库或其 -wal / -shm',
        detail: source,
      })
      return
    }

    const verdict = inspectDatabaseFile(source, { migrationsDir: migrationsDir() })
    if (!verdict.ok) {
      await dialog.showMessageBox({
        type: 'error',
        message: '不能恢复这个文件',
        detail: verdict.message,
      })
      return
    }

    const confirm = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '替换并重启'],
      defaultId: 0,
      cancelId: 0,
      message: '恢复会替换当前全部数据',
      detail:
        '当前数据库会先备份到：\n' + backupDir + '\n\n' +
        '已选文件：' + source + '\n' + verdict.message,
    })
    if (confirm.response !== 1) {
      return
    }

    // 关闭连接前先做一次在线备份，保证 pre-restore 副本是一致快照。
    let backedUp = false
    try {
      fs.mkdirSync(backupDir, { recursive: true })
      await ctx.sqlite.backup(path.join(backupDir, 'pre-restore-' + timestamp() + '.db'))
      backedUp = true
    } catch (error) {
      log('恢复前的在线备份失败：' + String(error))
    }

    await shutdownServer()

    let failed = false
    try {
      const outcome = applyRestore({
        sourcePath: source,
        databasePath,
        backupsDir: backupDir,
        migrationsDir: migrationsDir(),
        timestamp: timestamp(),
        alreadyBackedUp: backedUp,
      })
      log(
        '恢复完成（迁移 ' + String(outcome.applied) + ' 条），原库保留于 ' + outcome.previousPath,
      )
    } catch (error) {
      failed = true
      log('恢复失败：' + String(error))
      // 失败时把现场状态写进日志，方便事后判断到底停在新库还是旧库。
      const now = resolvePendingRestore({ databasePath, migrationsDir: migrationsDir() })
      log('恢复失败后的现场状态：' + now.kind + (now.kind === 'none' ? '' : ' — ' + now.detail))
      await dialog.showMessageBox({
        type: 'error',
        message: '恢复失败，应用将重新启动',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    app.relaunch()
    app.exit(failed ? 1 : 0)
  })
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function buildMenu(): void {
  const busy = maintenanceBusy
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '导出备份…', enabled: !busy, click: () => void exportBackup() },
        { label: '从备份恢复…', enabled: !busy, click: () => void importBackup() },
        { type: 'separator' },
        { role: 'quit', label: '退出', enabled: !busy },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据文件夹',
          click: () => {
            fs.mkdirSync(dataDir, { recursive: true })
            void shell.openPath(dataDir)
          },
        },
        { type: 'separator' },
        {
          label: '关于 HomeChef',
          click: () => {
            void dialog.showMessageBox({
              message: 'HomeChef ' + APP_VERSION,
              detail:
                '本地家庭食材库存与菜谱管理（桌面版）\n\n' +
                '数据目录：' + dataDir + '\n' +
                '日志：' + logFilePath,
            })
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/* ------------------------------------------------------------------ */
/* 窗口与导航                                                          */
/* ------------------------------------------------------------------ */

/** 只允许 http / https 交给系统浏览器，其它协议一律拦截。 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:'])

function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url)
    if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      log('已拦截非 http(s) 外链：' + url)
      return
    }
    void shell.openExternal(url)
  } catch {
    log('已拦截无法解析的外链：' + url)
  }
}

function isSameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin
  } catch {
    return false
  }
}

/** 主框架与子框架统一处理：非本源一律拦下，绝不在应用内导航出去。 */
function guardNavigation(event: Electron.Event, url: string, origin: string): void {
  if (!isSameOrigin(url, origin)) {
    event.preventDefault()
    openExternalSafely(url)
  }
}

async function createWindow(origin: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'HomeChef',
    backgroundColor: '#f7f1e6',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  // 本地应用不需要任何浏览器权限（摄像头/麦克风/通知/剪贴板等），全部拒绝。
  const session = win.webContents.session
  session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  session.setPermissionCheckHandler(() => false)

  win.webContents.setWindowOpenHandler(({ url }) => {
    // 同源新窗口也不在应用里开（会绕过单页状态），只把外链交给系统浏览器。
    if (!isSameOrigin(url, origin)) {
      openExternalSafely(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    guardNavigation(event, url, origin)
  })

  // 子框架（iframe）走单独的事件；不处理就能绕开主框架的校验。
  // 该事件名在 Electron 的类型定义里尚未收录，运行时存在，故此处断言。
  const frameGuard = (event: Electron.Event, url: string): void => {
    guardNavigation(event, url, origin)
  }
  win.webContents.on('will-frame-navigate' as never, frameGuard as never)

  win.once('ready-to-show', () => {
    win.show()
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  mainWindow = win
  await win.loadURL(origin)
  log('窗口已加载：' + origin)
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  try {
    await app.whenReady()
    app.setAppUserModelId('com.homechef.desktop')
    buildMenu()

    try {
      serverContext = await startServer()
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      log('启动失败：' + detail)
      await dialog.showMessageBox({
        type: 'error',
        message: 'HomeChef 启动失败',
        detail: detail + '\n\n日志：' + logFilePath,
      })
      app.exit(1)
      return
    }

    try {
      await createWindow(serverContext.origin)
    } catch (error) {
      log('创建窗口失败：' + String(error))
      await dialog.showMessageBox({
        type: 'error',
        message: '窗口加载失败',
        detail: String(error) + '\n\n日志：' + logFilePath,
      })
      app.exit(1)
      return
    }

    // 后端已监听、窗口已加载完成，此时才算恢复真正落地，移除回滚点。
    confirmPendingRestore(databasePath)
    log('启动完成，恢复标记（如有）已确认清除')
  } catch (error) {
    log('启动流程异常：' + String(error))
    try {
      app.exit(1)
    } catch {
      // 已无可退出
    }
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  // 已有实例在跑：直接退出，避免两个进程同时写同一个 SQLite 文件。
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown) {
      return
    }
    if (maintenanceBusy) {
      // 维护操作进行中被退出，会让恢复静默中断而不自知。
      event.preventDefault()
      log('维护操作进行中，已取消本次退出')
      void dialog.showMessageBox({
        type: 'info',
        message: '备份 / 恢复正在进行',
        detail: '请等操作结束后再退出。',
      })
      return
    }
    event.preventDefault()
    shuttingDown = true
    void (async () => {
      await shutdownServer()
      app.exit(0)
    })()
  })

  void bootstrap()
}
