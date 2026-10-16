import { useEffect, useRef, useState } from 'react'

import { applyMealPlan, getMealPlans } from '../api/recommendation'
import { ApiError } from '../types/api'
import type {
  MealPlanResult,
  RecommendationDish,
  RecommendationPlan,
  RecommendationRequirement,
} from '../types/api'

/**
 * v0.2.2 整餐推荐流程页。
 *
 * 流程：**人数 → 整餐候选 → 核对（合并食材 / 缺口 / 理由 / 每道菜详情）→ 确认进入烹饪**
 *
 * 关键约束：
 *   - 后端是唯一权威：分数/需求/缺口/倍率/快照指纹全部来自服务端；
 *   - `plansSeq` 丢弃迟到响应，避免旧结果覆盖新选择；
 *   - `applyLock` 是**同步**互斥，防连点；
 *   - **确认页不再允许修改份数**（条目⑧）：展示服务端倍率，避免"改了倍数但
 *     需求表还是旧值"的误导；进入既有烹饪页后仍可逐道调整份数；
 *   - **幂等**（条目⑩）：一次「确认意图」固定一个 `request_id`，失败后手动
 *     重试沿用同一个 key；服务端同 key 同 payload 返回同一会话；
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
  seasoning_missing: '缺调味品',
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
  if (r.status === 'seasoning_missing') return 'rec-req rec-req-seasoning'
  return 'rec-req rec-req-missing'
}

function fmtQty(n: number | null): string {
  if (n === null) return '—'
  return String(n)
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
  const [expandedDish, setExpandedDish] = useState<number | null>(null)

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

  async function handleGenerate() {
    const n = Number(peopleInput)
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      setError('人数请填 1–12 之间的整数。')
      return
    }

    const seq = ++plansSeq.current
    setLoading(true)
    setError(null)

    try {
      const data = await getMealPlans(n)
      if (seq !== plansSeq.current) return
      setPeople(n)
      setResult(data)
      setStep('plans')
    } catch (e) {
      if (seq !== plansSeq.current) return
      setError(e instanceof ApiError ? e.message : '生成推荐失败，请稍后重试。')
    } finally {
      if (seq === plansSeq.current) setLoading(false)
    }
  }

  function choosePlan(plan: RecommendationPlan) {
    setSelected(plan)
    setApplyError(null)
    setExpandedDish(null)
    // 换方案 = 新的确认意图 → 新的幂等键
    requestIdRef.current = null
    setStep('review')
  }

  async function handleApply() {
    if (selected === null || people === null) return
    if (applyLock.current) return // ⚠️ 同步互斥：防连点

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
        // 菜谱/库存/设置变了 → key 作废，必须重新生成后再确认
        requestIdRef.current = null
        setApplyError({ kind: 'stale', message: e.message })
      } else if (e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT') {
        requestIdRef.current = null
        setApplyError({ kind: 'idem', message: e.message })
      } else if (e instanceof ApiError) {
        setApplyError({ kind: 'other', message: e.message })
      } else {
        // ⚠️ 网络结果**不明**：服务端可能已经建好了会话。
        //    保留同一个 request_id，并引导用户先查看烹饪记录。
        setApplyError({
          kind: 'unknown',
          message:
            '网络请求的结果不确定，服务端可能已经创建了会话。请先到「烹饪 / 烹饪记录」里确认；' +
            '若确实没有，可在服务未重启的情况下点击「重试」。若服务重启过，请先核对记录，避免重复创建。',
        })
      }
    } finally {
      applyLock.current = false
      if (mountedRef.current) setApplying(false)
    }
  }

  /* ---------- 人数 ---------- */
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

        {error !== null && <p className="form-error">{error}</p>}

        <div className="rec-actions">
          <button type="button" className="primary" disabled={loading} onClick={() => void handleGenerate()}>
            {loading ? '正在搭配…' : '生成整餐推荐'}
          </button>
          <button type="button" onClick={onManual} disabled={loading}>
            手动选菜
          </button>
        </div>
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
            ← 改人数
          </button>
        </div>

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
            <p className="rec-muted">先到「菜谱」里建几个带配料的菜谱，或在「库存」里补一些食材。</p>
            <div className="rec-actions">
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
            return (
              <li key={p.plan_id} className={`rec-plan rec-plan-${p.level}`}>
                <div className="rec-plan-head">
                  <span className={`rec-badge rec-badge-${p.level}`}>{LEVEL_LABEL[p.level]}</span>
                  <span className="rec-plan-dishes">
                    {p.dishes.map((d) => d.recipe_name).join(' + ')}
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
                  {p.summary.main_missing_count > 0 && (
                    <span className="rec-warn">缺 {p.summary.main_missing_count} 项</span>
                  )}
                  {p.summary.unknown_count > 0 && (
                    <span className="rec-warn">用量未指定 {p.summary.unknown_count} 项</span>
                  )}
                  {p.summary.expiring_used_count > 0 && (
                    <span className="rec-good">用到临期 {p.summary.expiring_used_count} 项</span>
                  )}
                </div>

                <div className="rec-plan-actions">
                  <button type="button" className="primary" onClick={() => choosePlan(p)}>
                    选这套
                  </button>
                  <button type="button" onClick={() => setExpandedPlan(open ? null : p.plan_id)}>
                    {open ? '收起食材' : '查看合并食材'}
                  </button>
                </div>

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
        <ul className="rec-dish-list">
          {plan.dishes.map((d) => {
            const open = expandedDish === d.recipe_id
            return (
              <li key={d.recipe_id} className="rec-dish-item">
                <div className="rec-dish-row">
                  <span className="rec-dish-name">{d.recipe_name}</span>
                  <span className="rec-muted">{d.servings} 倍量</span>
                  <button
                    type="button"
                    onClick={() => setExpandedDish(open ? null : d.recipe_id)}
                  >
                    {open ? '收起详情' : '查看详情'}
                  </button>
                </div>

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
      {plan.summary.seasoning_missing_count > 0 && (
        <p className="rec-alert">缺 {plan.summary.seasoning_missing_count} 项调味品，可按家里情况自行处理。</p>
      )}

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
              <button type="button" onClick={() => { setSelected(null); setResult(null); setApplyError(null); setStep('people'); void handleGenerate() }} disabled={applying}>
                返回重新生成
              </button>
            </div>
          )}
        </div>
      )}

      <div className="rec-actions">
        <button type="button" className="primary" disabled={applying || applyError?.kind === 'stale' || applyError?.kind === 'idem'} onClick={() => void handleApply()}>
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
