import type { Category } from '../types/api'

/**
 * 分类筛选侧栏（v0.1.3）。
 *
 * ⚠️ 食材库与库存页**共用同一个组件与同一套 category 数据**，
 *    不创建第二套分类概念。
 *
 * 行为：
 *   - 「全部」表示不筛选
 *   - 点击分类只显示该分类
 *   - 与搜索 / 排序并行工作（本组件只负责产出选中的 category id）
 */

interface Props {
  categories: Category[]
  /** 当前选中的分类 id；null 表示「全部」 */
  selected: number | null
  onChange: (categoryId: number | null) => void
  /** 分类数量统计，用于在名称后显示条数（可选） */
  counts?: Map<number, number>
}

export default function CategoryFilter({ categories, selected, onChange, counts }: Props) {
  return (
    <nav className="category-filter" aria-label="分类筛选">
      <button
        type="button"
        className={selected === null ? 'category-filter-item active' : 'category-filter-item'}
        onClick={() => onChange(null)}
      >
        全部
      </button>

      {categories.map((c) => {
        const n = counts?.get(c.id)
        return (
          <button
            key={c.id}
            type="button"
            className={selected === c.id ? 'category-filter-item active' : 'category-filter-item'}
            onClick={() => onChange(c.id)}
          >
            {c.name}
            {n !== undefined && <span className="category-filter-count">{n}</span>}
          </button>
        )
      })}
    </nav>
  )
}
