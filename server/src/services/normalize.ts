/**
 * 名称归一化。
 *
 * 对应 DATABASE_DESIGN.md 第 13.3 节（已确认决策）：
 *
 *   normalize(input) = input.trim().toLowerCase()
 *
 * - 首尾空格：trim()
 * - 大小写：toLowerCase()（**不是** toLocaleLowerCase()）
 * - 就这两步，不做其他处理
 *
 * ⚠️ 全项目**只能有这一个实现**。
 * 创建与查询必须调用同一个函数，否则 name_normalized 的 UNIQUE 约束形同虚设
 * （例如创建时用 toLowerCase()、查询时用 toLocaleLowerCase()，
 * 在土耳其语的 I/ı 等字符上结果不一致，会静默导致"刚创建的食材查不到"）。
 *
 * v0.1 明确不做（DATABASE_DESIGN.md 第 13.3 节）：
 * - 全角 / 半角转换
 * - 内部连续空格折叠
 * - 繁简转换
 * - 拼音归一化
 * - 模糊匹配 / 编辑距离
 */

/**
 * 归一化食材名称。
 *
 * 用于生成 name_normalized / alias_normalized，以及对查询输入做同样处理。
 *
 * @param input 用户输入的原始名称
 * @returns 归一化后的名称（trim + 小写）
 */
export function normalizeName(input: string): string {
  return input.trim().toLowerCase()
}

/**
 * 名称是否为空（归一化之后判断）。
 *
 * 注意必须在 normalize 之后再判断：
 * 只包含空白的输入（如 "   "）trim 后为空，应视为无效。
 *
 * @param input 用户输入的原始名称
 * @returns 归一化后是否为空字符串
 */
export function isBlankName(input: string): boolean {
  return normalizeName(input).length === 0
}
