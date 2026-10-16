import { useMemo, useState } from 'react'

import { createTag } from '../api/tags'
import { ApiError } from '../types/api'
import type { RecipeTagCategoryCode, RecipeTagItem, TagCategoryDict } from '../types/api'

/**
 * v0.2.3 分类 Tag 选择器（**新建菜谱 / 编辑菜谱 / 列表筛选**共用）。
 *
 * 设计要点：
 *   1. **分类分组展示**：五类 + 「未分类」；分组标题与顺序**全部来自后端字典**
 *      （`GET /api/tag-categories`），前端不写死中文分类名。
 *   2. **多选无固定上限**：一道菜可以挂任意多个 Tag（只做界面可见性提示）。
 *   3. **可就地新建**（含分类）；同名由后端 409 拒绝并明确提示。
 *   4. **键盘可操作**：使用原生 `<label><input type="checkbox">`，
 *      空格键即可切换，不做自定义按键劫持。
 *   5. 加载中 / 失败 / 空列表都有明确呈现，失败可重试。
 *
 * ⚠️ 本组件**只产出选择结果**，不发起列表请求，也不做筛选计算。
 */

interface Props {
  allTags: RecipeTagItem[]
  /** 分类字典（后端下发）；null = 尚未加载，此时退化为单组展示 */
  dict: TagCategoryDict | null
  /**
   * 分类字典**加载失败**的提示。
   *
   * ⚠️ 必须显式告知：否则所有标签都会显示在「未分类」分组下，
   *    用户会误以为分类数据丢失（其实是字典没取到）。
   */
  dictError?: string | null
  /** 重试加载分类字典 */
  onRetryDict?: () => void
  /** 已选 Tag **名称**（后端按名称关联） */
  selected: string[]
  onToggle: (name: string) => void
  disabled?: boolean
  loading?: boolean
  error?: string | null
  onReload?: () => void
  /** 打开「标签管理」弹窗（可选） */
  onOpenManager?: () => void
  /** 新建成功回调：父级应刷新 Tag 列表并按需选中 */
  onCreated?: (name: string) => void
}

interface Group {
  key: string
  label: string
  tags: RecipeTagItem[]
}

export default function TagPicker({
  allTags,
  dict,
  dictError = null,
  onRetryDict,
  selected,
  onToggle,
  disabled = false,
  loading = false,
  error = null,
  onReload,
  onOpenManager,
  onCreated,
}: Props) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<RecipeTagCategoryCode | ''>('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  /** 按后端字典分组；字典缺失时用一个「全部 Tag」组兜底 */
  const groups = useMemo<Group[]>(() => {
    const result: Group[] = []
    const known = new Set<string>()

    for (const category of dict?.categories ?? []) {
      const tags = allTags.filter((t) => t.category === category.code)
      for (const t of tags) known.add(t.name)
      result.push({ key: category.code, label: category.label, tags })
    }

    const rest = allTags.filter((t) => !known.has(t.name))
    const unclassifiedLabel = dict?.unclassified.label ?? '未分类'
    result.push({ key: 'unclassified', label: unclassifiedLabel, tags: rest })

    // 空分类也展示（让用户知道这一类的存在），但排在后面的空组直接保留亦可读
    return result
  }, [allTags, dict])

  async function handleCreate() {
    const name = newName.trim()
    if (name.length === 0) {
      setCreateError('Tag 名称不能为空')
      return
    }
    if (name.length > 60) {
      setCreateError('Tag 名称最长 60 个字符')
      return
    }
    // 前端预检同名（跨分类全局唯一）：直接选中，不重复创建
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      if (!selected.includes(existing.name)) onToggle(existing.name)
      setNewName('')
      setShowCreate(false)
      setCreateError(null)
      return
    }

    setCreating(true)
    setCreateError(null)
    try {
      await createTag(name, newCategory === '' ? null : newCategory)
      setNewName('')
      setShowCreate(false)
      onCreated?.(name)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE_NAME') {
        setCreateError('该 Tag 名称已存在')
      } else if (e instanceof ApiError) {
        setCreateError(`创建失败：${e.message}`)
      } else {
        setCreateError('创建 Tag 失败，请重试')
      }
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="tag-picker">
      {loading && <p className="status">Tag 加载中…</p>}

      {!loading && error !== null && (
        <div className="load-error">
          <p>{error}</p>
          {onReload && (
            <button type="button" onClick={onReload}>
              重试
            </button>
          )}
        </div>
      )}

      {!loading && error === null && allTags.length === 0 && (
        <p className="empty-state">还没有 Tag。可以用下方「新建 Tag」创建。</p>
      )}

      {!loading && error === null && allTags.length > 0 && (
        <>
          {/* ⚠️ 字典失败必须显式说明，否则所有标签看起来都"变成未分类了" */}
          {dictError !== null && (
            <div className="tag-picker-dict-error" role="status">
              <span>分类字典加载失败（{dictError}），下面暂按「未分类」展示。</span>
              {onRetryDict && (
                <button type="button" disabled={disabled} onClick={onRetryDict}>
                  重新加载分类
                </button>
              )}
            </div>
          )}
          <div className="tag-picker-groups">
          {groups.map((g) => (
            <div key={g.key} className="tag-picker-group">
              <div className="tag-picker-group-title">
                {g.label}
                <span className="tag-picker-group-count">{g.tags.length}</span>
              </div>
              {g.tags.length === 0 ? (
                <p className="tag-picker-group-empty">（这一类还没有 Tag）</p>
              ) : (
                <ul className="tag-picker-list">
                  {g.tags.map((t) => {
                    const checked = selected.includes(t.name)
                    return (
                      <li key={t.id}>
                        <label
                          className={checked ? 'tag-select-item checked' : 'tag-select-item'}
                          title={t.is_system ? '系统预设 Tag' : '自定义 Tag'}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => onToggle(t.name)}
                          />
                          <span>{t.name}</span>
                          {t.is_system && <span className="tag-picker-preset">预设</span>}
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ))}
          </div>
        </>
      )}

      {/* ---------- 新建 / 管理 ---------- */}
      <div className="tag-create-block">
        {!showCreate ? (
          <div className="tag-picker-actions">
            <button
              type="button"
              className="tag-create-toggle"
              disabled={disabled}
              onClick={() => {
                setShowCreate(true)
                setCreateError(null)
              }}
            >
              + 新建 Tag
            </button>
            {onOpenManager && (
              <button type="button" disabled={disabled} onClick={onOpenManager}>
                管理全部标签
              </button>
            )}
          </div>
        ) : (
          <div className="tag-create-form">
            <input
              type="text"
              className="tag-create-input"
              placeholder="输入新 Tag 名称（最多 60 字）"
              value={newName}
              disabled={creating}
              maxLength={60}
              autoFocus
              onChange={(e) => {
                setNewName(e.target.value)
                setCreateError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleCreate()
                }
                if (e.key === 'Escape') {
                  setShowCreate(false)
                  setNewName('')
                  setCreateError(null)
                }
              }}
            />
            <select
              value={newCategory}
              disabled={creating}
              aria-label="Tag 分类"
              onChange={(e) => setNewCategory(e.target.value as RecipeTagCategoryCode | '')}
            >
              <option value="">未分类</option>
              {(dict?.categories ?? []).map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <button type="button" className="primary" disabled={creating} onClick={() => void handleCreate()}>
              {creating ? '创建中…' : '创建'}
            </button>
            <button
              type="button"
              disabled={creating}
              onClick={() => {
                setShowCreate(false)
                setNewName('')
                setCreateError(null)
              }}
            >
              取消
            </button>
          </div>
        )}

        {createError !== null && <p className="field-error">{createError}</p>}
      </div>
    </div>
  )
}
