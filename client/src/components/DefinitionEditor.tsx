import { useState } from 'react'

import {
  addAlias,
  addAllowedUnit,
  deleteAlias,
  removeAllowedUnit,
  setDefaultName,
  updateDefinition,
} from '../api/definitions'
import { UNITS, type IngredientDefinitionDetail } from '../types/api'

/**
 * 食材定义编辑器。
 *
 * 覆盖第 7/8/9 节：
 *   - 默认名称与预计保质期
 *   - 别名管理（新增 / 删除 / **设为默认**）
 *   - 允许单位管理（添加 / 移除）
 *
 * ⚠️ 所有唯一性、使用中判断、最后单位的限制都由**后端**决定，
 *    前端只显示后端返回的 message。
 */

interface Props {
  definition: IngredientDefinitionDetail
  /** 任何写操作成功后调用，用于刷新父组件数据 */
  onChanged: () => Promise<void>
  onClose: () => void
}

export function DefinitionEditor({ definition, onChanged, onClose }: Props) {
  const [name, setName] = useState(definition.name)
  const [shelfLife, setShelfLife] = useState(
    definition.estimated_shelf_life_days === null
      ? ''
      : String(definition.estimated_shelf_life_days),
  )
  const [newAlias, setNewAlias] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 统一执行写操作并刷新 */
  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveBasic() {
    const parsed =
      shelfLife.trim().length === 0 ? null : Number(shelfLife)
    if (parsed !== null && (!Number.isInteger(parsed) || parsed < 0)) {
      setError('预计保质期必须是非负整数，或留空')
      return
    }
    await run(() =>
      updateDefinition(definition.id, {
        name: name.trim(),
        estimated_shelf_life_days: parsed,
      }),
    )
  }

  const currentUnits = definition.allowed_units
  const missingUnits = UNITS.filter((u) => !currentUnits.includes(u))

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <h2>编辑食材</h2>

        {/* ---- 基本信息 ---- */}
        <section className="editor-section">
          <label>
            默认名称
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            预计保质期（天，可留空）
            <input
              type="text"
              inputMode="numeric"
              value={shelfLife}
              onChange={(e) => setShelfLife(e.target.value)}
            />
          </label>
          <p className="hint">
            修改保质期**只影响以后新建的库存记录**，已有库存不会被改动。
          </p>
          <button type="button" className="primary" onClick={saveBasic} disabled={busy}>
            保存基本信息
          </button>
        </section>

        {/* ---- 别名 ---- */}
        <section className="editor-section">
          <h3>别名</h3>
          <p className="modal-meta">默认名称：{definition.name}</p>

          {definition.aliases.length === 0 && <p className="hint">暂无故别名</p>}

          <ul className="alias-manage-list">
            {definition.aliases.map((a) => (
              <li key={a.id} className="alias-manage-item">
                <span className="alias-name">{a.alias}</span>
                <span className="alias-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => setDefaultName(definition.id, a.id))}
                  >
                    设为默认
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => run(() => deleteAlias(definition.id, a.id))}
                  >
                    删除
                  </button>
                </span>
              </li>
            ))}
          </ul>

          <div className="alias-input-row">
            <input
              type="text"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              placeholder="新别名"
            />
            <button
              type="button"
              disabled={busy || newAlias.trim().length === 0}
              onClick={() =>
                run(async () => {
                  await addAlias(definition.id, newAlias.trim())
                  setNewAlias('')
                })
              }
            >
              添加别名
            </button>
          </div>
        </section>

        {/* ---- 允许单位 ---- */}
        <section className="editor-section">
          <h3>允许单位</h3>

          <div className="unit-grid">
            {currentUnits.map((u) => (
              <span key={u} className="unit-chip">
                {u}
                <button
                  type="button"
                  className="tag-remove"
                  disabled={busy}
                  onClick={() => run(() => removeAllowedUnit(definition.id, u))}
                  aria-label={`移除 ${u}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {missingUnits.length > 0 && (
            <div className="add-unit-row">
              <span className="field-label">添加单位：</span>
              {missingUnits.map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={busy}
                  onClick={() => run(() => addAllowedUnit(definition.id, u))}
                >
                  + {u}
                </button>
              ))}
            </div>
          )}

          <p className="hint">
            移除正在被库存使用的单位会被后端拒绝；至少需保留一个单位。
          </p>
        </section>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
