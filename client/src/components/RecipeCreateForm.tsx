import { useEffect, useRef, useState } from 'react'

import { createRecipe, saveRecipeFull } from '../api/recipes'
import { ApiError, UNITS } from '../types/api'
import type { RecipeDetail, RecipeInput, RecipeTagItem } from '../types/api'
import IngredientPicker from './IngredientPicker'

/**
 * 菜谱表单（独立弹窗），**同时支持新建与编辑**。
 *
 * 字段与既有 schema 一致（`RecipeInput`）：
 *   - 菜谱名称（必填，同名后端返回 409 DUPLICATE_NAME）
 *   - 描述 / 备注（`note`，可空）
 *   - 配料：至少一条；每条含 **食材定义 + 数量 + 单位 + 备注**
 *   - Tag 多选
 *
 * 关键行为：
 *   - `initial` 为空 → **新建**（`POST /api/recipes`）
 *   - `initial` 非空 → **编辑**（`PATCH /api/recipes/:id/full`，统一保存模式）
 *   - **保存失败保留用户输入**，可直接重试
 *   - **只有保存成功才关闭**并通知父级刷新
 *   - 取消不产生任何写入（**不调用 API**）
 *   - 数量在草稿中是**字符串**，提交时转换；空串 → null
 *   - 单位可空；非空必须属于 10 个固定枚举之一
 *   - Tag 传**名称**（后端自动创建 / 复用）
 *   - 配料用**本地 key** 渲染（绝不用后端 id —— 保存后关联 id 会变）
 */

/**
 * 回显食材所需的最小信息。
 *
 * ⚠️ 编辑回填时数据来自 `RecipeIngredientDetail`（只有 `definition_name`），
 *    因此这里只要求 `id` + `name`，不要求完整 `IngredientDefinitionDetail`。
 *    `IngredientPicker` 的 `onChange` 会传回完整对象，结构上兼容本类型。
 */
interface PickedDefinition {
  id: number
  name: string
  aliases?: Array<{ alias: string }>
}

interface Props {
  open: boolean
  allTags: RecipeTagItem[]
  /** 编辑模式：传入待编辑的菜谱；新建模式传 null / 省略 */
  initial?: RecipeDetail | null
  onCancel: () => void
  /** 保存成功回调（新建与编辑共用；父级据此关闭弹窗、刷新列表/详情） */
  onSaved: (detail: RecipeDetail) => void
}

/** 单条配料草稿 */
interface IngredientDraft {
  /** ⚠️ 本地渲染 key，仅前端使用，绝不传给后端 */
  key: string
  /**
   * 选中的食材（用于回显）。
   *
   * ⚠️ 必须保存**对象**（而不是只存 id）：
   *    `IngredientPicker` 用 `selected` prop 判断是否已选中并回显名称，
   *    只传 id 会导致选中后仍显示输入框。
   */
  definition: PickedDefinition | null
  /** 数量草稿（字符串，提交时转换） */
  quantity: string
  /** 单位；'' 表示不填（提交为 null） */
  unit: string
  /** 该配料的备注 */
  note: string
}

/**
 * 生成本地稳定的渲染 key。
 *
 * ⚠️ 优先用 `crypto.randomUUID()`（localhost / https 属安全上下文）；
 *    若环境不支持则回退到时间戳 + 随机串，保证 key 仍唯一且稳定。
 */
function makeDraftKey(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  return `draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function emptyIngredient(): IngredientDraft {
  return {
    key: makeDraftKey(),
    definition: null,
    quantity: '',
    unit: '',
    note: '',
  }
}

export default function RecipeCreateForm({ open, allTags, initial = null, onCancel, onSaved }: Props) {
  const isEdit = initial !== null

  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [ingredients, setIngredients] = useState<IngredientDraft[]>([emptyIngredient()])
  const [selectedTags, setSelectedTags] = useState<string[]>([])

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  /**
   * 提交锁（**同步**）。
   *
   * ⚠️ 仅靠 `disabled={saving}` 无法防止同一事件循环内的连点：
   *    React 状态更新是异步的，重渲染前按钮仍是可点的。
   */
  const submittingRef = useRef(false)

  /* ------------------------------------------------------------
   * 打开时初始化草稿
   *   新建 → 清空；编辑 → 回填持久化数据
   *
   * ⚠️ 依赖用 `open` 与 `initial?.id`（而不是 `initial` 对象引用）：
   *    避免父组件重渲染时把用户正在编辑的草稿覆盖掉。
   * ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return

    if (initial) {
      setName(initial.name)
      setNote(initial.note ?? '')
      setIngredients(
        initial.ingredients.length > 0
          ? initial.ingredients.map((ing) => ({
              key: makeDraftKey(),
              // ⚠️ 回填只需要 id + name（详情接口已给出 definition_name）
              definition: { id: ing.definition_id, name: ing.definition_name },
              quantity: ing.quantity === null ? '' : String(ing.quantity),
              unit: ing.unit ?? '',
              note: ing.note ?? '',
            }))
          : [emptyIngredient()],
      )
      setSelectedTags(initial.tags)
    } else {
      setName('')
      setNote('')
      setIngredients([emptyIngredient()])
      setSelectedTags([])
    }

    setFormError(null)
    setNameError(null)
    setSaving(false)
    // 打开/切换菜谱时释放提交锁，避免上一次的失败状态影响本次编辑
    submittingRef.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id])

  if (!open) return null

  /* ---------- 配料行操作 ---------- */

  function updateIngredient(key: string, patch: Partial<IngredientDraft>) {
    setIngredients((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }

  function addIngredient() {
    // ⚠️ 允许重复选择同一种食材（每条独立保存数量/单位/备注）
    setIngredients((prev) => [...prev, emptyIngredient()])
  }

  function removeIngredient(key: string) {
    setIngredients((prev) => (prev.length <= 1 ? prev : prev.filter((d) => d.key !== key)))
  }

  /* ---------- 取消（不产生任何写入）---------- */

  function handleCancel() {
    setName('')
    setNote('')
    setIngredients([emptyIngredient()])
    setSelectedTags([])
    setFormError(null)
    setNameError(null)
    setSaving(false)
    onCancel()
  }

  /* ---------- 提交 ---------- */

  async function handleSubmit() {
    setFormError(null)
    setNameError(null)

    // ① 名称
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setNameError('菜谱名称不能为空')
      return
    }

    // ② 配料：至少一条，且每条必须已选食材
    if (ingredients.length === 0) {
      setFormError('至少需要一条配料')
      return
    }
    const missingDef = ingredients.findIndex((d) => d.definition === null)
    if (missingDef !== -1) {
      setFormError(`第 ${missingDef + 1} 条配料尚未选择食材`)
      return
    }

    // ③ 数量校验：空 → null；非空必须是有限非负数
    for (let i = 0; i < ingredients.length; i++) {
      const raw = ingredients[i].quantity.trim()
      if (raw.length === 0) continue
      const num = Number(raw)
      if (!Number.isFinite(num)) {
        setFormError(`第 ${i + 1} 条配料的数量不是有效数字`)
        return
      }
      if (num < 0) {
        setFormError(`第 ${i + 1} 条配料的数量不能为负数`)
        return
      }
    }

    const payload: RecipeInput = {
      name: trimmedName,
      note: note.trim().length === 0 ? null : note.trim(),
      ingredients: ingredients.map((d) => {
        const raw = d.quantity.trim()
        return {
          // 上面的校验保证 definition 非 null
          definition_id: (d.definition as PickedDefinition).id,
          quantity: raw.length === 0 ? null : Number(raw),
          unit: d.unit === '' ? null : d.unit,
          note: d.note.trim().length === 0 ? null : d.note.trim(),
        }
      }),
      tags: selectedTags,
    }

    /*
     * ⚠️ **同步守卫**（不能只靠 `disabled={saving}`）：
     *    React 的 `setSaving(true)` 是异步的，重渲染之前按钮并未真正禁用，
     *    同一事件循环内的连续点击会全部穿透，导致重复 POST/PATCH。
     *    实测：同步连点 5 次 → 5 次请求；加本守卫后 → 1 次。
     *    ref 是同步可读写的，作为提交锁；校验失败路径不会走到这里。
     */
    if (submittingRef.current) return
    submittingRef.current = true

    setSaving(true)
    try {
      // ⚠️ 复用既有 API：编辑走统一保存 PATCH，新建走 POST
      const detail = isEdit && initial
        ? await saveRecipeFull(initial.id, payload)
        : await createRecipe(payload)

      // ⚠️ 只有真正保存成功才关闭并通知父级刷新
      setName('')
      setNote('')
      setIngredients([emptyIngredient()])
      setSelectedTags([])
      onSaved(detail)
    } catch (e) {
      // ⚠️ 失败时**保留全部输入**，仅显示错误
      if (e instanceof ApiError && e.code === 'DUPLICATE_NAME') {
        setNameError('该菜谱名称已存在，请换一个名称')
      } else if (e instanceof ApiError) {
        setFormError(`保存失败：${e.message}`)
      } else {
        setFormError('保存失败，请重试')
      }
    } finally {
      // ⚠️ 无论成功或失败都释放提交锁，失败后用户可直接重试
      submittingRef.current = false
      setSaving(false)
    }
  }

  /* ---------- 渲染 ---------- */

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={isEdit ? '编辑菜谱' : '新建菜谱'}>
      <div className="modal recipe-create-modal">
        <h2>{isEdit ? '编辑菜谱' : '新建菜谱'}</h2>

        {/* 菜谱名称 */}
        <label className="field-block">
          <span className="field-label">菜谱名称 *</span>
          <input
            type="text"
            name="recipe-name"
            autoComplete="off"
            value={name}
            disabled={saving}
            autoFocus
            placeholder="例如：番茄炒蛋"
            aria-label="菜谱名称"
            onChange={(e) => {
              setName(e.target.value)
              setNameError(null)
            }}
          />
          {nameError !== null && <span className="field-error">{nameError}</span>}
        </label>

        {/* 描述 / 备注 */}
        <label className="field-block">
          <span className="field-label">描述（可选）</span>
          <textarea
            rows={2}
            name="recipe-note"
            autoComplete="off"
            value={note}
            disabled={saving}
            placeholder="整体备注，例如：家常做法"
            aria-label="描述"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        {/* 配料 */}
        <div className="field-block">
          <span className="field-label">配料 *（至少一条，可重复选择同一种食材）</span>

          <ul className="recipe-ingredient-rows">
            {ingredients.map((d, index) => (
              <li key={d.key} className="recipe-ingredient-row">
                <div className="recipe-ingredient-line">
                  <span className="recipe-ingredient-index">{index + 1}</span>

                  <div className="recipe-ingredient-picker">
                    <IngredientPicker
                      value={d.definition?.id ?? ''}
                      selected={d.definition ?? undefined}
                      disabled={saving}
                      placeholder="搜索食材"
                      onChange={(def) => {
                        updateIngredient(d.key, { definition: def })
                      }}
                    />
                  </div>

                  {/*
                    ⚠️ 数量字段必须带**明确的 name / autoComplete / 数字输入类型**。
                    原因（Chrome 155 autofill-internals 实测）：
                      原来这里是「无 name + type=text + placeholder=数量」，
                      Chrome 本地正则认不出中文 → UNKNOWN_TYPE，
                      于是把字段签名发给服务端，服务端把**第 2 个**数量框
                      预测成 VEHICLE_LICENSE_PLATE（车牌号），
                      提交时弹出「保存车牌号」。
                    修复：给出语义明确且稳定的 name，让字段签名可辨识；
                      同时显式声明 autoComplete="off" 与数字类型。
                  */}
                  <input
                    type="number"
                    className="recipe-ingredient-qty"
                    name="recipe-ingredient-quantity"
                    inputMode="decimal"
                    step="any"
                    min="0"
                    autoComplete="off"
                    placeholder="数量"
                    aria-label={`第 ${index + 1} 条配料的数量`}
                    value={d.quantity}
                    disabled={saving}
                    onChange={(e) => updateIngredient(d.key, { quantity: e.target.value })}
                  />

                  <select
                    className="recipe-ingredient-unit"
                    name="recipe-ingredient-unit"
                    autoComplete="off"
                    value={d.unit}
                    disabled={saving}
                    onChange={(e) => updateIngredient(d.key, { unit: e.target.value })}
                    aria-label={`第 ${index + 1} 条配料的单位`}
                  >
                    <option value="">（不填）</option>
                    {UNITS.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    className="recipe-ingredient-remove"
                    disabled={saving || ingredients.length <= 1}
                    onClick={() => removeIngredient(d.key)}
                    title={ingredients.length <= 1 ? '至少保留一条配料' : '移除这条配料'}
                  >
                    ×
                  </button>
                </div>

                <input
                  type="text"
                  className="recipe-ingredient-note"
                  name="recipe-ingredient-note"
                  autoComplete="off"
                  placeholder="该配料备注（可选），例如：切丝 / 适量"
                  aria-label={`第 ${index + 1} 条配料的备注`}
                  value={d.note}
                  disabled={saving}
                  onChange={(e) => updateIngredient(d.key, { note: e.target.value })}
                />
              </li>
            ))}
          </ul>

          <button type="button" className="recipe-add-ingredient" disabled={saving} onClick={addIngredient}>
            + 添加配料
          </button>
        </div>

        {/* Tag 多选 */}
        <div className="field-block">
          <span className="field-label">Tag（可选）</span>
          {allTags.length === 0 ? (
            <p className="recipe-create-tag-empty">
              暂无 Tag。可先保存菜谱，再在列表的「选择 Tag」窗口内创建。
            </p>
          ) : (
            <div className="recipe-create-tags">
              {allTags.map((t) => {
                const checked = selectedTags.includes(t.name)
                return (
                  <label key={t.id} className={checked ? 'recipe-create-tag checked' : 'recipe-create-tag'}>
                    <input
                      type="checkbox"
                      name="recipe-tag"
                      autoComplete="off"
                      checked={checked}
                      disabled={saving}
                      onChange={() =>
                        setSelectedTags((prev) =>
                          prev.includes(t.name) ? prev.filter((x) => x !== t.name) : [...prev, t.name],
                        )
                      }
                    />
                    <span>{t.name}</span>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        {formError !== null && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" disabled={saving} onClick={handleCancel}>
            取消
          </button>
          <button type="button" className="primary" disabled={saving} onClick={() => void handleSubmit()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
