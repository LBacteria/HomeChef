import { useState } from 'react'

import { UNITS, type CreateIngredientInput, type Ingredient } from '../types/ingredient'

/**
 * 添加 / 编辑食材表单（共用）。
 *
 * 前端只做**基础校验**（非空、数字、非负、单位合法、日期关系），
 * 后端仍是最终权威（名称唯一性、跨表冲突等由后端判定）。
 */

interface Props {
  /** 传入则为编辑模式，否则为添加模式 */
  initial?: Ingredient
  onSubmit: (data: CreateIngredientInput) => Promise<void>
  onCancel: () => void
}

/** 校验错误的字段名 → 错误信息 */
type FieldErrors = Record<string, string>

/** 校验日期格式 YYYY-MM-DD */
function isValidDateFormat(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  // 简单合法性：能被 Date 解析
  const parsed = new Date(`${value}T00:00:00`)
  return !Number.isNaN(parsed.getTime())
}

export default function IngredientForm({ initial, onSubmit, onCancel }: Props) {
  const isEdit = initial !== undefined

  const [name, setName] = useState(initial?.name ?? '')
  const [quantity, setQuantity] = useState(
    initial !== undefined ? String(initial.quantity) : '',
  )
  const [unit, setUnit] = useState(initial?.unit ?? UNITS[0])
  const [purchaseDate, setPurchaseDate] = useState(initial?.purchase_date ?? '')
  const [expiryDate, setExpiryDate] = useState(initial?.expiry_date ?? '')
  const [note, setNote] = useState(initial?.note ?? '')

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 基础校验，返回错误集合（空对象表示通过） */
  function validate(): FieldErrors {
    const errors: FieldErrors = {}

    if (name.trim().length === 0) {
      errors.name = '名称不能为空'
    }

    // 数量：允许留空（默认 0），填了就必须是合法数字
    if (quantity.trim().length > 0) {
      const parsed = Number(quantity)
      if (!Number.isFinite(parsed)) {
        errors.quantity = '数量必须是数字'
      } else if (parsed < 0) {
        errors.quantity = '数量不能小于 0'
      }
    }

    if (!UNITS.includes(unit as (typeof UNITS)[number])) {
      errors.unit = '单位不合法'
    }

    if (purchaseDate.trim().length > 0 && !isValidDateFormat(purchaseDate)) {
      errors.purchase_date = '购买日期格式应为 YYYY-MM-DD'
    }

    if (expiryDate.trim().length > 0 && !isValidDateFormat(expiryDate)) {
      errors.expiry_date = '有效期格式应为 YYYY-MM-DD'
    }

    // 日期关系：只有两个都填了才比较
    if (
      !errors.purchase_date &&
      !errors.expiry_date &&
      purchaseDate.trim().length > 0 &&
      expiryDate.trim().length > 0 &&
      expiryDate < purchaseDate
    ) {
      errors.expiry_date = '有效期不能早于购买日期'
    }

    return errors
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const errors = validate()
    setFieldErrors(errors)

    if (Object.keys(errors).length > 0) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onSubmit({
        name: name.trim(),
        quantity: quantity.trim().length > 0 ? Number(quantity) : 0,
        unit,
        purchase_date: purchaseDate.trim().length > 0 ? purchaseDate : null,
        expiry_date: expiryDate.trim().length > 0 ? expiryDate : null,
        note: note.trim().length > 0 ? note.trim() : null,
      })
    } catch (error) {
      // 后端错误原样显示（例如 409 DUPLICATE_NAME 的 message）
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{isEdit ? '编辑食材' : '添加食材'}</h2>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            名称
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：番茄"
              autoFocus
            />
          </label>
          {fieldErrors.name && <p className="field-error">{fieldErrors.name}</p>}

          <label>
            数量
            <input
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="例如：500"
            />
          </label>
          {fieldErrors.quantity && <p className="field-error">{fieldErrors.quantity}</p>}

          <label>
            单位
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          {fieldErrors.unit && <p className="field-error">{fieldErrors.unit}</p>}

          <label>
            购买日期
            <input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
            />
          </label>
          {fieldErrors.purchase_date && <p className="field-error">{fieldErrors.purchase_date}</p>}

          <label>
            有效期
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </label>
          {fieldErrors.expiry_date && <p className="field-error">{fieldErrors.expiry_date}</p>}

          <label>
            备注
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="可选"
              rows={2}
            />
          </label>

          {submitError && <p className="form-error">{submitError}</p>}

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
