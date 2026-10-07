import type { ExpiryStatus, ExpiryWarningMode } from '../db/schema.js'
import { compareDates, todayDateString } from './dates.js'

/**
 * 临期状态计算。
 *
 * ⚠️ 临期状态是**动态计算**的，绝不写入数据库。
 *    它只依赖：库存的 expiry_date / production_date / purchase_date、
 *    当前日期、以及当前临期设置。
 *
 * 四种状态：
 *   no_expiry —— 没有到期日期
 *   expired   —— 已超过 expiry_date（**永远优先于临期判断**）
 *   expiring  —— 未过期，且满足临期规则
 *   normal    —— 有到期日期，但既未过期也未进入临期阈值
 */

export interface ExpiryContext {
  expiry_date: string | null
  purchase_date: string
  production_date: string | null
}

export interface ExpiryRule {
  mode: ExpiryWarningMode
  threshold: number
}

/**
 * 计算两个 ISO 日期间的天数差（b - a）。
 *
 * 使用 UTC 午夜，避免本地时区导致跨日误差。
 * 复用与 dates.ts 一致的解析方式。
 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86400000)
}

/**
 * 确定保质期起点（start_date）。
 *
 * 规则与现有 expiry 语义保持一致：
 *
 *   - **estimated**：expiry 由 `production_date ?? purchase_date + shelf_life` 算出
 *     （见 standardIngredientService.computeExpiry 情况 B/C），
 *     因此起点也用同一个式子：有 production_date 就用它，否则用 purchase_date。
 *
 *   - **manual**：expiry 由用户直接填写，系统**不参与**其起点推断。
 *     为不擅自改变既有 expiry 语义，仍按同一优先级取起点
 *     （有 production_date 用 production_date，否则 purchase_date），
 *     但这只是**百分比计算的分母**，不会回写或影响 expiry 本身。
 *
 *   - **无到期日期**：属于 no_expiry 分支，不会走到这里。
 *
 * 注意：本函数**不读取 `expiry_date_source`**。
 * 原因是两种 source 下起点的选取规则相同（production_date ?? purchase_date），
 * 读取 source 只会引入无意义的分支。
 *
 * ⚠️ 本函数**只读**，绝不修改任何库存字段。
 */
export function resolveShelfLifeStartDate(record: ExpiryContext): string {
  return record.production_date ?? record.purchase_date
}

export interface ExpiryEvaluation {
  status: ExpiryStatus
  /** 距 expiry_date 的剩余天数（可为负）。no_expiry 时为 null */
  days_remaining: number | null
  /** 剩余保质期百分比。无法计算（总时长为 0 或非正）时为 null */
  remaining_percentage: number | null
}

/**
 * 计算一条库存记录的临期状态。
 *
 * @param record 库存的日期上下文
 * @param rule   当前临期规则
 * @param today  今天（注入以便测试；默认取 UTC 今天）
 */
export function evaluateExpiryStatus(
  record: ExpiryContext,
  rule: ExpiryRule,
  today: string = todayDateString(),
): ExpiryEvaluation {
  /* ---------- 1. 无到期日期 ---------- */
  if (record.expiry_date === null) {
    return { status: 'no_expiry', days_remaining: null, remaining_percentage: null }
  }

  const expiryDate = record.expiry_date
  const daysRemaining = daysBetween(today, expiryDate)

  /* ---------- 2. 已过期（永远优先） ---------- */
  //
  // compareDates(today, expiry) > 0 表示 today > expiry，即已超过到期日。
  // 注意：「今天正好是 expiry_date」**不算过期**（days_remaining === 0）。
  if (compareDates(today, expiryDate) > 0) {
    return {
      status: 'expired',
      days_remaining: daysRemaining,
      remaining_percentage: computeRemainingPercentage(record, expiryDate, today),
    }
  }

  /* ---------- 3. 未过期 → 按模式判断是否临期 ---------- */
  if (rule.mode === 'days') {
    // 剩余天数 <= 阈值即临期。临界值使用 <=（含等于）。
    const status: ExpiryStatus = daysRemaining <= rule.threshold ? 'expiring' : 'normal'
    return {
      status,
      days_remaining: daysRemaining,
      remaining_percentage: null,
    }
  }

  /* ---------- 4. percentage 模式 ---------- */
  //
  // 规则（v0.1.2 最终确定）：
  //
  //   expiring_days = ceil(total_duration_days × threshold / 100)
  //   days_remaining <= expiring_days → expiring
  //
  // 即「把百分比折算成天数」再比较，**不使用** remaining_percentage <= threshold。
  //
  // 示例：
  //   10 天 × 15% = 1.5  → ceil → 2 天
  //    7 天 × 15% = 1.05 → ceil → 2 天
  //    3 天 × 15% = 0.45 → ceil → 1 天
  //
  // ⚠️ 必须 **向上取整**（Math.ceil），不四舍五入、不向下取整 ——
  //    否则「剩余不到一天」的记录会被判为 normal，用户看不到临期提醒。
  const remainingPercentage = computeRemainingPercentage(record, expiryDate, today)
  const totalDuration = computeTotalDuration(record, expiryDate)

  // 总时长为 0 或非正（例如 purchase_date === expiry_date）→ 无法折算天数。
  // 此时退化为「今天到期即临期」：未过期且总时长为 0 ⇔ 今天正好到期。
  if (totalDuration === null || totalDuration <= 0) {
    return {
      status: 'expiring',
      days_remaining: daysRemaining,
      remaining_percentage: remainingPercentage,
    }
  }

  const expiringDays = Math.ceil((totalDuration * rule.threshold) / 100)

  // 注意：remaining_percentage 仍然返回（作为展示信息），但**不参与**状态判断。
  const status: ExpiryStatus = daysRemaining <= expiringDays ? 'expiring' : 'normal'

  return {
    status,
    days_remaining: daysRemaining,
    remaining_percentage: remainingPercentage,
  }
}

/**
 * 计算总保质期天数（expiry_date - start_date）。
 *
 * @returns 天数；无法计算时返回 null
 */
function computeTotalDuration(record: ExpiryContext, expiryDate: string): number | null {
  const startDate = resolveShelfLifeStartDate(record)
  return daysBetween(startDate, expiryDate)
}

/**
 * 计算剩余保质期百分比。
 *
 *   total_duration     = expiry_date - start_date
 *   remaining_duration = expiry_date - today
 *   remaining_percentage = remaining_duration / total_duration * 100
 *
 * ⚠️ 该字段**只用于 API 展示**，自 v0.1.2 起**不再参与 expiry_status 判断**
 *    （percentage 模式已改为「折算天数」语义，见 evaluateExpiryStatus）。
 *
 * @returns 百分比；当 total_duration <= 0 时返回 null（无法表达比例）
 */
function computeRemainingPercentage(
  record: ExpiryContext,
  expiryDate: string,
  today: string,
): number | null {
  const totalDuration = computeTotalDuration(record, expiryDate)

  // 总时长非正 → 无法计算比例（例如 purchase_date === expiry_date）
  if (totalDuration === null || totalDuration <= 0) {
    return null
  }

  const remainingDuration = daysBetween(today, expiryDate)

  // 保留 2 位小数，避免浮点噪声影响展示
  return Math.round((remainingDuration / totalDuration) * 10000) / 100
}
