import { useMemo, useState } from 'react'

import {
  SEASONING_CATEGORY_NAME,
  UNITS,
  type Category,
  type CreateDefinitionInput,
} from '../types/api'

/**
 * 食材定义创建表单。
 *
 * ⚠️ 这里**只创建 definition**，不创建库存记录。
 * ⚠️ 别名/名称全局唯一由后端保证，前端只显示错误。
 *
 * v0.1.3：增加分类选择。
 *   若分类为「调味品」：
 *     - **不要求** allowed_units（可以为 0 个）
 *     - **不要求** 预计保质期
 *     - 对应的输入控件直接隐藏（不显示无意义字段）
 *   其他分类：仍要求至少一个允许单位。
 */

interface Props {
  /** 可选分类列表（v0.1.3） */
  categories?: Category[]
  onSubmit: (data: CreateDefinitionInput) => Promise<void>
  onCancel: () => void
}

export default function DefinitionForm({ categories = [], onSubmit, onCancel }: Props) {
  const [name, setName] = useState('')
  const [categoryId, setCategoryId] = useState<number | ''>('')
  const [aliasInput, setAliasInput] = useState('')
  const [aliases, setAliases] = useState<string[]>([])
  const [units, setUnits] = useState<string[]>([])
  const [shelfLife, setShelfLife] = useState('')

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 当前选中的分类 */
  const selectedCategory = useMemo(
    () => (categoryId === '' ? undefined : categories.find((c) => c.id === categoryId)),
    [categoryId, categories],
  )

  /** 是否调味品 —— 只依据分类名判断，不使用 type 字段 */
  const isSeasoning = selectedCategory?.name === SEASONING_CATEGORY_NAME

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

    // ⚠️ 普通食材必须至少一个单位；调味品允许 0 个
    if (!isSeasoning && units.length === 0) {
      setError('请至少选择一个允许单位')
      return
    }

    // 调味品不需要保质期（表单也不显示该字段）
    let shelfLifeValue: number | null = null
    if (!isSeasoning && shelfLife.trim().length > 0) {
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
        // 调味品提交空数组；普通食材提交所选单位
        units: isSeasoning ? [] : units,
        aliases: aliases.length > 0 ? aliases : undefined,
        estimated_shelf_life_days: shelfLifeValue,
        category_id: categoryId === '' ? null : categoryId,
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

          {/* 分类选择（v0.1.3）—— 决定是否按调味品处理 */}
          <label>
            分类
            <select
              value={categoryId}
              onChange={(e) => {
                const v = e.target.value
                setCategoryId(v === '' ? '' : Number(v))
                // 切换到调味品时清空单位与保质期，避免残留无意义数据
                if (v !== '' && categories.find((c) => c.id === Number(v))?.name === SEASONING_CATEGORY_NAME) {
                  setUnits([])
                  setShelfLife('')
                }
              }}
            >
              <option value="">请选择…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          {isSeasoning && (
            <p className="hint">
              调味品无需填写允许单位与保质期 —— 库存只记录「家里有这个调味品」。
            </p>
          )}

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

          {/* 允许单位与保质期：调味品不显示（也不需要） */}
          {!isSeasoning && (
            <>
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
            </>
          )}

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
