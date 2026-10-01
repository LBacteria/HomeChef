import type { ExpiryDateSource, InventoryRecord } from './types/api'

/**
 * 显示格式化工具。
 *
 * ⚠️ 只影响显示，绝不改变后端数值。
 * ⚠️ 不做任何食品安全判断。
 */

/**
 * 格式化数量：整数显示整数，小数最多 3 位，去掉末尾多余的 0。
 *
 * 后端存储是 REAL，可能有浮点噪声，先舍入到 3 位再格式化。
 */
export function formatQuantity(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value)
  }
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

/** 数量 + 单位，例如 "500 克"、"1.5 千克" */
export function formatQuantityWithUnit(value: number, unit: string): string {
  return `${formatQuantity(value)} ${unit}`
}

/**
 * 今天的日期字符串（YYYY-MM-DD）。
 *
 * 用本地时间，因为这是给用户看的"今天"。
 * ⚠️ 前端**不**用它做日期加减（那是后端的职责）。
 */
export function todayDateString(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 到期日期的显示标签。
 *
 * estimated → "预计到期"
 * manual    → "到期"
 * null      → null（不显示）
 *
 * ⚠️ estimated 必须带"预计"，避免用户误以为是厂家提供的真实保质期。
 */
export function expiryLabel(source: ExpiryDateSource | null): string | null {
  if (source === 'estimated') return '预计到期'
  if (source === 'manual') return '到期'
  return null
}

/**
 * 到期日期是否已超过（仅用于提示，非食品安全判断）。
 *
 * 依赖 ISO 8601 的"字典序 = 时间序"。
 */
export function isPastDate(date: string | null): boolean {
  if (!date) return false
  return date < todayDateString()
}

/**
 * 为一条库存记录生成到期提示文本。
 *
 * 返回 null 表示不显示该行（expiry_date 为 null）。
 */
export function describeExpiry(record: {
  expiry_date: string | null
  expiry_date_source: ExpiryDateSource | null
}): { label: string; date: string; overdue: boolean } | null {
  const label = expiryLabel(record.expiry_date_source)
  if (!label || !record.expiry_date) {
    return null
  }
  return {
    label,
    date: record.expiry_date,
    overdue: isPastDate(record.expiry_date),
  }
}

/**
 * 按 definition 对库存记录分组。
 *
 * ⚠️ **不做任何数量聚合** —— 不同单位不能相加。
 *    同组内保持后端返回的顺序。
 */
export interface InventoryGroup {
  definitionId: number
  records: InventoryRecord[]
}

export function groupByDefinition(records: InventoryRecord[]): InventoryGroup[] {
  const map = new Map<number, InventoryRecord[]>()

  for (const record of records) {
    const list = map.get(record.definition_id)
    if (list) {
      list.push(record)
    } else {
      map.set(record.definition_id, [record])
    }
  }

  return [...map.entries()].map(([definitionId, list]) => ({
    definitionId,
    records: list,
  }))
}
