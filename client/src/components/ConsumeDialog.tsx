import { useState } from 'react'

import { formatQuantity, formatQuantityWithUnit } from '../format'
import { ApiError, type Ingredient } from '../types/ingredient'

/**
 * 消耗食材对话框。
 *
 * 提交 POST /api/ingredients/:id/consume。
 *
 * ⚠️ 前端**不修改库存**，只把 amount 发给后端，以后端返回的结果为准。
 */

interface Props {
  ingredient: Ingredient
  onSubmit: (amount: number) => Promise<void>
  onCancel: () => void
}

export default function ConsumeDialog({ ingredient, onSubmit, onCancel }: Props) {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const parsedAmount = Number(amount)
  const amountIsValid = amount.trim().length > 0 && Number.isFinite(parsedAmount) && parsedAmount > 0

  /** 预览消耗后的剩余量（仅显示用，不改变任何数据） */
  const previewRemaining = amountIsValid
    ? formatQuantity(ingredient.quantity - parsedAmount)
    : null

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!amountIsValid) {
      setError('消耗数量必须是大于 0 的数字')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await onSubmit(parsedAmount)
    } catch (err) {
      // 库存不足：给出明确提示（PRD 第 12 条）
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        setError('库存不足，无法消耗。')
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>消耗食材</h2>

        <p className="modal-ingredient-name">{ingredient.name}</p>
        <p className="modal-meta">
          当前库存：{formatQuantityWithUnit(ingredient.quantity, ingredient.unit)}
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            消耗数量
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如：200"
              autoFocus
            />
          </label>

          {previewRemaining !== null && (
            <p className="consume-preview">
              {formatQuantity(ingredient.quantity)} {ingredient.unit} → {previewRemaining}{' '}
              {ingredient.unit}
            </p>
          )}

          {error && <p className="form-error">{error}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? '消耗中…' : '确认消耗'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
