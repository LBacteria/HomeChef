/**
 * 显示格式化工具。
 *
 * ⚠️ 这些函数**只影响显示**，绝不改变后端实际数值。
 */

/**
 * 格式化数量用于显示。
 *
 * 规则（PRD 第 14 条）：
 * - 整数显示整数（500，不是 500.000）
 * - 小数最多 3 位
 * - 去掉末尾多余的 0
 *
 * 后端存储是 REAL，可能有浮点噪声（如 0.30000000000000004），
 * 这里先舍入到 3 位再格式化。
 *
 * @param value 数量
 * @returns 格式化后的字符串
 */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }

  // 先舍入到 3 位，消除浮点噪声
  const rounded = Math.round(value * 1000) / 1000

  // Number.prototype.toString 会自动去掉末尾的 0
  // 500 → "500"，1.5 → "1.5"，0.1 + 0.2 舍入后 → "0.3"
  return String(rounded)
}

/**
 * 格式化数量 + 单位，例如 "500 克"、"1.5 千克"、"2 个"。
 */
export function formatQuantityWithUnit(value: number, unit: string): string {
  return `${formatQuantity(value)} ${unit}`
}

/**
 * 日期是否已过期。
 *
 * 只做简单比较：ISO 8601 的 YYYY-MM-DD 字典序即时间序。
 * 与"今天"比较时使用本地日期（不引入日期库）。
 *
 * ⚠️ "即将过期"的阈值本轮**不做**定义（PRD 第 16 条），
 *    这里只判断"是否已经过期"。
 *
 * @param expiryDate YYYY-MM-DD，可为 null
 * @returns 是否已过期
 */
export function isExpired(expiryDate: string | null): boolean {
  if (!expiryDate) {
    return false
  }

  // 本地日期，格式 YYYY-MM-DD
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  const todayStr = `${year}-${month}-${day}`

  return expiryDate < todayStr
}
