import { useMemo, useState } from 'react'

import { STORAGE_METHODS, type IngredientDefinitionDetail, type InventoryRecord } from '../types/api'
import { todayDateString } from '../format'

/**
 * 库存记录表单（创建 / 编辑共用）。
 *
 * 创建时需要先选择**食材定义**；单位下拉来自该定义的 allowed_units。
 *
 * ⚠️ 前端只做基础格式校验；到期日期估算、单位是否合法、
 *    日期关系等业务规则全部由后端负责。
 */

export interface InventoryFormValue {
  definition_id: number
  quantity: number
  unit: string
  purchase_date: string | null
  production_date: string | null
  /** undefined = 不发送该字段（让后端决定是否重算）；null = 用户主动清空 */
  expiry_date: string | null | undefined
  storage_method: string
  note: string | null
}

interface Props {
  /** 可选的食材定义列表（创建时用于选择） */
  definitions: IngredientDefinitionDetail[]
  /** 传入则为编辑模式 */
  initial?: InventoryRecord
  /** 编辑模式下该记录所属定义（用于取 allowed_units） */
  initialDefinition?: IngredientDefinitionDetail
  onSubmit: (value: InventoryFormValue) => Promise<void>
  onCancel: () => void
}

type FieldErrors = Record<string, string>

export default function InventoryForm({
  definitions,
  initial,
  initialDefinition,
  onSubmit,
  onCancel,
}: Props) {
  const isEdit = initial !== undefined

  const [definitionId, setDefinitionId] = useState<number | ''>(
    initial?.definition_id ?? '',
  )
  const [quantity, setQuantity] = useState(initial !== undefined ? String(initial.quantity) : '')
  const [unit, setUnit] = useState(initial?.unit ?? '')
  const [purchaseDate, setPurchaseDate] = useState(
    initial?.purchase_date ?? todayDateString(),
  )
  const [productionDate, setProductionDate] = useState(initial?.production_date ?? '')
  const [expiryDate, setExpiryDate] = useState(initial?.expiry_date ?? '')
  const [storageMethod, setStorageMethod] = useState(initial?.storage_method ?? '常温')
  const [note, setNote] = useState(initial?.note ?? '')

  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /** 当前选中的定义 */
  const selectedDefinition = useMemo(() => {
    if (isEdit) return initialDefinition
    if (definitionId === '') return undefined
    return definitions.find((d) => d.id === definitionId)
  }, [isEdit, initialDefinition, definitionId, definitions])

  /** 允许单位来自定义，不硬编码 */
  const allowedUnits = selectedDefinition?.allowed_units ?? []

  function validate(): FieldErrors {
    const e: FieldErrors = {}

    if (!isEdit && definitionId === '') {
      e.definition_id = '请选择食材'
    }

    if (quantity.trim().length === 0) {
      e.quantity = '数量不能为空'
    } else {
      const parsed = Number(quantity)
      if (!Number.isFinite(parsed)) {
        e.quantity = '数量必须是数字'
      } else if (parsed <= 0) {
        e.quantity = '数量必须大于 0'
      }
    }

    if (unit.trim().length === 0) {
      e.unit = '请选择单位'
    }

    if (purchaseDate.trim().length === 0) {
      e.purchase_date = '入库日期不能为空'
    }

    return e
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()

    const e = validate()
    setErrors(e)
    if (Object.keys(e).length > 0) return

    setSubmitting(true)
    setSubmitError(null)

    try {
      await onSubmit({
        definition_id: isEdit ? initial.definition_id : Number(definitionId),
        quantity: Number(quantity),
        unit,
        purchase_date: purchaseDate.trim().length > 0 ? purchaseDate : null,
        production_date: productionDate.trim().length > 0 ? productionDate : null,
        // 编辑模式下，只有用户改动过到期日期才发送该字段；
        // 清空则发送 null（后端会清空且不重算）。
        expiry_date: isEdit
          ? expiryDate !== (initial.expiry_date ?? '')
            ? expiryDate.trim().length > 0
              ? expiryDate
              : null
            : undefined
          : expiryDate.trim().length > 0
            ? expiryDate
            : undefined,
        storage_method: storageMethod,
        note: note.trim().length > 0 ? note.trim() : null,
      })
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{isEdit ? '编辑库存' : '添加库存'}</h2>

        <form onSubmit={handleSubmit} noValidate>
          {!isEdit && (
            <>
              <label>
                食材
                <select
                  value={definitionId}
                  onChange={(e) => {
                    const v = e.target.value
                    setDefinitionId(v === '' ? '' : Number(v))
                    setUnit('')
                  }}
                  autoFocus
                >
                  <option value="">请选择…</option>
                  {definitions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              {errors.definition_id && <p className="field-error">{errors.definition_id}</p>}
            </>
          )}

          {isEdit && selectedDefinition && (
            <p className="modal-meta">食材：{selectedDefinition.name}</p>
          )}

          <label>
            数量
            <input
              type="text"
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder="例如：3"
            />
          </label>
          {errors.quantity && <p className="field-error">{errors.quantity}</p>}

          <label>
            单位
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              disabled={allowedUnits.length === 0}
            >
              <option value="">请选择…</option>
              {allowedUnits.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
          {errors.unit && <p className="field-error">{errors.unit}</p>}
          {selectedDefinition && allowedUnits.length === 0 && (
            <p className="field-error">该食材尚未配置可用单位</p>
          )}

          <label>
            入库日期
            <input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
            />
          </label>
          {errors.purchase_date && <p className="field-error">{errors.purchase_date}</p>}

          <label>
            生产日期（不知道可留空）
            <input
              type="date"
              value={productionDate}
              onChange={(e) => setProductionDate(e.target.value)}
            />
          </label>

          <label>
            到期日期
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </label>
          {!isEdit && (
            <p className="hint">
              留空则由 HomeChef 按该食材的预计保质期自动估算。
            </p>
          )}
          {isEdit && initial.expiry_date_source === 'estimated' && (
            <p className="hint">
              当前为 HomeChef 自动估算。修改后将成为手动填写的到期日期。
            </p>
          )}

          <label>
            存储方式
            <select value={storageMethod} onChange={(e) => setStorageMethod(e.target.value)}>
              {STORAGE_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>

          <label>
            备注
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
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
