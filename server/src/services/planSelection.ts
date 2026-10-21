/**
 * v0.2.4：从**已按硬 tier 排序**的候选里挑出最终方案（纯函数，无 DB）。
 *
 * 硬规则（不可被软分打破）：
 *   1. tier 顺序 = 等级 → 主缺口 → 用量覆盖分桶。**先挑完前一个 tier**，
 *      才允许看下一个 tier；`ready` 永远不会被 `nearly` / `missing` 越过。
 *   2. **每个 tier 只有一个「主菜档」**：取该 tier 全部候选里最小
 *      `main_dish_rank`（荤/半荤 → 主食 → 素菜 → 无标签 → 凉菜/汤 → 甜点），
 *      之后只在这一档里挑**主菜未占用**的方案。
 *      档内挑完就结束本 tier —— 不拿更弱的角色（例如让素菜/汤当主菜）凑数。
 *      下一 tier 仍严格按库存序继续；纯素/无标签的库在各自 tier 内仍能正常出方案。
 *   3. 每个主菜 `recipe_id` 最多返回一套；同一 `plan_id` 只出现一次。
 *
 * 同 tier、同主菜档内的比较键（**按顺序逐级比较，不做加权求和**）：
 *   ① 与已选主菜的「非调味食材」最大 Jaccard —— **升序**（变化越大越前）
 *   ② `side_complement`（配菜互补）—— 降序
 *   ③ `score - OVERLAP_PENALTY × 与已选方案的最大菜品重合数` —— 降序
 *   ④ `plan_id` —— 升序（稳定兜底）
 *
 * ⚠️ ①②是独立比较级，不会被旧总分或重合惩罚抵消；
 *    但 ① 只影响排序，**绝不淘汰**「同主料不同做法」（红烧鸡/咖喱鸡都能留下）。
 */

import { OVERLAP_PENALTY } from './recommendationConfig.js'
import { jaccardSimilarity } from './mainDish.js'

/** 选择器需要的候选信息（由服务层组装，与 `plan` 一一对应） */
export interface SelectablePlan {
  /** 稳定签名（= `plan_id`） */
  plan_id: string
  /** 硬 tier 键：等级 | 主缺口 | 覆盖分桶 */
  tier_key: string
  /** 既有总分（库存侧 + 软信号） */
  score: number
  /** 主菜锚点 */
  main_dish_recipe_id: number
  /** 锚点优先级档位（越小越主）：同一 tier 内只认最优的那一档 */
  main_dish_rank: number
  /** 本方案全部 recipe_id（用于重合惩罚） */
  recipe_ids: readonly number[]
  /** 主菜的**非调味品**食材集合（用于主菜相似度） */
  main_definition_ids: readonly number[]
  /** 配菜互补度（`sideComplementScore`） */
  side_complement: number
}

function maxOverlap(recipeIds: readonly number[], selected: readonly SelectablePlan[]): number {
  let max = 0
  for (const s of selected) {
    let shared = 0
    for (const id of recipeIds) if (s.recipe_ids.includes(id)) shared++
    if (shared > max) max = shared
  }
  return max
}

function maxMainSimilarity(
  mainIds: readonly number[],
  selected: readonly SelectablePlan[],
): number {
  if (mainIds.length === 0) return 0
  const a = new Set(mainIds)
  let max = 0
  for (const s of selected) {
    const sim = jaccardSimilarity(a, new Set(s.main_definition_ids))
    if (sim > max) max = sim
  }
  return max
}

interface RankedCandidate {
  /** 在输入数组中的下标 */
  index: number
  similarity: number
  /** 旧总分 − 重合惩罚（只作为第 ③ 级比较，不与 ①② 相加） */
  adjusted_score: number
  side_complement: number
  plan_id: string
}

/** 同 tier 内的严格比较键：返回负数表示 a 更优 */
export function compareWithinTier(a: RankedCandidate, b: RankedCandidate): number {
  // ① 主菜食材变化更大者优先
  if (a.similarity !== b.similarity) return a.similarity - b.similarity
  // ② 配菜互补更高者优先
  if (a.side_complement !== b.side_complement) return b.side_complement - a.side_complement
  // ③ 旧总分（扣重合惩罚）更高者优先
  if (a.adjusted_score !== b.adjusted_score) return b.adjusted_score - a.adjusted_score
  // ④ 稳定签名兜底
  if (a.plan_id < b.plan_id) return -1
  if (a.plan_id > b.plan_id) return 1
  return 0
}

/**
 * 选出最终方案，返回它们在输入数组里的下标（保持选择顺序）。
 *
 * @param candidates **必须已按硬 tier 升序排序**（等级 → 主缺口 → 覆盖分桶 → …）
 * @param maxPlans   最多返回几套
 */
export function selectDistinctMainPlans(
  candidates: readonly SelectablePlan[],
  maxPlans: number,
): number[] {
  const selectedIndexes: number[] = []
  const selected: SelectablePlan[] = []
  const usedMains = new Set<number>()
  const usedSignatures = new Set<string>()

  let cursor = 0
  while (cursor < candidates.length && selectedIndexes.length < maxPlans) {
    const tierKey = candidates[cursor].tier_key

    // 收集本 tier 的全部候选（输入有序 ⇒ 同 tier 连续）
    const tierPool: number[] = []
    while (cursor < candidates.length && candidates[cursor].tier_key === tierKey) {
      tierPool.push(cursor)
      cursor++
    }

    /**
     * 本 tier 的「主菜档」= 该 tier **全部候选**里最优（最小）的 `main_dish_rank`。
     *
     * ⚠️ 刻意**不**按「主菜是否已被占用」过滤后再取档位：
     *    否则当前档的主菜都被前面的 tier 用掉时，档位会掉到素菜/汤，
     *    又变成用更弱角色凑数。确定档位后，只在这一档里挑**未占用**的主菜；
     *    挑不出就结束本 tier，交给下一个 tier（仍按库存序）。
     */
    let bestRank = Number.POSITIVE_INFINITY
    for (const i of tierPool) {
      if (candidates[i].main_dish_rank < bestRank) bestRank = candidates[i].main_dish_rank
    }
    if (!Number.isFinite(bestRank)) continue

    while (selectedIndexes.length < maxPlans) {
      const ranked: RankedCandidate[] = []
      for (const i of tierPool) {
        const c = candidates[i]
        if (c.main_dish_rank !== bestRank) continue
        if (usedMains.has(c.main_dish_recipe_id)) continue
        if (usedSignatures.has(c.plan_id)) continue
        ranked.push({
          index: i,
          similarity: maxMainSimilarity(c.main_definition_ids, selected),
          adjusted_score: c.score - OVERLAP_PENALTY * maxOverlap(c.recipe_ids, selected),
          side_complement: c.side_complement,
          plan_id: c.plan_id,
        })
      }
      // 本档挑完（或本来就没有）→ 结束本 tier，绝不拿更弱角色凑数
      if (ranked.length === 0) break

      ranked.sort(compareWithinTier)
      const chosen = candidates[ranked[0].index]
      selectedIndexes.push(ranked[0].index)
      selected.push(chosen)
      usedMains.add(chosen.main_dish_recipe_id)
      usedSignatures.add(chosen.plan_id)
    }
  }

  return selectedIndexes
}
