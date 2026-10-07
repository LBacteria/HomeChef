import type { AppSettings, UpdateSettingsInput } from '../types/api'
import { request } from './definitions'

/**
 * 应用设置 API。
 *
 * ⚠️ 只负责读写，**不决定默认值** ——
 *    默认值由后端 Service 提供，前端直接使用返回值。
 */

/** 读取设置（表为空时后端返回默认值） */
export function getSettings(): Promise<AppSettings> {
  return request<AppSettings>('/settings')
}

/** 部分更新设置；只传需要修改的字段 */
export function updateSettings(data: UpdateSettingsInput): Promise<AppSettings> {
  return request<AppSettings>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}
