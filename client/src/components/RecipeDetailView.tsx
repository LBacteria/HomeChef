import { useMemo } from 'react'

import PreferenceButtons from './PreferenceButtons'
import type {
  RecipeDetail,
  RecipePreferenceValue,
  RecipeTagItem,
  TagCategoryDict,
} from '../types/api'

/**
 * 菜谱详情视图（批次 4 剩余功能；v0.2.3 增补单菜偏好与分类标签展示）。
 *
 * 展示**真实持久化数据**（由父组件从 `GET /api/recipes/:id` 取得）：
 * 名称、描述、Tag、食材（名称 / 数量 / 单位 / 备注 / 顺序）、烹饪步骤。
 *
 * v0.2.3 增补：
 *   - **喜欢 / 不喜欢 / 取消**：只针对这一道菜谱，落库失败必须明确报错；
 *   - Tag 按五大分类分组展示（分组标题来自后端字典）。
 *
 * 关键约定：
 *   - 展示为主，**不修改任何数据**；编辑与删除交由父组件处理
 *   - 空数据（无描述 / 无食材 / 无 Tag）必须给出明确提示，而不是留白
 *   - 食材**重复是合法的**（同一食材可多次出现），因此 key 使用
 *     `sort_order + 下标`，**不使用** `recipe_ingredient.id`
 *     （后端统一保存会重建关联行，id 不稳定）
 */

interface Props {
  detail: RecipeDetail
  /** v0.2.3：当前偏好（null = 无评价） */
  preference?: RecipePreferenceValue | null
  /**
   * v0.2.3：偏好状态是否**已成功加载**。
   *
   * ⚠️ 未加载成功时**禁止交互**：否则界面会把"未知"当成 null，
   *    用户点一下「取消评价」就可能覆盖掉真实的偏好。
   */
  preferenceReady?: boolean
  /** v0.2.3：偏好加载失败的原因（非 null 时显示错误与重试） */
  preferenceError?: string | null
  /** v0.2.3：重试加载偏好 */
  onRetryPreference?: () => void
  /** v0.2.3：写入偏好；null = 取消 */
  onSetPreference?: (next: RecipePreferenceValue | null) => Promise<void>
  /** v0.2.3：全部标签（用于把详情的标签名称映射回分类） */
  allTags?: RecipeTagItem[]
  /** v0.2.3：分类字典（分组标题与顺序来自后端） */
  tagDict?: TagCategoryDict | null
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
}

/** 数量 + 单位的展示（两者都可能为空） */
function formatAmount(quantity: number | null, unit: string | null): string {
  if (quantity === null && unit === null) return '未填写'
  if (quantity === null) return unit ?? '未填写'
  if (unit === null) return String(quantity)
  return `${quantity} ${unit}`
}

export default function RecipeDetailView({
  detail,
  preference = null,
  preferenceReady = true,
  preferenceError = null,
  onRetryPreference,
  onSetPreference,
  allTags = [],
  tagDict = null,
  onBack,
  onEdit,
  onDelete,
}: Props) {
  const hasNote = detail.note !== null && detail.note.trim().length > 0

  /**
   * 标签按分类分组（只展示**有标签**的分组）。
   *
   * ⚠️ 详情接口只返回标签**名称**，因此这里用父级传来的 `allTags`
   *    把名称映射回分类；分组标题与顺序仍来自**后端字典**。
   */
  const tagGroups = useMemo(() => {
    const categoryByName = new Map(allTags.map((t) => [t.name, t.category]))
    const known = new Set<string>()
    const out: Array<{ key: string; label: string; names: string[] }> = []

    for (const c of tagDict?.categories ?? []) {
      const names = detail.tags.filter((n) => categoryByName.get(n) === c.code)
      for (const n of names) known.add(n)
      out.push({ key: c.code, label: c.label, names })
    }
    out.push({
      key: 'unclassified',
      label: tagDict?.unclassified.label ?? '未分类',
      names: detail.tags.filter((n) => !known.has(n)),
    })
    return out.filter((g) => g.names.length > 0)
  }, [allTags, tagDict, detail.tags])

  return (
    <div className="recipe-detail">
      {/* ---------- 头部：返回 + 操作 ---------- */}
      <div className="recipe-detail-header">
        <button type="button" className="recipe-detail-back" onClick={onBack}>
          ← 返回列表
        </button>
        <div className="recipe-detail-actions">
          <button type="button" onClick={onEdit}>
            编辑
          </button>
          <button type="button" className="danger" onClick={onDelete}>
            删除
          </button>
        </div>
      </div>

      {/* ---------- 名称 ---------- */}
      <h2 className="recipe-detail-name">{detail.name}</h2>

      {/* ---------- v0.2.3：单菜偏好（喜欢 / 不喜欢 / 取消） ---------- */}
      {onSetPreference && (
        <section className="recipe-detail-section recipe-detail-pref">
          <h3>我的评价</h3>

          {preferenceError !== null ? (
            <div className="load-error">
              <p>评价状态加载失败：{preferenceError}</p>
              {onRetryPreference && (
                <button type="button" onClick={onRetryPreference}>
                  重试
                </button>
              )}
            </div>
          ) : !preferenceReady ? (
            <>
              {/* ⚠️ 状态未知时禁用交互，避免把"未知"当作"无评价"覆盖真实偏好 */}
              <PreferenceButtons value={preference} onSet={onSetPreference} disabled />
              <p className="rec-muted">评价状态加载中…</p>
            </>
          ) : (
            <PreferenceButtons value={preference} onSet={onSetPreference} />
          )}

          <p className="rec-muted">
            只影响推荐时的排序权重：喜欢会软加权，不喜欢会软降权，
            <strong>都不会把这道菜从推荐里排除</strong>。
          </p>
        </section>
      )}

      {/* ---------- 描述 ---------- */}
      <section className="recipe-detail-section">
        <h3>描述</h3>
        {hasNote ? (
          <p className="recipe-detail-note">{detail.note}</p>
        ) : (
          <p className="recipe-detail-empty">（无描述）</p>
        )}
      </section>

      {/* ---------- Tag（v0.2.3：按五大分类分组） ---------- */}
      <section className="recipe-detail-section">
        <h3>Tag</h3>
        {detail.tags.length > 0 ? (
          <div className="recipe-detail-tag-groups">
            {tagGroups.map((g) => (
              <div key={g.key} className="recipe-detail-tag-group">
                <span className="recipe-detail-tag-group-label">{g.label}</span>
                <div className="recipe-detail-tags">
                  {g.names.map((t) => (
                    <span key={t} className="recipe-tag-badge">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="recipe-detail-empty">（无 Tag）</p>
        )}
      </section>

      {/* ---------- 食材 ---------- */}
      <section className="recipe-detail-section">
        <h3>食材（{detail.ingredients.length}）</h3>
        {detail.ingredients.length > 0 ? (
          <ul className="recipe-detail-ingredients">
            {detail.ingredients.map((ing, index) => (
              // ⚠️ 不使用 ing.id：统一保存会重建关联行，id 不稳定
              <li key={`${ing.sort_order}-${ing.definition_id}-${index}`} className="recipe-detail-ingredient">
                <span className="recipe-detail-ing-index">{index + 1}</span>
                <span className="recipe-detail-ing-name">{ing.definition_name}</span>
                <span className="recipe-detail-ing-amount">
                  {formatAmount(ing.quantity, ing.unit)}
                </span>
                {ing.note !== null && ing.note.trim().length > 0 && (
                  <span className="recipe-detail-ing-note">{ing.note}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="recipe-detail-empty">（无食材）</p>
        )}
      </section>

      {/* 烹饪步骤（v0.2.1） */}
      <section className="recipe-detail-section">
        <h3>步骤（{detail.steps.length}）</h3>
        {detail.steps.length > 0 ? (
          <ol className="recipe-detail-steps">
            {detail.steps.map((s) => (
              // ⚠️ 用 step_no 作 key：统一保存会重建步骤行，id 不稳定
              <li key={s.step_no} className="recipe-detail-step">
                <span className="recipe-detail-step-no">{s.step_no}</span>
                <span className="recipe-detail-step-text">{s.content}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="recipe-detail-empty">（无步骤）</p>
        )}
      </section>
    </div>
  )
}
