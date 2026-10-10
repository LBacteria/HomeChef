import { useCallback, useEffect, useState } from 'react'

import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategoryColor,
} from '../api/categories'
import CategoryColorPicker from './CategoryColorPicker'
import type { Category } from '../types/api'

/**
 * 分类管理 Modal（v0.1.3 / v0.1.4）。
 *
 * ⚠️ 在**当前 React App 内**显示，不使用 window.open / 新标签页。
 *
 * 功能：
 *   - 列出全部分类（内置 + 自定义，同一套数据）
 *   - **每个分类单独配置颜色**（v0.1.4，浏览器原生颜色选择器）
 *   - 新建分类（小 Dialog）
 *   - 删除分类（二次确认）
 *   - 列表可滚动，不会让页面无限变长
 *
 * ⚠️ 修改颜色只改 color 字段，不影响名称、顺序、删除等操作。
 * ⚠️ 删除保护：仍有食材引用时后端返回 409，前端只显示后端 message。
 */

interface Props {
  onClose: () => void
  /** 分类发生增删时通知父组件（食材库/库存需要刷新筛选列表） */
  onChanged?: () => void
}

export default function CategoryManagerModal({ onClose, onChanged }: Props) {
  const [items, setItems] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const [showCreate, setShowCreate] = useState(false)
  const [deleting, setDeleting] = useState<Category | null>(null)

  /** 正在保存颜色的分类 id（v0.1.4）；null 表示空闲 */
  const [savingColorId, setSavingColorId] = useState<number | null>(null)

  /**
   * 正在编辑颜色的分类 id 与草稿颜色（v0.1.4 补充修复）。
   *
   * ⚠️ 面板打开期间只是**草稿**，只有点「保存」才提交到后端。
   *    这样拖动色相条不会产生大量请求，也不会误保存。
   */
  const [editingColorId, setEditingColorId] = useState<number | null>(null)
  const [draftColor, setDraftColor] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      setItems(await listCategories())
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Escape 关闭（遵循现有 Modal 习惯） */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // 有子弹窗时先关子弹窗
        if (deleting) setDeleting(null)
        else if (showCreate) setShowCreate(false)
        else onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [deleting, showCreate, onClose])

  async function handleCreate(name: string) {
    await createCategory(name)
    setShowCreate(false)
    await load()
    onChanged?.()
  }

  async function handleDelete(category: Category) {
    setActionError(null)
    try {
      await deleteCategory(category.id)
      setDeleting(null)
      await load()
      onChanged?.()
    } catch (error) {
      // 409 CATEGORY_IN_USE → 显示后端 message
      setActionError(error instanceof Error ? error.message : String(error))
      setDeleting(null)
    }
  }

  /**
   * 打开某分类的颜色面板（草稿 = 当前颜色）。
   */
  function openColorPicker(category: Category) {
    setActionError(null)
    setEditingColorId(category.id)
    setDraftColor(category.color)
  }

  /** 取消编辑颜色（不提交） */
  function cancelColorPicker() {
    setEditingColorId(null)
    setDraftColor('')
  }

  /**
   * 保存分类颜色（v0.1.4 补充修复）。
   *
   * ⚠️ 只有用户点「保存」才会调用，提交的是草稿颜色。
   *    后端只改 color 字段，不影响名称、顺序与食材关联。
   */
  async function saveColor(category: Category) {
    setActionError(null)
    setSavingColorId(category.id)
    try {
      await updateCategoryColor(category.id, draftColor)
      setEditingColorId(null)
      setDraftColor('')
      await load()
      onChanged?.()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingColorId(null)
    }
  }

  return (
    <>
      <div className="modal-backdrop">
        <div className="modal category-modal">
          <div className="modal-title-row">
            <h2>分类管理</h2>
            <button type="button" className="modal-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
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
              <button type="button" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}

          {!loading && !loadError && (
            <>
              <ul className="category-list">
                {items.map((c) => {
                  const editing = editingColorId === c.id
                  return (
                    <li key={c.id} className="category-item-wrapper">
                      <div className="category-item">
                        <span className="category-item-main">
                          <span
                            className="category-color-dot"
                            style={{ backgroundColor: c.color }}
                            aria-hidden="true"
                          />
                          <span className="category-name">{c.name}</span>
                        </span>

                        <span className="category-item-actions">
                          <button
                            type="button"
                            className={editing ? 'color-toggle active' : 'color-toggle'}
                            onClick={() => (editing ? cancelColorPicker() : openColorPicker(c))}
                            aria-expanded={editing}
                            title="设置该分类的颜色"
                          >
                            颜色
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => setDeleting(c)}
                          >
                            删除
                          </button>
                        </span>
                      </div>

                      {/* 内嵌颜色选择器：页面内展示，点击色相条/颜色区/HEX 均不会关闭 */}
                      {editing && (
                        <div className="color-panel-wrapper">
                          <CategoryColorPicker
                            color={draftColor}
                            onChange={setDraftColor}
                            disabled={savingColorId === c.id}
                          />

                          <div className="color-panel-actions">
                            <button
                              type="button"
                              onClick={cancelColorPicker}
                              disabled={savingColorId === c.id}
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              className="primary"
                              onClick={() => void saveColor(c)}
                              disabled={savingColorId === c.id}
                            >
                              {savingColorId === c.id ? '保存中…' : '保存颜色'}
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>

              <button
                type="button"
                className="category-add"
                onClick={() => setShowCreate(true)}
              >
                ＋ 新建分类
              </button>
            </>
          )}

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>

      {/* 新建分类 */}
      {showCreate && (
        <CreateCategoryDialog
          onCancel={() => setShowCreate(false)}
          onSubmit={handleCreate}
        />
      )}

      {/* 删除确认 */}
      {deleting && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>删除分类</h2>
            <p>
              确定要删除「<strong>{deleting.name}</strong>」吗？
            </p>
            <p className="hint">只有该分类下没有任何食材时才能删除。</p>
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
    </>
  )
}

/* ============================================================
 * 新建分类小 Dialog
 * ============================================================ */

function CreateCategoryDialog({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    // 前端只做基础校验（空值）；重名等由后端判断
    if (name.trim().length === 0) {
      setError('分类名称不能为空')
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      await onSubmit(name.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>新建分类</h2>
        <form onSubmit={handleSubmit} noValidate>
          <label>
            分类名称
            <input
              type="text"
              value={name}
              autoFocus
              disabled={submitting}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：咖啡"
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" onClick={onCancel} disabled={submitting}>
              取消
            </button>
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? '创建中…' : '创建'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
