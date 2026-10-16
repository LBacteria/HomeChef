import { and, asc, eq, sql } from 'drizzle-orm'

import { db } from '../db/index.js'
import { standardIngredient } from '../db/schema.js'
import { todayDateString } from './dates.js'
import { evaluateExpiryStatus } from './expiryStatusService.js'
import { roundQuantity } from './quantity.js'
import { getSettings } from './settingsService.js'

/**
 * **可用库存口径的唯一实现处**（v0.2.3）。
 *
 * 为什么单独成模块：结算扣减、结算预览、需求确认判定（`requiredReasonOf`）、
 * 以及菜谱建立时的必需跳过项计算（`requiredSkipsOf`）**必须**用同一套规则，
 * 否则会出现「预览说可扣、结算说不足」「确认项算不出/算多了」这类跨模块分歧。
 *
 * 规则（不得放宽）：
 *   1. 同 `definition_id` + **单位完全相同**（绝不换算）；
 *   2. 只取 `quantity > 0` 的记录（数量 0 无法提供任何扣减）；
 *   3. 排序为 **FEFO**：有到期日前 → `expiry_date` 升序 → `id` 升序；
 *   4. `allow_expired_for_recipe === false`（默认）时**排除已过期批次**；
 *      `true` 时保留（过期批次因到期日最早而**最先被扣**）；
 *   5. 「今天正好到期」**不算过期**（`evaluateExpiryStatus` 语义）。
 */

/** 与 settlementService 相同的 Queryable 形状（db 或事务对象） */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
export type AvailabilityQueryable = Tx | typeof db

export function availableStockRows(q: AvailabilityQueryable, definitionId: number, unit: string) {
  const rows = q
    .select()
    .from(standardIngredient)
    .where(
      and(
        eq(standardIngredient.definition_id, definitionId),
        eq(standardIngredient.unit, unit),
      ),
    )
    .orderBy(
      sql`case when ${standardIngredient.expiry_date} is null then 1 else 0 end`,
      asc(standardIngredient.expiry_date),
      asc(standardIngredient.id),
    )
    .all()
    .filter((r) => r.quantity > 0)

  const settings = getSettings()
  if (settings.allow_expired_for_recipe) {
    return rows
  }

  const rule = {
    mode: settings.expiry_warning_mode,
    threshold: settings.expiry_warning_threshold,
  }
  const today = todayDateString()

  return rows.filter((row) => {
    const evaluation = evaluateExpiryStatus(
      {
        expiry_date: row.expiry_date,
        purchase_date: row.purchase_date,
        production_date: row.production_date,
      },
      rule,
      today,
    )
    return evaluation.status !== 'expired'
  })
}

/** 同单位**可用**总量（与 `availableStockRows` 完全同口径） */
export function sumAvailableQuantity(
  q: AvailabilityQueryable,
  definitionId: number,
  unit: string,
): number {
  return availableStockRows(q, definitionId, unit).reduce(
    (sum, r) => roundQuantity(sum + r.quantity),
    0,
  )
}

/**
 * 是否存在**单位完全一致**的库存记录（**不看数量是否为 0**）。
 *
 * ⚠️ 与 `sumAvailableQuantity` 是两件事：本题只回答"单位对得上吗"，
 *    数量充足性由调用方另行判断（见 `deriveRequiredReason`）。
 */
export function hasUnitMatchedLot(
  q: AvailabilityQueryable,
  definitionId: number,
  unit: string,
): boolean {
  return (
    q
      .select({ id: standardIngredient.id })
      .from(standardIngredient)
      .where(
        and(
          eq(standardIngredient.definition_id, definitionId),
          eq(standardIngredient.unit, unit),
        ),
      )
      .get() !== undefined
  )
}
