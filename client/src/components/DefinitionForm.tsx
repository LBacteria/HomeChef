import { useState } from 'react'

import { UNITS, type CreateDefinitionInput } from '../types/api'

/**
 * 食材定义创建表单。
 *
 * ⚠️ 这里**只创建 definition**，不创建库存记录。
 * ⚠️ 至少一个 allowed unit（后端也会校验，这里只做基础提示）。
 * ⚠️ 别名/名称全局唯一由后端保证，前端只显示错误。
 */

interface Props {
  onSubmit: (data: CreateDefinitionInput) => Promise<void>
  onCancel: () => void
}

export default function DefinitionForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState('')
  const [aliasInput, setAliasInput] = useState('')
  const [aliases, setAliases] = useState<string[]>([])
  const [units, setUnits] = useState<string[]>([])
  const [shelfLife, setShelfLife] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function addAlias() {
    const v = aliasInput.trim()
    if (v.length === 0) return
    if (aliases.includes(v)) {
      setAliasInput('')
      return
    }
    setAliases([...aliases, v])
    setAliasInput('')
  }

  function toggleUnit(u: string) {
    setUnits((prev) => (prev.includes(u) ? prev.filter((x) => x !== u) : [...prev, u]))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (name.trim().length === 0) {
      setError('默认名称不能为空')
      return
    }
    if (units.length === 0) {
      setError('请至少选择一个允许单位')
      return
    }

    let shelfLifeValue: number | null = null
    if (shelfLife.trim().length > 0) {
      const parsed = Number(shelfLife)
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError('预计保质期必须是非负整数，或留空')
        return
      }
      shelfLifeValue = parsed
    }

    setSubmitting(true)
    setError(null)

    try {
      await onSubmit({
        name: name.trim(),
        units,
        aliases: aliases.length > 0 ? aliases : undefined,
        estimated_shelf_life_days: shelfLifeValue,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>添加食材</h2>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            默认名称
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：番茄"
              autoFocus
            />
          </label>

          <div className="field-block">
            <span className="field-label">别名</span>
            <div className="alias-input-row">
              <input
                type="text"
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addAlias()
                  }
                }}
                placeholder="例如：西红柿"
              />
              <button type="button" onClick={addAlias}>
                添加
              </button>
            </div>
            {aliases.length > 0 && (
              <ul className="tag-list">
                {aliases.map((a) => (
                  <li key={a} className="tag">
                    {a}
                    <button
                      type="button"
                      className="tag-remove"
                      onClick={() => setAliases(aliases.filter((x) => x !== a))}
                      aria-label={`移除 ${a}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="field-block">
            <span className="field-label">允许单位（至少一个）</span>
            <div className="unit-grid">
              {UNITS.map((u) => (
                <label key={u} className="unit-checkbox">
                  <input
                    type="checkbox"
                    checked={units.includes(u)}
                    onChange={() => toggleUnit(u)}
                  />
                  {u}
                </label>
              ))}
            </div>
          </div>

          <label>
            预计保质期（天，可留空）
            <input
              type="text"
              inputMode="numeric"
              value={shelfLife}
              onChange={(e) => setShelfLife(e.target.value)}
              placeholder="例如：7"
            />
          </label>
          <p className="hint">
            用于新入库食材的到期日期估算。留空则不自动估算。
          </p>

          {error && <p className="form-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
