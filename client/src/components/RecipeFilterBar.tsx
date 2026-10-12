import type {
  RecipeSortField,
  RecipeSortOrder,
  RecipeTagMode,
} from '../types/api'

/**
 * 菜谱列表工具栏。
 *
 * 布局（与产品确认的三行结构对应）：
 *
 *   第二行： [ 菜谱名称搜索框 ]              [ 排序字段 + 方向 ]
 *   第三行： [ 已选 Tag（可逐个移除） ]      [ 选择 Tag ] 按钮
 *
 * ⚠️ 与旧版的关键区别：
 *   1. **不再常驻展开全部 Tag** —— Tag 的选择移到独立的 `TagSelectDialog`
 *   2. 搜索框**只搜菜谱名称**（后端语义已同步变更，Tag 名称不参与搜索）
 *   3. 本组件**只产出用户选择**，不发起请求、不做过滤或排序计算
 *
 * ⚠️ 不复用库存的 `SortControls` —— 它的排序字段是库存专用
 *    （default / expiry / purchase_date / name / quantity），
 *    与菜谱字段（updated_at / created_at / name）完全不同。
 */

interface Props {
  /** 搜索词（受控） */
  search: string
  onSearchChange: (value: string) => void

  /** 已选 Tag 名称 */
  selectedTags: string[]
  /** 移除单个已选 Tag */
  onRemoveTag: (tagName: string) => void
  /** 打开 Tag 选择弹窗 */
  onOpenTagDialog: () => void

  /** Tag 筛选模式（仅用于展示，切换在弹窗内） */
  tagMode: RecipeTagMode

  /** 排序 */
  sortField: RecipeSortField
  sortOrder: RecipeSortOrder
  onSortChange: (field: RecipeSortField, order: RecipeSortOrder) => void

  /** 请求进行中时禁用交互 */
  disabled?: boolean
}

/** 排序字段的展示名与两方向文案 */
const SORT_META: Record<RecipeSortField, { label: string; asc: string; desc: string }> = {
  updated_at: { label: '最近修改时间', asc: '旧 → 新', desc: '新 → 旧' },
  created_at: { label: '创建时间', asc: '旧 → 新', desc: '新 → 旧' },
  name: { label: '菜谱名称', asc: 'A → Z', desc: 'Z → A' },
}

/** 切换排序字段时的默认方向（符合直觉） */
const DEFAULT_ORDER: Record<RecipeSortField, RecipeSortOrder> = {
  updated_at: 'desc', // 默认：最近修改倒序
  created_at: 'desc',
  name: 'asc',
}

const ALL_SORT_FIELDS: RecipeSortField[] = ['updated_at', 'created_at', 'name']

export default function RecipeFilterBar({
  search,
  onSearchChange,
  selectedTags,
  onRemoveTag,
  onOpenTagDialog,
  tagMode,
  sortField,
  sortOrder,
  onSortChange,
  disabled = false,
}: Props) {
  const meta = SORT_META[sortField]

  function handleFieldChange(next: RecipeSortField) {
    onSortChange(next, DEFAULT_ORDER[next])
  }

  function toggleOrder() {
    onSortChange(sortField, sortOrder === 'asc' ? 'desc' : 'asc')
  }

  return (
    <div className="recipe-toolbar">
      {/* ---------- 第二行：名称搜索 + 排序 ---------- */}
      <div className="recipe-toolbar-row recipe-toolbar-row-search">
        <input
          type="search"
          className="search-input recipe-search-input"
          placeholder="搜索菜谱名称"
          value={search}
          disabled={disabled}
          onChange={(e) => onSearchChange(e.target.value)}
          aria-label="搜索菜谱名称"
        />

        <div className="sort-controls">
          <label className="sort-field">
            排序
            <select
              value={sortField}
              disabled={disabled}
              onChange={(e) => handleFieldChange(e.target.value as RecipeSortField)}
            >
              {ALL_SORT_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {SORT_META[f].label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="sort-order-button"
            disabled={disabled}
            onClick={toggleOrder}
            title="切换排序方向"
          >
            {sortOrder === 'asc' ? meta.asc : meta.desc}
            <span className="sort-order-arrow">{sortOrder === 'asc' ? '↑' : '↓'}</span>
          </button>
        </div>
      </div>

      {/* ---------- 第三行：已选 Tag + 选择 Tag ---------- */}
      <div className="recipe-toolbar-row recipe-toolbar-row-tags">
        <div className="recipe-selected-tags">
          {selectedTags.length === 0 ? (
            <span className="recipe-selected-tags-empty">未筛选 Tag</span>
          ) : (
            <>
              <span className="recipe-selected-tags-mode">
                {tagMode === 'and' ? '全部满足' : '任一满足'}
              </span>
              {selectedTags.map((t) => (
                <span key={t} className="recipe-selected-tag">
                  {t}
                  <button
                    type="button"
                    className="recipe-selected-tag-remove"
                    disabled={disabled}
                    onClick={() => onRemoveTag(t)}
                    title={`移除 ${t}`}
                    aria-label={`移除 ${t}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </>
          )}
        </div>

        <button
          type="button"
          className="recipe-open-tag-dialog"
          disabled={disabled}
          onClick={onOpenTagDialog}
        >
          选择 Tag
          {selectedTags.length > 0 && (
            <span className="recipe-open-tag-dialog-count">{selectedTags.length}</span>
          )}
        </button>
      </div>
    </div>
  )
}
