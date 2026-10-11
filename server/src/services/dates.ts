/**
 * 日期工具 —— 纯日期运算。
 *
 * ⚠️ 两个概念要分清：
 *
 *   1. **纯日期运算**（addDays / compareDates / isValidDateString）
 *      全程使用 UTC，避免本地时区导致跨日错误。
 *
 *      反例（错误做法）：
 *        new Date('2026-10-02')            → 解析为 UTC 午夜
 *        new Date(2026, 9, 2)              → 解析为**本地**午夜，在不同时区偏移不同
 *        date.setDate(date.getDate() + 7)  → 用本地时区加减，跨时区会差一天
 *
 *      正确做法：解析为 UTC，用 setUTCDate / getUTCDate 运算，输出 YYYY-MM-DD。
 *
 *   2. **"今天"的取值基准**（todayDateString）
 *      取**用户本地日历日期** —— 因为日期字段表示日历日期，
 *      用户说的"今天"就是他电脑上日历显示的那一天。
 *      必须与前端 client/src/format.ts 的 todayDateString 保持一致。
 *
 * 日期格式统一为 ISO 8601 的 YYYY-MM-DD（与数据库存储一致）。
 */

/** 日期字符串格式：YYYY-MM-DD */
export type DateString = string

/** 校验是否为合法的 YYYY-MM-DD 日期字符串 */
export function isValidDateString(value: unknown): value is DateString {
  if (typeof value !== 'string') {
    return false
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  // 校验真实存在的日期（例如 2026-02-30 不合法）
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) {
    return false
  }
  // 防止 Date 自动进位（如 2 月 30 日变成 3 月 2 日）
  return d.toISOString().slice(0, 10) === value
}

/** 把 Date 转为 YYYY-MM-DD（UTC） */
function toDateString(date: Date): DateString {
  return date.toISOString().slice(0, 10)
}

/** 解析 YYYY-MM-DD 为 UTC 午夜的 Date */
function parseUTCDate(value: DateString): Date {
  return new Date(`${value}T00:00:00Z`)
}

/**
 * 今天的日期（**用户本地日历日期**）。
 *
 * ⚠️ 基准说明（v0.1.4 修复）：
 *   HomeChef 是单机单用户本地应用，日期字段表示**日历日期**而非时间点。
 *   用户说的"今天"就是他电脑上日历显示的那一天，因此这里取**本地日期**。
 *
 *   此前使用 UTC 日期，会导致 UTC+8 时区在北京时间 00:00–08:00 之间
 *   把"今天"判成前一天，与前端 `client/src/format.ts` 的本地日期不一致：
 *     - 默认入库日期会填成昨天
 *     - 临期 / 过期状态晚一天
 *
 * ⚠️ 只改**取值基准**；addDays / compareDates 等纯日期运算仍用 UTC
 *    （纯日期字符串运算不涉及时区，保持原实现即可）。
 *
 * @param now 可选。**仅供测试注入固定时刻**，业务调用一律不传。
 *            传入时按该 Date 的本地日历取值，使结果可重复验证。
 *            不允许传 null / undefined 以外的假值 —— 省略即用当前时间。
 */
export function todayDateString(now: Date = new Date()): DateString {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 日期加法：在基准日期上增加 N 天。
 *
 * @param baseDate YYYY-MM-DD
 * @param days 天数（可正可负，允许 0）
 * @returns 新的 YYYY-MM-DD
 */
export function addDays(baseDate: DateString, days: number): DateString {
  const d = parseUTCDate(baseDate)
  d.setUTCDate(d.getUTCDate() + days)
  return toDateString(d)
}

/**
 * 日期比较：a < b 返回负数，a === b 返回 0，a > b 返回正数。
 *
 * 依赖 ISO 8601 的"字典序 = 时间序"特性。
 */
export function compareDates(a: DateString, b: DateString): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
