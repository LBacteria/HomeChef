/**
 * 日期工具 —— 纯日期运算。
 *
 * ⚠️ 全部使用 UTC，避免本地时区导致跨日错误。
 *
 * 反例（错误做法）：
 *   new Date('2026-10-02')            → 解析为 UTC 午夜
 *   new Date(2026, 9, 2)              → 解析为**本地**午夜，在不同时区偏移不同
 *   date.setDate(date.getDate() + 7)  → 用本地时区加减，跨时区会差一天
 *
 * 正确做法：解析为 UTC，用 setUTCDate / getUTCDate 运算，输出 YYYY-MM-DD。
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
 * 今天的日期（UTC）。
 *
 * 注意：使用 UTC 而非本地时区，保证与所有日期运算逻辑一致。
 * 对 v0.1 单用户本地应用而言，UTC 与本地日期的差异最多一天，
 * 但一致性比"贴近本地"更重要 —— 否则跨时区计算会出错。
 */
export function todayDateString(): DateString {
  return toDateString(new Date())
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
