import type { RecipeSummary } from '../types/api'

/**
 * 菜谱列表。
 *
 * 展示：名称、Tag、菜谱整体备注。
 *
 * ⚠️ 不显示当前库存数量（产品规则：本阶段不做库存联动）。
 * ⚠️ 本组件**只负责渲染**，不含任何请求、筛选或排序逻辑。
 */

interface Props {
  recipes: RecipeSummary[]
  /** 点击某条菜谱（阶段 4.3 用于进入详情；当前阶段仍会触发但页面不跳转） */
  onSelect: (recipe: RecipeSummary) => void
}

export default function RecipeList({ recipes, onSelect }: Props) {
  return (
    <ul className="recipe-list">
      {recipes.map((r) => (
        <li key={r.id} className="recipe-item">
          <button
            type="button"
            className="recipe-item-main"
            onClick={() => onSelect(r)}
          >
            <div className="recipe-item-header">
              <span className="recipe-item-name">{r.name}</span>

              {r.tags.length > 0 && (
                <span className="recipe-item-tags">
                  {r.tags.map((t) => (
                    <span key={t} className="recipe-tag-badge">
                      {t}
                    </span>
                  ))}
                </span>
              )}
            </div>

            {r.note !== null && r.note.length > 0 && (
              <p className="recipe-item-note">{r.note}</p>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
