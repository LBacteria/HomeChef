import { useState } from 'react'

import { ApiError, type InventoryRecord } from '../types/api'
import { formatQuantity, formatQuantityWithUnit } from '../format'

/**
 * 消耗库存对话框。
 *
 * ⚠️ 针对**具体库存记录**（inventory.id），不跨记录寻找。
 * ⚠️ 前端不修改库存，只把 amount 发给后端，以后端返回为准。
 */

interface Props {
  record: InventoryRecord
  definitionName: string
  onSubmit: (amount: number) => Promise<void>
  onCancel: () => void
}

export default function ConsumeDialog({ record, definitionName, onSubmit, onCancel }: Props) {
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const parsed = Number(amount)
  const valid = amount.trim().length > 0 && Number.isFinite(parsed) && parsed > 0

  /** 预览剩余量（仅显示，不改变任何数据） */
  const remaining = valid ? formatQuantity(record.quantity - parsed) : null

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    if (!valid) {
      setError('消耗数量必须是大于 0 的数字')
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      await onSubmit(parsed)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_STOCK') {
        // 显示后端返回的具体信息（含需要量与现存量）
        setError(err.message)
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
        <h2>消耗库存</h2>

        <p className="modal-ingredient-name">{definitionName}</p>
        <p className="modal-meta">
          当前：{formatQuantityWithUnit(record.quantity, record.unit)}
          {record.storage_method && `　存储：${record.storage_method}`}
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <label>
            消耗数量
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="例如：1"
              autoFocus
            />
          </label>

          <p className="modal-meta">单位：{record.unit}</p>

          {remaining !== null && (
            <p className="consume-preview">
              剩余：{remaining} {record.unit}
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
