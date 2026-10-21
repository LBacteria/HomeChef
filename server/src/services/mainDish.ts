/**
 * v0.2.4：整餐的**主菜锚点**与配菜互补度（纯函数，无 DB、无副作用）。
 *
 * 设计约束（评审确定）：
 *   - 主菜**不等于荤菜**：纯素、全无标签也要能选出锚点，绝不能让整餐推荐失效。
 *   - 同一组菜**不论顺序**必须得到同一锚点（排序键 = 角色优先级 → recipe_id）。
 *   - 一餐**最多一个**主菜锚点，其余一律是配菜。
 *   - 不猜「克 / 个」跨单位的"份量最大"：只用明确的菜品类型角色。
 *   - 主菜相似度只做**软倾向**（Jaccard），不做淘汰门槛：
 *     红烧鸡/咖喱鸡同主料但不同做法必须都能留在候选里。
 */

import type { DishRole } from './tagConfig.js'
import { rolesOfDish } from './recommendationAlgorithm.js'
import type { DishSpec } from './recommendationAlgorithm.js'

/**
 * 主菜优先级的角色次序。
 *
 * 数字越小越优先：荤/半荤 → 主食 → 素菜 → 无标签 → 凉菜/汤 → 甜点。
 * 无标签单独占一档（4），而不是直接丢弃 —— 否则「全无标签」的库会没有锚点。
 */
export const MAIN_DISH_ROLE_RANK: Readonly<Record<DishRole, number>> = {
  meat: 1,
  mixed: 1,
  staple: 2,
  vegetable: 3,
  cold: 5,
  soup: 5,
  dessert: 6,
}

/** 没有任何菜品类型标签时的档位 */
export const NO_ROLE_RANK = 4

/**
 * 单道菜的锚点优先级（取它拥有的角色里最优先的那个）。
 *
 * ⚠️ `NO_ROLE_RANK` **只用于「完全没有任何菜品类型标签」**。
 *    早先的初值写法会让「只有汤 / 凉菜 / 甜点」的菜永远返回 4，
 *    与 `anchorRoleOf` 给出的 5 / 6 自相矛盾。
 */
export function anchorRankOf(dish: DishSpec): number {
  const roles = rolesOfDish(dish)
  if (roles.length === 0) return NO_ROLE_RANK
  let best = Number.POSITIVE_INFINITY
  for (const role of roles) {
    const rank = MAIN_DISH_ROLE_RANK[role]
    if (rank < best) best = rank
  }
  return best
}

/** 该菜在锚点判定中生效的角色（同档取字典序最小的，保证确定性） */
export function anchorRoleOf(dish: DishSpec): DishRole | null {
  const roles = rolesOfDish(dish)
  if (roles.length === 0) return null
  let best: { role: DishRole; rank: number } | null = null
  for (const role of roles) {
    const rank = MAIN_DISH_ROLE_RANK[role]
    if (
      best === null ||
      rank < best.rank ||
      (rank === best.rank && role < best.role)
    ) {
      best = { role, rank }
    }
  }
  return best === null ? null : best.role
}

export interface MainDishAnchor {
  recipe_id: number
  /** 生效的角色；无标签时为 null */
  role: DishRole | null
  /** 优先级档位（越小越主） */
  rank: number
}

/**
 * 选出一套餐的**唯一主菜锚点**。
 *
 * 排序键：优先级档位升序 → recipe_id 升序。
 * ⇒ 与输入顺序无关，同一集合必然同一锚点。
 */
export function mainDishAnchorOf(dishes: readonly DishSpec[]): MainDishAnchor | null {
  let best: { dish: DishSpec; rank: number } | null = null
  for (const dish of dishes) {
    const rank = anchorRankOf(dish)
    if (
      best === null ||
      rank < best.rank ||
      (rank === best.rank && dish.recipe_id < best.dish.recipe_id)
    ) {
      best = { dish, rank }
    }
  }
  if (best === null) return null
  return {
    recipe_id: best.dish.recipe_id,
    role: anchorRoleOf(best.dish),
    rank: best.rank,
  }
}

/** Jaccard 相似度；两侧都为空时按 0 处理（没有可比的主料） */
export function jaccardSimilarity(
  a: ReadonlySet<number>,
  b: ReadonlySet<number>,
): number {
  if (a.size === 0 && b.size === 0) return 0
  let intersection = 0
  for (const id of a) if (b.has(id)) intersection++
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 配菜互补的加分项 */
export const SIDE_COMPLEMENT_SCORE = {
  /** 有素菜 */
  vegetable: 4,
  /** 有汤或凉菜 */
  soup_or_cold: 3,
  /** 有主食 */
  staple: 2,
  /** 有半荤半素（补一点蔬菜性） */
  mixed: 2,
  /** 配菜全是纯荤（且没有素/汤/凉菜）时的扣分 */
  all_meat_penalty: 6,
} as const

/**
 * 配菜互补度：以锚点之外的菜计算，越像一个正常整餐分越高。
 *
 * ⚠️ 这是**粗略的菜品类型搭配**，不是营养计算，也不保证健康。
 */
export function sideComplementScore(
  dishes: readonly DishSpec[],
  mainRecipeId: number,
): number {
  const sides = dishes.filter((d) => d.recipe_id !== mainRecipeId)
  if (sides.length === 0) return 0

  let hasVegetable = false
  let hasSoupOrCold = false
  let hasStaple = false
  let hasMixed = false
  let meatOnlySides = 0

  for (const dish of sides) {
    const roles = rolesOfDish(dish)
    if (roles.includes('vegetable')) hasVegetable = true
    if (roles.includes('soup') || roles.includes('cold')) hasSoupOrCold = true
    if (roles.includes('staple')) hasStaple = true
    if (roles.includes('mixed')) hasMixed = true
    const onlyMeat = roles.length > 0 && roles.every((r) => r === 'meat')
    if (onlyMeat) meatOnlySides++
  }

  const S = SIDE_COMPLEMENT_SCORE
  let score = 0
  if (hasVegetable) score += S.vegetable
  if (hasSoupOrCold) score += S.soup_or_cold
  if (hasStaple) score += S.staple
  if (hasMixed) score += S.mixed
  // 有合适副菜却凑三荤：只在**全是纯荤**时扣，避免误伤「一道荤 + 一道半荤」
  if (meatOnlySides === sides.length && sides.length >= 2) score -= S.all_meat_penalty
  return score
}

/** 从一道菜里取「非调味品」食材集合（用于主菜相似度） */
export function mainIngredientIdsOf(
  dish: DishSpec,
  isSeasoning: (definitionId: number) => boolean,
): Set<number> {
  const ids = new Set<number>()
  for (const line of dish.lines) {
    if (!isSeasoning(line.definition_id)) ids.add(line.definition_id)
  }
  return ids
}
