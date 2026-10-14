import { useCallback, useEffect, useRef, useState } from 'react'

import {
  abandonSession,
  addDish,
  createSession,
  deleteSkip,
  getSession,
  listSessions,
  listSkips,
  previewSettlement,
  removeDish,
  saveSkips,
  settleSession,
  updateDishProgress,
  updateDishServings,
} from '../api/cooking'
import { listRecipes, getRecipe } from '../api/recipes'
import { ApiError } from '../types/api'
import type {
  CookingSessionDetail,
  CookingSessionStatus,
  CookingSessionSummary,
  DishSkipReason,
  SettlementPreview,
  SettlementResult,
  SkipConfirmationInput,
} from '../types/api'

/**
 * 烹饪页面（v0.2.1 B4）。
 *
 * 两个视图：
 *   列表视图 —— 会话列表 + 新建会话
 *   详情视图 —— 菜品管理 / 步骤进度 / 跳过确认 / 结算
 *
 * ---------------------------------------------------------------------------
 * 核心原则（勿删）
 * ---------------------------------------------------------------------------
 * 1. **后端是唯一权威**：所有状态、确认完整性、可用库存均由后端判定，
 *    前端不缓存权威状态、不模拟扣减、不自行认定确认完成。
 * 2. **请求竞态防护**：`detailSeq` 递增使过期响应被丢弃。
 * 3. **结算防重复提交**：`settling` 期间按钮禁用，且不做自动重试。
 */

/** 会话状态的中文标签 */
const STATUS_LABEL: Record<CookingSessionStatus, string> = {
  active: '准备中',
  cooking: '烹饪中',
  awaiting_settlement: '待结算',
  settled: '已结算',
  abandoned: '已放弃',
}

/** 终态：不可再修改 */
const TERMINAL: readonly CookingSessionStatus[] = ['settled', 'abandoned']

/** 跳过原因的中文说明 */
const REASON_LABEL: Record<DishSkipReason, string> = {
  null_quantity: '用量未指定（「适量」），无法计算扣减量',
  unit_mismatch: '库存中没有单位一致的记录，无法扣减',
  user_choice: '用户主动跳过',
}

/** 结算结果的标签 */
const OUTCOME_LABEL: Record<string, string> = {
  consumed: '已扣减',
  skipped_null_quantity: '跳过（用量未指定）',
  skipped_unit_mismatch: '跳过（单位不匹配）',
  skipped_user: '跳过（用户选择）',
  insufficient: '库存不足',
}

export default function CookingPage() {
  /* ---------- 列表 ---------- */
  const [sessions, setSessions] = useState<CookingSessionSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  /* ---------- 详情 ---------- */
  const [detail, setDetail] = useState<CookingSessionDetail | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailSeq = useRef(0)

  /* ---------- 提示 ---------- */
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /* ---------- 加菜 ---------- */
  const [recipeOptions, setRecipeOptions] = useState<Array<{ id: number; name: string }>>([])
  const [recipeOptionsLoading, setRecipeOptionsLoading] = useState(false)
  const [pickedRecipeId, setPickedRecipeId] = useState<number | ''>('')
  const [pickedServings, setPickedServings] = useState('1')

  /* ---------- 步骤展示 ---------- */
  /** 当前展开步骤的菜品 id → 步骤内容 */
  const [stepCache, setStepCache] = useState<Record<number, Array<{ step_no: number; content: string }>>>({})
  const [expandedDishId, setExpandedDishId] = useState<number | null>(null)

  /* ---------- 结算 ---------- */
  const [preview, setPreview] = useState<SettlementPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [settling, setSettling] = useState(false)
  const [settleResult, setSettleResult] = useState<SettlementResult | null>(null)

  /* ---------- 份数待提交状态（★ 竞态修复的核心）----------
   *
   * 问题：用户改完成份数立刻点「结算」，input 的 onBlur 与 click 在
   *       同一事件循环内先后触发，而 React 的 setState 是异步的 ——
   *       仅靠 state 里的 `busy` 判断**挡不住**这一次结算。
   *
   * 解决：用 **ref** 维护「尚未成功保存到服务端的份数」。
   *   - ref 同步读写，不受渲染时序影响
   *   - 只在服务端**确认保存成功后**才移除，绝不在 setState 时移除
   *   - `handleSettle` 在真正执行前**必须**先把这里清空（保存成功）
   */
  const [inputServings, setInputServings] = useState<Record<number, string>>({})
  /** dishId → 用户输入但尚未成功保存的份数（字符串原样） */
  const pendingServings = useRef<Map<number, string>>(new Map())
  /** 结算互斥锁：同步可读，防止连续点击穿透 */
  const settleLock = useRef(false)

  /* ============================================================
   * 列表加载
   * ============================================================ */
  const fetchSessions = useCallback(async () => {
    setListLoading(true)
    setListError(null)
    try {
      setSessions(await listSessions())
    } catch (e) {
      setSessions([])
      setListError(e instanceof ApiError ? e.message : '加载烹饪会话失败，请稍后重试。')
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    return () => {
      detailSeq.current++
    }
  }, [])

  /* ============================================================
   * 详情加载
   * ============================================================ */
  const openDetail = useCallback(async (id: number) => {
    const seq = ++detailSeq.current
    // ⚠️ 切换会话时丢弃上一个会话的待提交份数，避免串到新会话
    pendingServings.current.clear()
    setInputServings({})
    settleLock.current = false
    setDetailId(id)
    setDetailLoading(true)
    setDetailError(null)
    setActionError(null)
    setNotice(null)
    setPreview(null)
    setSettleResult(null)
    setExpandedDishId(null)

    try {
      const data = await getSession(id)
      if (seq !== detailSeq.current) return
      setDetail(data)
    } catch (e) {
      if (seq !== detailSeq.current) return
      setDetailError(e instanceof ApiError ? e.message : '加载会话详情失败，请稍后重试。')
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false)
    }
  }, [])

  function backToList() {
    detailSeq.current++
    // ⚠️ 离开详情时丢弃待提交份数与结算锁
    pendingServings.current.clear()
    setInputServings({})
    settleLock.current = false
    setDetail(null)
    setDetailId(null)
    setDetailError(null)
    setDetailLoading(false)
    setPreview(null)
    setSettleResult(null)
    setActionError(null)
    setNotice(null)
    void fetchSessions()
  }

  /* ============================================================
   * 通用操作包装：统一错误处理 + busy 状态
   * ============================================================ */
  const runAction = useCallback(
    async (fn: () => Promise<CookingSessionDetail>, successMessage?: string) => {
      setBusy(true)
      setActionError(null)
      setNotice(null)
      try {
        const next = await fn()
        // ⚠️ 以**后端返回的详情**为准，不本地猜测状态
        if (next.id === detailId) setDetail(next)
        // 任何写操作都可能使既有跳过确认失效 → 清掉本地预览
        setPreview(null)
        setSettleResult(null)
        if (successMessage) setNotice(successMessage)
        void fetchSessions()
      } catch (e) {
        setActionError(e instanceof ApiError ? e.message : '操作失败，请稍后重试。')
      } finally {
        setBusy(false)
      }
    },
    [detailId, fetchSessions],
  )

  /* ============================================================
   * 会话操作
   * ============================================================ */
  async function handleCreateSession() {
    setCreating(true)
    setListError(null)
    try {
      const created = await createSession()
      await fetchSessions()
      void openDetail(created.id)
    } catch (e) {
      setListError(e instanceof ApiError ? e.message : '创建会话失败，请稍后重试。')
    } finally {
      setCreating(false)
    }
  }

  async function handleAbandon() {
    if (detail === null) return
    await runAction(() => abandonSession(detail.id), '会话已放弃。')
  }

  /* ============================================================
   * 加菜：加载菜谱选项
   * ============================================================ */
  async function loadRecipeOptions() {
    setRecipeOptionsLoading(true)
    try {
      const list = await listRecipes({ sortField: 'name', sortOrder: 'asc' })
      setRecipeOptions(list.map((r) => ({ id: r.id, name: r.name })))
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '加载菜谱列表失败。')
      setRecipeOptions([])
    } finally {
      setRecipeOptionsLoading(false)
    }
  }

  async function handleAddDish() {
    if (detail === null || pickedRecipeId === '') return

    const servings = Number(pickedServings)
    if (!Number.isFinite(servings) || servings <= 0) {
      setActionError('份数必须是大于 0 的数字。')
      return
    }

    await runAction(
      () => addDish(detail.id, pickedRecipeId, servings),
      '已加入菜品（若该菜谱已存在则合并份数）。',
    )
    setPickedRecipeId('')
    setPickedServings('1')
  }

  /* ============================================================
   * 份数调整（★ 竞态修复）
   * ============================================================ */

  /** 用户输入份数：只记录到本地（受控输入），标记为待保存 */
  function handleServingsInput(dishId: number, raw: string) {
    setInputServings((prev) => ({ ...prev, [dishId]: raw }))
    pendingServings.current.set(dishId, raw)
    setActionError(null)
  }

  /**
   * 把**全部待提交的份数**保存到服务端。
   *
   * ⚠️ 必须逐个 await 完成，任一失败立即返回 `false`，
   *    调用方（结算）据此**中止**，绝不用旧数据继续。
   * ⚠️ 只有服务端确认成功后才从 `pendingServings` 移除 ——
   *    这是「已保存」的唯一判据。
   *
   * @returns 是否全部保存成功（无待提交项时返回 true）
   */
  async function flushPendingServings(): Promise<boolean> {
    if (detailId === null) return false

    // 逐个串行提交：避免同一会话的并发写导致后端返回顺序不可控
    for (;;) {
      const entry = pendingServings.current.entries().next()
      if (entry.done === true) break

      const [dishId, raw] = entry.value
      const next = Number(raw)

      // 非法输入：保留在队列中，报错中止（不静默丢弃用户输入）
      if (!Number.isFinite(next) || next <= 0) {
        setActionError(`份数必须是大于 0 的数字（菜品 #${dishId}）。`)
        return false
      }

      const saved = detail?.dishes.find((d) => d.id === dishId)
      // 与服务端当前值一致 → 无需请求，直接出队
      if (saved !== undefined && saved.servings === next) {
        pendingServings.current.delete(dishId)
        continue
      }

      setBusy(true)
      try {
        const updated = await updateDishServings(detailId, dishId, next)
        // ★ 只有服务端返回成功，才认为「已保存」
        pendingServings.current.delete(dishId)
        setDetail(updated)
        setPreview(null)
        setSettleResult(null)
        // 输入框回落到服务端确认值
        setInputServings((prev) => {
          const copy = { ...prev }
          delete copy[dishId]
          return copy
        })
      } catch (e) {
        // ⚠️ 失败时**保留**队列项与输入值，让用户能看到并重试，
        //    绝不静默丢失用户输入。结算流程会因返回 false 而中止。
        setActionError(
          e instanceof ApiError ? `份数保存失败：${e.message}` : '份数保存失败，请稍后重试。',
        )
        return false
      } finally {
        setBusy(false)
      }
    }

    return true
  }

  /** 失焦提交（不阻塞：失败时错误已在 flush 内报告） */
  async function handleServingsBlur(dishId: number) {
    if (!pendingServings.current.has(dishId)) return
    const ok = await flushPendingServings()
    if (ok) setNotice('份数已更新（相关跳过确认已失效，需重新确认）。')
  }

  async function handleRemoveDish(dishId: number, name: string) {
    if (detailId === null) return
    // 移除前先提交待保存的份数，避免遗留脏状态
    if (pendingServings.current.size > 0) {
      const ok = await flushPendingServings()
      if (!ok) return
    }
    pendingServings.current.delete(dishId)
    await runAction(() => removeDish(detailId, dishId), `已移除「${name}」。`)
  }

  /* ============================================================
   * 步骤与进度
   * ============================================================ */
  async function handleToggleSteps(dishId: number, recipeId: number) {
    if (expandedDishId === dishId) {
      setExpandedDishId(null)
      return
    }
    setExpandedDishId(dishId)

    if (stepCache[dishId] !== undefined) return

    try {
      const recipe = await getRecipe(recipeId)
      setStepCache((prev) => ({ ...prev, [dishId]: recipe.steps }))
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '加载菜谱步骤失败。')
      setExpandedDishId(null)
    }
  }

  async function handleSetStep(dishId: number, stepNo: number | null) {
    if (detailId === null) return
    await runAction(() => updateDishProgress(detailId, dishId, { current_step_no: stepNo }))
  }

  async function handleToggleDishDone(dishId: number, current: 'pending' | 'done') {
    if (detailId === null) return
    const next = current === 'done' ? 'pending' : 'done'
    await runAction(
      () => updateDishProgress(detailId, dishId, { status: next }),
      next === 'done' ? '该菜品已标记完成。' : '该菜品已改回未完成。',
    )
  }

  /* ============================================================
   * 跳过确认
   * ============================================================ */
  async function handleConfirmSkips(items: SkipConfirmationInput[], message: string) {
    if (detailId === null) return
    await runAction(() => saveSkips(detailId, items), message)
  }

  /** 批量确认预览中所有「必需但未确认」的项 */
  async function handleConfirmAllRequired() {
    if (preview === null || detailId === null) return

    const pending: SkipConfirmationInput[] = preview.items
      .filter((it) => it.required_reason !== null && !it.confirmed && it.line_key !== null)
      .map((it) => ({
        dish_id: it.dish_id,
        line_key: it.line_key as string,
        reason: it.required_reason as DishSkipReason,
      }))

    if (pending.length === 0) return

    await handleConfirmSkips(pending, `已确认 ${pending.length} 项跳过。`)
    // ⚠️ 确认后必须重新预览 —— 完整性由后端判定
    await loadPreview()
  }

  async function handleDeleteSkip(dishId: number, lineKey: string) {
    if (detailId === null) return
    await runAction(() => deleteSkip(detailId, dishId, lineKey), '已撤销该确认。')
    setPreview(null)
  }

  /* ============================================================
   * 结算
   * ============================================================ */
  /**
   * 获取服务端最新结算预览。
   *
   * @returns 预览对象；失败返回 null（错误已展示）
   */
  async function fetchPreview(): Promise<SettlementPreview | null> {
    if (detailId === null) return null
    setPreviewLoading(true)
    try {
      const p = await previewSettlement(detailId)
      setPreview(p)
      return p
    } catch (e) {
      setPreview(null)
      setActionError(e instanceof ApiError ? e.message : '加载结算预览失败。')
      return null
    } finally {
      setPreviewLoading(false)
    }
  }

  /** 用户手动「查看结算预览」 */
  async function loadPreview() {
    setActionError(null)
    await fetchPreview()
  }

  /**
   * 执行结算。
   *
   * 前置检查顺序（**缺一不可**）：
   *   ① 同步互斥锁 `settleLock` —— 挡住同一事件循环内的连续点击
   *   ② **提交全部待保存份数** —— 失败立即中止，绝不用旧数据结算
   *   ③ **重新拉取服务端预览** —— 绝不复用结算前可能已过期的 `preview`
   *   ④ 依据**最新预览**判断是否就绪（`ready`）—— 不就绪则中止
   *   ⑤ 只有以上全部通过才调用结算 API
   *
   * ⚠️ 不做自动重试；失败一律如实展示。
   */
  async function handleSettle() {
    if (detailId === null) return

    // ① 同步互斥：`settleLock` 是 ref，同一事件循环内立即可见
    if (settleLock.current) return
    settleLock.current = true

    setSettling(true)
    setActionError(null)
    setNotice(null)

    try {
      // ② ★ 先提交所有待保存的份数
      const flushed = await flushPendingServings()
      if (!flushed) return

      // ③ ★ 重新获取基于最新服务端状态的预览
      const latest = await fetchPreview()
      if (latest === null) return

      // ④ 依据最新预览判断（不使用结算前的旧 preview）
      if (!latest.ready) {
        setActionError(
          `结算条件尚未满足：仍有 ${latest.needing_confirmation} 项需要确认，` +
            '或存在库存不足的项目。请处理后重试。',
        )
        return
      }

      // ⑤ 执行结算
      const result = await settleSession(detailId)
      setSettleResult(result)
      setPreview(null)
      pendingServings.current.clear()
      setInputServings({})
      const refreshed = await getSession(detailId)
      setDetail(refreshed)
      void fetchSessions()
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : '结算失败，请稍后重试。')
    } finally {
      setSettling(false)
      settleLock.current = false
    }
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  const inDetail = detail !== null || detailLoading || detailError !== null

  /* ---------- 列表视图 ---------- */
  if (!inDetail) {
    return (
      <section className="cooking-page">
        <div className="section-header">
          <h2>烹饪</h2>
          <button
            type="button"
            className="primary"
            disabled={creating}
            onClick={() => void handleCreateSession()}
          >
            {creating ? '创建中…' : '+ 新建烹饪会话'}
          </button>
        </div>

        {listLoading && <p className="status">加载中…</p>}

        {!listLoading && listError !== null && (
          <div className="load-error">
            <p>{listError}</p>
            <button type="button" onClick={() => void fetchSessions()}>
              重试
            </button>
          </div>
        )}

        {!listLoading && listError === null && sessions.length === 0 && (
          <p className="empty-state">还没有烹饪会话。点击右上角「新建烹饪会话」开始。</p>
        )}

        {!listLoading && listError === null && sessions.length > 0 && (
          <ul className="cooking-session-list">
            {sessions.map((s) => (
              <li key={s.id} className="cooking-session-item">
                <button type="button" className="cooking-session-open" onClick={() => void openDetail(s.id)}>
                  <span className="cooking-session-id">会话 #{s.id}</span>
                  <span className={`cooking-status cooking-status-${s.status}`}>
                    {STATUS_LABEL[s.status]}
                  </span>
                  <span className="cooking-session-meta">{s.dish_count} 道菜</span>
                </button>
                <span className="cooking-session-time">{formatTime(s.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  }

  /* ---------- 详情视图 ---------- */
  const isTerminal = detail !== null && TERMINAL.includes(detail.status)

  return (
    <section className="cooking-page">
      <div className="section-header">
        <h2>烹饪会话 #{detailId ?? ''}</h2>
        <button type="button" onClick={backToList}>
          ← 返回列表
        </button>
      </div>

      {detailLoading && <p className="status">加载中…</p>}

      {!detailLoading && detailError !== null && (
        <div className="load-error">
          <p>{detailError}</p>
          <button type="button" onClick={() => detailId !== null && void openDetail(detailId)}>
            重试
          </button>
        </div>
      )}

      {!detailLoading && detailError === null && detail !== null && (
        <>
          {/* ---------- 状态概览 ---------- */}
          <div className="cooking-overview">
            <span className={`cooking-status cooking-status-${detail.status}`}>
              {STATUS_LABEL[detail.status]}
            </span>
            <span className="cooking-overview-meta">
              {detail.dishes.length} 道菜 · 内容版本 v{detail.recipe_revision}
            </span>
            {detail.settled_at !== null && (
              <span className="cooking-overview-meta">结算于 {formatTime(detail.settled_at)}</span>
            )}
          </div>

          {isTerminal && (
            <p className="cooking-terminal-note">
              {detail.status === 'settled'
                ? '该会话已结算完成，不可再修改。'
                : '该会话已放弃，不可再修改。'}
            </p>
          )}

          {actionError !== null && (
            <p className="cooking-action-error" role="alert">
              {actionError}
            </p>
          )}

          {notice !== null && (
            <p className="recipe-notice" role="status">
              {notice}
            </p>
          )}

          {/* ---------- 加菜 ---------- */}
          {!isTerminal && (
            <div className="cooking-add-dish">
              <h3>添加菜品</h3>
              <div className="cooking-add-row">
                <select
                  value={pickedRecipeId}
                  disabled={busy || recipeOptionsLoading}
                  onFocus={() => {
                    if (recipeOptions.length === 0) void loadRecipeOptions()
                  }}
                  onChange={(e) => setPickedRecipeId(e.target.value === '' ? '' : Number(e.target.value))}
                >
                  <option value="">
                    {recipeOptionsLoading ? '加载菜谱中…' : '选择菜谱…'}
                  </option>
                  {recipeOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>

                <label className="cooking-servings-input">
                  份数
                  <input
                    type="number"
                    min="0.5"
                    step="0.5"
                    value={pickedServings}
                    disabled={busy}
                    onChange={(e) => setPickedServings(e.target.value)}
                  />
                </label>

                <button
                  type="button"
                  className="primary"
                  disabled={busy || pickedRecipeId === ''}
                  onClick={() => void handleAddDish()}
                >
                  添加
                </button>

                <button type="button" disabled={busy} onClick={() => void loadRecipeOptions()}>
                  刷新菜谱
                </button>
              </div>
              <p className="cooking-hint">重复添加同一菜谱会合并份数。</p>
            </div>
          )}

          {/* ---------- 菜品列表 ---------- */}
          <h3>菜品（{detail.dishes.length}）</h3>

          {detail.dishes.length === 0 && (
            <p className="empty-state">还没有菜品。请先添加菜谱。</p>
          )}

          <ul className="cooking-dish-list">
            {detail.dishes.map((dish) => {
              const steps = stepCache[dish.id]
              const expanded = expandedDishId === dish.id

              return (
                <li key={dish.id} className="cooking-dish-item">
                  <div className="cooking-dish-head">
                    <span className="cooking-dish-name">{dish.recipe_name}</span>
                    <span className={`cooking-dish-state ${dish.status === 'done' ? 'done' : ''}`}>
                      {dish.status === 'done' ? '已完成' : '未完成'}
                    </span>
                    {!dish.confirmed && (
                      <span className="cooking-dish-warn">确认未完成</span>
                    )}
                  </div>

                  <div className="cooking-dish-controls">
                    <label className="cooking-servings-input">
                      份数
                      <input
                        type="number"
                        min="0.5"
                        step="0.5"
                        // ⚠️ 受控：优先显示用户输入，否则显示服务端确认值
                        value={inputServings[dish.id] ?? String(dish.servings)}
                        disabled={busy || isTerminal}
                        onChange={(e) => handleServingsInput(dish.id, e.target.value)}
                        onBlur={() => void handleServingsBlur(dish.id)}
                      />
                      {pendingServings.current.has(dish.id) && (
                        <span className="cooking-pending-badge">待保存</span>
                      )}
                    </label>

                    <span className="cooking-dish-progress">
                      步骤 {dish.current_step_no ?? '未开始'} / {dish.step_count}
                    </span>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleSteps(dish.id, dish.recipe_id)}
                    >
                      {expanded ? '隐藏步骤' : '查看步骤'}
                    </button>

                    {!isTerminal && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleToggleDishDone(dish.id, dish.status)}
                        >
                          {dish.status === 'done' ? '改回未完成' : '标记完成'}
                        </button>
                        <button
                          type="button"
                          className="danger"
                          disabled={busy}
                          onClick={() => void handleRemoveDish(dish.id, dish.recipe_name)}
                        >
                          移除
                        </button>
                      </>
                    )}
                  </div>

                  {expanded && (
                    <div className="cooking-steps">
                      {steps === undefined && <p className="status">加载步骤中…</p>}
                      {steps !== undefined && steps.length === 0 && (
                        <p className="empty-state">该菜谱没有步骤。</p>
                      )}
                      {steps !== undefined && steps.length > 0 && (
                        <ol className="cooking-step-list">
                          {steps.map((st) => {
                            const isCurrent = dish.current_step_no === st.step_no
                            return (
                              <li
                                key={st.step_no}
                                className={isCurrent ? 'cooking-step current' : 'cooking-step'}
                              >
                                <span className="cooking-step-text">{st.content}</span>
                                {!isTerminal && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleSetStep(dish.id, st.step_no)}
                                  >
                                    {isCurrent ? '当前' : '设为当前'}
                                  </button>
                                )}
                              </li>
                            )
                          })}
                        </ol>
                      )}
                      {!isTerminal && dish.current_step_no !== null && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleSetStep(dish.id, null)}
                        >
                          重置进度
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>

          {/* ---------- 放弃 ---------- */}
          {!isTerminal && (
            <div className="cooking-danger-zone">
              <button type="button" className="danger" disabled={busy} onClick={() => void handleAbandon()}>
                放弃本次烹饪
              </button>
              <span className="cooking-hint">放弃不会扣减任何库存。</span>
            </div>
          )}

          {/* ---------- 结算 ---------- */}
          {!isTerminal && detail.dishes.length > 0 && (
            <div className="cooking-settle">
              <h3>结算</h3>

              <button
                type="button"
                disabled={previewLoading || settling}
                onClick={() => void loadPreview()}
              >
                {previewLoading ? '加载中…' : '查看结算预览'}
              </button>

              {preview !== null && (
                <div className="cooking-preview">
                  <p className="cooking-preview-summary">
                    共 {preview.items.length} 项需求
                    {preview.needing_confirmation > 0
                      ? ` · ${preview.needing_confirmation} 项需要确认`
                      : ' · 无需额外确认'}
                  </p>

                  <table className="cooking-preview-table">
                    <thead>
                      <tr>
                        <th>食材</th>
                        <th>需求</th>
                        <th>可用</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.items.map((it, idx) => (
                        <tr key={`${it.dish_id}-${it.line_key ?? idx}`}>
                          <td>{it.definition_name}</td>
                          <td>
                            {it.required_quantity === null
                              ? '未指定'
                              : `${it.required_quantity} ${it.unit ?? ''}`}
                          </td>
                          <td>
                            {it.available_quantity} {it.unit ?? ''}
                          </td>
                          <td>
                            {it.required_reason !== null && !it.confirmed && (
                              <span className="cooking-need-confirm">
                                需确认：{REASON_LABEL[it.required_reason]}
                              </span>
                            )}
                            {it.required_reason !== null && it.confirmed && (
                              <span className="cooking-ok">已确认跳过</span>
                            )}
                            {it.required_reason === null && it.can_consume && (
                              <span className="cooking-ok">可扣减</span>
                            )}
                            {it.required_reason === null && !it.can_consume && (
                              <span className="cooking-bad">库存不足</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {preview.needing_confirmation > 0 && (
                    <div className="cooking-confirm-actions">
                      <p className="cooking-hint">
                        以下项目需要你明确确认后才能跳过。确认由后端记录。
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleConfirmAllRequired()}
                      >
                        确认全部必需跳过项（{preview.needing_confirmation}）
                      </button>
                    </div>
                  )}

                  <div className="cooking-settle-action">
                    <button
                      type="button"
                      className="primary"
                      disabled={!preview.ready || settling || busy || previewLoading}
                      onClick={() => void handleSettle()}
                    >
                      {settling ? '结算中…' : '确认并结算（扣减库存）'}
                    </button>
                    {!preview.ready && (
                      <span className="cooking-hint">
                        请先完成上述必需确认，或处理库存不足的项目。
                      </span>
                    )}
                    <span className="cooking-hint">
                      点击结算会先保存所有待提交的份数变更，并重新校验最新状态。
                    </span>
                  </div>
                </div>
              )}

              {settleResult !== null && (
                <div className="cooking-settle-result">
                  <h4>结算完成</h4>
                  <p>结算单号 #{settleResult.settlement_id}</p>
                  <ul>
                    {settleResult.items.map((it, idx) => (
                      <li key={`${it.dish_id}-${it.line_key ?? idx}`}>
                        {it.definition_name}：
                        {OUTCOME_LABEL[it.outcome] ?? it.outcome}
                        {it.consumed_quantity > 0 && ` ${it.consumed_quantity} ${it.unit ?? ''}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* ---------- 已有确认记录 ---------- */}
          <SkipSection
            sessionId={detail.id}
            dishes={detail.dishes}
            busy={busy}
            isTerminal={isTerminal}
            onDelete={(dishId, lineKey) => void handleDeleteSkip(dishId, lineKey)}
          />
        </>
      )}
    </section>
  )
}

/* ============================================================
 * 已有跳过确认列表（独立小组件，避免主组件过长）
 * ============================================================ */
function SkipSection({
  sessionId,
  dishes,
  busy,
  isTerminal,
  onDelete,
}: {
  sessionId: number
  dishes: CookingSessionDetail['dishes']
  busy: boolean
  isTerminal: boolean
  onDelete: (dishId: number, lineKey: string) => void
}) {
  const [records, setRecords] = useState<Array<{ dish_id: number; line_key: string; definition_name: string; reason: DishSkipReason }>>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listSkips(sessionId)
      setRecords(
        list.map((r) => ({
          dish_id: r.dish_id,
          line_key: r.line_key,
          definition_name: r.definition_name,
          reason: r.reason,
        })),
      )
    } catch {
      setRecords([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void reload()
  }, [reload, dishes])

  if (loading) return null
  if (records.length === 0) return null

  return (
    <div className="cooking-skips">
      <h3>已记录的跳过确认（{records.length}）</h3>
      <ul>
        {records.map((r) => (
          <li key={`${r.dish_id}-${r.line_key}`}>
            <span>{r.definition_name}</span>
            <span className="cooking-skip-reason">{REASON_LABEL[r.reason]}</span>
            {!isTerminal && (
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(r.dish_id, r.line_key)}
              >
                撤销
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** ISO 时间 → 本地简短显示 */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
