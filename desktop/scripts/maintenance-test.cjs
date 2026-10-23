#!/usr/bin/env node
/**
 * 备份 / 恢复真实逻辑测试。
 *
 * 直接 require 编译后的 dist/database-maintenance.js，调用真实实现，
 * 并用可注入的 RestoreIo 精确制造故障（不靠 Copy-Item 模拟）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');

const m = require('../dist/database-maintenance.js');

const DESKTOP = path.resolve(__dirname, '..');
const MIGRATIONS = path.resolve(DESKTOP, '..', 'server', 'drizzle');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-maint-'));
const BACKUPS = path.join(ROOT, 'backups');

const steps = [];
function check(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log('[' + (ok ? 'PASS' : 'FAIL') + '] ' + name + ' :: ' + detail);
}

function makeHomeChefDb(filePath, markerName) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const sqlite = new Database(filePath);
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
  sqlite.pragma('application_id = ' + m.HOMECHEF_APPLICATION_ID);
  const now = new Date().toISOString();
  sqlite
    .prepare(
      'insert into ingredient_definition (name, name_normalized, created_at, updated_at) values (?, ?, ?, ?)',
    )
    .run(markerName, markerName.toLowerCase(), now, now);
  sqlite.close();
}

function names(filePath) {
  const sqlite = new Database(filePath, { readonly: true });
  try {
    return sqlite.prepare('select name from ingredient_definition order by id').all().map((r) => r.name);
  } finally {
    sqlite.close();
  }
}

const realIo = {
  exists: (t) => fs.existsSync(t),
  copyFile: (a, b) => fs.copyFileSync(a, b),
  rename: (a, b) => fs.renameSync(a, b),
  remove: (t) => fs.rmSync(t, { force: true }),
  writeFile: (t, c) => fs.writeFileSync(t, c, 'utf8'),
  readFile: (t) => fs.readFileSync(t, 'utf8'),
  mkdir: (t) => fs.mkdirSync(t, { recursive: true }),
};

/** 注入故障的 IO：failOn.rename / failOn.writeFile 返回 true 时抛错。 */
function makeFailingIo(failOn) {
  return {
    ...realIo,
    rename: (a, b) => {
      if (failOn.rename && failOn.rename(a, b)) throw new Error('注入故障：rename ' + a + ' → ' + b);
      fs.renameSync(a, b);
    },
    writeFile: (t, c) => {
      if (failOn.writeFile && failOn.writeFile(t, c)) throw new Error('注入故障：write ' + t);
      fs.writeFileSync(t, c, 'utf8');
    },
  };
}

const active = path.join(ROOT, 'data', 'homechef.db');
const backupSource = path.join(ROOT, 'backup-source.db');
const results = { root: ROOT };

try {
  makeHomeChefDb(active, '原数据-用户');
  makeHomeChefDb(backupSource, '备份数据-用户');
  const originalNames = names(active);

  check('活动库结构可识别', m.inspectDatabaseFile(active, { migrationsDir: MIGRATIONS }).ok, 'ok');

  // ---------- 校验拒绝 ----------
  const foreign = path.join(ROOT, 'foreign.db');
  const fdb = new Database(foreign);
  fdb.exec('create table notes(a text)');
  fdb.close();
  const r1 = m.inspectDatabaseFile(foreign, { migrationsDir: MIGRATIONS });
  check('拒绝无关 SQLite', !r1.ok && r1.code === 'NOT_HOMECHEF', r1.code);

  const empty = path.join(ROOT, 'empty.db');
  fs.writeFileSync(empty, '');
  check('拒绝空文件', m.inspectDatabaseFile(empty, { migrationsDir: MIGRATIONS }).code === 'EMPTY', 'EMPTY');

  const full = fs.readFileSync(active);
  const trunc = path.join(ROOT, 'trunc.db');
  fs.writeFileSync(trunc, full.subarray(0, 300));
  check('拒绝截断（过小）', !m.inspectDatabaseFile(trunc, { migrationsDir: MIGRATIONS }).ok, 'rejected');

  const truncMid = path.join(ROOT, 'trunc-mid.db');
  fs.writeFileSync(truncMid, full.subarray(0, Math.floor(full.length / 2)));
  check('拒绝截断（中段）', !m.inspectDatabaseFile(truncMid, { migrationsDir: MIGRATIONS }).ok, 'rejected');

  const future = path.join(ROOT, 'future.db');
  fs.copyFileSync(active, future);
  const fdb2 = new Database(future);
  fdb2.prepare('insert into __drizzle_migrations (hash, created_at) values (?, ?)').run('x', 9999999999999);
  fdb2.close();
  check('拒绝未来版本', m.inspectDatabaseFile(future, { migrationsDir: MIGRATIONS }).code === 'FUTURE_VERSION', 'FUTURE_VERSION');

  const tampered = path.join(ROOT, 'tampered.db');
  fs.copyFileSync(active, tampered);
  const tdb = new Database(tampered);
  tdb.prepare('update __drizzle_migrations set hash = ? where rowid = (select min(rowid) from __drizzle_migrations)').run('deadbeef');
  tdb.close();
  check('拒绝迁移记录被篡改', m.inspectDatabaseFile(tampered, { migrationsDir: MIGRATIONS }).code === 'MIGRATION_MISMATCH', 'MIGRATION_MISMATCH');

  let guard = false;
  try {
    m.applyRestore({ sourcePath: active, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 't0' });
  } catch (e) { guard = /正在使用/.test(String(e)); }
  check('拒绝活动库作为恢复来源', guard, String(guard));

  let exportGuard = false;
  try { m.exportDatabase(active, active, BACKUPS); } catch (e) { exportGuard = /导出目标/.test(String(e)); }
  check('拒绝导出到活动库', exportGuard, String(exportGuard));

  // ---------- 正常恢复 ----------
  const outcome = m.applyRestore({ sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 't1' });
  check('恢复后数据来自备份', names(active).includes('备份数据-用户'), names(active).join(','));
  check('恢复前已留副本', fs.existsSync(outcome.backupPath), path.basename(outcome.backupPath));
  check('恢复后存在标记', m.readRestoreMarker(active).kind === 'valid', m.readRestoreMarker(active).kind);

  // ---------- 回滚 ----------
  const rolled = m.rollbackPendingRestore(active);
  check('回滚成功', rolled === true, String(rolled));
  check('回滚后数据为原数据', JSON.stringify(names(active)) === JSON.stringify(originalNames), names(active).join(','));
  check('回滚后标记清除', m.readRestoreMarker(active).kind === 'none', 'none');

  // ---------- 确认 ----------
  const o2 = m.applyRestore({ sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 't2' });
  m.confirmPendingRestore(active);
  check('确认后保留新数据', names(active).includes('备份数据-用户'), names(active).join(','));
  check('确认后清理标记与临时原库', m.readRestoreMarker(active).kind === 'none' && !fs.existsSync(o2.previousPath), 'cleaned');

  // ================= 故障注入 =================

  // A. rename staging → active 失败
  makeHomeChefDb(active, 'A-原数据');
  const aBefore = names(active);
  let aThrew = null;
  try {
    m.applyRestore(
      { sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'A' },
      makeFailingIo({ rename: (from) => from.includes('.restore-staging') }),
    );
  } catch (e) { aThrew = String(e); }
  check('A: 替换失败会抛错并说明已回滚', aThrew !== null && /已回滚/.test(aThrew), String(aThrew).slice(0, 80));
  check('A: 原库数据完好', JSON.stringify(names(active)) === JSON.stringify(aBefore), names(active).join(','));
  check('A: 没有残留标记', m.readRestoreMarker(active).kind === 'none', m.readRestoreMarker(active).kind);
  check('A: 没有残留暂存文件', !fs.existsSync(path.join(ROOT, 'data', '.restore-staging.db')), 'no staging');

  // B. marker 写入失败
  makeHomeChefDb(active, 'B-原数据');
  const bBefore = names(active);
  let bThrew = null;
  try {
    m.applyRestore(
      { sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'B' },
      makeFailingIo({ writeFile: (t) => t.includes('.restore-pending') }),
    );
  } catch (e) { bThrew = String(e); }
  check('B: 标记写不出时取消恢复', bThrew !== null && /恢复标记/.test(bThrew), String(bThrew).slice(0, 80));
  check('B: 原库未被替换', JSON.stringify(names(active)) === JSON.stringify(bBefore), names(active).join(','));
  check('B: 没有残留标记', m.readRestoreMarker(active).kind === 'none', m.readRestoreMarker(active).kind);
  check('B: 暂存已清理', !fs.existsSync(path.join(ROOT, 'data', '.restore-staging.db')), 'no staging');

  // C. 半途状态：原库已挪走、新库没换上（模拟进程被杀）
  makeHomeChefDb(active, 'C-原数据');
  const cBefore = names(active);
  const prevPath = path.join(ROOT, 'data', '.restore-previous.db');
  m.applyRestore({ sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'C' });
  // 人为回到「已 swap 一半」：删掉新库，把 previous 留在原地，标记仍在
  fs.rmSync(active, { force: true });
  const recovery = m.resolvePendingRestore({ databasePath: active, migrationsDir: MIGRATIONS });
  check('C: 半途状态被识别并回滚', recovery.kind === 'recovered', recovery.kind);
  check('C: 回滚后数据为原数据', JSON.stringify(names(active)) === JSON.stringify(cBefore), names(active).join(','));
  check('C: previous 已消费', !fs.existsSync(prevPath), 'gone');

  // D. 标记损坏但当前库可用 → 允许启动
  makeHomeChefDb(active, 'D-原数据');
  fs.writeFileSync(path.join(ROOT, 'data', '.restore-pending.json'), '{ this is not json');
  const dState = m.resolvePendingRestore({ databasePath: active, migrationsDir: MIGRATIONS });
  check('D: 标记损坏且库可用 → ready', dState.kind === 'ready', dState.kind);
  fs.rmSync(path.join(ROOT, 'data', '.restore-pending.json'), { force: true });

  // E. 标记损坏且当前库缺失 → 拒绝启动（不得建空库）
  fs.writeFileSync(path.join(ROOT, 'data', '.restore-pending.json'), '{ broken');
  fs.rmSync(active, { force: true });
  const eState = m.resolvePendingRestore({ databasePath: active, migrationsDir: MIGRATIONS });
  check('E: 标记损坏且库缺失 → blocked', eState.kind === 'blocked', eState.kind);
  check('E: 拒绝启动时不会创建空库', !fs.existsSync(active), 'no db created');
  fs.rmSync(path.join(ROOT, 'data', '.restore-pending.json'), { force: true });

  // F. 结构缺失的备份被拒绝且当前库不受影响
  makeHomeChefDb(active, 'F-原数据');
  const brokenBackup = path.join(ROOT, 'broken.db');
  fs.copyFileSync(backupSource, brokenBackup);
  const bdb = new Database(brokenBackup);
  bdb.exec('drop table recipe_step');
  bdb.close();
  let fRejected = false;
  try {
    m.applyRestore({ sourcePath: brokenBackup, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'F' });
  } catch (e) { fRejected = /备份不可用/.test(String(e)); }
  check('F: 结构缺失的备份被拒绝', fRejected, String(fRejected));
  check('F: 被拒后当前库未受影响', names(active).includes('F-原数据'), names(active).join(','));

  // ---------- G. 恢复源带未合并的 -wal ----------
  makeHomeChefDb(active, 'G-原数据');
  const walSource = path.join(ROOT, 'wal-source.db');
  fs.copyFileSync(backupSource, walSource);
  fs.writeFileSync(walSource + '-wal', Buffer.alloc(64, 1));
  let gRejected = false;
  try {
    m.applyRestore({ sourcePath: walSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'G' });
  } catch (e) { gRejected = /-wal/.test(String(e)); }
  check('G: 源带未合并 -wal 被拒绝', gRejected, String(gRejected));
  fs.rmSync(walSource + '-wal', { force: true });

  // ---------- H. 标记里的路径被篡改 ----------
  const markerPath = path.join(ROOT, 'data', '.restore-pending.json');
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      version: 1,
      phase: 'swapping',
      databasePath: active,
      stagingPath: path.join(ROOT, 'data', '.restore-staging.db'),
      previousPath: 'C:\\Windows\\System32\\config\\SAM',
      backupPath: '',
      sourcePath: '',
      startedAt: new Date().toISOString(),
    }),
  );
  const hState = m.readRestoreMarker(active);
  check('H: 标记路径越界被视为不合法', hState.kind === 'corrupt', hState.kind);
  fs.rmSync(markerPath, { force: true });

  // ---------- I. 回滚保留未完成的新库 ----------
  makeHomeChefDb(active, 'I-原数据');
  m.applyRestore({ sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'I' });
  m.rollbackPendingRestore(active);
  const failedCopies = fs.readdirSync(path.join(ROOT, 'data')).filter((n) => n.startsWith('.restore-failed-'));
  check('I: 回滚保留未完成的新库而非删除', failedCopies.length > 0, failedCopies.join(','));

  // ---------- K. 拒绝导出到内部保留文件 ----------
  let kRejected = false;
  try {
    m.exportDatabase(active, path.join(ROOT, 'data', '.restore-previous.db'), BACKUPS);
  } catch (e) { kRejected = /保留文件/.test(String(e)); }
  check('K: 拒绝导出到内部保留文件', kRejected, String(kRejected));
  const dataDir = path.join(ROOT, 'data');

  // ---------- L. 第一个 rename（原库 → previous）失败 ----------
  makeHomeChefDb(active, 'L-原数据');
  const lBefore = names(active);
  const failedBefore = fs.readdirSync(dataDir).filter((n) => n.startsWith('.restore-failed-')).length;
  let lThrew = null;
  try {
    m.applyRestore(
      { sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'L' },
      makeFailingIo({ rename: (from) => path.resolve(from) === path.resolve(active) }),
    );
  } catch (e) { lThrew = String(e); }
  check('L: 原库 rename 失败会被报告', lThrew !== null, String(lThrew).slice(0, 90));
  check('L: 原库仍在原位且用户数据完好', JSON.stringify(names(active)) === JSON.stringify(lBefore), names(active).join(','));
  const failedAfter = fs.readdirSync(dataDir).filter((n) => n.startsWith('.restore-failed-')).length;
  check('L: 未新增 .restore-failed 副本', failedAfter === failedBefore, failedBefore + '->' + failedAfter);
  check('L: 没有残留标记', m.readRestoreMarker(active).kind === 'none', m.readRestoreMarker(active).kind);

  // ---------- M. 标记的 rename（.tmp → .json）失败 ----------
  makeHomeChefDb(active, 'M-原数据');
  const mBefore = names(active);
  let mThrew = null;
  try {
    m.applyRestore(
      { sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'M' },
      makeFailingIo({ rename: (_from, to) => to.endsWith('.restore-pending.json') }),
    );
  } catch (e) { mThrew = String(e); }
  check('M: 标记 rename 失败会取消恢复', mThrew !== null && /恢复标记/.test(mThrew), String(mThrew).slice(0, 80));
  check('M: 原库未被替换', JSON.stringify(names(active)) === JSON.stringify(mBefore), names(active).join(','));
  check('M: 暂存已清理', !fs.existsSync(path.join(dataDir, '.restore-staging.db')), 'no staging');

  // ---------- N. 回滚自身中断后的下一次启动 ----------
  makeHomeChefDb(active, 'N-原数据');
  const nBefore = names(active);
  m.applyRestore({ sourcePath: backupSource, databasePath: active, backupsDir: BACKUPS, migrationsDir: MIGRATIONS, timestamp: 'N' });
  // 现场：active=备份库、previous=原库、marker 存在。模拟回滚只做了一半：
  fs.renameSync(active, path.join(dataDir, '.restore-failed-halfway.db'));
  const nRec = m.resolvePendingRestore({ databasePath: active, migrationsDir: MIGRATIONS });
  check('N: 回滚中断后下次启动仍能保守恢复', nRec.kind === 'recovered', nRec.kind);
  check('N: 恢复出的是原库数据', JSON.stringify(names(active)) === JSON.stringify(nBefore), names(active).join(','));
  results.summary = { passed: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length };
  results.steps = steps;
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(JSON.stringify(results.summary));
if (results.summary.failed > 0) process.exitCode = 1;
