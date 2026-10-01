import { formatQuantityWithUnit, isExpired } from '../format'
import type { Ingredient } from '../types/ingredient'

/**
 * 单个食材卡片。
 *
 * 只负责展示与触发操作，不含业务逻辑。
 */

interface Props {
  ingredient: Ingredient
  onEdit: (ingredient: Ingredient) => void
  onConsume: (ingredient: Ingredient) => void
  onDelete: (ingredient: Ingredient) => void
}

export default function IngredientCard({ ingredient, onEdit, onConsume, onDelete }: Props) {
  const expired = isExpired(ingredient.expiry_date)

  return (
    <li className={expired ? 'card expired' : 'card'}>
      <div className="card-main">
        <h3 className="card-name">{ingredient.name}</h3>

        <p className="card-quantity">
          {formatQuantityWithUnit(ingredient.quantity, ingredient.unit)}
        </p>

        {ingredient.purchase_date && (
          <p className="card-meta">购买日期：{ingredient.purchase_date}</p>
        )}

        {ingredient.expiry_date && (
          <p className={expired ? 'card-meta expired-text' : 'card-meta'}>
            有效期：{ingredient.expiry_date}
            {expired && <span className="expired-badge">已过期</span>}
          </p>
        )}

        {ingredient.note && <p className="card-meta">备注：{ingredient.note}</p>}
      </div>

      <div className="card-actions">
        <button type="button" onClick={() => onEdit(ingredient)}>
          编辑
        </button>
        <button type="button" onClick={() => onConsume(ingredient)}>
          消耗
        </button>
        <button type="button" className="danger" onClick={() => onDelete(ingredient)}>
          删除
        </button>
      </div>
    </li>
  )
}
