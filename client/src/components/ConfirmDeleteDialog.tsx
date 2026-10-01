import { useState } from 'react'

/**
 * 删除确认对话框。
 *
 * 删除前必须确认（PRD 第 13 条）。
 * 不做软删除。
 */

interface Props {
  ingredientName: string
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export default function ConfirmDeleteDialog({ ingredientName, onConfirm, onCancel }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)

    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>删除食材</h2>

        <p>
          确定要删除「<strong>{ingredientName}</strong>」吗？
        </p>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>
            取消
          </button>
          <button type="button" className="danger" onClick={handleConfirm} disabled={submitting}>
            {submitting ? '删除中…' : '删除'}
          </button>
        </div>
      </div>
    </div>
  )
}
