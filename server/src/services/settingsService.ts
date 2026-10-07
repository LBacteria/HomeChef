import { eq } from 'drizzle-orm'

import { db } from '../db/index.js'
import { EXPIRY_WARNING_MODES, appSettings } from '../db/schema.js'
import type { ExpiryWarningMode } from '../db/schema.js'
import { validationError } from './errors.js'

/**
 * 应用设置 Service。
 *
 * 单行设置表（id = 1）。
 *
 * 设计要点：
 *   - **默认值定义在 Service**，前端不参与决定默认值
 *   - 表为空时返回默认值（不依赖迁移插入初始行）
 *   - 更新采用 UPSERT（存在则 UPDATE，不存在则 INSERT）
 *   - 业务规则在 Service 层**再次**校验，不只依赖路由的 JSON Schema
 */

/** 数据库行 id 固定为 1（单行表） */
const SETTINGS_ROW_ID = 1

/** 设置的应用层表示（类型明确，不用 key-value 字符串） */
export interface AppSettingsValue {
  expiry_warning_mode: ExpiryWarningMode
  expiry_warning_threshold: number
  allow_expired_for_recipe: boolean
}

/**
 * 默认设置。
 *
 * ⚠️ 这是**唯一**的默认值来源。前端不得自行决定默认值。
 */
export const DEFAULT_APP_SETTINGS: Readonly<AppSettingsValue> = Object.freeze({
  expiry_warning_mode: 'days',
  expiry_warning_threshold: 3,
  allow_expired_for_recipe: false,
})

function nowIso(): string {
  return new Date().toISOString()
}

/** 校验并规范化部分设置输入 */
function validatePartial(input: Partial<AppSettingsValue>): Partial<AppSettingsValue> {
  const result: Partial<AppSettingsValue> = {}

  if (input.expiry_warning_mode !== undefined) {
    if (!EXPIRY_WARNING_MODES.includes(input.expiry_warning_mode)) {
      throw validationError(
        `临期判断模式不合法：${String(input.expiry_warning_mode)}。允许：${EXPIRY_WARNING_MODES.join('、')}`,
      )
    }
    result.expiry_warning_mode = input.expiry_warning_mode
  }

  if (input.expiry_warning_threshold !== undefined) {
    const t = input.expiry_warning_threshold
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      throw validationError(`临期阈值必须是有限数字，当前为：${String(t)}`)
    }
    if (t < 0) {
      throw validationError(`临期阈值不能为负数，当前为：${t}`)
    }
    result.expiry_warning_threshold = t
  }

  if (input.allow_expired_for_recipe !== undefined) {
    if (typeof input.allow_expired_for_recipe !== 'boolean') {
      throw validationError(
        `allow_expired_for_recipe 必须是布尔值，当前为：${String(input.allow_expired_for_recipe)}`,
      )
    }
    result.allow_expired_for_recipe = input.allow_expired_for_recipe
  }

  return result
}

/**
 * 按**最终组合**校验（模式 + 阈值必须匹配）。
 *
 * ⚠️ 必须在合并出最终值之后校验，而不是逐个字段独立校验 ——
 *    否则「只改 mode 为 days、阈值仍是 15.5」这类组合会漏过。
 */
function validateFinalCombination(value: AppSettingsValue): void {
  const { expiry_warning_mode: mode, expiry_warning_threshold: threshold } = value

  if (mode === 'days') {
    // days 模式：必须是非负整数
    if (!Number.isInteger(threshold)) {
      throw validationError(
        `按天数模式时，临期阈值必须是整数（天），当前为：${threshold}`,
      )
    }
    return
  }

  // percentage 模式：0–100
  if (threshold < 0 || threshold > 100) {
    throw validationError(
      `按百分比模式时，临期阈值必须在 0–100 之间，当前为：${threshold}`,
    )
  }
}

/** 把数据库行转为应用层表示（0/1 → boolean） */
function rowToValue(row: {
  expiry_warning_mode: string
  expiry_warning_threshold: number
  allow_expired_for_recipe: number
}): AppSettingsValue {
  return {
    expiry_warning_mode: row.expiry_warning_mode as ExpiryWarningMode,
    expiry_warning_threshold: row.expiry_warning_threshold,
    allow_expired_for_recipe: row.allow_expired_for_recipe === 1,
  }
}

/**
 * 读取设置。
 *
 * 表为空（或行不存在）时返回**默认值**，不写入数据库 ——
 * 这样「读取」是纯读操作，不会因为查询而产生副作用。
 */
export function getSettings(): AppSettingsValue {
  const row = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .get()

  if (!row) {
    return { ...DEFAULT_APP_SETTINGS }
  }

  return rowToValue(row)
}

/**
 * 更新设置（部分更新）。
 *
 * 只传需要修改的字段，其余保持当前值（或默认值）。
 *
 * @throws ServiceError VALIDATION_ERROR
 */
export function updateSettings(input: Partial<AppSettingsValue>): AppSettingsValue {
  const current = getSettings()
  const validated = validatePartial(input)

  // 先合并出最终值，再按最终组合校验
  const merged: AppSettingsValue = { ...current, ...validated }

  validateFinalCombination(merged)

  const timestamp = nowIso()

  const existing = db
    .select()
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ROW_ID))
    .get()

  const row = {
    id: SETTINGS_ROW_ID,
    expiry_warning_mode: merged.expiry_warning_mode,
    expiry_warning_threshold: merged.expiry_warning_threshold,
    allow_expired_for_recipe: merged.allow_expired_for_recipe ? 1 : 0,
    created_at: existing?.created_at ?? timestamp,
    updated_at: timestamp,
  }

  if (existing) {
    db.update(appSettings).set(row).where(eq(appSettings.id, SETTINGS_ROW_ID)).run()
  } else {
    db.insert(appSettings).values(row).run()
  }

  return merged
}
