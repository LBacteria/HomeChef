import { useMemo, useRef, useState } from 'react'

import { createTag, deleteTag, updateTag } from '../api/tags'
import { ApiError } from '../types/api'
import type { RecipeTagCategoryCode, RecipeTagItem, TagCategoryDict } from '../types/api'

/**
 * v0.2.3 标签管理弹窗：**五分类分组**下的完整增 / 改 / 删。
 *
 * 规则（与后端一致）：
 *   - 分类固定五类 + 「未分类」；标题与顺序来自后端字典，前端不写死；
 *   - 系统预设与自定义 Tag **同等可改可删**；
 *   - 名称**跨分类全局唯一**，同名由后端 409 拒绝并明确提示；
 *   - 删除**只解除菜谱关联，绝不删除菜谱**；删除前展示被多少菜谱使用并要求确认；
 *   - 改名 / 删除后通过 `onRenamed` / `onDeleted` 通知父级**同步筛选条件**，
 *     否则列表会筛到一个已不存在的旧名（表现为空列表或重新保存时复活旧名）。
 *
 * ⚠️ 失败一律明确提示，绝不假装成功（界面以服务端返回为准）。
 */

interface Props {
  open: boolean
  allTags: RecipeTagItem[]
  dict: TagCategoryDict | null
  onClose: () => void
  /** 任一变更成功后：父级重新拉取 Tag 列表（返回值忽略） */
  onReload: () => Promise<unknown> | void
  onRenamed: (oldName: string, newName: string) => void
  onDeleted: (name: string) => void
}

interface RowState {
  name: string
  category: RecipeTagCategoryCode | ''
}

export default function TagManagerModal({
  open,
  allTags,
  dict,
  onClose,
  onReload,
  onRenamed,
  onDeleted,
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [row, setRow] = useState<RowState>({ name: '', category: '' })
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<RecipeTagItem | null>(null)

  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<RecipeTagCategoryCode | ''>('')
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * ⚠️ 写操作**同步互斥锁**（与 `applyLock` / `submittingRef` 同一模式）：
   *    `setBusyId` 要等重渲染才生效，同一事件循环内的连点会发出两个请求。
   */
  const lockRef = useRef(false)

  const groups = useMemo(() => {
    const known = new Set<string>()
    const out: Array<{ key: string; label: string; tags: RecipeTagItem[] }> = []
    for (const c of dict?.categories ?? []) {
      const tags = allTags.filter((t) => t.category === c.code)
      for (const t of tags) known.add(t.name)
      out.push({ key: c.code, label: c.label, tags })
    }
    out.push({
      key: 'unclassified',
      label: dict?.unclassified.label ?? '未分类',
      tags: allTags.filter((t) => !known.has(t.name)),
    })
    return out
  }, [allTags, dict])

  if (!open) return null

  /**
   * ⚠️ 全局忙碌标志：任何一次写操作（创建 / 改名 / 改分类 / 删除）在途时，
   *    禁止切换编辑行、关闭弹窗或再次新建 —— 否则会出现
   *    「上一次保存还没回来、界面已经切到另一行」的状态错乱。
   */
  const anyBusy = busyId !== null || creating

  function startEdit(t: RecipeTagItem) {
    if (anyBusy) return
    setEditingId(t.id)
    setRow({ name: t.name, category: (t.category ?? '') as RecipeTagCategoryCode | '' })
    setError(null)
    setNotice(null)
  }

  async function handleSaveEdit(t: RecipeTagItem) {
    if (lockRef.current) return
    const name = row.name.trim()
    if (name.length === 0) {
      setError('Tag 名称不能为空')
      return
    }
    if (name.length > 60) {
      setError('Tag 名称最长 60 个字符')
      return
    }
    lockRef.current = true
    setBusyId(t.id)
    setError(null)
    try {
      const nextCategory = row.category === '' ? null : row.category
      const nameChanged = name !== t.name
      const categoryChanged = nextCategory !== t.category
      if (!nameChanged && !categoryChanged) {
        setEditingId(null)
        return
      }
      await updateTag(t.id, {
        ...(nameChanged ? { name } : {}),
        ...(categoryChanged ? { category: nextCategory } : {}),
      })
      await onReload()
      if (nameChanged) onRenamed(t.name, name)
      setNotice(`已更新「${name}」。`)
      setEditingId(null)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_NAME') {
        setError('该 Tag 名称已存在（名称跨分类全局唯一）')
      } else {
        setError(e instanceof ApiError ? e.message : '更新 Tag 失败，请重试')
      }
    } finally {
      lockRef.current = false
      setBusyId(null)
    }
  }

  async function handleDelete(t: RecipeTagItem) {
    if (lockRef.current) return
    lockRef.current = true
    setBusyId(t.id)
    setError(null)
    try {
      await deleteTag(t.id)
      await onReload()
      onDeleted(t.name)
      setConfirmDelete(null)
      setNotice(`已删除「${t.name}」，相关菜谱本身未受影响。`)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '删除 Tag 失败，请重试')
    } finally {
      lockRef.current = false
      setBusyId(null)
    }
  }

  async function handleCreate() {
    if (lockRef.current) return
    const name = newName.trim()
    if (name.length === 0) {
      setError('Tag 名称不能为空')
      return
    }
    if (name.length > 60) {
      setError('Tag 名称最长 60 个字符')
      return
    }
    lockRef.current = true
    setCreating(true)
    setError(null)
    try {
      await createTag(name, newCategory === '' ? null : newCategory)
      await onReload()
      setNewName('')
      setNotice(`已新建「${name}」。`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_NAME') {
        setError('该 Tag 名称已存在')
      } else {
        setError(e instanceof ApiError ? e.message : '新建 Tag 失败，请重试')
      }
    } finally {
      lockRef.current = false
      setCreating(false)
    }
  }

  return (
    <div
      className="modal-backdrop tag-manager-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="标签管理"
    >
      <div className="modal tag-manager">
        <div className="tag-manager-head">
          <h2>标签管理</h2>
          <button type="button" disabled={anyBusy} onClick={onClose}>
            关闭
          </button>
        </div>

        <p className="rec-muted">
          系统预设与自定义标签都可以改名、改分类、删除。删除只会解除与菜谱的关联，
          <strong>不会删除任何菜谱</strong>。
        </p>

        {error !== null && <p className="field-error">{error}</p>}
        {notice !== null && (
          <p className="recipe-notice" role="status">
            {notice}
          </p>
        )}

        <div className="tag-manager-groups">
          {groups.map((g) => (
            <section key={g.key} className="tag-manager-group">
              <h3>
                {g.label}
                <span className="tag-picker-group-count">{g.tags.length}</span>
              </h3>
              {g.tags.length === 0 ? (
                <p className="tag-picker-group-empty">（这一类还没有 Tag）</p>
              ) : (
                <ul className="tag-manager-list">
                  {g.tags.map((t) => {
                    const editing = editingId === t.id
                    const rowBusy = busyId === t.id
                    return (
                      <li key={t.id} className="tag-manager-row">
                        {editing ? (
                          <>
                            <input
                              type="text"
                              value={row.name}
                              maxLength={60}
                              disabled={anyBusy}
                              aria-label="Tag 名称"
                              onChange={(e) => setRow((p) => ({ ...p, name: e.target.value }))}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  void handleSaveEdit(t)
                                }
                                if (e.key === 'Escape' && !anyBusy) setEditingId(null)
                              }}
                            />
                            <select
                              value={row.category}
                              disabled={anyBusy}
                              aria-label="Tag 分类"
                              onChange={(e) =>
                                setRow((p) => ({
                                  ...p,
                                  category: e.target.value as RecipeTagCategoryCode | '',
                                }))
                              }
                            >
                              <option value="">未分类</option>
                              {(dict?.categories ?? []).map((c) => (
                                <option key={c.code} value={c.code}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="primary"
                              disabled={anyBusy}
                              onClick={() => void handleSaveEdit(t)}
                            >
                              {rowBusy ? '保存中…' : '保存'}
                            </button>
                            <button type="button" disabled={anyBusy} onClick={() => setEditingId(null)}>
                              取消
                            </button>
                          </>
                        ) : (
                          <>
                            <span className="tag-manager-name">{t.name}</span>
                            <span className="tag-manager-meta">
                              {t.is_system ? '系统预设' : '自定义'} · 用于 {t.recipe_count} 个菜谱
                            </span>
                            <button type="button" disabled={anyBusy} onClick={() => startEdit(t)}>
                              改名 / 改分类
                            </button>
                            <button
                              type="button"
                              className="danger"
                              disabled={anyBusy}
                              onClick={() => {
                                setNotice(null)
                                setConfirmDelete(t)
                              }}
                            >
                              删除
                            </button>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>

        <div className="tag-manager-create">
          <h3>新建标签</h3>
          <div className="tag-create-form">
            <input
              type="text"
              className="tag-create-input"
              placeholder="名称（最多 60 字）"
              value={newName}
              maxLength={60}
              disabled={anyBusy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleCreate()
                }
              }}
            />
            <select
              value={newCategory}
              disabled={anyBusy}
              aria-label="新标签分类"
              onChange={(e) => setNewCategory(e.target.value as RecipeTagCategoryCode | '')}
            >
              <option value="">未分类</option>
              {(dict?.categories ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <button type="button" className="primary" disabled={anyBusy} onClick={() => void handleCreate()}>
              {creating ? '创建中…' : '新建'}
            </button>
          </div>
        </div>

        {/* ---------- 删除确认（必须先看关联数） ---------- */}
        {confirmDelete !== null && (
          <div className="tag-manager-confirm" role="alertdialog" aria-label="确认删除标签">
            <p>
              确定删除「{confirmDelete.name}」吗？
              {confirmDelete.recipe_count > 0
                ? `它当前被 ${confirmDelete.recipe_count} 个菜谱使用，删除后会从这些菜谱上移除该标签（菜谱本身保留）。`
                : '它目前没有被任何菜谱使用。'}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                disabled={anyBusy}
                onClick={() => setConfirmDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={anyBusy}
                onClick={() => void handleDelete(confirmDelete)}
              >
                {busyId === confirmDelete.id ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button type="button" className="primary" disabled={anyBusy} onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  )
}
