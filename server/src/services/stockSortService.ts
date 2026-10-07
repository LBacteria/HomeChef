import type { ExpiryStatus, StandardIngredient } from '../db/schema.js'
import type { ExpiryContext, ExpiryRule } from './expiryStatusService.js'
import { evaluateExpiryStatus } from './expiryStatusService.js'

/**
 * 库存排序 Service。
 *
 * 设计原则：
 *   - **排序逻辑集中在 Service**，前端不自行排序 ——
 *     后续食谱系统与其他页面可复用同一套规则。
 *   - 排序键使用**真实数据**（expiry_date / days_remaining / quantity / purchase_date），
 *     绝不对显示文本排序。
 *   - **白名单**，不接受任意字段名，杜绝 SQL 注入。
 *   - 最后一定有稳定 tie-breaker（id ASC），保证刷新后顺序不变。
 *
 * ⚠️ 排序只影响**展示顺序**，绝不修改任何库存数据
 *    （不合并、不改 ID、不改 expiry、不改数量、不改 purchase_date）。
 */

/** 允许的排序字段（白名单） */
export const SORT_FIELDS = ['default', 'expiry', 'purchase_date', 'name', 'quantity'] as const

export type SortField = (typeof SORT_FIELDS)[number]

/** 允许的排序方向（白名单） */
export const SORT_ORDERS = ['asc', 'desc'] as const

export type SortOrder = (typeof SORT_ORDERS)[number]

/**
 * 默认排序中状态的分组顺序。
 *
 *   expired   → 0（最优先，最需要关注）
 *   expiring  → 1
 *   normal    → 2
 *   no_expiry → 3（最后）
 *
 * ⚠️ 该映射**只在 Service 层使用**，不下发到前端、不在前端硬编码。
 */
const STATUS_ORDER: Record<ExpiryStatus, number> = {
  expired: 0,
  expiring: 1,
  normal: 2,
  no_expiry: 3,
}

/** 排序所需的上下文（含动态计算的临期信息与食材名称） */
export interface SortableStock {
  row: StandardIngredient
  status: ExpiryStatus
  daysRemaining: number | null
  /** 食材默认名称（来自 ingredient_definition） */
  name: string
}

/**
 * 构建可排序列表：为每条库存计算临期信息与名称。
 *
 * @param rows 库存行
 * @param rule 临期规则
 * @param today 今天
 * @param nameOf definition_id → 默认名称
 */
export function buildSortableList(
  rows: StandardIngredient[],
  rule: ExpiryRule,
  today: string,
  nameOf: (definitionId: number) => string,
): SortableStock[] {
  return rows.map((row) => {
    const context: ExpiryContext = {
      expiry_date: row.expiry_date,
      purchase_date: row.purchase_date,
      production_date: row.production_date,
    }
    const evaluation = evaluateExpiryStatus(context, rule, today)

    return {
      row,
      status: evaluation.status,
      daysRemaining: evaluation.days_remaining,
      name: nameOf(row.definition_id),
    }
  })
}

/**
 * 名称比较。
 *
 * 使用 localeCompare 并指定中文与数字感知：
 *   - 中文按 Unicode 码点顺序（不引入拼音库，符合要求）
 *   - numeric: true 让「2」排在「10」前面（对含数字的名称更自然）
 */
function compareName(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
}

/**
 * 有 expiry 与无 expiry 的处理。
 *
 * ⚠️ 无 expiry **不当作 0 天**：
 *    - asc（短 → 长）：有 expiry 的在前，无 expiry 的排在其后
 *    - desc（长 → 短）：同样让无 expiry 的排在最后
 *      （「无保质期」既不是最短也不是最长，放在末尾最不容易误导；
 *       若按 0 处理会在 asc 中排到最前，与直觉相反）
 *
 * @returns 负数表示 a 在前
 */
function compareDaysRemaining(
  a: SortableStock,
  b: SortableStock,
  order: SortOrder,
): number {
  const aHas = a.daysRemaining !== null
  const bHas = b.daysRemaining !== null

  // 无 expiry 一律排在后面（两个方向都是）
  if (aHas && !bHas) return -1
  if (!aHas && bHas) return 1
  if (!aHas && !bHas) return 0

  const diff = (a.daysRemaining as number) - (b.daysRemaining as number)
  return order === 'asc' ? diff : -diff
}

/**
 * 按指定字段与方向排序。
 *
 * @param items 可排序列表（通常是 buildSortableList 的产物）
 * @param field 排序字段（白名单内）
 * @param order 方向（白名单内）
 * @param direction 各字段的"自然方向"覆盖，用于 UI 的中文语义
 *                  （例如「短 → 长」对应 expiry + asc）
 */
export function sortStock(
  items: SortableStock[],
  field: SortField,
  order: SortOrder,
): SortableStock[] {
  // 复制一份，不修改入参
  const sorted = [...items]

  sorted.sort((a, b) => {
    let primary = 0

    switch (field) {
      /* ---------- 默认排序 ---------- */
      case 'default': {
        // 1. 状态分组
        const sa = STATUS_ORDER[a.status]
        const sb = STATUS_ORDER[b.status]
        if (sa !== sb) {
          primary = sa - sb
          break
        }

        // 2. 剩余天数升序（无 expiry 的在同一状态内保持在后面）
        primary = compareDaysRemaining(a, b, 'asc')
        if (primary !== 0) break

        // 3. 入库日期（早的在前）
        if (a.row.purchase_date !== b.row.purchase_date) {
          primary = a.row.purchase_date < b.row.purchase_date ? -1 : 1
          break
        }

        // 4. 食材名称
        primary = compareName(a.name, b.name)
        break
      }

      /* ---------- 保质期剩余时间 ---------- */
      case 'expiry': {
        primary = compareDaysRemaining(a, b, order)
        break
      }

      /* ---------- 入库日期 ---------- */
      case 'purchase_date': {
        if (a.row.purchase_date !== b.row.purchase_date) {
          const cmp = a.row.purchase_date < b.row.purchase_date ? -1 : 1
          primary = order === 'asc' ? cmp : -cmp
        }
        break
      }

      /* ---------- 食材名称 ---------- */
      case 'name': {
        const cmp = compareName(a.name, b.name)
        primary = order === 'asc' ? cmp : -cmp
        break
      }

      /* ---------- 数量 ---------- */
      case 'quantity': {
        // ⚠️ 数值比较，不是字符串比较（10 必须大于 2）
        if (a.row.quantity !== b.row.quantity) {
          const cmp = a.row.quantity < b.row.quantity ? -1 : 1
          primary = order === 'asc' ? cmp : -cmp
        }
        break
      }
    }

    if (primary !== 0) return primary

    // 5. 稳定 tie-breaker：inventory id 升序
    return a.row.id - b.row.id
  })

  return sorted
}

/** 校验排序字段是否在白名单内 */
export function isValidSortField(value: unknown): value is SortField {
  return typeof value === 'string' && (SORT_FIELDS as readonly string[]).includes(value)
}

/** 校验排序方向是否在白名单内 */
export function isValidSortOrder(value: unknown): value is SortOrder {
  return typeof value === 'string' && (SORT_ORDERS as readonly string[]).includes(value)
}
