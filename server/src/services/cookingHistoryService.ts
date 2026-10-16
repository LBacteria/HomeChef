/**
 * v0.2.3 烹饪历史取数 —— **只读**派生信号（不新增表）。
 *
 * 规则（与产品确认一致）：
 *   - **只统计「已实际完成」的菜**：会话状态 `settled` **且** 该菜 `done`；
 *     放弃的会话、未完成的菜**一律不惩罚**。
 *   - 时间锚点：会话的 `settled_at`（缺失时回退 `started_at`），
 *     取**本地日历日期**与「今天」比较（与前端一致，避免 UTC 跨日差一天）。
 *   - 时间戳无效 / 落在未来 → **跳过或夹到 0 天**，绝不算出负天数。
 *
 * ⚠️ 纯只读：本模块不写库、不改会话状态。
 * ⚠️ 历史在推荐里只是**软信号**（降权），永不排除任何菜谱。
 */

import { asc, eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { cookingSession, cookingSessionDish } from '../db/schema.js'
import { daysBetween, todayDateString } from './dates.js'

/** 单个菜谱的完成统计 */
export interface CookedRecipeStat {
  /** 最近一次完成的**本地日历日期**（YYYY-MM-DD） */
  last_date: string
  /** 窗口内完成的次数 */
  times: number
}

/** 一次完整的「已做完的整餐」（用于重复组合惩罚） */
export interface CookedMeal {
  session_id: number
  /** 该会话中**已完成**的菜谱 id（升序、去重） */
  recipe_ids: number[]
  /** 最近完成日期（本地日历） */
  last_date: string
  /** 距今本地日历天数（夹到 >= 0） */
  days_ago: number
}

export interface CookingHistory {
  /** recipe_id → 完成统计（只在窗口内） */
  byRecipe: Map<number, CookedRecipeStat>
  /** 窗口内已完成的整餐（按日期升序，稳定顺序） */
  recentMeals: CookedMeal[]
  /** 时间戳无效而被跳过的会话数（用于测试与诊断） */
  skipped_invalid: number
  /** 时间戳落在未来而被夹到 0 天的会话数 */
  clamped_future: number
}

/** 把 ISO 时间戳转成**本地日历日期**；无法解析返回 null */
function localDateOf(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string' || iso.length === 0) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return todayDateString(d)
}

/** 两个 YYYY-MM-DD 之间的天数差（b - a），用 UTC 运算避免时区抖动 */
export { daysBetween }

/**
 * 读取「最近 windowDays 天内真正做完的菜」。
 *
 * @param today      今天的本地日历日期（YYYY-MM-DD）
 * @param windowDays 统计窗口（含今天；<=0 时返回空历史）
 */
export function loadCookingHistory(today: string, windowDays: number): CookingHistory {
  const empty: CookingHistory = {
    byRecipe: new Map(),
    recentMeals: [],
    skipped_invalid: 0,
    clamped_future: 0,
  }
  if (windowDays <= 0) return empty

  const sessions = db
    .select({
      id: cookingSession.id,
      status: cookingSession.status,
      started_at: cookingSession.started_at,
      settled_at: cookingSession.settled_at,
    })
    .from(cookingSession)
    .where(eq(cookingSession.status, 'settled'))
    .orderBy(asc(cookingSession.id))
    .all()

  if (sessions.length === 0) return empty

  const doneDishes = db
    .select({
      session_id: cookingSessionDish.session_id,
      recipe_id: cookingSessionDish.recipe_id,
      status: cookingSessionDish.status,
    })
    .from(cookingSessionDish)
    .where(eq(cookingSessionDish.status, 'done'))
    .orderBy(asc(cookingSessionDish.id))
    .all()

  const dishesBySession = new Map<number, number[]>()
  for (const d of doneDishes) {
    const list = dishesBySession.get(d.session_id)
    if (list) list.push(d.recipe_id)
    else dishesBySession.set(d.session_id, [d.recipe_id])
  }

  const byRecipe = new Map<number, CookedRecipeStat>()
  const recentMeals: CookedMeal[] = []
  let skippedInvalid = 0
  let clampedFuture = 0

  for (const s of sessions) {
    const recipeIds = [...new Set(dishesBySession.get(s.id) ?? [])].sort((a, b) => a - b)
    if (recipeIds.length === 0) continue // 会话里没有已完成菜品 → 不参与历史

    const date = localDateOf(s.settled_at) ?? localDateOf(s.started_at)
    if (date === null) {
      skippedInvalid++
      continue
    }

    let daysAgo = daysBetween(date, today)
    if (daysAgo < 0) {
      // 时间戳落在未来（时钟回拨 / 脏数据）→ 夹到 0，绝不产生负天数
      daysAgo = 0
      clampedFuture++
    }
    if (daysAgo > windowDays) continue

    recentMeals.push({ session_id: s.id, recipe_ids: recipeIds, last_date: date, days_ago: daysAgo })

    for (const recipeId of recipeIds) {
      const stat = byRecipe.get(recipeId)
      if (stat === undefined) {
        byRecipe.set(recipeId, { last_date: date, times: 1 })
      } else {
        stat.times++
        if (date > stat.last_date) stat.last_date = date
      }
    }
  }

  recentMeals.sort((a, b) =>
    a.last_date === b.last_date ? a.session_id - b.session_id : a.last_date < b.last_date ? -1 : 1,
  )

  return {
    byRecipe,
    recentMeals,
    skipped_invalid: skippedInvalid,
    clamped_future: clampedFuture,
  }
}
