import { useMemo, useState } from 'react'

import {
  saveDefinitionFull,
  type SaveDefinitionFullPayload,
} from '../api/definitions'
import {
  SEASONING_CATEGORY_NAME,
  UNITS,
  type Alias,
  type Category,
  type IngredientDefinitionDetail,
} from '../types/api'

/**
 * 食材定义编辑器（v0.1.4 第二批：统一保存）。
 *
 * ============================================================
 * 核心行为：**所有字段统一草稿，只在点「保存」时提交**
 * ============================================================
 *
 * 参与统一保存的字段：
 *   - 食材名称
 *   - 食材分类
 *   - 预计保质期
 *   - 别名（新增 / 删除）
 *   - 允许单位（新增 / 移除）
 *
 * ⚠️ 编辑期间**不发任何请求**：
 *    - 取消 / 关闭 → 丢弃全部草稿
 *    - 保存失败 → 保留草稿，允许修正后重试
 *    - 无变化 → 不发起任何请求
 *
 * ⚠️ 本组件只操作**食材定义**，绝不触碰库存记录
 *    （数量 / 日期 / 储存方式 / 备注等一律不涉及）。
 *
 * ⚠️ 业务校验仍然全部由后端负责（名称唯一、单位在用、
 *    最后单位、分类跨类等），前端只提交并显示后端消息。
 */

interface Props {
  definition: IngredientDefinitionDetail
  /** 分类列表；不传则不显示分类编辑（向后兼容） */
  categories?: Category[]
  /** 保存成功后调用，用于刷新父组件数据 */
  onChanged: () => Promise<void>
  onClose: () => void
}

/** 别名草稿项：已有别名带 id，新增的 id 为 null */
interface AliasDraft {
  id: number | null
  alias: string
}

export function DefinitionEditor({ definition, categories, onChanged, onClose }: Props) {
  /* ---------- 统一草稿状态 ---------- */
  const [name, setName] = useState(definition.name)
  const [shelfLife, setShelfLife] = useState(
    definition.estimated_shelf_life_days === null
      ? ''
      : String(definition.estimated_shelf_life_days),
  )
  const [categoryId, setCategoryId] = useState<number | ''>(definition.category_id ?? '')

  /** 别名草稿：包含「保留的已有别名」与「新增别名」 */
  const [aliasDrafts, setAliasDrafts] = useState<AliasDraft[]>(
    definition.aliases.map((a: Alias) => ({ id: a.id, alias: a.alias })),
  )
  const [newAlias, setNewAlias] = useState('')

  /** 允许单位草稿：字符串数组 */
  const [unitDrafts, setUnitDrafts] = useState<string[]>([...definition.allowed_units])

  /**
   * 待执行的「设为默认」操作（v0.1.4 第二批恢复）。
   *
   * 值为**要提升为默认名称的别名 id**；null 表示本次不改默认名称。
   *
   * ⚠️ 这只是草稿意图，不发请求。保存时才调用 setDefaultName。
   * ⚠️ 后端语义是一个「交换」：
   *      被提升的别名 → 删除
   *      原默认名称   → 降级为新别名
   *      默认名称     → 改为被提升的别名文本
   */
  const [pendingDefaultAliasId, setPendingDefaultAliasId] = useState<number | null>(null)

  /* ---------- 状态 ---------- */
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* ============================================================
   * 草稿变更判断（用于「无变化则不请求」）
   * ============================================================ */
  const originalAliases = useMemo(() => {
    const map = new Map<number, string>()
    for (const a of definition.aliases) map.set(a.id, a.alias)
    return map
  }, [definition.aliases])

  const originalUnits = useMemo(
    () => [...definition.allowed_units].sort().join('|'),
    [definition.allowed_units],
  )

  /** 是否有任何未保存的修改 */
  const isDirty = useMemo(() => {
    if (name.trim() !== definition.name) return true

    const parsedShelf =
      shelfLife.trim().length === 0 ? null : Number(shelfLife)
    if (parsedShelf !== definition.estimated_shelf_life_days) return true

    if (categories !== undefined) {
      const nextCat = categoryId === '' ? null : categoryId
      if (nextCat !== definition.category_id) return true
    }

    // 别名：数量或内容有变
    if (aliasDrafts.length !== definition.aliases.length) return true
    for (const draft of aliasDrafts) {
      if (draft.id === null) return true
      if (originalAliases.get(draft.id) !== draft.alias) return true
    }

    // 单位：集合有变
    if ([...unitDrafts].sort().join('|') !== originalUnits) return true

    // 待执行的「设为默认」
    if (pendingDefaultAliasId !== null) return true

    return false
  }, [
    name, shelfLife, categoryId, categories, aliasDrafts, unitDrafts,
    pendingDefaultAliasId, definition, originalAliases, originalUnits,
  ])

  /* ============================================================
   * 草稿操作（全部只改本地状态，不发请求）
   * ============================================================ */

  function addAliasDraft() {
    const v = newAlias.trim()
    if (v.length === 0) return
    // 本地去重（后端仍会做全局唯一性校验）
    if (aliasDrafts.some((a) => a.alias === v)) {
      setNewAlias('')
      return
    }
    setAliasDrafts([...aliasDrafts, { id: null, alias: v }])
    setNewAlias('')
  }

  function removeAliasDraft(index: number) {
    const target = aliasDrafts[index]
    // 若移除的正是待提升为默认的别名，同时取消该待执行操作
    if (target.id !== null && target.id === pendingDefaultAliasId) {
      setPendingDefaultAliasId(null)
    }
    setAliasDrafts(aliasDrafts.filter((_, i) => i !== index))
  }

  /**
   * 点「设为默认」——只记录草稿意图，不发请求（v0.1.4 第二批恢复）。
   *
   * 字段关系规则（避免草稿与提交内容不一致）：
   *
   *   后端 setDefaultName 会**同时**改动「默认名称」与「别名」：
   *     被提升的别名 → 从别名列表删除（它成为名称）
   *     原默认名称   → 变成新别名
   *
   *   因此这里同步更新草稿中的 name 与 aliasDrafts，让 UI 立刻反映
   *   最终结果；保存时基础字段用 updateDefinition、名称交换用
   *   setDefaultName，两者不会互相覆盖（见 handleSave 的顺序说明）。
   */
  function markDefaultAlias(index: number) {
    const target = aliasDrafts[index]
    if (target.id === null) {
      // 新增别名尚未入库，无法作为「设为默认」的目标
      setError('新增的别名需要先保存一次，才能设为默认名称')
      return
    }

    const oldName = name
    const promoted = target.alias

    // 1. 默认名称 → 被提升的别名文本
    setName(promoted)

    // 2. 别名列表：移除被提升项，并把原默认名称加入别名（若尚不存在）
    const rest = aliasDrafts.filter((_, i) => i !== index)
    const alreadyHasOldName = rest.some((a) => a.alias === oldName)
    const nextAliases = alreadyHasOldName
      ? rest
      : [...rest, { id: null, alias: oldName }]

    setAliasDrafts(nextAliases)
    setPendingDefaultAliasId(target.id)
    setError(null)
  }

  function toggleUnitDraft(unit: string) {
    setUnitDrafts((prev) =>
      prev.includes(unit) ? prev.filter((u) => u !== unit) : [...prev, unit],
    )
  }

  /* ============================================================
   * 统一保存
   * ============================================================ */

  /**
   * 提交全部草稿。
   *
   * ⚠️ 顺序很重要（避免字段互相覆盖）：
   *
   *   1. **先执行 setDefaultName**（若有待执行的设为默认）
   *      —— 它同时改「名称」与「别名」，影响面最大，必须最先做。
   *
   *   2. 再改其余基础字段（分类 / 保质期）
   *      —— 名称此时已由 setDefaultName 定为草稿中的值，
   *         **不再重复提交名称**，否则会用旧值覆盖刚交换好的名称。
   *         若没有设为默认操作，则正常提交用户改过的名称。
   *
   *   3. 最后处理别名增删与单位增删（基于**重新拉取**的最新状态计算差异）。
   *
   *    任一环节失败都会中止，已成功的部分保留（后端各自独立事务），
   *    草稿与待执行的「设为默认」**都不清空**，用户可修正后重试。
   *
   * ⚠️ 全程不涉及任何库存字段。
   */
  async function handleSave() {
    if (busy) return

    setError(null)

    // ---- 本地基础校验（真正的业务校验仍在后端）----
    if (name.trim().length === 0) {
      setError('食材名称不能为空')
      return
    }

    const parsedShelf = shelfLife.trim().length === 0 ? null : Number(shelfLife)
    if (parsedShelf !== null && (!Number.isInteger(parsedShelf) || parsedShelf < 0)) {
      setError('预计保质期必须是非负整数，或留空')
      return
    }

    // 普通食材至少要保留一个单位（调味品允许 0 个）
    const nextCategoryName =
      categoryId === '' ? null : (categories?.find((c) => c.id === categoryId)?.name ?? null)
    const seasoningAfterSave = nextCategoryName === SEASONING_CATEGORY_NAME
    if (!seasoningAfterSave && unitDrafts.length === 0) {
      setError('普通食材必须至少保留一个单位')
      return
    }

    // 无变化 → 不发请求
    if (!isDirty) {
      onClose()
      return
    }

    setBusy(true)
    try {
      /* ---- 统一保存：**单个请求**，后端在同一事务内完成全部改动 ---- */
      //
      // ⚠️ v0.1.4 第二批修复：
      //    此前是「多个独立请求串行」，会出现部分成功 ——
      //    例如 setDefaultName 已成功（alias id 已被消耗），
      //    但后续请求失败，用户重试时用旧 id → 404，无法恢复。
      //
      //    现在全部交给后端一个事务：要么全成功，要么全回滚。
      //    因此**重试永远安全**，不存在过期 ID 问题。
      const payload: SaveDefinitionFullPayload = {}

      const nextCategory = categoryId === '' ? null : categoryId
      const nextShelf = parsedShelf

      if (name.trim() !== definition.name) payload.name = name.trim()
      if (nextShelf !== definition.estimated_shelf_life_days) {
        payload.estimated_shelf_life_days = nextShelf
      }
      if (categories !== undefined && nextCategory !== definition.category_id) {
        payload.category_id = nextCategory
      }

      // 别名：提交全量草稿（后端按文本做差异同步）
      payload.aliases = aliasDrafts.map((a) => ({ id: a.id, alias: a.alias }))

      // 单位：提交全量草稿
      payload.units = unitDrafts

      // 设为默认（若有）
      if (pendingDefaultAliasId !== null) {
        payload.set_default_alias_id = pendingDefaultAliasId
      }

      await saveDefinitionFull(definition.id, payload)

      /* ---- 保存成功：刷新父组件并关闭 ---- */
      await onChanged()
      onClose()
    } catch (err) {
      // ⚠️ 后端已整体回滚，后端状态 = 保存前状态。
      //    因此保留全部草稿（含待执行的「设为默认」）是**安全可重试**的。
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const missingUnits = UNITS.filter((u) => !unitDrafts.includes(u))

  /** 当前分类名（用于调味品提示） */
  const currentCategoryName =
    categories?.find((c) => c.id === definition.category_id)?.name ?? null
  const selectedCategoryName =
    categoryId === '' ? null : (categories?.find((c) => c.id === categoryId)?.name ?? null)
  const isSeasoning = selectedCategoryName === SEASONING_CATEGORY_NAME

  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <h2>编辑食材</h2>

        {/* ---- 基本信息 ---- */}
        <section className="editor-section">
          <label>
            默认名称
            <input
              type="text"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          {categories !== undefined && (
            <label>
              分类
              <select
                value={categoryId}
                disabled={busy}
                onChange={(e) => {
                  const v = e.target.value
                  setCategoryId(v === '' ? '' : Number(v))
                }}
              >
                <option value="">未设置</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {categories !== undefined &&
            selectedCategoryName !== currentCategoryName &&
            (isSeasoning || currentCategoryName === SEASONING_CATEGORY_NAME) && (
              <p className="hint">
                在「调味品」与普通食材之间切换分类时，如果该食材下还有库存记录
                （包含数量为 0 的记录），后端会拒绝并提示先删除库存。
              </p>
            )}

          <label>
            预计保质期（天，可留空）
            <input
              type="text"
              inputMode="numeric"
              value={shelfLife}
              disabled={busy}
              onChange={(e) => setShelfLife(e.target.value)}
            />
          </label>
          <p className="hint">
            修改保质期**只影响以后新建的库存记录**，已有库存不会被改动。
          </p>
        </section>

        {/* ---- 别名 ---- */}
        <section className="editor-section">
          <h3>别名</h3>
          <p className="modal-meta">默认名称：{definition.name}</p>

          {aliasDrafts.length === 0 && <p className="hint">暂无别名</p>}

          <ul className="alias-manage-list">
            {aliasDrafts.map((a, index) => {
              const isPendingDefault =
                a.id !== null && a.id === pendingDefaultAliasId
              return (
                <li key={a.id ?? `new-${index}`} className="alias-manage-item">
                  <span className="alias-name">
                    {a.alias}
                    {a.id === null && <span className="draft-badge">待新增</span>}
                    {isPendingDefault && <span className="draft-badge">待设为默认</span>}
                  </span>
                  <span className="alias-actions">
                    <button
                      type="button"
                      disabled={busy || a.id === null || isPendingDefault}
                      title={
                        a.id === null
                          ? '新增的别名需先保存一次才能设为默认名称'
                          : '把该别名设为食材的默认名称'
                      }
                      onClick={() => markDefaultAlias(index)}
                    >
                      设为默认
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => removeAliasDraft(index)}
                    >
                      移除
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>

          <div className="alias-input-row">
            <input
              type="text"
              value={newAlias}
              disabled={busy}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addAliasDraft()
                }
              }}
              placeholder="新别名"
            />
            <button
              type="button"
              disabled={busy || newAlias.trim().length === 0}
              onClick={addAliasDraft}
            >
              添加别名
            </button>
          </div>
          <p className="hint">别名的增删会在点击底部「保存」时一并提交。</p>
        </section>

        {/* ---- 允许单位 ---- */}
        <section className="editor-section">
          <h3>允许单位</h3>

          {unitDrafts.length === 0 ? (
            <p className="modal-meta">
              无
              {isSeasoning && <span className="hint-inline">（调味品无需单位）</span>}
            </p>
          ) : (
            <div className="unit-grid">
              {unitDrafts.map((u) => (
                <span key={u} className="unit-chip">
                  {u}
                  <button
                    type="button"
                    className="tag-remove"
                    disabled={busy}
                    onClick={() => toggleUnitDraft(u)}
                    aria-label={`移除 ${u}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {missingUnits.length > 0 && (
            <div className="add-unit-row">
              <span className="field-label">添加单位：</span>
              {missingUnits.map((u) => (
                <button
                  key={u}
                  type="button"
                  disabled={busy}
                  onClick={() => toggleUnitDraft(u)}
                >
                  + {u}
                </button>
              ))}
            </div>
          )}

          <p className="hint">
            {isSeasoning
              ? '调味品允许没有单位；库存只记录「有 / 无」。'
              : '移除正在被库存使用的单位会被后端拒绝；普通食材至少需保留一个单位。'}
          </p>
          <p className="hint">单位的增删会在点击底部「保存」时一并提交。</p>
        </section>

        {error && <p className="form-error">{error}</p>}

        {/* ---- 唯一的统一保存按钮 ---- */}
        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void handleSave()}
            disabled={busy}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>

        {isDirty && !busy && <p className="hint draft-hint">有未保存的修改</p>}
      </div>
    </div>
  )
}
