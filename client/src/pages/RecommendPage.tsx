import { useCallback, useEffect, useRef, useState } from 'react'

import { getMealPlans, applyMealPlan } from '../api/recommendation'
import { listPreferences, setPreference } from '../api/recipes'
import { getTagCategories, listTags } from '../api/tags'
import PreferenceButtons from '../components/PreferenceButtons'
import TagSelectDialog from '../components/TagSelectDialog'
import { ApiError } from '../types/api'
import type {
  MealPlanResult,
  RecipePreferenceValue,
  RecipeTagItem,
  RecipeTagMode,
  RecommendationDish,
  RecommendationPlan,
  RecommendationRequirement,
  TagCategoryDict,
} from '../types/api'

/**
 * v0.2.3 整餐推荐流程页。
 *
 * 流程：**人数 / 标签筛选 → 整餐候选（含评分分项解释）→ 核对 → 确认进入烹饪**
 *
 * 关键约束：
 *   - 后端是唯一权威：分数/需求/缺口/倍率/快照指纹全部来自服务端；
 *   - `plansSeq` 丢弃迟到响应，避免旧结果覆盖新选择；
 *   - `applyLock` 是**同步**互斥，防连点；
 *   - **确认页不再允许修改份数**：展示服务端倍率，避免"改了倍数但需求表还是旧值"；
 *   - **幂等**：一次「确认意图」固定一个 `request_id`，失败后手动重试沿用同一个 key；
 *   - v0.2.3：**标签筛选**与**单菜评价**都会改变推荐结果，
 *     因此任一变化后**立即作废旧方案**（并重新生成），
 *     绝不允许拿旧方案继续「确认进入烹饪」；
 *   - 卸载后**不再导航**；写操作**绝不自动重试**。
 */

const LEVEL_LABEL: Record<string, string> = {
  ready: '可做',
  nearly: '基本可做',
  missing: '缺料',
}

const STATUS_LABEL: Record<string, string> = {
  ok: '够用',
  insufficient: '不足',
  unit_mismatch: '单位不匹配',
  unknown_quantity: '用量未指定',
  /** 兼容旧数据；v0.2.4 起的响应不再出现 */
  seasoning_missing: '调味品自行准备',
  /** v0.2.4：中性提醒 —— 不计库存、不扣量 */
  seasoning_reminder: '调味品自行准备',
}

/** 菜品类型角色 → 中文（后端只给 code） */
const ROLE_LABEL: Record<string, string> = {
  staple: '主食',
  meat: '荤菜',
  vegetable: '素菜',
  mixed: '半荤半素',
  soup: '汤',
  cold: '凉菜',
  dessert: '甜点',
}

interface Props {
  onBack: () => void
  onApplied: (sessionId: number) => void
  onManual: () => void
}

type ApplyErrorKind = 'stale' | 'idem' | 'unknown' | 'other'

interface ApplyErrorState {
  kind: ApplyErrorKind
  message: string
}

function statusClass(r: RecommendationRequirement): string {
  if (r.status === 'ok') return 'rec-req rec-req-ok'
  if (r.status === 'unknown_quantity') return 'rec-req rec-req-unknown'
  if (r.status === 'seasoning_missing' || r.status === 'seasoning_reminder')
    return 'rec-req rec-req-seasoning'
  return 'rec-req rec-req-missing'
}

function fmtQty(n: number | null): string {
  if (n === null) return '—'
  return String(n)
}

function fmtPct(x: number): string {
  if (!Number.isFinite(x)) return '—'
  return `${Math.round(x * 100)}%`
}

/** 生成一次性幂等键（localhost 属安全上下文，randomUUID 可用） */
function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* 回退 */
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

export default function RecommendPage({ onBack, onApplied, onManual }: Props) {
  const [step, setStep] = useState<'people' | 'plans' | 'review'>('people')
  const [peopleInput, setPeopleInput] = useState('2')
  const [people, setPeople] = useState<number | null>(null)
  const [result, setResult] = useState<MealPlanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<RecommendationPlan | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<ApplyErrorState | null>(null)
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null)
  const [expandedScore, setExpandedScore] = useState<string | null>(null)
  const [expandedDish, setExpandedDish] = useState<number | null>(null)

  /* ---------- v0.2.3：标签筛选 ---------- */
  const [filterTags, setFilterTags] = useState<string[]>([])
  const [filterMode, setFilterMode] = useState<RecipeTagMode>('and')
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [tags, setTags] = useState<RecipeTagItem[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const [tagsError, setTagsError] = useState<string | null>(null)
  const [tagDict, setTagDict] = useState<TagCategoryDict | null>(null)

  /* ---------- v0.2.3：单菜评价 ---------- */
  const [preferences, setPreferences] = useState<Record<number, RecipePreferenceValue>>({})
  /**
   * v0.2.3：偏好是否**已成功加载**。
   *
   * ⚠️ 未加载成功时**禁止交互**：否则界面会把"未知"当成 `null`，
   *    用户点一下「取消评价」就可能覆盖掉真实的偏好。
   */
  const [prefReady, setPrefReady] = useState(false)
  /** 偏好**加载**失败原因（可见 + 可重试） */
  const [prefError, setPrefError] = useState<string | null>(null)
  /** 偏好**写入**失败原因（与加载失败分开，成功前保留原结果） */
  const [prefSaveError, setPrefSaveError] = useState<string | null>(null)
  /** 偏好写入在途（驱动界面禁用） */
  const [prefSaving, setPrefSaving] = useState(false)
  /** v0.2.3：分类字典加载失败原因（透传给 TagPicker，不静默归为未分类） */
  const [dictError, setDictError] = useState<string | null>(null)
  /** 因筛选 / 评价变化而使旧结果作废时的提示 */
  const [invalidNotice, setInvalidNotice] = useState<string | null>(null)

  const plansSeq = useRef(0)
  const applyLock = useRef(false)
  const mountedRef = useRef(true)
  /**
   * 当前「确认意图」的幂等键。
   *
   * ⚠️ 刻意**不**在每次重试时更换：网络结果不明时用同一个 key 重试，
   *    服务端会返回首次创建的那个会话，避免重复建会话。
   * ⚠️ 一旦请求成功、或确定是「快照过期 / key 复用冲突」，则作废并重新生成。
   */
  const requestIdRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      plansSeq.current++
    }
  }, [])

  /** 评价写入的**同步互斥锁**：从置位到释放之间禁止确认 apply / 换方案 */
  const prefWriteLock = useRef(false)

  /* ---------- 参考数据（标签字典 / 偏好）---------- */
  /** v0.2.3：加载分类字典；**失败必须可见可重试**，不能静默把所有标签归为未分类 */
  const loadTagDict = useCallback(async () => {
    setDictError(null)
    try {
      const dict = await getTagCategories()
      setTagDict(dict)
    } catch (e) {
      setTagDict(null)
      setDictError(e instanceof ApiError ? e.message : '加载分类字典失败')
    }
  }, [])

  /** v0.2.3：加载单菜偏好；失败时 `prefReady=false` → 评价控件禁用（未知 ≠ 无评价） */
  const loadPreferences = useCallback(async () => {
    setPrefError(null)
    try {
      const prefs = await listPreferences()
      const map: Record<number, RecipePreferenceValue> = {}
      for (const p of prefs) map[p.recipe_id] = p.value
      setPreferences(map)
      setPrefReady(true)
    } catch (e) {
      setPrefReady(false)
      setPrefError(e instanceof ApiError ? e.message : '加载评价状态失败')
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadRefs() {
      setTagsLoading(true)
      try {
        const list = await listTags()
        if (!cancelled) setTags(list)
      } catch (e) {
        if (!cancelled) setTagsError(e instanceof ApiError ? e.message : '加载 Tag 失败')
      } finally {
        if (!cancelled) setTagsLoading(false)
      }

      await loadTagDict()
      await loadPreferences()
    }

    void loadRefs()
    return () => {
      cancelled = true
    }
  }, [loadTagDict, loadPreferences])

  /**
   * 生成推荐。
   *
   * @param peopleOverride 显式人数（用于「评价变化后自动重新生成」）
   */
  async function handleGenerate(peopleOverride?: number) {
    const n = peopleOverride ?? Number(peopleInput)
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      setError('人数请填 1–12 之间的整数。')
      return
    }

    const seq = ++plansSeq.current
    setLoading(true)
    setError(null)
    setInvalidNotice(null)

    try {
      const data = await getMealPlans(n, filterTags, filterMode)
      if (seq !== plansSeq.current) return
      setPeople(n)
      setResult(data)
      setStep('plans')
      setSelected(null)
      setApplyError(null)
      requestIdRef.current = null
    } catch (e) {
      if (seq !== plansSeq.current) return
      setError(e instanceof ApiError ? e.message : '生成推荐失败，请稍后重试。')
    } finally {
      if (seq === plansSeq.current) setLoading(false)
    }
  }

  function choosePlan(plan: RecommendationPlan) {
    // ⚠️ 评价写入在途时禁止换方案：新方案会基于**尚未确认**的评价打分
    if (prefWriteLock.current) return
    setSelected(plan)
    setApplyError(null)
    setExpandedDish(null)
    // 换方案 = 新的确认意图 → 新的幂等键
    requestIdRef.current = null
    setStep('review')
  }

  /**
   * v0.2.3：筛选条件变化 → **旧结果立即作废**。
   *
   * ⚠️ 只改筛选不重算的话，用户会拿着「另一批菜谱算出来的快照」去确认，
   *    属于典型的误导；因此这里直接清空结果并要求重新生成。
   * ⚠️ 必须同时把 `plansSeq` 推高：让**在途的旧推荐请求**到期后自行作废，
   *    否则它返回后会覆盖掉刚清空的状态（完整失效语义，不依赖界面禁用）。
   */
  function invalidateForFilterChange(nextTags: string[], nextMode: RecipeTagMode) {
    plansSeq.current++
    setLoading(false)
    setFilterTags(nextTags)
    setFilterMode(nextMode)
    setResult(null)
    setSelected(null)
    setApplyError(null)
    setExpandedPlan(null)
    setExpandedScore(null)
    setExpandedDish(null)
    requestIdRef.current = null
    setStep('people')
    setInvalidNotice('标签筛选条件已改变，之前的推荐结果已作废，请重新生成。')
  }

  /**
   * v0.2.3：单菜评价写入。
   *
   * - 写入期间用**同步 ref 锁**保护整页：禁止确认 apply / 换方案
   *   （绝不能在评价还在保存时就创建"旧方案"的烹饪会话）；
   * - 成功 → 作废旧结果并**真正重新生成**；
   * - 失败 → **保留原结果**，只显示错误（写操作**不自动重试**）；
   * - 错误同时抛给 `PreferenceButtons`，按钮处也会显示一行错误。
   */
  async function handleDishPreference(recipeId: number, next: RecipePreferenceValue | null) {
    if (prefWriteLock.current || applyLock.current || !prefReady) return
    prefWriteLock.current = true
    setPrefSaving(true)
    setPrefSaveError(null)

    try {
      const res = await setPreference(recipeId, next)
      if (!mountedRef.current) return

      setPreferences((prev) => {
        const copy = { ...prev }
        if (res.value === null) delete copy[recipeId]
        else copy[recipeId] = res.value
        return copy
      })

      const currentPeople = people ?? Number(peopleInput)
      setResult(null)
      setSelected(null)
      setApplyError(null)
      setExpandedScore(null)
      setExpandedDish(null)
      requestIdRef.current = null
      setStep('people')
      setInvalidNotice('评价已更新：推荐排序会随之变化，已作废旧结果并重新生成。')
      void handleGenerate(currentPeople)
    } catch (e) {
      // ⚠️ 失败保留原结果与原评价状态，只报错；**不自动重试**
      setPrefSaveError(e instanceof ApiError ? e.message : '保存评价失败，请重试')
      throw e // 让按钮组件也显示错误
    } finally {
      prefWriteLock.current = false
      if (mountedRef.current) setPrefSaving(false)
    }
  }

  async function handleApply() {
    if (selected === null || people === null) return
    if (applyLock.current) return // ⚠️ 同步互斥：防连点
    // ⚠️ 评价还在保存时**禁止**创建会话：否则会按"旧评价"的方案落库
    if (prefWriteLock.current) return

    applyLock.current = true
    setApplying(true)
    setApplyError(null)

    if (requestIdRef.current === null) requestIdRef.current = newRequestId()
    const requestId = requestIdRef.current

    try {
      const res = await applyMealPlan(
        people,
        selected.dishes.map((d) => ({ recipe_id: d.recipe_id, servings: d.servings })),
        selected.snapshot_id,
        requestId,
      )
      if (!mountedRef.current) return // ⚠️ 卸载后不再导航
      requestIdRef.current = null
      onApplied(res.session_id)
    } catch (e) {
      if (!mountedRef.current) return

      if (e instanceof ApiError && e.code === 'SNAPSHOT_STALE') {
        requestIdRef.current = null
        setApplyError({ kind: 'stale', message: e.message })
      } else if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') {
        requestIdRef.current = null
        setApplyError({ kind: 'idem', message: e.message })
      } else if (e instanceof ApiError) {
        setApplyError({ kind: 'other', message: e.message })
      } else {
        setApplyError({
          kind: 'unknown',
          message:
            '结果暂未确认，你可以在当前页面点击「重试」，不会重复创建。' +
            '若已刷新或离开页面，请先到「烹饪记录」查看。',
        })
      }
    } finally {
      applyLock.current = false
      if (mountedRef.current) setApplying(false)
    }
  }

  /* ---------- 评分分项（可解释；后端算，前端只展示） ---------- */
  function renderScoreBreakdown(p: RecommendationPlan) {
    const b = p.score_breakdown
    return (
      <div className="rec-score-breakdown">
        <ul className="rec-score-lines">
          {b.ready_bonus > 0 && <li className="rec-good">库存全足奖励 +{b.ready_bonus}</li>}
          <li>满足比例 {fmtPct(p.summary.coverage)} → +{b.coverage}</li>
          <li>
            库存利用率 {fmtPct(p.summary.utilization)}（不浪费加分）→ +{b.utilization}
          </li>
          {p.summary.expiring_ratio > 0 && (
            <li className="rec-good">
              临期食材可消耗 {fmtPct(p.summary.expiring_ratio)} → +{b.expiring}
            </li>
          )}
          {b.structure !== 0 && (
            <li>
              菜品搭配（{p.summary.dish_roles.map((r) => ROLE_LABEL[r] ?? r).join('、')}）→{' '}
              {b.structure > 0 ? '+' : ''}
              {b.structure}
            </li>
          )}
          {b.shared > 0 && <li>共享食材加分 → +{b.shared}</li>}
          <li>食材多样性 → +{b.diversity}</li>
          {b.missing_penalty > 0 && (
            <li className="rec-warn">缺 {p.summary.main_missing_count} 项主料 → −{b.missing_penalty}</li>
          )}
          {b.seasoning_penalty > 0 && (
            <li className="rec-warn">缺调味品 → −{b.seasoning_penalty}</li>
          )}
          {b.unknown_penalty > 0 && (
            <li className="rec-warn">用量未指定 → −{b.unknown_penalty}</li>
          )}
          <li className="rec-score-subtotal">库存侧小计 {b.stock_total}</li>
          <li>
            历史（最近做过会降权）：<strong>{b.history}</strong>
          </li>
          <li>
            我的评价（喜欢 +40 / 不喜欢 −80）：<strong>{b.preference}</strong>
          </li>
          <li>
            每日轮换 / 重复组合：<strong>{b.rotation}</strong>
          </li>
          <li className="rec-score-total">合计 {b.total}</li>
        </ul>
        <p className="rec-muted">
          分数只影响**展示顺序**：库存等级（可做 / 基本可做 / 缺料）永远优先，
          评价与历史不会把缺料方案顶到前面。
        </p>
      </div>
    )
  }

  /* ---------- 人数 + 标签筛选 ---------- */
  if (step === 'people') {
    return (
      <section className="rec-page">
        <div className="section-header">
          <h2>今天做几人份？</h2>
          <button type="button" onClick={onBack}>
            ← 返回主页
          </button>
        </div>

        <p className="rec-lead">
          HomeChef 会按人数和现有库存，挑出几套能直接开做的整餐。
          可以先按标签缩小范围（例如只看「快手菜」）。
        </p>

        <div className="rec-people-picks">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              type="button"
              className={peopleInput === String(n) ? 'rec-people-chip active' : 'rec-people-chip'}
              onClick={() => setPeopleInput(String(n))}
            >
              {n} 人
            </button>
          ))}
        </div>

        <label className="rec-people-input">
          <span>人数</span>
          <input
            type="number"
            min={1}
            max={12}
            value={peopleInput}
            onChange={(e) => setPeopleInput(e.target.value)}
          />
          <span className="rec-muted">1–12</span>
        </label>

        {/* ---------- v0.2.3：标签筛选 ---------- */}
        <div className="rec-filter-block">
          <div className="rec-filter-head">
            <span className="field-label">标签筛选（可选）</span>
            <button type="button" onClick={() => setTagDialogOpen(true)} disabled={loading}>
              选择标签
              {filterTags.length > 0 && (
                <span className="recipe-open-tag-dialog-count">{filterTags.length}</span>
              )}
            </button>
          </div>
          {filterTags.length === 0 ? (
            <p className="rec-muted">未筛选标签，将在全部菜谱里搭配。</p>
          ) : (
            <div className="rec-filter-tags">
              <span className="recipe-selected-tags-mode">
                {filterMode === 'and' ? '全部满足' : '任一满足'}
              </span>
              {filterTags.map((t) => (
                <span key={t} className="recipe-selected-tag">
                  {t}
                  <button
                    type="button"
                    className="recipe-selected-tag-remove"
                    aria-label={`移除 ${t}`}
                    disabled={loading}
                    onClick={() =>
                      invalidateForFilterChange(
                        filterTags.filter((x) => x !== t),
                        filterMode,
                      )
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="rec-filter-clear"
                disabled={loading}
                onClick={() => invalidateForFilterChange([], filterMode)}
              >
                清空筛选
              </button>
            </div>
          )}
        </div>

        {invalidNotice !== null && <p className="rec-notice">{invalidNotice}</p>}
        {error !== null && <p className="form-error">{error}</p>}

        <div className="rec-actions">
          <button type="button" className="primary" disabled={loading} onClick={() => void handleGenerate()}>
            {loading ? '正在搭配…' : '生成整餐推荐'}
          </button>
          <button type="button" onClick={onManual} disabled={loading}>
            手动选菜
          </button>
        </div>

        <TagSelectDialog
          open={tagDialogOpen}
          allTags={tags}
          dict={tagDict}
          selectedTags={filterTags}
          tagMode={filterMode}
          loadingTags={tagsLoading}
          tagsError={tagsError}
          dictError={dictError}
          onRetryDict={() => void loadTagDict()}
          onReloadTags={() => {
            setTagsError(null)
            void listTags()
              .then((list) => setTags(list))
              .catch((e) => setTagsError(e instanceof ApiError ? e.message : '加载 Tag 失败'))
          }}
          onCancel={() => setTagDialogOpen(false)}
          onConfirm={(nextTags, nextMode) => {
            setTagDialogOpen(false)
            invalidateForFilterChange(nextTags, nextMode)
          }}
        />
      </section>
    )
  }

  /* ---------- 候选方案 ---------- */
  if (step === 'plans') {
    const plans = result?.plans ?? []
    return (
      <section className="rec-page">
        <div className="section-header">
          <h2>{people} 人份 · 推荐方案</h2>
          <button type="button" onClick={() => setStep('people')}>
            ← 改人数 / 筛选
          </button>
        </div>

        {result !== null && result.tag_filter.tags.length > 0 && (
          <p className="rec-muted">
            已按标签筛选：{result.tag_filter.tags.join('、')}（
            {result.tag_filter.tag_mode === 'and' ? '全部满足' : '任一满足'}），
            命中菜谱 {result.tag_filter.matched_recipe_count} 个。
          </p>
        )}

        {result !== null && result.notes.length > 0 && (
          <ul className="rec-notes">
            {result.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}

        {plans.length === 0 && (
          <div className="rec-empty">
            <p>还没有能推荐的整餐。</p>
            <p className="rec-muted">
              换个标签筛选，或先到「菜谱」里建几个带配料的菜谱、在「库存」里补一些食材。
            </p>
            <div className="rec-actions">
              <button type="button" onClick={() => setStep('people')}>
                改标签筛选
              </button>
              <button type="button" onClick={onManual}>
                手动选菜
              </button>
              <button type="button" onClick={onBack}>
                返回主页
              </button>
            </div>
          </div>
        )}

        <ul className="rec-plan-list">
          {plans.map((p) => {
            const open = expandedPlan === p.plan_id
            const scoreOpen = expandedScore === p.plan_id
            return (
              <li key={p.plan_id} className={`rec-plan rec-plan-${p.level}`}>
                <div className="rec-plan-head">
                  <span className={`rec-badge rec-badge-${p.level}`}>{LEVEL_LABEL[p.level]}</span>
                  {/* v0.2.4：主菜先展示并加标签；其余按后端顺序（配菜） */}
                  <span className="rec-plan-dishes">
                    {p.dishes.map((d, i) => (
                      <span key={d.recipe_id}>
                        {i > 0 && ' + '}
                        {d.role_in_meal === 'main' ? (
                          <strong className="rec-main-dish">
                            {d.recipe_name}
                            <span className="rec-role-tag rec-role-main">主菜</span>
                          </strong>
                        ) : (
                          <span>
                            {d.recipe_name}
                            <span className="rec-role-tag rec-role-side rec-role-tag-compact">
                              配菜
                            </span>
                          </span>
                        )}
                      </span>
                    ))}
                  </span>
                  <span className="rec-plan-score">得分 {p.score}</span>
                </div>

                <ul className="rec-reasons">
                  {p.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>

                <div className="rec-plan-meta">
                  {p.summary.required_count > 0 && (
                    <span>
                      食材 {p.summary.satisfied_count}/{p.summary.required_count} 项够用
                    </span>
                  )}
                  {p.summary.utilization > 0 && (
                    <span>库存利用 {fmtPct(p.summary.utilization)}</span>
                  )}
                  {p.summary.main_missing_count > 0 && (
                    <span className="rec-warn">缺 {p.summary.main_missing_count} 项</span>
                  )}
                  {p.summary.unknown_count > 0 && (
                    <span className="rec-warn">用量未指定 {p.summary.unknown_count} 项</span>
                  )}
                  {p.summary.expiring_used_count > 0 && (
                    <span className="rec-good">用到临期 {p.summary.expiring_used_count} 项</span>
                  )}
                  {p.signals.cooked_recently.length > 0 && (
                    <span className="rec-muted">
                      最近做过 {p.signals.cooked_recently.length} 道
                    </span>
                  )}
                  {p.signals.disliked.length > 0 && (
                    <span className="rec-muted">含 {p.signals.disliked.length} 道不喜欢的菜</span>
                  )}
                </div>

                {/* v0.2.3：缺口清晰列出（不足方案必须标明） */}
                {p.shortages.length > 0 && (
                  <ul className="rec-shortages">
                    {p.shortages.map((s) => (
                      <li key={`${s.definition_id}-${s.unit ?? 'n'}`}>
                        缺口：{s.definition_name}
                        {s.missing_quantity !== null
                          ? ` 还差 ${fmtQty(s.missing_quantity)}${s.unit !== null ? ` ${s.unit}` : ''}`
                          : '（单位不匹配，不换算）'}
                        {s.is_seasoning ? '（调味品）' : ''}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="rec-plan-actions">
                  <button type="button" className="primary" onClick={() => choosePlan(p)}>
                    选这套
                  </button>
                  <button type="button" onClick={() => setExpandedPlan(open ? null : p.plan_id)}>
                    {open ? '收起食材' : '查看合并食材'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setExpandedScore(scoreOpen ? null : p.plan_id)}
                    aria-expanded={scoreOpen}
                  >
                    {scoreOpen ? '收起评分依据' : '评分依据'}
                  </button>
                </div>

                {scoreOpen && renderScoreBreakdown(p)}

                {open && (
                  <ul className="rec-req-list">
                    {p.requirements.map((r) => (
                      <li key={`${r.definition_id}-${r.unit ?? 'n'}`} className={statusClass(r)}>
                        <span className="rec-req-name">{r.definition_name}</span>
                        <span className="rec-req-num">
                          {fmtQty(r.required_quantity)}
                          {r.unit !== null ? ` ${r.unit}` : ''}
                          {r.available_quantity > 0 ? ` / 有 ${r.available_quantity}` : ''}
                        </span>
                        <span className="rec-req-status">{STATUS_LABEL[r.status]}</span>
                        <span className="rec-req-note">{r.note}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>

        {plans.length > 0 && (
          <div className="rec-actions">
            <button type="button" disabled={loading} onClick={() => void handleGenerate()}>
              {loading ? '正在重新生成…' : '按当前筛选重新生成'}
            </button>
            <button type="button" onClick={onManual}>
              换个方式：手动选菜
            </button>
          </div>
        )}
      </section>
    )
  }

  /* ---------- 核对 → 进入烹饪 ---------- */
  const plan = selected!
  const multiplier = result?.multiplier ?? 1
  const missing = plan.requirements.filter(
    (r) => r.status === 'insufficient' || r.status === 'unit_mismatch',
  )

  return (
    <section className="rec-page">
      <div className="section-header">
        <h2>核对这套整餐</h2>
        <button type="button" onClick={() => setStep('plans')} disabled={applying}>
          ← 换一套
        </button>
      </div>

      <div className="rec-review-block">
        <h3>菜品与份量</h3>
        <p className="rec-muted">
          默认每张菜谱按 {result?.base_servings ?? 2} 人份估算；本次 {people} 人，每道菜做 {multiplier} 倍量。
          进入烹饪后可逐道调整份量。
        </p>

        {/* v0.2.3：评价状态未就绪时必须明说，并且禁用交互（未知 ≠ 无评价） */}
        {prefError !== null && (
          <div className="load-error">
            <p>评价状态加载失败：{prefError}</p>
            <button type="button" onClick={() => void loadPreferences()}>
              重试
            </button>
          </div>
        )}
        {prefError === null && !prefReady && <p className="rec-muted">评价状态加载中…（加载完成前不能修改评价）</p>}
        {prefSaveError !== null && (
          <p className="rec-alert rec-alert-error">保存评价失败：{prefSaveError}（原推荐结果保持不变）</p>
        )}
        <ul className="rec-dish-list">
          {plan.dishes.map((d) => {
            const open = expandedDish === d.recipe_id
            return (
              <li key={d.recipe_id} className="rec-dish-item">
                <div className="rec-dish-row">
                  {/* v0.2.4：角色由后端给出，前端不猜 */}
                  <span className={`rec-role-tag rec-role-${d.role_in_meal}`}>
                    {d.role_in_meal === 'main' ? '主菜' : '配菜'}
                  </span>
                  <span className="rec-dish-name">{d.recipe_name}</span>
                  <span className="rec-muted">{d.servings} 倍量</span>
                  <button
                    type="button"
                    onClick={() => setExpandedDish(open ? null : d.recipe_id)}
                  >
                    {open ? '收起详情' : '查看详情'}
                  </button>
                </div>

                {/* v0.2.3：每道菜都能评价；评价后会重新生成推荐 */}
                <PreferenceButtons
                  compact
                  value={preferences[d.recipe_id] ?? null}
                  disabled={applying || prefSaving || !prefReady}
                  onSet={(next) => handleDishPreference(d.recipe_id, next)}
                />

                {open && (
                  <div className="rec-dish-detail">
                    <h4>配料（已按 {d.servings} 倍量换算）</h4>
                    <ul className="rec-dish-ing">
                      {d.ingredients.map((ing, i) => (
                        <li key={i}>
                          <span className="rec-dish-ing-name">
                            {ing.definition_name}
                            {ing.is_seasoning ? '（调味品）' : ''}
                          </span>
                          <span className="rec-dish-ing-qty">
                            {ing.quantity === null
                              ? '用量未指定'
                              : `${fmtQty(ing.quantity)}${ing.unit !== null ? ` ${ing.unit}` : ''}`}
                          </span>
                          {ing.note !== null && ing.note !== '' && (
                            <span className="rec-muted">{ing.note}</span>
                          )}
                        </li>
                      ))}
                    </ul>

                    <h4>步骤</h4>
                    {d.steps.length === 0 ? (
                      <p className="rec-muted">这个菜谱还没有步骤。</p>
                    ) : (
                      <ol className="rec-dish-steps">
                        {d.steps.map((s) => (
                          <li key={s.step_no}>{s.content}</li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>

      <div className="rec-review-block">
        <h3>整餐合并需求（同食材同单位已合并，不重复占用库存）</h3>
        <ul className="rec-req-list">
          {plan.requirements.map((r) => (
            <li key={`${r.definition_id}-${r.unit ?? 'n'}`} className={statusClass(r)}>
              <span className="rec-req-name">{r.definition_name}</span>
              <span className="rec-req-num">
                {fmtQty(r.required_quantity)}
                {r.unit !== null ? ` ${r.unit}` : ''}
                {r.available_quantity > 0 ? ` / 有 ${r.available_quantity}` : ''}
              </span>
              <span className="rec-req-status">{STATUS_LABEL[r.status]}</span>
              <span className="rec-req-note">{r.note}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rec-review-block">
        <h3>这套的评分依据</h3>
        {renderScoreBreakdown(plan)}
      </div>

      {/* v0.2.3：缺口逐项列出，不再只给一个数字 */}
      {plan.shortages.length > 0 && (
        <div className="rec-review-block">
          <h3>缺口清单（{plan.shortages.length} 项）</h3>
          <ul className="rec-shortages">
            {plan.shortages.map((s) => (
              <li key={`${s.definition_id}-${s.unit ?? 'n'}`}>
                {s.definition_name}：{s.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {missing.length > 0 && (
        <p className="rec-alert">
          这套菜还缺 {missing.length} 项食材。仍可开始烹饪，缺的部分到结算时会逐项确认。
        </p>
      )}
      {plan.summary.unknown_count > 0 && (
        <p className="rec-alert">
          有 {plan.summary.unknown_count} 项用量未指定（如「适量」），结算时需要你逐项确认。
        </p>
      )}
      {(() => {
        /**
         * v0.2.4：调味品只做中性提醒 —— 不计库存、不扣量、不影响能否开做。
         * ⚠️ 不根据库存说「有 / 没有」。
         */
        const reminders = plan.requirements.filter((r) => r.status === 'seasoning_reminder')
        if (reminders.length === 0) return null
        return (
          <p className="rec-note">
            调味品 {reminders.length} 项（{reminders.slice(0, 4).map((r) => r.definition_name).join('、')}
            ）请自行准备：不计库存、也不扣量。
          </p>
        )
      })()}

      {applyError !== null && (
        <div className="rec-alert rec-alert-error">
          <p>{applyError.message}</p>
          {applyError.kind === 'unknown' && (
            <div className="rec-actions">
              <button type="button" onClick={onManual} disabled={applying}>
                去查看烹饪记录
              </button>
            </div>
          )}
          {(applyError.kind === 'stale' || applyError.kind === 'idem') && (
            <div className="rec-actions">
              <button
                type="button"
                onClick={() => {
                  void handleGenerate()
                }}
                disabled={applying}
              >
                返回重新生成
              </button>
            </div>
          )}
        </div>
      )}

      <div className="rec-actions">
        <button
          type="button"
          className="primary"
          disabled={
            applying ||
            prefSaving ||
            applyError?.kind === 'stale' ||
            applyError?.kind === 'idem'
          }
          onClick={() => void handleApply()}
        >
          {applying ? '正在创建烹饪会话…' : applyError !== null ? '重试' : '确认，开始烹饪'}
        </button>
        <button type="button" disabled={applying} onClick={() => setStep('plans')}>
          再看看
        </button>
      </div>
      <p className="rec-muted">
        查看推荐不会改动库存；完成烹饪并确认结算后才会扣减。
      </p>
    </section>
  )
}

/** 供上层复用的类型导出 */
export type { RecommendationDish }
