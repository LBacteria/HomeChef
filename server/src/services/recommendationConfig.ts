/**
 * v0.2.2 整餐推荐 —— **集中参数**。
 *
 * 设计原则：
 *   - 所有可调参数集中在本文件，算法与服务层不得散落魔法数字；
 *   - 纯本地规则算法，**不接入任何 AI / 网络请求**；
 *   - 参数改动即可调整口味，不需要动算法主流程。
 */

/** 菜谱基准人数：菜谱表本身**没有**基准人数字段，在此集中约定。 */
export const DEFAULT_RECIPE_BASE_SERVINGS = 2

export interface MealSizeRule {
  /** 人数上限（含） */
  max_people: number
  /** 该人数区间建议的菜品数量 */
  dishes: number
}

/**
 * 人数 → 整餐菜品数量（通常 2–3 菜）。
 *
 * ⚠️ 实际菜品数还会被「可用候选菜谱数」下调（菜谱少时允许简餐）。
 */
export const MEAL_SIZE_BY_PEOPLE: readonly MealSizeRule[] = [
  { max_people: 1, dishes: 2 },
  { max_people: Number.POSITIVE_INFINITY, dishes: 3 },
]

/** 返回给前端的方案数量区间 */
export const MIN_PLANS = 3
export const MAX_PLANS = 5

/** 人数输入范围 */
export const MIN_PEOPLE = 1
export const MAX_PEOPLE = 12

/** 单道菜份数倍数上限（进入烹饪时校验；防止异常大的写入） */
export const MAX_SERVINGS_MULTIPLIER = 20

/* ------------------------------------------------------------
 * 复杂度上限（防组合爆炸）
 * ------------------------------------------------------------ */

/** 参与组合的候选菜谱数量上限（按 recipe_id 升序截取，确定性） */
export const MAX_CANDIDATE_RECIPES = 40

/** 最多评估的组合数；超出后只评估前 N 个（按字典序，确定性） */
export const MAX_COMBINATIONS = 20000

/* ------------------------------------------------------------
 * 过期与临期
 * ------------------------------------------------------------ */

/**
 * 是否把**已过期**库存计入可用数量。
 *
 * ⚠️ 默认 **false**：需求明确「推荐不将过期视作可用」。
 *    已过期库存仍然会被**报告**（理由里提示），但不计入可满足数量。
 *    注意：这与设置里的 `allow_expired_for_recipe` 是**两件事** ——
 *    后者影响结算是否允许消耗过期库存；推荐一律从严，只作提示。
 */
export const COUNT_EXPIRED_AS_AVAILABLE = false

/* ------------------------------------------------------------
 * 评分权重
 * ------------------------------------------------------------ */

export const RECOMMENDATION_WEIGHTS = {
  /** 全足奖励（最高优先级：优先推荐库存足够的整餐） */
  ready_bonus: 1000,
  /** 满足比例（0–1）的权重 */
  coverage: 100,
  /** 每用到一项**临期**食材的加分（其次优先消耗临期） */
  expiring_each: 6,
  /** 组合多样性得分权重 */
  diversity: 8,
  /** 每缺一项的扣分 */
  missing_each: 40,
  /**
   * 每缺一项**调味品**的扣分。
   *
   * ⚠️ 刻意远低于 `missing_each`：调味品是 presence-only，
   *    家里常用替代品，缺盐不应把一整套菜判为不可做。
   */
  seasoning_missing_each: 10,
  /** 每存在一项「用量未指定」的扣分（未知用量不得视为充分） */
  unknown_each: 8,
} as const

/** 分数保留小数位（保证比较稳定、可复现） */
export const SCORE_DECIMALS = 3

/**
 * 方案间**菜品重合**的惩罚系数（每重合 1 道菜扣多少分）。
 *
 * ⚠️ 轻量多样性：top N 的选择在同一等级内做贪心，重叠越多分越低，
 *    避免 5 套方案几乎一样。取值小于 `ready_bonus`，
 *    但大于临期/多样性奖励，足以改变同等级内的排序。
 */
export const OVERLAP_PENALTY = 60

/* ------------------------------------------------------------
 * 幂等（request_id）
 * ------------------------------------------------------------ */

/**
 * 幂等条目存活时间。
 *
 * ⚠️ 这是**进程内**去重：进程重启后同一 request_id 会被当成新请求。
 *    因此前端**不得自动重试写操作**，只允许用户看到明确失败提示后手动重试。
 */
export const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000

/** 幂等表条目上限（超出按插入顺序淘汰最旧的） */
export const IDEMPOTENCY_MAX_ENTRIES = 200
