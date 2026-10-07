import { useCallback, useEffect, useState } from 'react'

import { createCategory, deleteCategory, listCategories } from '../api/categories'
import type { Category } from '../types/api'

/**
 * 分类管理 Modal（v0.1.3）。
 *
 * ⚠️ 在**当前 React App 内**显示，不使用 window.open / 新标签页。
 *
 * 功能：
 *   - 列出全部分类（内置 + 自定义，同一套数据）
 *   - 新建分类（小 Dialog）
 *   - 删除分类（二次确认）
 *   - 列表可滚动，不会让页面无限变长
 *
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
                {items.map((c) => (
                  <li key={c.id} className="category-item">
                    <span className="category-name">{c.name}</span>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setDeleting(c)}
                    >
                      删除
                    </button>
                  </li>
                ))}
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
