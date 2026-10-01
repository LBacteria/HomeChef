/**
 * 数量处理：舍入与钳制。
 *
 * 对应 DATABASE_DESIGN.md 第 7.6 节"必须配套的措施"：
 *
 *   ① 写入前舍入 —— 所有写入前把数量舍入到固定小数位（3 位），消除大部分累积误差
 *   ② 扣减后钳制 —— 结果若在容差内（1e-9）为负，钳制为 0，避免 CHECK 意外失败
 *
 * ⚠️ 设计明确要求：**舍入与钳制逻辑集中在一处实现，不允许散落在各个调用点。**
 * 这里就是那"一处"。
 *
 * 背景：quantity 使用 SQLite REAL（IEEE 754 双精度）。
 * 浮点误差会导致 1 - 0.1*10 得到 1.38e-17 或 -1.1e-16，
 * 后者会让 `CHECK (quantity >= 0)` 意外失败，用户看到莫名错误。
 */

/** 数量保留的小数位（DATABASE_DESIGN.md 第 7.6 节措施 ①：建议 3 位） */
export const QUANTITY_DECIMALS = 3

/** 钳制容差（DATABASE_DESIGN.md 第 7.6 节措施 ②：如 1e-9） */
export const QUANTITY_EPSILON = 1e-9

/**
 * 把数量舍入到固定精度。
 *
 * 所有写入 quantity 之前都必须经过这里。
 *
 * @param value 原始数量
 * @returns 舍入到 QUANTITY_DECIMALS 位的数量
 */
export function roundQuantity(value: number): number {
  const factor = 10 ** QUANTITY_DECIMALS
  return Math.round(value * factor) / factor
}

/**
 * 把接近 0 的负值钳制为 0。
 *
 * 用于扣减之后：浮点误差可能产生 -1.1e-16 这样的值，
 * 它会让 `CHECK (quantity >= 0)` 失败。
 *
 * 注意：只有**在容差内**的负值才被钳制为 0。
 * 真正的负数（如 -1）不会被钳制，应当由调用方拒绝。
 *
 * @param value 计算结果
 * @returns 容差内的负值 → 0；其余原样返回
 */
export function clampQuantity(value: number): number {
  if (value < 0 && value > -QUANTITY_EPSILON) {
    return 0
  }
  return value
}

/**
 * 写入前的数量规范化：先钳制，再舍入。
 *
 * 这是 create / update（以及将来的 consume）写入 quantity 前**必须调用**的函数。
 *
 * @param value 原始数量
 * @returns 可安全写入数据库的数量
 */
export function prepareQuantityForWrite(value: number): number {
  return roundQuantity(clampQuantity(value))
}

/**
 * 数量是否合法：必须是有限数且非负。
 *
 * 这同时是 STRICT 表不可用后的补偿措施
 * （DATABASE_DESIGN.md 第 10.6 节：Service 层在写入前校验数值类型，
 * 防止 NaN / Infinity / 字符串被写入）。
 *
 * @param value 待校验的值
 * @returns 是否为合法数量
 */
export function isValidQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
