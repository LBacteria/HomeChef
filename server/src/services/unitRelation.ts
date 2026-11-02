import { prepareQuantityForWrite } from './quantity.js'
/** 每批次独立的数量关系；无关系时只接受完全相同的单位。 */
export interface UnitRelation { unit: string; secondary_unit?: string | null; secondary_ratio?: number | null }
export function unitFactor(lot: UnitRelation, requested: string | null): number {
  if (requested === lot.unit) return 1
  if (requested === lot.secondary_unit && typeof lot.secondary_ratio === 'number' && Number.isFinite(lot.secondary_ratio) && lot.secondary_ratio > 0) return lot.secondary_ratio
  return 0
}

// 换算后保留有效精度；例如 1 克 / 每个 300 克，不能先把个数舍入成 0.003。
export function lotQuantity(value: number, related: boolean): number {
  return related ? Number(Math.max(0, value).toPrecision(15)) : prepareQuantityForWrite(value)
}
export function remainingLot(lot: UnitRelation & {quantity:number}, take:number, requested:string) {
  return lotQuantity(lot.quantity - take / unitFactor(lot, requested), lot.secondary_unit != null)
}
