import { useEffect, useState } from 'react'

import { getSettings, updateSettings } from '../api/settings'
import type { AppSettings, ExpiryWarningMode } from '../types/api'

/**
 * 设置页面。
 *
 * 本批次只有「库存 → 临期设置」。
 *
 * ⚠️ 默认值来自后端，前端不自行假定。
 * ⚠️ 与库存相关的业务规则（临期判断）全部在后端计算。
 */

type LoadState = 'loading' | 'ready' | 'error'

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedHint, setSavedHint] = useState<string | null>(null)

  /** 表单本地状态（阈值用字符串，便于输入中间态） */
  const [thresholdInput, setThresholdInput] = useState('')

  async function load() {
    setState('loading')
    setLoadError(null)
    try {
      const data = await getSettings()
      setSettings(data)
      setThresholdInput(String(data.expiry_warning_threshold))
      setState('ready')
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setState('error')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  /** 统一保存：只提交发生变化的字段 */
  async function save(patch: Partial<AppSettings>) {
    setSaving(true)
    setSaveError(null)
    setSavedHint(null)
    try {
      const updated = await updateSettings(patch)
      setSettings(updated)
      setThresholdInput(String(updated.expiry_warning_threshold))
      setSavedHint('已保存')
    } catch (error) {
      // 后端会给出具体原因（模式与阈值不匹配等），直接展示
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleModeChange(mode: ExpiryWarningMode) {
    if (!settings || settings.expiry_warning_mode === mode) return
    // 切换模式时同时提交当前输入的阈值，让后端按新模式的规则校验
    const parsed = Number(thresholdInput)
    await save({
      expiry_warning_mode: mode,
      ...(Number.isFinite(parsed) ? { expiry_warning_threshold: parsed } : {}),
    })
  }

  async function handleThresholdSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!settings) return

    const parsed = Number(thresholdInput)
    if (thresholdInput.trim().length === 0 || !Number.isFinite(parsed)) {
      setSaveError('临期阈值必须是数字')
      return
    }
    await save({ expiry_warning_threshold: parsed })
  }

  function handleToggleExpired() {
    if (!settings) return
    void save({ allow_expired_for_recipe: !settings.allow_expired_for_recipe })
  }

  /* ---------------- 渲染 ---------------- */

  if (state === 'loading') {
    return (
      <section>
        <h2>设置</h2>
        <p className="status">加载中...</p>
      </section>
    )
  }

  if (state === 'error' || !settings) {
    return (
      <section>
        <h2>设置</h2>
        <div className="load-error">
          <p>加载失败：{loadError}</p>
          <button type="button" onClick={() => void load()}>
            重试
          </button>
        </div>
      </section>
    )
  }

  const isPercentage = settings.expiry_warning_mode === 'percentage'

  return (
    <section>
      <h2>设置</h2>

      <div className="settings-group">
        <h3 className="settings-group-title">库存</h3>

        <div className="settings-block">
          <h4 className="settings-block-title">临期设置</h4>

          {saveError && <p className="form-error">{saveError}</p>}
          {savedHint && <p className="hint">{savedHint}</p>}

          {/* 临期判断方式 */}
          <div className="settings-field">
            <span className="field-label">临期判断方式</span>
            <div className="radio-group">
              <label className="radio-item">
                <input
                  type="radio"
                  name="expiry_warning_mode"
                  checked={!isPercentage}
                  disabled={saving}
                  onChange={() => void handleModeChange('days')}
                />
                按剩余天数
              </label>
              <label className="radio-item">
                <input
                  type="radio"
                  name="expiry_warning_mode"
                  checked={isPercentage}
                  disabled={saving}
                  onChange={() => void handleModeChange('percentage')}
                />
                按剩余百分比
              </label>
            </div>
          </div>

          {/* 阈值 */}
          <form className="settings-field" onSubmit={handleThresholdSubmit}>
            <label>
              临期阈值（{isPercentage ? '%' : '天'}）
              <input
                type="text"
                inputMode="decimal"
                value={thresholdInput}
                disabled={saving}
                onChange={(e) => setThresholdInput(e.target.value)}
                placeholder={isPercentage ? '例如：15' : '例如：3'}
              />
            </label>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? '保存中…' : '保存阈值'}
            </button>
          </form>

          <p className="hint">
            {isPercentage
              ? '剩余保质期比例小于等于该值时视为临期。'
              : '距到期日期小于等于该天数时视为临期。'}
            已过期的食材始终按“已过期”处理，与阈值无关。
          </p>

          {/* 食谱推荐设置（仅保存） */}
          <div className="settings-field">
            <label className="checkbox-item">
              <input
                type="checkbox"
                checked={settings.allow_expired_for_recipe}
                disabled={saving}
                onChange={handleToggleExpired}
              />
              推荐食谱时允许考虑已过期食材
            </label>
            <p className="hint">
              当前仅保存设置，食谱推荐功能将在后续版本使用。
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}
