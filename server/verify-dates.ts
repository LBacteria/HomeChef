/**
 * 日期处理验证（v0.1.5 修复）
 *
 * 覆盖：
 *   1. 纯日期运算：今天 / 明天 / 昨天 / 同一天 / 跨月 / 跨年 / 闰年 2 月 29
 *   2. 真实性校验：非法日期（2 月 30 等）
 *   3. 临期状态：已过期 / 今天到期 / 明天到期 / 正常 / 无保质期
 *   4. **时区边界**：在 UTC+8 与 UTC-5 下分别验证 todayDateString()
 *      —— 通过独立 Node 子进程设置 TZ，**不依赖执行机器的时区**
 *   5. 前后端一致性：后端 todayDateString 与前端 format.ts 的算法一致
 *   6. API 端到端：默认入库日期 = 本地今天；临期状态与本地基准一致
 *
 * ⚠️ 使用独立临时数据库 + 动态端口，不触碰 homechef.db。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

import {
  addDays,
  compareDates,
  isValidDateString,
  todayDateString,
} from './src/services/dates.js'
import { evaluateExpiryStatus } from './src/services/expiryStatusService.js'

let pass = 0
let fail = 0
const ok = (label: string, cond: boolean, detail = '') => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` —— ${detail}` : ''}`)
  cond ? pass++ : fail++
}
const info = (label: string, detail = '') => console.log(`  [INFO] ${label}${detail ? ` —— ${detail}` : ''}`)
const section = (t: string) => console.log(`\n===== ${t} =====`)

/* ============================================================
 * 1. 纯日期运算
 * ============================================================ */
section('1. 纯日期运算')

ok('addDays 相同日期 +0 天不变', addDays('2026-10-11', 0) === '2026-10-11')
ok('明天 = +1', addDays('2026-10-11', 1) === '2026-10-12')
ok('昨天 = -1', addDays('2026-10-11', -1) === '2026-10-10')

// 跨月
ok('跨月：10-31 +1 = 11-01', addDays('2026-10-31', 1) === '2026-11-01')
ok('跨月：11-01 -1 = 10-31', addDays('2026-11-01', -1) === '2026-10-31')
ok('跨月：4-30 +1 = 5-01', addDays('2026-04-30', 1) === '2026-05-01')

// 跨年
ok('跨年：12-31 +1 = 次年 01-01', addDays('2026-12-31', 1) === '2027-01-01')
ok('跨年：01-01 -1 = 上年 12-31', addDays('2027-01-01', -1) === '2026-12-31')

// 闰年
ok('闰年：2024-02-28 +1 = 02-29', addDays('2024-02-28', 1) === '2024-02-29')
ok('闰年：2024-02-29 +1 = 03-01', addDays('2024-02-29', 1) === '2024-03-01')
ok('闰年：2024-02-29 -1 = 02-28', addDays('2024-02-29', -1) === '2024-02-28')
ok('平年：2026-02-28 +1 = 03-01（无 2-29）', addDays('2026-02-28', 1) === '2026-03-01')
ok('世纪平年：1900-02-28 +1 = 03-01', addDays('1900-02-28', 1) === '1900-03-01')
ok('世纪闰年：2000-02-28 +1 = 02-29', addDays('2000-02-28', 1) === '2000-02-29')

// 大跨度
ok('+365 天跨年', addDays('2026-01-01', 365) === '2027-01-01')
ok('闰年 +366 天', addDays('2024-01-01', 366) === '2025-01-01')

// compareDates
section('2. 日期比较')
ok('早于返回负数', compareDates('2026-10-10', '2026-10-11') < 0)
ok('等于返回 0', compareDates('2026-10-11', '2026-10-11') === 0)
ok('晚于返回正数', compareDates('2026-10-12', '2026-10-11') > 0)
ok('跨年比较正确', compareDates('2026-12-31', '2027-01-01') < 0)
ok('闰日比较正确', compareDates('2024-02-29', '2024-03-01') < 0)

// 合法性
section('3. 日期合法性')
ok('合法日期通过', isValidDateString('2026-10-11'))
ok('闰日 2024-02-29 合法', isValidDateString('2024-02-29'))
ok('非闰年 2026-02-29 非法', !isValidDateString('2026-02-29'))
ok('2026-02-30 非法', !isValidDateString('2026-02-30'))
ok('2026-13-01 非法', !isValidDateString('2026-13-01'))
ok('2026-00-10 非法', !isValidDateString('2026-00-10'))
ok('格式错误非法', !isValidDateString('2026/10/11'))
ok('非字符串非法', !isValidDateString(20261011))

/* ============================================================
 * 4. ★ 时区边界（独立子进程设 TZ，可重复）
 * ============================================================ */
section('4. 时区边界（子进程注入 TZ）')

/**
 * 从 `formatToParts()` 的结果中提取 year / month / day 并校验。
 *
 * ⚠️ 抽成**独立的模块级纯函数**（接收 parts 数组），原因是：
 *    `need()` 原本是 `ymdInTz()` 内部的闭包，外部无法单独调用，也无法注入
 *    缺少字段的 parts —— 于是"字段缺失"这条错误分支**根本没法被直接测试**
 *    （非法时区/非法日期都在更早的阶段就抛错了，走不到这里）。
 *    抽出来之后，可以为"缺 year / 缺 month / 缺 day / 空字符串"分别构造
 *    parts 数组做直接验证。
 *
 * @param parts `formatToParts()` 的返回值
 * @param ctx   出错信息里的上下文（调用方传入 iso / tz 等）
 */
function pickYmd(
  parts: Intl.DateTimeFormatPart[],
  ctx: string,
): { year: string; month: string; day: string } {
  /**
   * 取指定 part 的值；缺失或为空立即报错。
   *
   * ⚠️ 不用 `?? ''` 兜底：静默拼出 "--" 这类非法值会掩盖问题，
   *    必须让异常显式暴露（含字段名与上下文，便于定位）。
   */
  const need = (type: 'year' | 'month' | 'day'): string => {
    const value = parts.find((p) => p.type === type)?.value
    if (value === undefined || value === '') {
      throw new Error(`缺少 ${type} 部分（${ctx}）`)
    }
    return value
  }

  const year = need('year')
  const month = need('month')
  const day = need('day')

  // 位数校验：格式不符预期时立即报错，而不是返回一个看似合法的字符串
  if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw new Error(
      `日期部分位数异常（${ctx}, year=${year}, month=${month}, day=${day}）`,
    )
  }

  return { year, month, day }
}

/**
 * 把某个时刻在**指定时区**下的日历日格式化为 YYYY-MM-DD。
 *
 * ⚠️ 为什么不用 `new Intl.DateTimeFormat('en-CA', ...).format(d)`：
 *    `en-CA` 的输出格式**依赖 ICU 数据版本**，历史上曾输出过 `M/d/yyyy`，
 *    不能保证永远是 `YYYY-MM-DD`。在本测试机器上恰好正确，但换 Node/ICU
 *    版本就可能失效，属于隐式的环境依赖。
 *
 *    因此改用 `formatToParts()` 按 part 类型取 year / month / day，
 *    再**显式拼接**（见 pickYmd）—— 不依赖 locale 的排列顺序与分隔符。
 *
 * @param iso 带时区标记的 ISO 时刻（例如 '2026-10-11T23:30:00Z'）
 * @param tz  IANA 时区名
 */
function ymdInTz(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))

  const { year, month, day } = pickYmd(parts, `iso=${iso}, tz=${tz}`)
  return `${year}-${month}-${day}`
}

/* ---------- ymdInTz 自身的健壮性自测 ---------- */
//
// 这一小节验证"测试辅助函数"本身按预期工作：
//   - 正常输入返回 YYYY-MM-DD
//   - 非法输入**抛出异常**（而不是静默返回非法字符串）
section('4a. ymdInTz 辅助函数自测')

ok('正常输入：UTC 下返回 2026-10-11',
  ymdInTz('2026-10-11T23:30:00Z', 'UTC') === '2026-10-11')
ok('正常输入：UTC+8 下跨日返回 2026-10-12',
  ymdInTz('2026-10-11T23:30:00Z', 'Asia/Shanghai') === '2026-10-12')
ok('个位数月/日仍补零为两位',
  ymdInTz('2026-01-05T00:00:00Z', 'UTC') === '2026-01-05')
ok('闰日正确',
  ymdInTz('2000-02-29T00:00:00Z', 'UTC') === '2000-02-29')
ok('+14 时区跨年正确',
  ymdInTz('2026-12-31T23:59:59Z', 'Pacific/Kiritimati') === '2027-01-01')

/** 断言某次调用会抛错（辅助函数不得静默返回非法值） */
function throwsOn(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

/** 捕获调用抛出的错误信息；未抛错时返回 null */
function errorMessageOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/* ---------- 直接测试 pickYmd 的"字段缺失"分支 ---------- */
//
// ⚠️ 为什么不复用上面的 ymdInTz：
//    非法时区名会在 Intl.DateTimeFormat() 构造时抛错，
//    非法日期会在 formatToParts() 内部抛错 ——
//    两者都**走不到 pickYmd**，因此无法验证下面这个分支：
//        if (value === undefined || value === '') { throw ... }
//
//    所以这里直接构造 parts 数组喂给 pickYmd。

/** 用真实 parts 作模板，再按需删除/改空某个字段 */
function partsWithout(omit: 'year' | 'month' | 'day'): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  })
    .formatToParts(new Date('2026-10-11T12:00:00Z'))
    .filter((p) => p.type !== omit)
}

function partsWithEmpty(field: 'year' | 'month' | 'day'): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  })
    .formatToParts(new Date('2026-10-11T12:00:00Z'))
    .map((p) => (p.type === field ? { type: p.type, value: '' } : p))
}

const CTX = 'iso=2026-10-11T12:00:00Z, tz=UTC'

// ---- 缺少字段 ----
const errNoYear = errorMessageOf(() => pickYmd(partsWithout('year'), CTX))
ok('缺少 year → 抛错', errNoYear !== null, `${errNoYear}`)
ok('  错误信息含 "year"', errNoYear?.includes('year') === true, `${errNoYear}`)
ok('  错误信息含上下文（iso/tz）',
  errNoYear?.includes(CTX) === true, `${errNoYear}`)

const errNoMonth = errorMessageOf(() => pickYmd(partsWithout('month'), CTX))
ok('缺少 month → 抛错', errNoMonth !== null, `${errNoMonth}`)
ok('  错误信息含 "month"', errNoMonth?.includes('month') === true, `${errNoMonth}`)
ok('  错误信息含上下文（iso/tz）',
  errNoMonth?.includes(CTX) === true, `${errNoMonth}`)

const errNoDay = errorMessageOf(() => pickYmd(partsWithout('day'), CTX))
ok('缺少 day → 抛错', errNoDay !== null, `${errNoDay}`)
ok('  错误信息含 "day"', errNoDay?.includes('day') === true, `${errNoDay}`)
ok('  错误信息含上下文（iso/tz）',
  errNoDay?.includes(CTX) === true, `${errNoDay}`)

// ---- 空字符串字段（不得被静默接受）----
const errEmptyYear = errorMessageOf(() => pickYmd(partsWithEmpty('year'), CTX))
ok('year 为空字符串 → 抛错（不静默接受）', errEmptyYear !== null, `${errEmptyYear}`)
ok('  错误信息含 "year"', errEmptyYear?.includes('year') === true, `${errEmptyYear}`)

const errEmptyMonth = errorMessageOf(() => pickYmd(partsWithEmpty('month'), CTX))
ok('month 为空字符串 → 抛错（不静默接受）', errEmptyMonth !== null, `${errEmptyMonth}`)
ok('  错误信息含 "month"', errEmptyMonth?.includes('month') === true, `${errEmptyMonth}`)

const errEmptyDay = errorMessageOf(() => pickYmd(partsWithEmpty('day'), CTX))
ok('day 为空字符串 → 抛错（不静默接受）', errEmptyDay !== null, `${errEmptyDay}`)
ok('  错误信息含 "day"', errEmptyDay?.includes('day') === true, `${errEmptyDay}`)

// ---- 位数校验分支（同样直接构造 parts）----
const errShortYear = errorMessageOf(() =>
  pickYmd(
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date('2026-10-11T12:00:00Z'))
      .map((p) => (p.type === 'year' ? { type: p.type, value: '26' } : p)),
    CTX,
  ))
ok('year 为 2 位 → 抛位数异常', errShortYear !== null, `${errShortYear}`)
ok('  错误信息含 "位数异常"', errShortYear?.includes('位数异常') === true, `${errShortYear}`)

// ---- 正常 parts 仍应通过 ----
const goodParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
}).formatToParts(new Date('2026-10-11T12:00:00Z'))
ok('完整 parts → 正常返回',
  pickYmd(goodParts, CTX).year === '2026' &&
  pickYmd(goodParts, CTX).month === '10' &&
  pickYmd(goodParts, CTX).day === '11')

/* ---------- 端到端：非法输入的兜底行为（不代表 pickYmd 分支）---------- */
ok('非法时区名 → 抛错（在 Intl 构造阶段）',
  throwsOn(() => ymdInTz('2026-10-11T23:30:00Z', 'Not/AZone')))
ok('非法日期字符串 → 抛错（在 formatToParts 阶段）',
  throwsOn(() => ymdInTz('not-a-date', 'UTC')))

/**
 * 在指定 TZ 下运行时区探针，返回其 stdout（去掉首尾空白）。
 *
 * 用独立的 `node`/`tsx` 子进程设置 TZ 环境变量，
 * 因此**结果只取决于传入的 TZ，与执行机器的时区无关**。
 *
 * 探针 _tz-probe.ts 输出两段：<真实 todayDateString(固定时刻)>|<UTC 日期>
 */
function runInTz(tz: string, fixedIso: string): string {
  const r = spawnSync(
    'npx',
    ['tsx', '_tz-probe.ts', fixedIso],
    {
      cwd: process.cwd(),
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      shell: true,
    },
  )
  if (r.error) {
    return `ERROR:${r.error.message}`
  }
  const out = (r.stdout ?? '').trim()
  if (out === '') {
    return `EMPTY:${String(r.stderr ?? '').trim().split('\n')[0]}`
  }
  return out
}

// ⚠️ 三个固定时刻都**显式带 Z**，不受运行机器时区影响
//
//   LATE     = 2026-10-11T23:30:00Z
//              UTC 10-11 | UTC+8 已是 10-12（**本地领先 UTC**）| UTC-5 仍是 10-11
//   EARLY    = 2026-10-11T02:00:00Z
//              UTC 10-11 | UTC+8 仍是 10-11（**本地与 UTC 同日**）| UTC-5 是 10-10（**本地落后 UTC**）
//   FAR_PAST = 2026-10-09T02:00:00Z
//              与 LATE 相差 69.5 小时。
//              它**专供本进程自检**使用：
//              LATE / EARLY 只相隔 21.5 小时，在 UTC 时区下同属一天，
//              不能用于"两个时刻必须得到不同日期"这类与时区无关的断言；
//              FAR_PAST 与 LATE 相隔 > 24 小时，在**任何时区**下都不同日
//              （已用 UTC / UTC+8 / UTC-5 / UTC+14 / UTC-11 等边界时区核实）。
const LATE = '2026-10-11T23:30:00Z'
const EARLY = '2026-10-11T02:00:00Z'
const FAR_PAST = '2026-10-09T02:00:00Z'

/* ---------- 场景 1：本地领先 UTC（UTC+8 在 LATE）---------- */
const p8Late = runInTz('Asia/Shanghai', LATE)
info('UTC+8 @ LATE 子进程输出', p8Late)
const [p8LateLocal, p8LateUtc] = p8Late.split('|')
ok('★ [真实函数] UTC+8 下 23:30Z → 本地 2026-10-12', p8LateLocal === '2026-10-12', `${p8LateLocal}`)
ok('★ [真实函数] 同刻 UTC 日期为 2026-10-11', p8LateUtc === '2026-10-11', `${p8LateUtc}`)
ok('★ 本地领先 UTC 一天（修复的核心场景）', p8LateLocal !== p8LateUtc, `${p8LateLocal} vs ${p8LateUtc}`)

/* ---------- 场景 2：本地落后 UTC（UTC-5 在 EARLY）---------- */
const m5Early = runInTz('America/New_York', EARLY)
info('UTC-5 @ EARLY 子进程输出', m5Early)
const [m5EarlyLocal, m5EarlyUtc] = m5Early.split('|')
ok('★ [真实函数] UTC-5 下 02:00Z → 本地 2026-10-10', m5EarlyLocal === '2026-10-10', `${m5EarlyLocal}`)
ok('★ [真实函数] 同刻 UTC 日期为 2026-10-11', m5EarlyUtc === '2026-10-11', `${m5EarlyUtc}`)
ok('★ 本地落后 UTC 一天', m5EarlyLocal !== m5EarlyUtc, `${m5EarlyLocal} vs ${m5EarlyUtc}`)

/* ---------- 场景 3：本地与 UTC 同日 ---------- */
const utcEarly = runInTz('UTC', EARLY)
info('UTC @ EARLY 子进程输出', utcEarly)
const [utcEarlyLocal, utcEarlyUtc] = utcEarly.split('|')
ok('★ [真实函数] UTC 时区下本地 = UTC = 2026-10-11',
  utcEarlyLocal === '2026-10-11' && utcEarlyUtc === '2026-10-11',
  `${utcEarlyLocal} vs ${utcEarlyUtc}`)

const p8Early = runInTz('Asia/Shanghai', EARLY)
info('UTC+8 @ EARLY 子进程输出', p8Early)
const [p8EarlyLocal, p8EarlyUtc] = p8Early.split('|')
ok('★ [真实函数] UTC+8 下 02:00Z → 本地与 UTC 同为 2026-10-11',
  p8EarlyLocal === '2026-10-11' && p8EarlyUtc === '2026-10-11',
  `${p8EarlyLocal} vs ${p8EarlyUtc}`)

const m5Late = runInTz('America/New_York', LATE)
info('UTC-5 @ LATE 子进程输出', m5Late)
const [m5LateLocal, m5LateUtc] = m5Late.split('|')
ok('★ [真实函数] UTC-5 下 23:30Z → 本地与 UTC 同为 2026-10-11',
  m5LateLocal === '2026-10-11' && m5LateUtc === '2026-10-11',
  `${m5LateLocal} vs ${m5LateUtc}`)

/* ---------- ★ 回归保护：若 todayDateString 退回 UTC，以下必须失败 ---------- */
//
// 关键设计：UTC+8 @ LATE 场景下，
//   本地基准 → 2026-10-12（正确）
//   UTC 基准 → 2026-10-11（错误，正是本次修复前的行为）
// 因此 "UTC+8@LATE 本地日期 === 2026-10-12" 这条断言
// 只要 todayDateString 退回 UTC 就必然失败。
//
// 下面把"退回 UTC 时的预期错误值"也显式断言出来，
// 使回归保护的意图在测试输出中可见。
info('回归保护：若退回 UTC，UTC+8@LATE 会得到', p8LateUtc)
ok('★★ 回归保护：真实函数结果 != UTC 结果（否则说明退回了 UTC）',
  p8LateLocal !== p8LateUtc, `${p8LateLocal} vs ${p8LateUtc}`)
ok('★★ 回归保护：真实函数结果 = 本地日期而非 UTC 日期',
  p8LateLocal === '2026-10-12' && p8LateLocal !== p8LateUtc,
  `本地=${p8LateLocal} UTC=${p8LateUtc}`)

/* ============================================================
 * 5. 前后端 todayDateString 算法一致性
 * ============================================================ */
section('5. 前后端一致性')

const backendToday = todayDateString()
const frontendToday = (() => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
})()

info('后端 todayDateString', backendToday)
info('前端算法结果', frontendToday)
ok('★ 后端与前端"今天"一致', backendToday === frontendToday, `${backendToday} vs ${frontendToday}`)

// 真实函数在 UTC+8 下的输出（探针第 1 段）
const rTzToday = runInTz('Asia/Shanghai', LATE)
const realTodayInTz = rTzToday.split('|')[0]
ok('子进程 UTC+8 下真实 todayDateString 返回合法日期',
  /^\d{4}-\d{2}-\d{2}$/.test(realTodayInTz ?? ''), `${realTodayInTz}`)
ok('子进程 UTC+8 下真实 todayDateString 结果 = 2026-10-12（本地而非 UTC）',
  realTodayInTz === '2026-10-12', `${realTodayInTz}`)
info('子进程 UTC+8 的 todayDateString', realTodayInTz)

// ---------- 本进程直接注入固定时刻（不经过子进程）----------
//
// ⚠️ 时区前提（务必分清两类测试）：
//
//   1. 子进程测试（本节上方场景 1/2/3）
//      通过 `env: { TZ: ... }` **显式指定**时区，结果只取决于传入的 TZ，
//      与执行机器的时区无关。
//
//   2. 本进程调用（下面这几条）
//      `todayDateString()` 使用**执行机器的本地时区**，结果**随机器时区变化**。
//      因此这里**不能**把本进程结果与"固定 UTC+8 的子进程结果"比较 ——
//      那种比较只在机器恰好是 UTC+8 时成立，其他时区必然失败。
//      正确做法是把本进程结果与"用同一台机器的时区算出的期望值"比较。
const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone

const directInjected = todayDateString(new Date(LATE))
info('本进程 todayDateString(LATE)（使用执行机器时区 ' + localTz + '）', directInjected)
ok('★ 注入固定时刻返回合法日期',
  /^\d{4}-\d{2}-\d{2}$/.test(directInjected), `${directInjected}`)

// 与"同一机器时区下的日历日"比较：任何时区下都应成立（可移植）
ok('★ 注入 LATE 的结果 = 执行机器本地时区的日历日',
  directInjected === ymdInTz(LATE, localTz),
  `实测=${directInjected} 期望=${ymdInTz(LATE, localTz)} 时区=${localTz}`)

/* ---------- ★ 断言有效性自检：证明"注入参数"真的被使用 ---------- */
//
// 目的：防止"注入固定时刻"这类断言退化成恒真条件。
//
// 若 todayDateString 忽略了传入的 Date（例如返回常量、或总是取当前时间），
// 那么对两个**相隔足够远**的时刻注入结果就会相同 —— 下面这条断言随即失败。
//
// ⚠️ 必须用 FAR_PAST 而不是 EARLY：
//    LATE 与 EARLY 仅相隔 21.5 小时，在 UTC 时区下同属一天，
//    用它做自检会在 UTC 机器上误报失败。
//    FAR_PAST 与 LATE 相隔 69.5 小时，在任何时区下都不同日。
const injectedFarPast = todayDateString(new Date(FAR_PAST))
info('本进程 todayDateString(FAR_PAST) 结果', injectedFarPast)
ok('★★ 断言有效性自检：注入两个相隔 >24h 的时刻必须得到不同日期（否则说明参数被忽略）',
  directInjected !== injectedFarPast,
  `LATE→${directInjected}  FAR_PAST→${injectedFarPast}  时区=${localTz}`)

// 同时验证 FAR_PAST 的注入结果也等于其本地时区日历日（不只是"互不相等"）
ok('★ 注入 FAR_PAST 的结果 = 执行机器本地时区的日历日',
  injectedFarPast === ymdInTz(FAR_PAST, localTz),
  `实测=${injectedFarPast} 期望=${ymdInTz(FAR_PAST, localTz)} 时区=${localTz}`)

// 默认无参调用仍等于系统本地今天
ok('无参调用 = 系统本地今天',
  todayDateString() === frontendToday, `${todayDateString()} vs ${frontendToday}`)

/* ============================================================
 * 6. 临期 / 过期状态（真实业务结果）
 * ============================================================ */
section('6. 临期 / 过期状态')

/** 构造一条库存记录的临期计算输入 */
function statusOf(expiry: string | null, today: string, warningDays = 3) {
  return evaluateExpiryStatus(
    {
      expiry_date: expiry,
      purchase_date: '2026-01-01',
      production_date: null,
    },
    { mode: 'days', threshold: warningDays },
    today,
  )
}

const T = '2026-10-11'

// 已过期
const sExpired = statusOf('2026-10-10', T)
ok('昨天到期 → expired', sExpired.status === 'expired', sExpired.status)
ok('  剩余天数 -1', sExpired.days_remaining === -1, `${sExpired.days_remaining}`)

// 今天到期
const sToday = statusOf('2026-10-11', T)
ok('★ 今天到期 → expiring（不是 expired）', sToday.status === 'expiring', sToday.status)
ok('  剩余天数 0', sToday.days_remaining === 0, `${sToday.days_remaining}`)

// 明天到期
const sTomorrow = statusOf('2026-10-12', T)
ok('明天到期 → expiring', sTomorrow.status === 'expiring', sTomorrow.status)
ok('  剩余天数 1', sTomorrow.days_remaining === 1, `${sTomorrow.days_remaining}`)

// 阈值边界：第 3 天
const sDay3 = statusOf('2026-10-14', T)
ok('第 3 天（=阈值）→ expiring', sDay3.status === 'expiring', sDay3.status)

// 第 4 天 → normal
const sDay4 = statusOf('2026-10-15', T)
ok('第 4 天（>阈值）→ normal', sDay4.status === 'normal', sDay4.status)

// 无保质期
const sNone = statusOf(null, T)
ok('无到期日期 → no_expiry', sNone.status === 'no_expiry', sNone.status)

/* ============================================================
 * 7. API 端到端（独立临时库）
 * ============================================================ */
section('7. API 端到端')

const PORT = 61000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`
const dbPath = resolve(process.cwd(), 'data', `dates-${Date.now()}.db`)

for (const s of ['', '-shm', '-wal']) rmSync(`${dbPath}${s}`, { force: true })

const setup = new Database(dbPath)
setup.pragma('foreign_keys = ON')
const drizzleDir = resolve(process.cwd(), 'drizzle')
for (const f of readdirSync(drizzleDir).filter((x) => x.endsWith('.sql')).sort()) {
  for (const stmt of readFileSync(resolve(drizzleDir, f), 'utf8').split('--> statement-breakpoint')) {
    const t = stmt.trim(); if (t) setup.exec(t)
  }
}
setup.close()

const raw = new Database(dbPath)
raw.pragma('foreign_keys = ON')

interface Res { status: number; body: any }
async function req(method: string, path: string, body?: unknown): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = text.length > 0 ? JSON.parse(text) : undefined } catch { parsed = undefined }
  return { status: res.status, body: parsed }
}

const proc: ChildProcess = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOME_CHEF_DB_PATH: dbPath },
  stdio: 'ignore',
  shell: true,
})

async function waitFor(url: string, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok || r.status === 404) return true } catch { /* */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

try {
  let occupied = false
  try { await fetch(`${BASE}/health`); occupied = true } catch { /* */ }
  if (occupied) {
    console.log(`  [FAIL] 端口 ${PORT} 已占用`)
    fail++
  } else if (!(await waitFor(`${BASE}/health`))) {
    console.log('  [FAIL] 服务未就绪')
    fail++
  } else {
    info('服务地址', BASE)

    const cats = (await req('GET', '/api/categories')).body as any[]
    const veg = cats.find((c) => c.name === '蔬菜').id

    // 建一个有保质期的定义
    const d = await req('POST', '/api/definitions', {
      name: '日期测试食材',
      units: ['个'],
      estimated_shelf_life_days: 10,
      category_id: veg,
    })
    ok('创建定义 → 201', d.status === 201, `${d.status}`)
    const defId = d.body.id

    // ---- 默认入库日期 = 本地今天 ----
    const localToday = (() => {
      const n = new Date()
      return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
    })()

    const created = await req('POST', '/api/ingredients', {
      definition_id: defId,
      quantity: 5,
      unit: '个',
      // 不提供 purchase_date → 后端应填"本地今天"
    })
    ok('创建库存（不传入库日期）→ 201', created.status === 201, `${created.status}`)
    const recId = created.body.id

    const row = raw.prepare('select * from standard_ingredient where id = ?').get(recId) as any
    info('库中 purchase_date', row?.purchase_date)
    info('本地今天', localToday)
    ok('★ 默认入库日期 = 本地今天（不是 UTC 今天）', row?.purchase_date === localToday,
      `${row?.purchase_date} vs ${localToday}`)

    // 到期日期 = 入库 + 10 天
    const expectedExpiry = addDays(localToday, 10)
    info('库中 expiry_date', row?.expiry_date)
    ok('到期日期 = 入库日期 + 10 天', row?.expiry_date === expectedExpiry,
      `${row?.expiry_date} vs ${expectedExpiry}`)
    ok('expiry_date_source = estimated', row?.expiry_date_source === 'estimated', `${row?.expiry_date_source}`)

    // ---- 临期状态与本地基准一致 ----
    const list = await req('GET', '/api/ingredients')
    ok('库存列表 → 200', list.status === 200, `${list.status}`)
    const item = (list.body as any[]).find((x) => x.id === recId)
    ok('列表含该记录', item !== undefined)
    if (item) {
      info('返回的 days_remaining', String(item.days_remaining))
      info('返回的 expiry_status', String(item.expiry_status))
      ok('★ days_remaining 基于本地今天 = 10', item.days_remaining === 10, `${item.days_remaining}`)
      ok('状态为 normal（10 天 > 阈值）', item.expiry_status === 'normal', `${item.expiry_status}`)
    }

    // ---- 入库日期与到期日期相同 ----
    const same = await req('POST', '/api/ingredients', {
      definition_id: defId,
      quantity: 1,
      unit: '个',
      purchase_date: '2026-10-11',
      expiry_date: '2026-10-11',        // 手动指定 = 入库日
    })
    ok('入库日期 = 到期日期 → 201', same.status === 201, `${same.status}`)
    if (same.status === 201) {
      const r2 = raw.prepare('select * from standard_ingredient where id = ?').get(same.body.id) as any
      ok('  两者都存为 2026-10-11', r2?.purchase_date === '2026-10-11' && r2?.expiry_date === '2026-10-11',
        `${r2?.purchase_date} / ${r2?.expiry_date}`)
      ok('  source = manual', r2?.expiry_date_source === 'manual', `${r2?.expiry_date_source}`)
    }

    // ---- 跨月：purchase 10-31 + shelfLife 会跨月 ----
    const crossMonth = await req('POST', '/api/ingredients', {
      definition_id: defId,
      quantity: 1,
      unit: '个',
      purchase_date: '2026-10-31',
    })
    ok('跨月入库 → 201', crossMonth.status === 201, `${crossMonth.status}`)
    if (crossMonth.status === 201) {
      const r3 = raw.prepare('select * from standard_ingredient where id = ?').get(crossMonth.body.id) as any
      info('跨月到期日期', r3?.expiry_date)
      ok('  10-31 + 10 天 = 11-10（跨月正确）', r3?.expiry_date === '2026-11-10', `${r3?.expiry_date}`)
    }

    // ---- 跨年 ----
    const crossYear = await req('POST', '/api/ingredients', {
      definition_id: defId,
      quantity: 1,
      unit: '个',
      purchase_date: '2026-12-28',
    })
    ok('跨年入库 → 201', crossYear.status === 201, `${crossYear.status}`)
    if (crossYear.status === 201) {
      const r4 = raw.prepare('select * from standard_ingredient where id = ?').get(crossYear.body.id) as any
      info('跨年到期日期', r4?.expiry_date)
      ok('  12-28 + 10 天 = 次年 01-07（跨年正确）', r4?.expiry_date === '2027-01-07', `${r4?.expiry_date}`)
    }

    // ---- 闰年 ----
    const leap = await req('POST', '/api/ingredients', {
      definition_id: defId,
      quantity: 1,
      unit: '个',
      purchase_date: '2024-02-25',
    })
    ok('闰年入库 → 201', leap.status === 201, `${leap.status}`)
    if (leap.status === 201) {
      const r5 = raw.prepare('select * from standard_ingredient where id = ?').get(leap.body.id) as any
      info('闰年到期日期', r5?.expiry_date)
      ok('  2024-02-25 + 10 天 = 03-06（含 2-29）', r5?.expiry_date === '2024-03-06', `${r5?.expiry_date}`)
    }
  }
} finally {
  proc.kill()
  raw.close()
  await new Promise((r) => setTimeout(r, 800))
}

console.log(`\n===== 日期验证结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
