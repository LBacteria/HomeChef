/**
 * 测试专用的**受控故障注入**。
 *
 * 目的
 * ────
 * 验证「统一保存」在**事务已执行部分写入之后**失败时，能否完整回滚。
 * 仅靠输入校验无法覆盖这条路径 —— 因为所有校验都在事务开始之前完成，
 * 事务内永远不会抛错。
 *
 * 设计原则（重要）
 * ───────────────
 * 1. ❌ **不是** HTTP 接口 —— 不存在任何可通过网络触发的调试端点
 * 2. ✅ 只由**环境变量** `HOME_CHEF_FAULT_INJECT` 控制
 * 3. ✅ **默认完全不生效**：未设置该变量时，`faultPoint()` 是空操作
 * 4. ✅ 只影响被测进程（测试用独立临时库 + 独立端口 + 独立 env）
 * 5. ✅ 生产环境不设置此变量 → 行为与之前**逐字节一致**
 *
 * 用法（仅测试脚本）
 * ──────────────────
 *   env: { HOME_CHEF_FAULT_INJECT: 'recipe_full_save_after_links' }
 *
 * 与既有 `HOME_CHEF_DB_PATH` 属同一类「测试专用环境变量」，
 * 见 `src/db/index.ts` 的注释。
 */

/** 支持注入的故障点标识 */
export type FaultPoint =
  /** 统一保存：三部分写完之后（菜谱 / 食材关联 / Tag 关联均已写入） */
  | 'recipe_full_save_after_links'

/**
 * 在指定故障点按需抛出异常。
 *
 * ⚠️ 未设置 `HOME_CHEF_FAULT_INJECT`、或值与 `point` 不匹配时，
 *    本函数**什么都不做**（零开销、零副作用）。
 *
 * @param point 当前所处的故障点
 * @throws Error 当环境变量恰好等于该故障点名时
 */
export function faultPoint(point: FaultPoint): void {
  if (process.env.HOME_CHEF_FAULT_INJECT === point || ((import.meta.env.MODE === 'validation' || import.meta.env.MODE === 'content-validation') && (globalThis as any).__homechefFault === point)) {
    throw new Error(`[FAULT-INJECTION] 在故障点 ${point} 人为抛出异常（仅测试用）`)
  }
}
