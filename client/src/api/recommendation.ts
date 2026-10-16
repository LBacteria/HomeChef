import { request } from './definitions'
import type { ApplyPlanResult, MealPlanResult } from '../types/api'

/**
 * v0.2.2 整餐推荐 API。
 *
 * ⚠️ 后端是唯一权威：
 *    - 分数、需求数量、缺口、份数倍率全部由服务端计算，前端只负责展示；
 *    - 前端**不自行推算**缺口，也不得把本地算出的数量回传。
 */

/** 生成整餐推荐（纯读接口，不会写库） */
export function getMealPlans(people: number): Promise<MealPlanResult> {
  return request<MealPlanResult>('/recommendation/meal-plans', {
    method: 'POST',
    body: JSON.stringify({ people }),
  })
}

/**
 * 把选中的整餐**原子**落到一个烹饪会话。
 *
 * ⚠️ 只回传 recipe_id / 份数 / 快照指纹 / 幂等键；其余一律由服务端重算。
 * ⚠️ 服务端在单个事务内创建会话 + 全部菜品，失败整体回滚。
 * ⚠️ 不预扣库存（扣减仍由既有结算完成）。
 * ⚠️ 失败会抛错；调用方**不得自动重试**写操作。
 *
 * 重试语义（条目⑩）：
 *   - `requestId` 是**一次性幂等键**。网络结果不明时，**用同一个 requestId
 *     重试是安全的**：服务端同 key 同 payload 会返回首次创建的那个会话，
 *     不会重复建会话。
 *   - 同 key **不同 payload** 会被服务端以 409 拒绝（客户端复用 key 的错误）。
 *   - ⚠️ 幂等表在服务端**进程内**，重启即失效（见 HANDOFF_V022 局限说明）。
 */
export function applyMealPlan(
  people: number,
  dishes: Array<{ recipe_id: number; servings: number }>,
  snapshotId: string,
  requestId: string,
): Promise<ApplyPlanResult> {
  return request<ApplyPlanResult>('/recommendation/apply', {
    method: 'POST',
    body: JSON.stringify({
      people,
      dishes,
      snapshot_id: snapshotId,
      request_id: requestId,
    }),
  })
}
