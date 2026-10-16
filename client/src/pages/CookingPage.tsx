import { useCallback, useEffect, useRef, useState } from 'react'

import {
  abandonSession,
  addDish,
  createSession,
  deleteSessions,
  deleteSkip,
  getSession,
  listSessions,
  listSkips,
  previewSettlement,
  removeDish,
  renameSession,
  saveSkips,
  settleSession,
  updateDishProgress,
  updateDishServings,
} from '../api/cooking'
import { listRecipes, getRecipe } from '../api/recipes'
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog'
import { ApiError } from '../types/api'
import type {
  CookingSessionDetail,
  CookingSessionStatus,
  CookingSessionSummary,
  DerivedSkipReason,
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
const REASON_LABEL: Record<DerivedSkipReason, string> = {
  null_quantity: '用量未指定（「适量」），无法计算扣减量',
  unit_mismatch: '库存中没有单位一致的记录，无法扣减',
  user_choice: '用户主动跳过',
  seasoning_presence:
    '调味品只记「有 / 无」，不按量扣减。已备好请确认跳过计量；家里缺少也可以确认省略',
}

/** 结算结果的标签 */
const OUTCOME_LABEL: Record<string, string> = {
  consumed: '已扣减',
  skipped_null_quantity: '跳过（用量未指定）',
  skipped_unit_mismatch: '跳过（单位不匹配）',
  skipped_user: '跳过（用户选择）',
  insufficient: '库存不足',
}

/**
 * 名称长度上限（v0.2.1.1）。
 *
 * ⚠️ **必须与后端保持一致**：后端为
 *    `cookingService.COOKING_SESSION_NAME_MAX_LENGTH`（同为 60），
 *    API 层 JSON Schema 的 `maxLength` 也是 60。改一处就要同步三处。
 */
const NAME_MAX_LENGTH = 60

/** 默认名称的渲染格式：`YYYY-MM-DD-HH:mm`（**用户本地时区**） */
function formatDefaultName(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/**
 * 记录在界面上显示的**最终名称**。
 *
 * - 已有自定义名称（`name !== null`）→ 直接显示（列表与详情一致）。
 * - 否则显示**默认名**：优先 `started_at`，无法解析时回退 `created_at`
 *   （均在本地时区）；两者都不可解析时回退 `#id`，**绝不显示空白**。
 *
 * ⚠️ 纯展示派生：不写库、不批量改写历史记录。
 */
function displaySessionName(s: {
  id: number
  name: string | null
  started_at: string
  created_at: string
}): string {
  if (s.name !== null && s.name.length > 0) return s.name
  return formatDefaultName(s.started_at) || formatDefaultName(s.created_at) || `#${s.id}`
}

interface CookingPageProps {
  /**
   * v0.2.2 整餐推荐：确认后**直达**该会话。
   *
   * `null`（默认）＝正常显示会话列表，既有行为完全不变。
   */
  initialSessionId?: number | null
}

export default function CookingPage({ initialSessionId = null }: CookingPageProps = {}) {
  /* ---------- 列表 ---------- */
  const [sessions, setSessions] = useState<CookingSessionSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  /* ---------- 多选与批量删除（v0.2.1.1）---------- */
  /** 已勾选的会话 id（选择范围＝当前已加载的列表） */
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [deleteOpen, setDeleteOpen] = useState(false)
  /** 全选框需要 ref 才能设置 indeterminate（半选态） */
  const selectAllRef = useRef<HTMLInputElement | null>(null)

  /* ---------- 行内改名（v0.2.1.1）---------- */
  /** 正在编辑的会话 id；null = 无 */
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  /**
   * 改名的**同步互斥锁**。
   *
   * ⚠️ 必须是 ref：React 的 `setState` 是异步的，只靠 `renameBusy` 挡不住
   *    「Enter 连按」「回车与保存按钮同一事件循环内先后触发」这类重复提交。
   *    与结算的 `settleLock` 同一套做法。
   */
  const renameLock = useRef(false)

  /**
   * 列表请求序号：丢弃**迟到响应**，避免旧请求覆盖新状态
   * （与详情视图的 `detailSeq` 同一套做法）。
   */
  const listSeq = useRef(0)

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
    const seq = ++listSeq.current
    setListLoading(true)
    setListError(null)
    try {
      const data = await listSessions()
      // ⚠️ 迟到响应直接丢弃：否则旧结果会覆盖刚改名 / 刚删除后的新状态
      if (seq !== listSeq.current) return
      setSessions(data)
    } catch (e) {
      if (seq !== listSeq.current) return
      setSessions([])
      setListError(e instanceof ApiError ? e.message : '加载烹饪会话失败，请稍后重试。')
    } finally {
      if (seq === listSeq.current) setListLoading(false)
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
   * 多选与批量删除（v0.2.1.1）
   * ------------------------------------------------------------
   * ⚠️ 接口 `GET /api/cooking/sessions` 当前**不分页**，
   *    因此「全选」的作用范围就是当前加载的全部记录。
   *    若将来引入分页或筛选，必须把选择范围限定在**当前可见集合**内，
   *    不得让「全选」跨页选中不可见记录。
   * ============================================================ */
  const selectableIds = sessions.map((s) => s.id)
  const selectedInView = selectedIds.filter((id) => selectableIds.includes(id))
  const selectedCount = selectedInView.length
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length
  const someSelected = selectedCount > 0 && !allSelected

  /**
   * 行级交互锁定：删除确认弹窗已打开，或改名正在提交。
   *
   * ⚠️ 锁定期间禁止「打开详情 / 勾选 / 开始编辑」，
   *    避免后台列表刷新或快捷键造成**重复提交**与**误开记录**。
   */
  const rowLocked = deleteOpen || renameBusy

  // 半选态只能通过 DOM 属性设置，原生 checkbox 没有对应的 JSX 属性
  useEffect(() => {
    if (selectAllRef.current !== null) {
      selectAllRef.current.indeterminate = someSelected
    }
  }, [someSelected])

  // ⚠️ 列表刷新后丢弃已不存在的 id，避免「已选 N 条」包含已被删除的记录
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = prev.filter((id) => sessions.some((s) => s.id === id))
      return next.length === prev.length ? prev : next
    })
  }, [sessions])

  function toggleOne(id: number, checked: boolean) {
    setSelectedIds((prev) =>
      checked ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((x) => x !== id),
    )
  }

  function toggleAll(checked: boolean) {
    // 全选/取消全选只作用于当前列表；取消全选即清空选择
    setSelectedIds(checked ? [...selectableIds] : [])
  }

  /**
   * 删除所选记录（单条与批量走**同一条**后端路径）。
   *
   * ⚠️ 失败时**必须让异常抛出**：由 ConfirmDeleteDialog 捕获并显示错误，
   *    且**不清除**选择状态，用户可以处理后重试 —— 绝不假装成功。
   */
  async function handleDeleteSelected() {
    const ids = [...selectedInView]
    if (ids.length === 0) return

    await deleteSessions(ids)

    setDeleteOpen(false)
    // 只移除已确认删除的 id；其余选择状态保留
    setSelectedIds((prev) => prev.filter((id) => !ids.includes(id)))
    await fetchSessions()
    setNotice(`已删除 ${ids.length} 条烹饪记录（仅清理记录，库存未变动）。`)
  }

  /* ============================================================
   * 行内改名（v0.2.1.1）
   * ============================================================ */

  /** 进入行内编辑（预填当前显示的名称作为编辑起点） */
  function startRename(s: CookingSessionSummary) {
    if (renameLock.current || deleteOpen) return
    setEditingId(s.id)
    setEditingValue(s.name ?? displaySessionName(s))
    setRenameError(null)
  }

  /** 取消编辑，丢弃未保存输入 */
  function cancelRename() {
    if (renameLock.current) return
    setEditingId(null)
    setEditingValue('')
    setRenameError(null)
  }

  /**
   * 提交改名。
   *
   * @param next `null` = **恢复默认名称**（后端写 NULL）；字符串 = 自定义名称
   *
   * ⚠️ `renameLock` 是**同步**互斥：Enter 连按 / 双击 / 「回车 + 点保存」
   *    同时触发时，只有第一个请求会真正发出。
   * ⚠️ 失败时**保留用户输入**（不退出编辑态）并就地提示，绝不假装成功。
   */
  async function submitRename(sessionId: number, next: string | null) {
    if (renameLock.current) return
    renameLock.current = true
    setRenameBusy(true)
    setRenameError(null)

    try {
      await renameSession(sessionId, next)
      setEditingId(null)
      setEditingValue('')
      await fetchSessions()
      setNotice(next === null ? '已恢复默认名称。' : `已重命名为「${next}」。`)
    } catch (e) {
      setRenameError(e instanceof ApiError ? e.message : '重命名失败，请稍后重试。')
    } finally {
      renameLock.current = false
      setRenameBusy(false)
    }
  }

  /**
   * 行内编辑的「保存」。
   *
   * ⚠️ 空 / 纯空白在**前端就拦下**并提示 —— 它与「恢复默认」（传 `null`）
   *    是两种不同意图，不能靠后端猜测。
   */
  async function handleRenameSave(sessionId: number) {
    const trimmed = editingValue.trim()
    if (trimmed.length === 0) {
      setRenameError('名称不能为空或纯空白。可点「恢复默认」使用默认名称。')
      return
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setRenameError(`名称过长：最多 ${NAME_MAX_LENGTH} 个字符。`)
      return
    }
    await submitRename(sessionId, trimmed)
  }

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
    // 进入详情前退出行内改名，避免编辑态残留在列表上
    setEditingId(null)
    setEditingValue('')
    setRenameError(null)

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

  /**
   * v0.2.2：推荐流程确认后**直达**新建的会话。
   *
   * ⚠️⚠️ 这里**刻意不做「只执行一次」的 ref 守卫** —— 原因是本组件另有一个
   *      「卸载时作废在途详情请求」的清理 effect（`detailSeq.current++`），
   *      而 React 18 StrictMode 在开发模式下会把挂载 effect 跑两次
   *      （挂载 → 清理 → 再挂载）：
   *
   *        1) 首次挂载 effect 发出 `openDetail`，拿到 seq = N，请求在途
   *        2) StrictMode 的**模拟卸载**触发清理 → detailSeq 变成 N+1
   *        3) 若这里用 ref 阻止第二次执行，就再没人发起加载
   *        4) 请求返回时 seq(N) !== current(N+1) → 结果被丢弃，
   *           `setDetailLoading(false)` 也不会执行
   *           ⇒ **页面永远停在「加载中…」**
   *
   *      因此这里让 effect 每次真正运行时都发起加载：后发的请求序号最新，
   *      自然胜出；被作废的旧响应照旧安全丢弃。生产环境无双重调用，
   *      行为不变。
   */
  useEffect(() => {
    if (initialSessionId === null) return
    void openDetail(initialSessionId)
  }, [initialSessionId, openDetail])

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
    // 回到列表时一并清理行内改名状态
    setEditingId(null)
    setEditingValue('')
    setRenameError(null)
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
        /**
         * ⚠️ v0.2.3（R2）：`seasoning_presence` 是**派生**原因，不能落库。
         *    必须使用后端给的 `confirm_reason`（调味品映射为既有的 `user_choice`）；
         *    只有用户**真实点击确认**才会走到这里。
         */
        reason: (it.confirm_reason ?? it.required_reason) as DishSkipReason,
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
      //
      // ⚠️ v0.2.3（R4）：`ready` 只表示「待确认项为 0」，**不代表库存充足**。
      //    展示预览之后库存可能被改动，因此这里必须**同时**检查 `stock_sufficient`，
      //    否则仍会发起一次**必然失败**的结算请求。
      if (!latest.ready) {
        setActionError(
          `结算条件尚未满足：仍有 ${latest.needing_confirmation} 项需要确认，请处理后重试。`,
        )
        return
      }
      if (!latest.stock_sufficient) {
        setActionError('当前库存不足，请补充库存或减少菜量后重试。')
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

        {notice !== null && (
          <p className="recipe-notice" role="status">
            {notice}
          </p>
        )}

        {!listLoading && listError === null && sessions.length > 0 && (
          <>
            <div className="cooking-session-toolbar">
              <label className="cooking-select-all">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  checked={allSelected}
                  disabled={rowLocked}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
                <span>全选</span>
              </label>

              {selectedCount > 0 && (
                <>
                  <span className="cooking-selected-count" role="status">
                    已选 {selectedCount} 条
                  </span>
                  <button
                    type="button"
                    className="danger"
                    disabled={renameBusy}
                    onClick={() => setDeleteOpen(true)}
                  >
                    删除选中
                  </button>
                </>
              )}
            </div>

            <ul className="cooking-session-list">
              {sessions.map((s) => {
                const checked = selectedIds.includes(s.id)
                const editing = editingId === s.id
                return (
                  <li
                    key={s.id}
                    className={`cooking-session-item${checked ? ' is-selected' : ''}`}
                  >
                    {/* ⚠️ 复选框、行、铅笔同为**并列兄弟节点**，不嵌套在按钮内，
                        因此勾选 / 改名都不会误触「打开详情」 */}
                    <input
                      type="checkbox"
                      className="cooking-session-checkbox"
                      checked={checked}
                      disabled={rowLocked}
                      onChange={(e) => toggleOne(s.id, e.target.checked)}
                      aria-label={`选择记录 ${displaySessionName(s)}`}
                    />

                    {editing ? (
                      <div className="cooking-session-rename">
                        <input
                          type="text"
                          className="cooking-rename-input"
                          value={editingValue}
                          maxLength={NAME_MAX_LENGTH}
                          disabled={renameBusy}
                          /* eslint-disable-next-line jsx-a11y/no-autofocus */
                          autoFocus
                          aria-label="记录名称"
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            /*
                             * ⚠️⚠️ 输入法（中文 / 日文等）**组合输入期间必须完全让路**
                             *
                             * 原因：
                             *   - 拼音选词确认会发送 **Enter**。若当成「保存」，
                             *     会把**未完成的候选**（或半截拼音）存成名称。
                             *   - **Esc** 可能只是关闭候选框，并不代表用户想取消编辑。
                             *
                             * 判据（任一成立即视为组合中）：
                             *   ① `nativeEvent.isComposing`（标准属性）
                             *   ② `keyCode === 229`（部分浏览器 / 输入法在
                             *      `compositionend` 之前给出的兼容值）
                             *
                             * 组合期间**直接返回**：不 `preventDefault`、
                             * 不提交、不取消，让输入法自己处理这次按键。
                             */
                            const native = e.nativeEvent
                            if (native.isComposing || native.keyCode === 229) return

                            if (e.key === 'Enter') {
                              e.preventDefault()
                              void handleRenameSave(s.id)
                            } else if (e.key === 'Escape') {
                              e.preventDefault()
                              cancelRename()
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="primary"
                          disabled={renameBusy}
                          onClick={() => void handleRenameSave(s.id)}
                        >
                          {renameBusy ? '保存中…' : '保存'}
                        </button>
                        <button type="button" disabled={renameBusy} onClick={cancelRename}>
                          取消
                        </button>
                        <button
                          type="button"
                          disabled={renameBusy}
                          onClick={() => void submitRename(s.id, null)}
                        >
                          恢复默认
                        </button>
                        {renameError !== null && (
                          <span className="field-error" role="alert">
                            {renameError}
                          </span>
                        )}
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="cooking-session-open"
                          disabled={rowLocked}
                          onClick={() => void openDetail(s.id)}
                        >
                          <span className="cooking-session-name">
                            {displaySessionName(s)}
                          </span>
                          <span className={`cooking-status cooking-status-${s.status}`}>
                            {STATUS_LABEL[s.status]}
                          </span>
                          <span className="cooking-session-meta">
                            #{s.id} · {s.dish_count} 道菜
                          </span>
                        </button>
                        <button
                          type="button"
                          className="cooking-session-rename-btn"
                          disabled={rowLocked}
                          title="重命名"
                          aria-label={`重命名记录 ${displaySessionName(s)}`}
                          onClick={() => startRename(s)}
                        >
                          ✏️
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </>
        )}

        {deleteOpen && (
          <ConfirmDeleteDialog
            title="删除烹饪记录"
            description={
              <>
                <p>
                  将删除选中的 <strong>{selectedCount}</strong> 条烹饪记录，并一并清理
                  其菜品、跳过确认与结算明细。
                </p>
                <p>
                  <strong>
                    本操作只清理历史记录：不会恢复库存，也不会撤销已扣减的数量。
                  </strong>
                </p>
                <p>未选中的记录、菜谱与食材均不受影响。此操作不可撤销。</p>
              </>
            }
            onConfirm={handleDeleteSelected}
            onCancel={() => setDeleteOpen(false)}
          />
        )}
      </section>
    )
  }

  /* ---------- 详情视图 ---------- */
  const isTerminal = detail !== null && TERMINAL.includes(detail.status)

  return (
    <section className="cooking-page">
      <div className="section-header">
        <h2>{detail !== null ? displaySessionName(detail) : `烹饪会话 #${detailId ?? ''}`}</h2>
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
                            {it.required_reason !== null && !it.confirmed ? (
                              <span className="cooking-need-confirm">
                                需确认：{REASON_LABEL[it.required_reason]}
                              </span>
                            ) : it.skipped ? (
                              <span className="cooking-ok">
                                {it.required_quantity === null
                                  ? '已跳过（用量未指定）'
                                  : '已跳过（不扣库存）'}
                              </span>
                            ) : it.can_consume ? (
                              <span className="cooking-ok">可扣减</span>
                            ) : (
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
                      disabled={
                        !preview.ready ||
                        !preview.stock_sufficient ||
                        settling ||
                        busy ||
                        previewLoading
                      }
                      onClick={() => void handleSettle()}
                    >
                      {settling ? '结算中…' : '确认并结算（扣减库存）'}
                    </button>
                    {!preview.ready && (
                      <span className="cooking-hint">请先完成上述必需确认。</span>
                    )}
                    {!preview.stock_sufficient && (
                      <span className="cooking-bad">当前库存不足，请补充库存或减少菜量。</span>
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
