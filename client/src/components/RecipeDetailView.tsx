import type { RecipeDetail } from '../types/api'

/**
 * 菜谱详情视图（批次 4 剩余功能）。
 *
 * 展示**真实持久化数据**（由父组件从 `GET /api/recipes/:id` 取得）：
 * 名称、描述、Tag、食材（名称 / 数量 / 单位 / 备注 / 顺序）。
 *
 * 关键约定：
 *   - 只读展示，**不修改任何数据**；编辑与删除交由父组件处理
 *   - 空数据（无描述 / 无食材 / 无 Tag）必须给出明确提示，而不是留白
 *   - 食材**重复是合法的**（同一食材可多次出现），因此 key 使用
 *     `sort_order + 下标`，**不使用** `recipe_ingredient.id`
 *     （后端统一保存会重建关联行，id 不稳定）
 */

interface Props {
  detail: RecipeDetail
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

export default function RecipeDetailView({ detail, onBack, onEdit, onDelete }: Props) {
  const hasNote = detail.note !== null && detail.note.trim().length > 0

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

      {/* ---------- 描述 ---------- */}
      <section className="recipe-detail-section">
        <h3>描述</h3>
        {hasNote ? (
          <p className="recipe-detail-note">{detail.note}</p>
        ) : (
          <p className="recipe-detail-empty">（无描述）</p>
        )}
      </section>

      {/* ---------- Tag ---------- */}
      <section className="recipe-detail-section">
        <h3>Tag</h3>
        {detail.tags.length > 0 ? (
          <div className="recipe-detail-tags">
            {detail.tags.map((t) => (
              <span key={t} className="recipe-tag-badge">
                {t}
              </span>
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
