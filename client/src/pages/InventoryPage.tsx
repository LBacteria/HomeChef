import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { listDefinitions } from '../api/definitions'
import { listCategories } from '../api/categories'
import {
  MAX_BULK_STOCK_DELETE,
  consumeInventory,
  createInventory,
  deleteInventory,
  deleteInventoryBulk,
  listInventory,
  updateInventory,
} from '../api/inventory'
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog'
import ConsumeDialog from '../components/ConsumeDialog'
import InventoryForm, { type InventoryFormValue } from '../components/InventoryForm'
import SortControls from '../components/SortControls'
import CategoryFilter from '../components/CategoryFilter'
import type {
  Category,
  ExpiryStatus,
  IngredientDefinitionDetail,
  InventoryRecord,
  SortField,
  SortOrder,
} from '../types/api'
import { describeExpiry, formatQuantityWithUnit, groupByDefinition } from '../format'

/**
 * 库存页面。
 *
 * 第 3 节：按 **definition 分组**展示，同一食材可有多条库存记录。
 *
 * ⚠️ 不做跨单位数量聚合（"3 个 + 1 袋"无法相加）。
 *
 * 数据来源：
 *   - GET /api/ingredients  → 库存记录（含 quantity=0 的被后端隐藏）
 *   - GET /api/definitions  → 定义（用于显示分组名称与 allowed_units）
 *
 * 后端返回的库存记录只有 definition_id，没有名称，因此需要在这里做映射。
 */

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; record: InventoryRecord }
  | { kind: 'consume'; record: InventoryRecord }
  | { kind: 'delete'; record: InventoryRecord }

/**
 * 根据背景色选择可读的文字颜色（v0.1.4）。
 *
 * 用标准相对亮度公式（sRGB → 线性 → 加权）判断深浅：
 * 浅色背景配黑字，深色背景配白字，保证分类标签可读。
 *
 * ⚠️ 这是纯显示层计算，不涉及任何业务规则。
 */
function readableTextColor(background: string): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(background)
  if (!match) {
    // 颜色格式异常时退回深色文字（后端已保证格式，这里只是兜底）
    return '#1f1f1f'
  }

  const hex = match[1]
  const toLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }

  const r = toLinear(parseInt(hex.slice(0, 2), 16))
  const g = toLinear(parseInt(hex.slice(2, 4), 16))
  const b = toLinear(parseInt(hex.slice(4, 6), 16))

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b

  return luminance > 0.5 ? '#1f1f1f' : '#ffffff'
}

/**
 * 临期状态的展示徽章。
 *
 * ⚠️ 状态来自**后端**（record.expiry_status / days_remaining），
 *    前端只做文案映射，绝不自行判断日期。
 *
 * 文案规则（v0.1.2）：
 *   已过期（1 天以上）→ 「已过期 · N 天」
 *   今天到期（剩余 0）→ 「临期 · 今天到期」（**不显示"还剩 0 天"**）
 *   临期且剩余 >0   → 「临期 · 还剩 N 天」
 *   正常            → 不显示徽章
 *   无保质期        → 弱化显示「无保质期」
 *
 * ⚠️ 已过期天数取绝对值，**绝不显示负数**。
 */
function expiryStatusBadge(
  status: ExpiryStatus,
  daysRemaining: number | null,
): { text: string; className: string } | null {
  switch (status) {
    case 'expired': {
      // daysRemaining 为负数，取绝对值展示
      const overdueDays = daysRemaining === null ? null : Math.abs(daysRemaining)
      return {
        text: overdueDays === null ? '已过期' : `已过期 · ${overdueDays} 天`,
        className: 'expiry-badge-expired',
      }
    }

    case 'expiring': {
      if (daysRemaining === null) {
        return { text: '临期', className: 'expiry-badge-expiring' }
      }
      // 今天正好到期 → 不显示「还剩 0 天」
      if (daysRemaining === 0) {
        return { text: '临期 · 今天到期', className: 'expiry-badge-expiring' }
      }
      return {
        text: `临期 · 还剩 ${daysRemaining} 天`,
        className: 'expiry-badge-expiring',
      }
    }

    case 'no_expiry':
      // 弱化显示，不作为警告
      return { text: '无保质期', className: 'expiry-badge-none' }

    case 'normal':
    default:
      return null
  }
}

interface Props {
  /** 由父组件传入，用于触发定义刷新（定义增删后库存页需要最新列表） */
  definitionsVersion?: number
  /**
   * 临期设置变化计数。
   * 设置变化后需要重新拉取库存 —— 临期状态由**后端按最新设置计算**，
   * 前端不自行重算。
   */
  settingsVersion?: number
}

export default function InventoryPage({ definitionsVersion = 0, settingsVersion = 0 }: Props) {
  const [records, setRecords] = useState<InventoryRecord[]>([])
  const [definitions, setDefinitions] = useState<IngredientDefinitionDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })

  /**
   * 排序状态。
   *
   * ⚠️ 只保存"用户选了哪个排序"，**实际排序在后端完成**。
   *    本批次不持久化排序偏好（不写数据库、不写 localStorage）。
   */
  const [sortField, setSortField] = useState<SortField>('default')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')

  /**
   * 分类列表与当前筛选（v0.1.3）。
   * ⚠️ 与食材库共用同一套 category 数据（同一个 API）。
   */
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null)

  /**
   * 库存搜索词（本次新增）。
   *
   * ⚠️ 纯**前端本地过滤** —— 后端 `/api/ingredients` 没有 search 参数，
   *    且库存页已经加载了全部库存记录与食材定义（用于显示名称），
   *    因此无需新增后端接口。
   */
  const [search, setSearch] = useState('')

  /** 定义 ID → 定义 的映射（用于显示名称与可用单位） */
  const definitionMap = useMemo(() => {
    const map = new Map<number, IngredientDefinitionDetail>()
    for (const d of definitions) map.set(d.id, d)
    return map
  }, [definitions])

  /**
   * 分类 ID → 分类 的映射（v0.1.4）。
   *
   * ⚠️ 复用**已经加载**的 categories（同一个 listCategories 响应），
   *    不为分类标签额外发请求。
   */
  const categoryById = useMemo(() => {
    const map = new Map<number, Category>()
    for (const c of categories) map.set(c.id, c)
    return map
  }, [categories])

  /**
   * v0.2.4：请求序号。
   *
   * ⚠️ 快速切换分类/搜索时，**旧请求可能晚于新请求返回**。
   *    只接受「最新一次加载」的结果，避免用过期数据覆盖当前列表，
   *    进而让批量选择的范围变成另一个分类的记录。
   */
  const loadSeqRef = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    setLoadError(null)

    try {
      // 排序与分类筛选由后端执行：把当前选择作为查询参数传入
      const [stock, defs, cats] = await Promise.all([
        listInventory({ sort: sortField, order: sortOrder, categoryId: selectedCategoryId }),
        listDefinitions(),
        listCategories(),
      ])
      if (seq !== loadSeqRef.current) return // 过期响应：直接丢弃
      setRecords(stock)
      setDefinitions(defs)
      setCategories(cats)
      // 若当前选中的分类已被删除，回到「全部」
      setSelectedCategoryId((prev) =>
        prev !== null && !cats.some((c) => c.id === prev) ? null : prev,
      )
    } catch (error) {
      if (seq !== loadSeqRef.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [sortField, sortOrder, selectedCategoryId])

  useEffect(() => {
    void load()
  }, [load, definitionsVersion, settingsVersion])

  function closeDialog() {
    setDialog({ kind: 'none' })
  }

  /**
   * 搜索过滤后的库存记录（本次新增）。
   *
   * 规则：
   *   - 只在**库存记录**上过滤（`records` 来自 `GET /api/ingredients`），
   *     因此结果必然是"当前确实有库存的食材"，
   *     **不会**把食材库里没有任何库存记录的定义带进列表。
   *   - 匹配对象是该记录所属食材定义的**名称**（definitionMap 已在本地）。
   *   - 首尾空白 trim；空搜索词 = 不过滤；匹配不区分大小写。
   *   - 与分类筛选、排序**并行兼容**：后两者由后端执行，
   *     这里只是在其结果之上再按名称过滤。
   */
  const visibleRecords = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle.length === 0) return records
    return records.filter((r) => {
      const def = definitionMap.get(r.definition_id)
      return (def?.name ?? '').toLowerCase().includes(needle)
    })
  }, [records, definitionMap, search])

  /* ============================================================
   * v0.2.4：批量选择与批量删除（只针对**当前可见**的库存批次）
   * ============================================================ */

  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState(false)

  /** 可见记录 id 集合（全选范围只在这里面，绝不包含被筛选/搜索隐藏的行） */
  const visibleIdSet = useMemo(
    () => new Set(visibleRecords.map((r) => r.id)),
    [visibleRecords],
  )

  /**
   * 列表/筛选/搜索变化后，**清理已不在可见范围内的选中项**。
   * ⚠️ 后端请求在途时也保持这一不变量，避免拿旧范围去删。
   */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((id) => visibleIdSet.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [visibleIdSet])

  /** 卸载时让在途请求失效，避免 setState 到已卸载组件 / 旧数据回填 */
  useEffect(
    () => () => {
      loadSeqRef.current++
    },
    [],
  )

  /** 批量删除的同步锁（state 更新是异步的，防止连点重复提交） */
  const bulkBusyRef = useRef(false)

  const selectedCount = selectedIds.size
  const allVisibleSelected =
    visibleRecords.length > 0 && visibleRecords.every((r) => selectedIds.has(r.id))

  function exitSelectionMode() {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setBulkError(null)
    setBulkConfirm(false)
  }

  function toggleSelected(id: number) {
    setBulkError(null)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 全选 = 仅当前**可见**记录；超过单次上限时只选前 N 条并提示 */
  function toggleSelectAllVisible() {
    setBulkError(null)
    if (allVisibleSelected) {
      setSelectedIds(new Set())
      return
    }
    const ids = visibleRecords.map((r) => r.id)
    if (ids.length > MAX_BULK_STOCK_DELETE) {
      setSelectedIds(new Set(ids.slice(0, MAX_BULK_STOCK_DELETE)))
      setBulkError(`一次最多删除 ${MAX_BULK_STOCK_DELETE} 条，已选中前 ${MAX_BULK_STOCK_DELETE} 条。`)
      return
    }
    setSelectedIds(new Set(ids))
  }

  async function handleBulkDelete() {
    if (bulkBusyRef.current || bulkBusy || loading) return // 同步锁 + 加载中禁删
    const ids = [...selectedIds]
    if (ids.length === 0) return
    if (ids.length > MAX_BULK_STOCK_DELETE) {
      setBulkError(`一次最多删除 ${MAX_BULK_STOCK_DELETE} 条。`)
      return
    }

    /**
     * ⚠️ 删除前再核一次「选中 ⊆ 当前可见」：
     *    隐藏项（被筛选/搜索/刷新挤掉的记录）绝不能被发送出去。
     *    一旦范围变化就取消确认、保留可见部分，让用户重新确认。
     */
    const hidden = ids.filter((id) => !visibleIdSet.has(id))
    if (hidden.length > 0) {
      setBulkConfirm(false)
      setSelectedIds(new Set(ids.filter((id) => visibleIdSet.has(id))))
      setBulkError('选择范围已变化（部分记录已不在当前列表），已取消本次删除，请重新确认。')
      return
    }

    bulkBusyRef.current = true
    setBulkBusy(true)
    setBulkError(null)
    try {
      await deleteInventoryBulk(ids)
      setBulkConfirm(false)
      setSelectedIds(new Set())
      setSelectionMode(false)
      await load()
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : String(e))
      // 失败时保持选中，便于用户核对后重试；范围变化由上面的清理 effect 兜底
      setBulkConfirm(false)
    } finally {
      bulkBusyRef.current = false
      setBulkBusy(false)
    }
  }

  const groups = useMemo(() => groupByDefinition(visibleRecords), [visibleRecords])

  async function handleCreate(value: InventoryFormValue) {
    // ⚠️ 调味品：quantity / unit 为 null → 不发送，由后端用哨兵值填充
    const payload: Record<string, unknown> = {
      definition_id: value.definition_id,
      note: value.note,
    }
    if (value.quantity !== null) payload.quantity = value.quantity
    if (value.unit !== null) payload.unit = value.unit
    if (value.purchase_date !== null) payload.purchase_date = value.purchase_date
    if (value.production_date !== null) payload.production_date = value.production_date
    if (value.expiry_date !== undefined) payload.expiry_date = value.expiry_date
    if (value.storage_method !== null) payload.storage_method = value.storage_method

    await createInventory(payload as never)
    closeDialog()
    await load()
  }

  async function handleUpdate(id: number, value: InventoryFormValue) {
    // ⚠️ 调味品：只提交备注，其余字段不发送（不影响哨兵值）
    if (value.quantity === null && value.unit === null) {
      await updateInventory(id, { note: value.note })
      closeDialog()
      await load()
      return
    }

    await updateInventory(id, {
      // 编辑时也提交 definition_id：允许更换该记录所属的食材
      definition_id: value.definition_id,
      quantity: value.quantity ?? undefined,
      unit: value.unit ?? undefined,
      purchase_date: value.purchase_date,
      production_date: value.production_date,
      // undefined = 不发送（后端保持/按 source 重算）；null = 主动清空
      ...(value.expiry_date !== undefined ? { expiry_date: value.expiry_date } : {}),
      storage_method: value.storage_method ?? undefined,
      note: value.note,
    })
    closeDialog()
    await load()
  }

  async function handleConsume(id: number, amount: number) {
    await consumeInventory(id, { amount })
    closeDialog()
    await load()
  }

  async function handleDelete(id: number) {
    await deleteInventory(id)
    closeDialog()
    await load()
  }

  /**
   * 「食材设置」保存成功后的回调（v0.1.4）。
   *
   * ⚠️ 只刷新食材与分类列表，**不重建 dialog 状态** ——
   *    否则 InventoryForm 会被卸载重挂，正在填写的库存数据就丢了。
   *    单位与分类的更新由 InventoryForm 内部通过返回的最新定义完成。
   */
  const handleDefinitionSaved = useCallback(async () => {
    try {
      const [defs, cats] = await Promise.all([listDefinitions(), listCategories()])
      setDefinitions(defs)
      setCategories(cats)
    } catch {
      // 刷新失败不影响正在编辑的库存表单；下次 load() 会重新同步
    }
  }, [])

  return (
    <section>
      <div className="section-header">
        <h2>当前库存</h2>
        <div className="section-header-actions">
          {!selectionMode && (
            <button
              type="button"
              disabled={loading || visibleRecords.length === 0}
              onClick={() => {
                setSelectionMode(true)
                setSelectedIds(new Set())
                setBulkError(null)
              }}
              title={visibleRecords.length === 0 ? '当前没有可选择的库存记录' : undefined}
            >
              批量选择
            </button>
          )}
          <button
            type="button"
            className="primary"
            disabled={definitions.length === 0 || selectionMode}
            onClick={() => setDialog({ kind: 'create' })}
            title={definitions.length === 0 ? '请先在食材库中添加食材' : undefined}
          >
            + 添加库存
          </button>
        </div>
      </div>

      {/* v0.2.4：批量选择条 —— 全选范围只限**当前可见**记录 */}
      {selectionMode && (
        <div className="bulk-bar">
          <span className="bulk-count">
            已选 {selectedCount} 条（当前可见 {visibleRecords.length} 条）
          </span>
          <button
            type="button"
            disabled={loading || visibleRecords.length === 0}
            onClick={toggleSelectAllVisible}
          >
            {allVisibleSelected ? '取消全选' : '全选可见'}
          </button>
          <button
            type="button"
            className="danger"
            disabled={selectedCount === 0 || bulkBusy || loading}
            onClick={() => setBulkConfirm(true)}
          >
            {bulkBusy ? '删除中…' : `删除选中（${selectedCount}）`}
          </button>
          <button type="button" disabled={bulkBusy} onClick={exitSelectionMode}>
            取消
          </button>
          {loading && <span className="hint">正在刷新列表，暂不可删除</span>}
          {bulkError !== null && <p className="bulk-error">{bulkError}</p>}
        </div>
      )}

      <div className="with-category-filter">
        {/* 左侧：分类筛选（与食材库共用同一套 category 数据） */}
        <CategoryFilter
          categories={categories}
          selected={selectedCategoryId}
          onChange={setSelectedCategoryId}
        />

        <div className="with-category-filter-main">
          {/*
            搜索栏（本次新增）：
            ⚠️ 沿用库存页既有控件风格 —— 与 SortControls 同处一个工具条，
               使用项目统一的 `.search-input` 样式与 `.inventory-search-input`
               覆盖其独立使用时的宽度/下边距。
          */}
          <input
            type="search"
            className="search-input inventory-search-input"
            placeholder="搜索库存食材"
            value={search}
            disabled={loading}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="搜索库存食材"
          />

          {/* 排序：只选择方式，实际排序由后端执行 */}
          <SortControls
            field={sortField}
            order={sortOrder}
            disabled={loading}
            onChange={(f, o) => {
              setSortField(f)
              setSortOrder(o)
            }}
          />

          {loading && <p className="status">加载中...</p>}

          {!loading && loadError && (
            <div className="load-error">
              <p>加载失败：{loadError}</p>
              <button type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

      {!loading && !loadError && groups.length === 0 && (
        <div className="empty-state">
          {records.length > 0 && search.trim().length > 0 ? (
            /* 有库存，但搜索没有命中 —— 给出明确提示，避免误认为库存丢失 */
            <>
              <p>没有匹配「{search.trim()}」的库存食材。</p>
              <button type="button" onClick={() => setSearch('')}>
                清空搜索
              </button>
            </>
          ) : (
            <>
              <p>目前没有库存。</p>
              {definitions.length === 0 ? (
                <p className="hint">请先到「食材库」添加食材。</p>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={() => setDialog({ kind: 'create' })}
                >
                  添加第一条库存
                </button>
              )}
            </>
          )}
        </div>
      )}

      {!loading && !loadError && groups.length > 0 && (
        <ul className="group-list">
          {groups.map((group) => {
            const def = definitionMap.get(group.definitionId)
            // 分类标签（v0.1.4）：名称与颜色都来自后端返回的 category 数据，
            // 不在此处硬编码任何分类名或颜色。
            const category = categoryById.get(def?.category_id ?? -1)
            return (
              <li key={group.definitionId} className="group-card">
                <div className="group-header">
                  <h3 className="group-name">
                    {def?.name ?? `食材 #${group.definitionId}`}
                    {category && (
                      <span
                        className="category-color-tag"
                        style={{
                          backgroundColor: category.color,
                          color: readableTextColor(category.color),
                        }}
                      >
                        {category.name}
                      </span>
                    )}
                  </h3>
                  <span className="group-count">{group.records.length} 条库存记录</span>
                </div>

                <ul className="record-list">
                  {group.records.map((record) => {
                    const expiry = describeExpiry(record)
                    // ⚠️ 临期状态由**后端**计算，前端只负责展示
                    const badge = expiryStatusBadge(record.expiry_status, record.days_remaining)
                    // 调味品：只显示「有」，不显示数量/单位/日期/储存方式
                    const seasoning = record.is_seasoning === true
                    return (
                      <li
                        key={record.id}
                        className={`record-item${selectionMode && selectedIds.has(record.id) ? ' record-item-selected' : ''}`}
                      >
                        {selectionMode && (
                          <input
                            type="checkbox"
                            className="record-select"
                            checked={selectedIds.has(record.id)}
                            onChange={() => toggleSelected(record.id)}
                            aria-label={`选择库存记录 ${record.id}`}
                          />
                        )}
                        <div className="record-main">
                          {seasoning ? (
                            <p className="record-quantity">
                              有
                              <span className="seasoning-badge">调味品</span>
                            </p>
                          ) : (
                            <p className="record-quantity">
                              {formatQuantityWithUnit(record.quantity, record.unit)}
                              {badge && (
                                <span className={`expiry-badge ${badge.className}`}>
                                  {badge.text}
                                </span>
                              )}
                            </p>
                          )}

                          {/* 调味品不展示任何日期与储存方式 */}
                          {!seasoning && (
                            <>
                              <p className="record-meta">
                                入库：{record.purchase_date}
                                {record.production_date && `　生产：${record.production_date}`}
                                {`　存储：${record.storage_method}`}
                              </p>

                              {expiry && (
                                <p
                                  className={
                                    record.expiry_status === 'expired'
                                      ? 'record-meta overdue'
                                      : 'record-meta'
                                  }
                                >
                                  {expiry.label}：{expiry.date}
                                  {record.days_remaining !== null &&
                                    record.days_remaining >= 0 && (
                                      <span className="hint-inline">
                                        　剩余 {record.days_remaining} 天
                                      </span>
                                    )}
                                </p>
                              )}
                            </>
                          )}

                          {record.note && <p className="record-meta">备注：{record.note}</p>}
                        </div>

                        {!selectionMode && (
                        <div className="record-actions">
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'edit', record })}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'consume', record })}
                          >
                            编辑
                          </button>
                          {/* 调味品没有数量，不提供「消耗」 */}
                          {!seasoning && (
                            <button
                              type="button"
                              onClick={() => setDialog({ kind: 'consume', record })}
                            >
                              消耗
                            </button>
                          )}
                          <button
                            type="button"
                            className="danger"
                            onClick={() => setDialog({ kind: 'delete', record })}
                          >
                            删除
                          </button>
                        </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
          )}
        </div>
      </div>

      {dialog.kind === 'create' && (
        <InventoryForm
          definitions={definitions}
          categories={categories}
          onDefinitionSaved={handleDefinitionSaved}
          onSubmit={handleCreate}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'edit' && (
        <InventoryForm
          definitions={definitions}
          categories={categories}
          initial={dialog.record}
          initialDefinition={definitionMap.get(dialog.record.definition_id)}
          onDefinitionSaved={handleDefinitionSaved}
          onSubmit={(value) => handleUpdate(dialog.record.id, value)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'consume' && (
        <ConsumeDialog
          record={dialog.record}
          definitionName={
            definitionMap.get(dialog.record.definition_id)?.name ??
            `食材 #${dialog.record.definition_id}`
          }
          onSubmit={(amount) => handleConsume(dialog.record.id, amount)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'delete' && (
        <ConfirmDeleteDialog
          ingredientName={`${formatQuantityWithUnit(
            dialog.record.quantity,
            dialog.record.unit,
          )}（${definitionMap.get(dialog.record.definition_id)?.name ?? '库存记录'}）`}
          onConfirm={() => handleDelete(dialog.record.id)}
          onCancel={closeDialog}
        />
      )}

      {bulkConfirm && (
        <ConfirmDeleteDialog
          title="删除选中的库存记录"
          description={
            <>
              <p>
                确定删除选中的 <strong>{selectedCount}</strong> 条库存记录吗？
              </p>
              <p className="hint">
                只删除这些库存批次，不会删除食材定义、菜谱或烹饪记录。
                若其中任意一条已不存在，整批都不会删除。
              </p>
            </>
          }
          onConfirm={handleBulkDelete}
          onCancel={() => setBulkConfirm(false)}
        />
      )}
    </section>
  )
}
