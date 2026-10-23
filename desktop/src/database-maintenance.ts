import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 数据库备份 / 恢复的文件级实现（不依赖 electron，测试可直接调用）。
 *
 * 恢复的安全约束：
 *   1. **先持久化 pending 标记，再动任何文件**；标记用「写 .tmp + rename」原子落盘。
 *   2. 标记存在但读不出来时不允许当作「没有恢复」：能确认数据可用才继续，
 *      否则拒绝启动，绝不无标记建空库。
 *   3. 回滚时**不删除**当前库，而是改名成 .restore-failed-<时间>.db 保留。
 *   4. 只有结构性错误才自动回滚；临时性不可读（UNREADABLE）交给用户重试。
 *   5. 路径判定用 dev+ino 同文件比较，避免 8.3 短名 / 符号链接 / 硬链接绕过。
 */

export const HOMECHEF_APPLICATION_ID = 1212377158

const SQLITE_MAGIC = 'SQLite format 3\u0000'
const MIGRATION_TABLE = '__drizzle_migrations'

const REQUIRED_TABLES = [
  'app_settings',
  'category',
  'ingredient_definition',
  'ingredient_definition_unit',
  'standard_ingredient',
  'recipe',
  'recipe_ingredient',
  'recipe_step',
  'recipe_tag',
  'recipe_tag_link',
  'cooking_session',
  'cooking_session_dish',
  'cooking_settlement',
  'cooking_settlement_item',
  'recommendation_request',
  MIGRATION_TABLE,
]

export type InspectCode =
  | 'OK'
  | 'MISSING'
  | 'EMPTY'
  | 'NOT_SQLITE'
  | 'UNREADABLE'
  | 'INTEGRITY'
  | 'NOT_HOMECHEF'
  | 'FUTURE_VERSION'
  | 'MIGRATION_MISMATCH'
  | 'FOREIGN_KEY'

export interface InspectResult {
  ok: boolean
  code: InspectCode
  message: string
  applied: number
  known: number
}

interface JournalEntry {
  idx: number
  tag: string
  when: number
}

export interface ExpectedMigration {
  when: number
  hash: string
}

export function readJournal(migrationsDir: string): JournalEntry[] {
  const raw = fs.readFileSync(path.join(migrationsDir, 'meta', '_journal.json'), 'utf8')
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] }
  return parsed.entries.slice().sort((a, b) => a.idx - b.idx)
}

export function expectedMigrations(migrationsDir: string): ExpectedMigration[] {
  return readJournal(migrationsDir).map((entry) => {
    const sql = fs.readFileSync(path.join(migrationsDir, entry.tag + '.sql'), 'utf8')
    return { when: entry.when, hash: createHash('sha256').update(sql).digest('hex') }
  })
}

function hasSqliteHeader(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(16)
    const read = fs.readSync(fd, buffer, 0, 16, 0)
    return read === 16 && buffer.toString('latin1') === SQLITE_MAGIC
  } finally {
    fs.closeSync(fd)
  }
}

/* ------------------------------------------------------------------ */
/* 路径判定                                                            */
/* ------------------------------------------------------------------ */

/** 同一文件判定：优先 dev+ino，能穿透 8.3 短名、符号链接、硬链接。 */
function isSameFile(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/** 规范化路径：解析真实路径（若存在），并去掉 Windows 会忽略的尾随点/空格。 */
function canonicalPath(target: string): string {
  let resolved = path.resolve(target)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
    // 目标不存在：解析父目录，保留 basename
    const dir = path.dirname(resolved)
    try {
      resolved = path.join(fs.realpathSync.native(dir), path.basename(resolved))
    } catch {
      // 父目录也解析不了，就用原样
    }
  }
  return resolved.toLowerCase().replace(/[. ]+$/, '')
}

/** 目标是否是「当前活动数据库」本身或它的 WAL/SHM。 */
export function isActiveDatabasePath(targetPath: string, databasePath: string): boolean {
  const candidates = [databasePath, databasePath + '-wal', databasePath + '-shm']
  for (const candidate of candidates) {
    if (isSameFile(targetPath, candidate)) {
      return true
    }
    if (canonicalPath(targetPath) === canonicalPath(candidate)) {
      return true
    }
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 数据库校验                                                          */
/* ------------------------------------------------------------------ */

export function inspectDatabaseFile(
  filePath: string,
  options: { migrationsDir: string },
): InspectResult {
  const fail = (code: InspectCode, message: string, applied = 0, known = 0): InspectResult => ({
    ok: false,
    code,
    message,
    applied,
    known,
  })

  let expected: ExpectedMigration[]
  try {
    expected = expectedMigrations(options.migrationsDir)
  } catch (error) {
    return fail('UNREADABLE', '无法读取本应用的迁移清单：' + String(error))
  }

  // 文件层面的读取全部纳入 try：statSync / 读头失败也要变成 InspectResult，
  // 不能把原始 fs 错误抛给调用方。
  let size = 0
  try {
    if (!fs.existsSync(filePath)) {
      return fail('MISSING', '文件不存在', 0, expected.length)
    }
    size = fs.statSync(filePath).size
    if (size === 0) {
      return fail('EMPTY', '文件为空', 0, expected.length)
    }
    if (size < 512) {
      return fail('NOT_SQLITE', '文件太小，不是完整的 SQLite 数据库（可能复制中断）', 0, expected.length)
    }
    if (!hasSqliteHeader(filePath)) {
      return fail('NOT_SQLITE', '文件头不是 SQLite 格式，可能不是 HomeChef 备份', 0, expected.length)
    }
  } catch (error) {
    return fail('UNREADABLE', '无法读取文件：' + String(error), 0, expected.length)
  }

  let probe: Database.Database | null = null
  try {
    probe = new Database(filePath, { readonly: true, fileMustExist: true })
    probe.pragma('busy_timeout = 3000')

    const integrity = probe.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      return fail('INTEGRITY', '完整性检查未通过：' + String(integrity), 0, expected.length)
    }

    const tables = new Set(
      (
        probe
          .prepare("select name from sqlite_master where type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name),
    )
    const missing = REQUIRED_TABLES.filter((name) => !tables.has(name))
    if (missing.length > 0) {
      return fail(
        'NOT_HOMECHEF',
        '不是 HomeChef 数据库，缺少数据表：' + missing.slice(0, 4).join('、'),
        0,
        expected.length,
      )
    }

    const applicationId = probe.pragma('application_id', { simple: true }) as number
    if (applicationId !== 0 && applicationId !== HOMECHEF_APPLICATION_ID) {
      return fail(
        'NOT_HOMECHEF',
        'application_id = ' + String(applicationId) + '，不是 HomeChef 数据库',
        0,
        expected.length,
      )
    }

    const applied = probe
      .prepare('select hash, created_at from ' + MIGRATION_TABLE + ' order by created_at')
      .all() as Array<{ hash: string; created_at: number }>

    if (applied.length > expected.length) {
      return fail(
        'FUTURE_VERSION',
        '数据库来自更新版本的 HomeChef（' +
          String(applied.length) +
          ' 条迁移 > 本应用已知 ' +
          String(expected.length) +
          ' 条），请先升级应用',
        applied.length,
        expected.length,
      )
    }

    for (let i = 0; i < applied.length; i += 1) {
      if (applied[i].created_at !== expected[i].when || applied[i].hash !== expected[i].hash) {
        return fail(
          'MIGRATION_MISMATCH',
          '迁移记录不一致（第 ' + String(i) + ' 条），可能不是同一份数据库或已被改动',
          applied.length,
          expected.length,
        )
      }
    }

    const violations = probe.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) {
      return fail(
        'FOREIGN_KEY',
        '外键检查发现 ' + String(violations.length) + ' 处不一致',
        applied.length,
        expected.length,
      )
    }

    return {
      ok: true,
      code: 'OK',
      message:
        '结构兼容：' + String(tables.size) + ' 张表，已应用 ' + String(applied.length) + ' 条迁移',
      applied: applied.length,
      known: expected.length,
    }
  } catch (error) {
    return fail('UNREADABLE', '无法读取数据库：' + String(error), 0, expected.length)
  } finally {
    if (probe) {
      probe.close()
    }
  }
}

/* ------------------------------------------------------------------ */
/* 可注入的文件操作                                                     */
/* ------------------------------------------------------------------ */

export interface RestoreIo {
  exists(target: string): boolean
  copyFile(from: string, to: string): void
  rename(from: string, to: string): void
  remove(target: string): void
  writeFile(target: string, content: string): void
  readFile(target: string): string
  mkdir(target: string): void
}

const defaultIo: RestoreIo = {
  exists: (target) => fs.existsSync(target),
  copyFile: (from, to) => fs.copyFileSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (target) => fs.rmSync(target, { force: true }),
  writeFile: (target, content) => fs.writeFileSync(target, content, 'utf8'),
  readFile: (target) => fs.readFileSync(target, 'utf8'),
  mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
}

/* ------------------------------------------------------------------ */
/* 恢复标记                                                            */
/* ------------------------------------------------------------------ */

export const STAGING_NAME = '.restore-staging.db'
export const PREVIOUS_NAME = '.restore-previous.db'
const MARKER_NAME = '.restore-pending.json'
const MARKER_VERSION = 1

export interface RestoreMarker {
  version: number
  phase: 'swapping'
  databasePath: string
  stagingPath: string
  previousPath: string
  backupPath: string
  sourcePath: string
  startedAt: string
}

export type MarkerState =
  | { kind: 'none' }
  | { kind: 'valid'; marker: RestoreMarker }
  /** 文件存在但读不出/不合法：调用方不能当作“没有恢复”。 */
  | { kind: 'corrupt'; detail: string }

export function restoreMarkerPath(databasePath: string): string {
  return path.join(path.dirname(databasePath), MARKER_NAME)
}

/**
 * 标记里的路径必须严格等于本次数据库目录下的固定位置。
 * 标记文件在用户可写目录里，不能让篡改后的内容驱动任意文件操作。
 */
function validateMarkerShape(parsed: unknown, databasePath: string): RestoreMarker | null {
  if (parsed === null || typeof parsed !== 'object') {
    return null
  }
  const candidate = parsed as Partial<RestoreMarker>
  const dir = path.dirname(path.resolve(databasePath))
  const expectPrevious = path.join(dir, PREVIOUS_NAME)
  const expectStaging = path.join(dir, STAGING_NAME)

  if (candidate.version !== MARKER_VERSION) return null
  if (candidate.phase !== 'swapping') return null
  if (typeof candidate.previousPath !== 'string') return null
  if (typeof candidate.stagingPath !== 'string') return null
  if (typeof candidate.backupPath !== 'string') return null
  if (typeof candidate.sourcePath !== 'string') return null
  if (typeof candidate.startedAt !== 'string') return null
  if (typeof candidate.databasePath !== 'string') return null

  if (path.resolve(candidate.databasePath).toLowerCase() !== path.resolve(databasePath).toLowerCase()) {
    return null
  }
  if (path.resolve(candidate.previousPath).toLowerCase() !== expectPrevious.toLowerCase()) {
    return null
  }
  if (path.resolve(candidate.stagingPath).toLowerCase() !== expectStaging.toLowerCase()) {
    return null
  }
  return candidate as RestoreMarker
}

export function readRestoreMarker(databasePath: string, io: RestoreIo = defaultIo): MarkerState {
  const markerPath = restoreMarkerPath(databasePath)
  if (!io.exists(markerPath)) {
    return { kind: 'none' }
  }
  try {
    const parsed = JSON.parse(io.readFile(markerPath)) as unknown
    const marker = validateMarkerShape(parsed, databasePath)
    if (marker === null) {
      return { kind: 'corrupt', detail: '标记内容不合法（字段缺失或路径不符合预期）' }
    }
    return { kind: 'valid', marker }
  } catch (error) {
    return { kind: 'corrupt', detail: String(error) }
  }
}

/** 原子写标记：先写 .tmp 再 rename。中断只会留下 .tmp。 */
function writeMarkerAtomically(io: RestoreIo, databasePath: string, marker: RestoreMarker): void {
  const markerPath = restoreMarkerPath(databasePath)
  const tmpPath = markerPath + '.tmp'
  io.writeFile(tmpPath, JSON.stringify(marker, null, 2))
  io.rename(tmpPath, markerPath)
}

/** 坏标记改名保留，便于排查，也避免每次启动重复判定。 */
function quarantineMarker(io: RestoreIo, databasePath: string): void {
  const markerPath = restoreMarkerPath(databasePath)
  if (!io.exists(markerPath)) {
    return
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  io.rename(markerPath, path.join(path.dirname(databasePath), '.restore-pending.corrupt-' + stamp + '.json'))
}

function sidecarSuffixes(): string[] {
  return ['', '-wal', '-shm']
}

/** 把活动库（含 sidecar）整体挪到 previous 前缀。 */
function moveActiveAside(io: RestoreIo, databasePath: string, previousPath: string): void {
  if (io.exists(previousPath)) {
    for (const suffix of sidecarSuffixes()) {
      io.remove(previousPath + suffix)
    }
  }
  for (const suffix of sidecarSuffixes()) {
    const from = databasePath + suffix
    if (io.exists(from)) {
      io.rename(from, previousPath + suffix)
    }
  }
}

/**
 * 把当前（失败的）库改名保留，而不是删除。
 * 它可能是用户数据唯一的一份副本。
 */
function quarantineCurrent(io: RestoreIo, databasePath: string): string | null {
  if (!io.exists(databasePath) && !io.exists(databasePath + '-wal') && !io.exists(databasePath + '-shm')) {
    return null
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(path.dirname(databasePath), '.restore-failed-' + stamp + '.db')
  for (const suffix of sidecarSuffixes()) {
    const current = databasePath + suffix
    if (io.exists(current)) {
      io.rename(current, target + suffix)
    }
  }
  return target
}

/**
 * 把 previous 前缀（含 sidecar）挪回活动库位置；当前库先隔离保留。
 *
 * ⚠️ 必须先确认 previous 主库真的存在。若上一次恢复在第一个 rename
 *    （active → previous）就失败，previous 从未生成；此时若直接隔离当前库，
 *    会把仍然完好的 active 挪走，导致两边都不在原位。
 *    返回 null 表示「什么都没有移动」。
 */
interface RollbackResult {
  /** 原库是否真的被搬回来了。false = 什么都没动。 */
  moved: boolean
  /** 搬回时被隔离保留的「未完成的新库」路径，没有则为 null。 */
  quarantined: string | null
}

function restorePrevious(
  io: RestoreIo,
  databasePath: string,
  previousPath: string,
): RollbackResult {
  if (!io.exists(previousPath)) {
    return { moved: false, quarantined: null }
  }
  // active 已不存在时（已挪到 previous 但新库没换上）没有可隔离的对象。
  const quarantined = quarantineCurrent(io, databasePath)
  for (const suffix of sidecarSuffixes()) {
    const from = previousPath + suffix
    if (io.exists(from)) {
      io.rename(from, databasePath + suffix)
    }
  }
  return { moved: true, quarantined }
}

/** 尽力回滚到原库；幂等，可重复调用。 */
export function rollbackPendingRestore(databasePath: string, io: RestoreIo = defaultIo): boolean {
  const state = readRestoreMarker(databasePath, io)
  if (state.kind === 'none') {
    return false
  }
  if (state.kind === 'corrupt') {
    throw new Error('恢复标记已损坏，无法安全回滚：' + state.detail)
  }

  const marker = state.marker
  // 只看主库：只剩一个孤立的 -wal 不算「原库还在」。
  const hasPrevious = io.exists(marker.previousPath)
  if (!hasPrevious) {
    // 原库从未被移动过（失败发生在更早阶段），清掉标记与暂存即可。
    io.remove(restoreMarkerPath(databasePath))
    io.remove(marker.stagingPath)
    return false
  }

  restorePrevious(io, databasePath, marker.previousPath)
  io.remove(restoreMarkerPath(databasePath))
  io.remove(marker.stagingPath)
  return true
}

/** 恢复确认成功：删除标记、暂存与临时原库副本（更早副本仍在 backups/）。 */
export function confirmPendingRestore(databasePath: string, io: RestoreIo = defaultIo): void {
  const state = readRestoreMarker(databasePath, io)
  if (state.kind !== 'valid') {
    return
  }
  io.remove(restoreMarkerPath(databasePath))
  io.remove(state.marker.stagingPath)
  for (const suffix of sidecarSuffixes()) {
    io.remove(state.marker.previousPath + suffix)
  }
}

export type RecoveryOutcome =
  | { kind: 'none' }
  | { kind: 'ready'; detail: string }
  | { kind: 'recovered'; detail: string }
  /** 无法判断安全状态：必须拒绝启动，不能新建空库。 */
  | { kind: 'blocked'; detail: string }

/** 只有结构性损坏才值得自动回滚；临时不可读应当让用户重试。 */
const STRUCTURAL_CODES: InspectCode[] = [
  'INTEGRITY',
  'NOT_HOMECHEF',
  'MIGRATION_MISMATCH',
  'FUTURE_VERSION',
  'FOREIGN_KEY',
  'EMPTY',
  'NOT_SQLITE',
]

/**
 * 启动期幂等恢复，必须在打开数据库连接之前调用。
 */
export function resolvePendingRestore(options: {
  databasePath: string
  migrationsDir: string
  io?: RestoreIo
}): RecoveryOutcome {
  const io = options.io ?? defaultIo
  const databasePath = options.databasePath
  const state = readRestoreMarker(databasePath, io)

  if (state.kind === 'none') {
    return { kind: 'none' }
  }

  if (state.kind === 'corrupt') {
    const active = inspectDatabaseFile(databasePath, { migrationsDir: options.migrationsDir })
    if (active.ok) {
      quarantineMarker(io, databasePath)
      return { kind: 'ready', detail: '恢复标记不合法，但当前数据库可用；已把坏标记改名保留' }
    }
    return {
      kind: 'blocked',
      detail:
        '上次恢复未完成且标记文件不合法（' +
        state.detail +
        '），当前数据库也不可用。已停止启动以避免新建空库。请用 backups 目录里的副本手工恢复。',
    }
  }

  const marker = state.marker
  const active = inspectDatabaseFile(databasePath, { migrationsDir: options.migrationsDir })
  if (active.ok) {
    return { kind: 'ready', detail: '恢复后的数据库可用' }
  }

  // 文件缺失说明 swap 没走完；这是明确的半途状态，可以安全回滚。
  // 而 UNREADABLE 可能只是被杀软/其它进程短暂占用，不能在瞬时错误上做破坏性操作。
  if (active.code === 'UNREADABLE') {
    return {
      kind: 'blocked',
      detail:
        '恢复后的数据库暂时无法读取（' + active.message + '）。为避免误删数据已停止启动。' +
        '请关闭可能占用该文件的程序后重试；若持续失败，用 backups 目录里的副本手工恢复。',
    }
  }

  const previous = inspectDatabaseFile(marker.previousPath, { migrationsDir: options.migrationsDir })
  if (previous.ok && (active.code === 'MISSING' || STRUCTURAL_CODES.includes(active.code))) {
    const result = restorePrevious(io, databasePath, marker.previousPath)
    io.remove(restoreMarkerPath(databasePath))
    io.remove(marker.stagingPath)
    return {
      kind: 'recovered',
      detail:
        '恢复未完成（' + active.code + '），已回滚到恢复前的数据库' +
        (result.quarantined === null ? '' : '；未完成的新库保留在 ' + result.quarantined),
    }
  }

  return {
    kind: 'blocked',
    detail:
      '恢复未完成，且恢复前的副本也无法使用（当前库 ' +
      active.code +
      '，原库 ' +
      previous.code +
      '）。已停止启动以避免新建空库。请用 backups 目录里的副本手工恢复。',
  }
}

/* ------------------------------------------------------------------ */
/* 恢复主流程                                                          */
/* ------------------------------------------------------------------ */

export interface RestoreRequest {
  sourcePath: string
  databasePath: string
  backupsDir: string
  migrationsDir: string
  timestamp: string
  /** 调用方已用在线备份 API 做过 pre-restore 快照时置 true，跳过内部拷贝。 */
  alreadyBackedUp?: boolean
}

export interface RestoreOutcome {
  backupPath: string | null
  previousPath: string
  applied: number
}

export function applyRestore(request: RestoreRequest, io: RestoreIo = defaultIo): RestoreOutcome {
  const source = path.resolve(request.sourcePath)
  const databasePath = path.resolve(request.databasePath)
  const dir = path.dirname(databasePath)
  const stagingPath = path.join(dir, STAGING_NAME)
  const previousPath = path.join(dir, PREVIOUS_NAME)

  if (isActiveDatabasePath(source, databasePath)) {
    throw new Error('不能把当前正在使用的数据库（或其 -wal / -shm）作为恢复来源')
  }

  // 来源旁边有非空 -wal，说明它可能没被正常关闭：只复制主文件会丢掉已提交事务。
  if (io.exists(source + '-wal') && fs.statSync(source + '-wal').size > 0) {
    throw new Error(
      '这个备份文件旁边还有未合并的 -wal 文件，说明它没有正常关闭。' +
        '请在来源应用中重新导出备份后再恢复。',
    )
  }

  const inspection = inspectDatabaseFile(source, { migrationsDir: request.migrationsDir })
  if (!inspection.ok) {
    throw new Error('备份不可用：' + inspection.message)
  }

  io.mkdir(request.backupsDir)
  io.mkdir(dir)

  let backupPath: string | null = null
  if (request.alreadyBackedUp !== true) {
    if (io.exists(databasePath)) {
      backupPath = path.join(request.backupsDir, 'pre-restore-' + request.timestamp + '.db')
      io.copyFile(databasePath, backupPath)
    }
  }

  io.remove(stagingPath)
  io.copyFile(source, stagingPath)

  const staged = inspectDatabaseFile(stagingPath, { migrationsDir: request.migrationsDir })
  if (!staged.ok) {
    io.remove(stagingPath)
    throw new Error('暂存的备份副本校验失败：' + staged.message)
  }

  // 破坏性操作之前先落标记；写失败就直接退出，此时原库尚未被动过。
  const marker: RestoreMarker = {
    version: MARKER_VERSION,
    phase: 'swapping',
    databasePath,
    stagingPath,
    previousPath,
    backupPath: backupPath ?? '',
    sourcePath: source,
    startedAt: new Date().toISOString(),
  }
  try {
    writeMarkerAtomically(io, databasePath, marker)
  } catch (error) {
    io.remove(stagingPath)
    throw new Error('无法写入恢复标记，已取消恢复：' + String(error))
  }

  try {
    moveActiveAside(io, databasePath, previousPath)
    io.rename(stagingPath, databasePath)
  } catch (error) {
    let note = ''
    try {
      const result = restorePrevious(io, databasePath, previousPath)
      io.remove(restoreMarkerPath(databasePath))
      io.remove(stagingPath)
      if (!result.moved) {
        note = '原库尚未被移动，保持原状'
      } else if (result.quarantined === null) {
        note = '已回滚到原库'
      } else {
        note = '已回滚到原库；未完成的新库保留在 ' + result.quarantined
      }
    } catch (rollbackError) {
      throw new Error(
        '恢复失败（' +
          String(error) +
          '），自动回滚也失败（' +
          String(rollbackError) +
          '）。原库位于 ' +
          previousPath +
          '，请手工恢复。',
      )
    }
    throw new Error('恢复失败：' + String(error) + '；' + note)
  }

  return { backupPath, previousPath, applied: staged.applied }
}

/** 导出：把活动库复制到目标路径。调用方应优先用 better-sqlite3 的在线 backup。 */
export function exportDatabase(
  databasePath: string,
  targetPath: string,
  backupDir: string,
  io: RestoreIo = defaultIo,
): void {
  if (isActiveDatabasePath(targetPath, databasePath)) {
    throw new Error('导出目标不能是当前正在使用的数据库或其 -wal / -shm')
  }
  const target = path.resolve(targetPath).toLowerCase()
  const dir = path.dirname(path.resolve(databasePath)).toLowerCase()
  const reserved = [STAGING_NAME, PREVIOUS_NAME, MARKER_NAME]
  for (const name of reserved) {
    if (target === path.join(dir, name).toLowerCase()) {
      throw new Error('导出目标不能覆盖应用内部的恢复保留文件')
    }
  }
  if (target === path.resolve(backupDir).toLowerCase()) {
    throw new Error('导出目标不能是备份目录本身')
  }
  if (!io.exists(databasePath)) {
    throw new Error('当前数据库不存在，无法导出')
  }
  io.copyFile(databasePath, targetPath)
}
