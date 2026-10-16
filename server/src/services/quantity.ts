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

/**
 * **一条配料行按份数缩放后的需求量**（R1：推荐 / 预览 / 结算的唯一口径）。
 *
 * ```
 * scaleLineQuantity(quantity, servings) =
 *   quantity === null ? null : roundQuantity(quantity × servings)
 * ```
 *
 * ⚠️⚠️ 为什么必须**先缩放、再舍入、然后才合并**：
 *   旧实现里推荐侧是「先累加未舍入的 `quantity × servings`，再对累加结果舍入」，
 *   而结算侧是「逐行 `roundQuantity` 后再求和」—— 两种舍入序列在 3 位小数下
 *   会差 **0.001**，于是出现「推荐说 ready、结算却库存不足」。
 *   例如两条同定义同单位的需求 `0.001` 与 `0.019`（`servings = 0.5`）、库存 `0.010`：
 *     - 逐行舍入后求和：`0.001 + 0.010 = 0.011`（结算口径，必然需要 0.011）
 *     - 累加后一次舍入：浮点尾差可能得到 `0.010`（推荐旧口径 → 误判 ready）
 *   统一到本函数后，两边得到**同一个** `0.011`，且**与配料行顺序无关**
 *   （每个加数都已是 3 位小数，任意顺序求和后再舍入都回到同一个值）。
 *
 * ⚠️ 本函数**不做单位换算**，也不引入 Decimal —— 保持项目既有的 3 位小数语义。
 *
 * @param quantity 菜谱原始用量（`null` = 未指定）
 * @param servings 份数倍数（人数 ÷ 基准人数）
 */
export function scaleLineQuantity(
  quantity: number | null,
  servings: number,
): number | null {
  return quantity === null ? null : roundQuantity(quantity * servings)
}
