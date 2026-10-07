import type { SortField, SortOrder } from '../types/api'

/**
 * 库存排序控件。
 *
 * ⚠️ 只负责**选择**排序方式，实际排序由后端完成。
 *    组件不包含任何排序算法。
 */

interface Props {
  field: SortField
  order: SortOrder
  onChange: (field: SortField, order: SortOrder) => void
  disabled?: boolean
}

/** 每个排序字段的展示名与两个方向的中文说明 */
interface FieldMeta {
  label: string
  /** asc 方向的文案（null 表示该字段不支持方向切换） */
  ascLabel: string | null
  descLabel: string | null
}

const FIELD_META: Record<SortField, FieldMeta> = {
  default: {
    label: '默认',
    ascLabel: null,
    descLabel: null,
  },
  expiry: {
    label: '保质期剩余时间',
    ascLabel: '短 → 长',
    descLabel: '长 → 短',
  },
  purchase_date: {
    label: '入库日期',
    ascLabel: '旧 → 新',
    descLabel: '新 → 旧',
  },
  name: {
    label: '食材名称',
    ascLabel: 'A → Z',
    descLabel: 'Z → A',
  },
  quantity: {
    label: '数量',
    ascLabel: '少 → 多',
    descLabel: '多 → 少',
  },
}

/** 选中某字段时的默认方向（符合直觉） */
const DEFAULT_ORDER: Record<SortField, SortOrder> = {
  default: 'asc',
  expiry: 'asc', // 短 → 长
  purchase_date: 'desc', // 新 → 旧
  name: 'asc', // A → Z
  quantity: 'desc', // 多 → 少
}

const ALL_FIELDS: SortField[] = ['default', 'expiry', 'purchase_date', 'name', 'quantity']

export default function SortControls({ field, order, onChange, disabled = false }: Props) {
  const meta = FIELD_META[field]
  const supportsDirection = meta.ascLabel !== null

  function handleFieldChange(next: SortField) {
    // 切换字段时使用该字段的默认方向
    onChange(next, DEFAULT_ORDER[next])
  }

  function toggleOrder() {
    onChange(field, order === 'asc' ? 'desc' : 'asc')
  }

  return (
    <div className="sort-controls">
      <label className="sort-field">
        排序
        <select
          value={field}
          disabled={disabled}
          onChange={(e) => handleFieldChange(e.target.value as SortField)}
        >
          {ALL_FIELDS.map((f) => (
            <option key={f} value={f}>
              {FIELD_META[f].label}
            </option>
          ))}
        </select>
      </label>

      {supportsDirection && (
        <button
          type="button"
          className="sort-order-button"
          disabled={disabled}
          onClick={toggleOrder}
          title="切换排序方向"
        >
          {order === 'asc' ? meta.ascLabel : meta.descLabel}
          <span className="sort-order-arrow">{order === 'asc' ? '↑' : '↓'}</span>
        </button>
      )}
    </div>
  )
}
