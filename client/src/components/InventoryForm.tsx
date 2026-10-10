import { useCallback, useMemo, useState } from 'react'

import {
  SEASONING_CATEGORY_NAME,
  STORAGE_METHODS,
  type Category,
  type IngredientDefinitionDetail,
  type InventoryRecord,
} from '../types/api'
import { todayDateString } from '../format'
import IngredientPicker from './IngredientPicker'
import DefinitionQuickEditor from './DefinitionQuickEditor'

/**
 * 库存记录表单（创建 / 编辑共用）。
 *
 * 食材选择使用 IngredientPicker（可搜索，支持默认名称与别名）。
 * 选中的是 **definition.id**，名称只用于显示。
 * 单位下拉来自该定义的 allowed_units。
 *
 * ⚠️ 前端只做基础格式校验；到期日期估算、单位是否合法、
 *    日期关系等业务规则全部由后端负责。
 */

export interface InventoryFormValue {
  definition_id: number
  /**
   * 数量 / 单位。
   * ⚠️ 调味品传 null（后端用哨兵值填充）；普通食材必须提供。
   */
  quantity: number | null
  unit: string | null
  purchase_date: string | null
  production_date: string | null
  /** undefined = 不发送该字段（让后端决定是否重算）；null = 用户主动清空 */
  expiry_date: string | null | undefined
  storage_method: string | null
  note: string | null
}

interface Props {
  /** 可选的食材定义列表（保留以兼容旧调用方） */
  definitions: IngredientDefinitionDetail[]
  /** 分类列表（v0.1.3）：用于判断所选食材是否为调味品 */
  categories?: Category[]
  /** 传入则为编辑模式 */
  initial?: InventoryRecord
  /** 编辑模式下该记录所属定义（用于取 allowed_units） */
  initialDefinition?: IngredientDefinitionDetail
  /**
   * 用户通过选择器换了一个食材时回调。
   * 父组件据此更新用于计算 allowed_units 的定义对象。
   */
  onDefinitionPicked?: (definition: IngredientDefinitionDetail) => void
  /**
   * 「食材设置」弹窗保存成功后的回调（v0.1.4）。
   *
   * 父组件应据此刷新食材列表；表单本身会用传入的最新定义
   * **只更新与食材相关的部分**（分类、可用单位），
   * 绝不重置数量 / 日期 / 储存方式 / 备注等其他字段。
   */
  onDefinitionSaved?: (definition: IngredientDefinitionDetail) => Promise<void> | void
  onSubmit: (value: InventoryFormValue) => Promise<void>
  onCancel: () => void
}

type FieldErrors = Record<string, string>

export default function InventoryForm({
  definitions,
  categories = [],
  initial,
  initialDefinition,
  onDefinitionPicked,
  onDefinitionSaved,
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

  /** 用户在本次表单中通过选择器新选的食材（优先于初始值） */
  const [pickedDefinition, setPickedDefinition] = useState<IngredientDefinitionDetail | null>(
    null,
  )

  /**
   * 「食材设置」弹窗开关（v0.1.4）。
   *
   * ⚠️ 保存后的最新定义存放在 overrideDefinition 中，而不是修改上面那些
   *    useState 初值 —— 因为 useState 的初值只在首次挂载时生效。
   *    这样既能让界面用上最新配置，又**不会重置**用户已填写的其他字段。
   */
  const [showSettings, setShowSettings] = useState(false)
  const [overrideDefinition, setOverrideDefinition] =
    useState<IngredientDefinitionDetail | null>(null)

  /**
   * 当前选中的定义。
   *
   * ⚠️ 编辑模式下也必须支持更换食材：
   *    优先使用用户新选的，否则回退到 initialDefinition。
   * ⚠️ v0.1.4：若通过「食材设置」保存过，优先使用保存后的最新定义。
   */
  const selectedDefinition = useMemo(() => {
    if (overrideDefinition && overrideDefinition.id === definitionId) {
      return overrideDefinition
    }
    if (pickedDefinition) return pickedDefinition
    if (isEdit) return initialDefinition
    if (definitionId === '') return undefined
    return definitions.find((d) => d.id === definitionId)
  }, [overrideDefinition, pickedDefinition, isEdit, initialDefinition, definitionId, definitions])

  /** 允许单位来自定义，不硬编码 */
  const allowedUnits = selectedDefinition?.allowed_units ?? []

  /**
   * 「食材设置」保存后的处理（v0.1.4）。
   *
   * 只做三件事：
   *   1. 记录最新定义（供 selectedDefinition 使用）
   *   2. 通知父组件刷新食材列表
   *   3. 若当前已选单位在新配置下不再合法 → 标出错误提示重选
   *
   * ⚠️ 绝不重置数量 / 入库日期 / 生产日期 / 到期日期 / 储存方式 / 备注。
   * ⚠️ 不自动提交、不自动创建库存。
   */
  const handleDefinitionSaved = useCallback(
    async (updated: IngredientDefinitionDetail) => {
      setOverrideDefinition(updated)
      setPickedDefinition(updated)
      await onDefinitionSaved?.(updated)

      // 单位是否仍然合法？不合法则提示用户重选（不静默提交）
      setErrors((prev) => {
        const next = { ...prev }
        if (unit !== '' && !updated.allowed_units.includes(unit)) {
          next.unit = `单位「${unit}」已不在该食材的允许单位中，请重新选择`
        } else {
          delete next.unit
        }
        return next
      })
    },
    [onDefinitionSaved, unit],
  )

  /** 当前所选食材的分类名（仅用于展示，不参与业务判断） */
  const selectedCategoryName = useMemo(() => {
    const categoryId = selectedDefinition?.category_id
    if (categoryId === null || categoryId === undefined) return null
    return categories.find((c) => c.id === categoryId)?.name ?? null
  }, [selectedDefinition, categories])

  /**
   * 是否调味品（v0.1.3）。
   *
   * ⚠️ 判定依据是**分类名**（与后端 SEASONING_CATEGORY_NAME 同一常量），
   *    不使用 type 字段，也不复制后端的业务规则。
   */
  const seasoning = selectedCategoryName === SEASONING_CATEGORY_NAME

  function validate(): FieldErrors {
    const e: FieldErrors = {}

    // 创建与编辑都必须有食材（编辑时也允许更换）
    if (definitionId === '') {
      e.definition_id = '请选择食材'
    }

    // ⚠️ 调味品不需要数量与单位，直接跳过这两项校验
    if (seasoning) {
      return e
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
      // ⚠️ 调味品不传数量 / 单位 / 日期 / 储存方式 —— 后端用哨兵值填充
      if (seasoning) {
        await onSubmit({
          definition_id: isEdit ? initial.definition_id : Number(definitionId),
          quantity: null,
          unit: null,
          purchase_date: null,
          production_date: null,
          expiry_date: null,
          storage_method: null,
          note: note.trim().length > 0 ? note.trim() : null,
        })
        return
      }

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
          {/* 食材选择：创建与编辑都支持，且都可搜索（默认名称 + 别名） */}
          <label>
            食材
            <IngredientPicker
              value={definitionId}
              selected={selectedDefinition}
              autoFocus={!isEdit}
              onChange={(picked) => {
                // ⚠️ 只保存 definition.id，绝不用名称反查
                setDefinitionId(picked ? picked.id : '')
                setPickedDefinition(picked)
                // 更换食材后原单位可能不再合法，清空让用户重选
                setUnit('')
                if (picked) {
                  onDefinitionPicked?.(picked)
                }
              }}
            />
          </label>
          {errors.definition_id && <p className="field-error">{errors.definition_id}</p>}

          {/* ---- 食材设置快捷入口（v0.1.4）---- */}
          <div className="definition-quick-row">
            <button
              type="button"
              className="definition-quick-open"
              disabled={definitionId === ''}
              title={
                definitionId === ''
                  ? '请先选择食材'
                  : '修改该食材的名称、分类、别名、可用单位与保质期'
              }
              onClick={() => setShowSettings(true)}
            >
              食材设置
            </button>
            {selectedDefinition && (
              <span className="definition-quick-name">
                {selectedDefinition.name}
                {selectedCategoryName && (
                  <span className="category-tag">{selectedCategoryName}</span>
                )}
              </span>
            )}
          </div>

          {/* ⚠️ 调味品只记录「家里有」，不显示数量/单位/日期/储存方式 */}
          {seasoning ? (
            <p className="hint">
              调味品库存只记录「有」，无需填写数量、单位与日期。
            </p>
          ) : (
            <>
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
            </>
          )}

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

      {/*
        「食材设置」弹窗（v0.1.4）。

        ⚠️ 作为**兄弟节点**渲染，而不是替换库存表单本身：
           库存表单始终挂载，因此数量 / 日期 / 储存方式 / 备注等
           useState 状态在打开设置期间完整保留。
      */}
      {showSettings && definitionId !== '' && (
        <DefinitionQuickEditor
          definitionId={definitionId}
          onSaved={handleDefinitionSaved}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  )
}
