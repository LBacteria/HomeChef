import { useCallback, useEffect, useRef, useState } from 'react'

import { deleteDefinition, listDefinitions } from '../api/definitions'
import { listCategories } from '../api/categories'
import { DefinitionEditor } from '../components/DefinitionEditor'
import DefinitionForm from '../components/DefinitionForm'
import CategoryFilter from '../components/CategoryFilter'
import { createDefinition } from '../api/definitions'
import type {
  Category,
  CreateDefinitionInput,
  DefinitionSortOrder,
  IngredientDefinitionDetail,
} from '../types/api'

/**
 * 食材库页面。
 *
 * 第 6 节：
 *   - 搜索（**后端 substring 匹配**，覆盖默认名称与别名）
 *   - 列表展示名称、别名、允许单位、预计保质期
 *   - 编辑入口（名称/别名/单位/保质期）
 *   - 删除定义（有库存时后端返回 409 HAS_STOCK）
 *
 * v0.1.2 Batch 3：
 *   - 名称排序（A → Z / Z → A），默认 A → Z
 *   - 排序由**后端**执行，前端只传参，不复制排序规则
 *   - 排序与搜索完全兼容（搜索结果同样按当前方向排序）
 *   - 不持久化排序偏好（刷新后回到 A → Z）
 */

interface Props {
  /** 定义发生变化时通知父组件（库存页需要最新的定义列表） */
  onDefinitionsChanged?: () => void
}

export default function DefinitionsPage({ onDefinitionsChanged }: Props) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<IngredientDefinitionDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /**
   * 名称排序方向。
   * ⚠️ 不持久化：刷新页面回到默认的 'asc'（A → Z）。
   */
  const [sortOrder, setSortOrder] = useState<DefinitionSortOrder>('asc')

  /**
   * 分类列表与当前筛选（v0.1.3）。
   * ⚠️ 与库存页共用同一套 category 数据（同一个 API）。
   */
  const [categories, setCategories] = useState<Category[]>([])
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [editing, setEditing] = useState<IngredientDefinitionDetail | null>(null)
  const [deleting, setDeleting] = useState<IngredientDefinitionDetail | null>(null)

  /** 用于丢弃过期的搜索响应，避免竞态 */
  const requestSeq = useRef(0)

  /** 加载分类列表（分类增删后需要刷新） */
  const loadCategories = useCallback(async () => {
    try {
      const list = await listCategories()
      setCategories(list)
      // 若当前选中的分类已被删除，回到「全部」
      setSelectedCategoryId((prev) =>
        prev !== null && !list.some((c) => c.id === prev) ? null : prev,
      )
    } catch {
      /* 分类加载失败不影响主列表 */
    }
  }, [])

  const load = useCallback(
    async (search: string, order: DefinitionSortOrder, categoryId: number | null) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setLoadError(null)

      try {
        // 搜索 + 分类筛选 + 排序三者由后端同时处理
        const data = await listDefinitions(search, order, categoryId)
        // 只接受最后一次请求的结果
        if (seq === requestSeq.current) {
          setItems(data)
        }
      } catch (error) {
        if (seq === requestSeq.current) {
          setLoadError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  useEffect(() => {
    void load(query, sortOrder, selectedCategoryId)
  }, [load, query, sortOrder, selectedCategoryId])

  const refresh = useCallback(async () => {
    await load(query, sortOrder, selectedCategoryId)
    await loadCategories()
    onDefinitionsChanged?.()
  }, [load, query, sortOrder, selectedCategoryId, loadCategories, onDefinitionsChanged])

  async function handleCreate(data: CreateDefinitionInput) {
    await createDefinition(data)
    setShowCreate(false)
    await refresh()
  }

  async function handleDelete(def: IngredientDefinitionDetail) {
    setActionError(null)
    try {
      await deleteDefinition(def.id)
      setDeleting(null)
      await refresh()
    } catch (error) {
      // 409 HAS_STOCK 等错误显示后端 message
      setActionError(error instanceof Error ? error.message : String(error))
      setDeleting(null)
    }
  }

  /** 分类 id → 显示名称（仅用于展示，不做业务判断） */
  function categoryName(categoryId: number | null): string | null {
    if (categoryId === null) return null
    return categories.find((c) => c.id === categoryId)?.name ?? null
  }

  return (
    <section>
      <div className="section-header">
        <h2>食材库</h2>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          + 添加食材
        </button>
      </div>

      <div className="with-category-filter">
        {/* 左侧：分类筛选（与库存页共用同一套 category 数据） */}
        <CategoryFilter
          categories={categories}
          selected={selectedCategoryId}
          onChange={setSelectedCategoryId}
        />

        {/* 右侧：搜索 + 排序 + 列表 */}
        <div className="with-category-filter-main">
          <input
            type="search"
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索食材（支持名称与别名）…"
          />

          {/* 名称排序：只提供 A → Z / Z → A 两种方向 */}
          <div className="sort-controls">
            <label className="sort-field">
              排序
              <select
                value={sortOrder}
                disabled={loading}
                onChange={(e) => setSortOrder(e.target.value as DefinitionSortOrder)}
              >
                <option value="asc">名称 A → Z</option>
                <option value="desc">名称 Z → A</option>
              </select>
            </label>
          </div>

          {actionError && (
            <div className="action-error">
              <p>{actionError}</p>
              <button type="button" onClick={() => setActionError(null)}>
                关闭
              </button>
            </div>
          )}

          {loading && <p className="status">加载中...</p>}

          {!loading && loadError && (
            <div className="load-error">
              <p>加载失败：{loadError}</p>
              <button
                type="button"
                onClick={() => void load(query, sortOrder, selectedCategoryId)}
              >
                重试
              </button>
            </div>
          )}

          {!loading && !loadError && items.length === 0 && (
            <div className="empty-state">
              <p>{query.trim().length > 0 ? '没有找到匹配的食材。' : '食材库还是空的。'}</p>
            </div>
          )}

          {!loading && !loadError && items.length > 0 && (
            <ul className="definition-list">
              {items.map((def) => (
                <li key={def.id} className="definition-item">
                  <div className="definition-main">
                    <h3 className="definition-name">
                      {def.name}
                      {categoryName(def.category_id) && (
                        <span className="category-tag">{categoryName(def.category_id)}</span>
                      )}
                    </h3>

                    {def.aliases.length > 0 && (
                      <p className="definition-meta">
                        别名：{def.aliases.map((a) => a.alias).join(' / ')}
                      </p>
                    )}

                    <p className="definition-meta">
                      可用单位：{def.allowed_units.join('、') || '（无，调味品无需单位）'}
                    </p>

                    <p className="definition-meta">
                      预计保质期：
                      {def.estimated_shelf_life_days === null
                        ? '未设置'
                        : `${def.estimated_shelf_life_days} 天`}
                    </p>
                  </div>

                  <div className="definition-actions">
                    <button type="button" onClick={() => setEditing(def)}>
                      编辑
                    </button>
                    <button type="button" className="danger" onClick={() => setDeleting(def)}>
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {showCreate && (
        <DefinitionForm
          categories={categories}
          onSubmit={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {editing && (
        <DefinitionEditor
          definition={editing}
          onChanged={async () => {
            await refresh()
            // 刷新后再取最新数据回填编辑器
            try {
              const fresh = await listDefinitions(query, sortOrder, selectedCategoryId)
              const found = fresh.find((d) => d.id === editing.id)
              if (found) setEditing(found)
            } catch {
              /* 忽略：主列表已显示错误 */
            }
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {deleting && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>删除食材</h2>
            <p>
              确定要删除「<strong>{deleting.name}</strong>」吗？
            </p>
            <p className="hint">
              只有该食材没有任何库存记录时才能删除。
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void handleDelete(deleting)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
