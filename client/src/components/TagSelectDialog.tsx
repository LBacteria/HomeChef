import { useEffect, useState } from 'react'

import { createTag } from '../api/tags'
import { ApiError } from '../types/api'
import type { RecipeTagItem, RecipeTagMode } from '../types/api'

/**
 * 独立的 Tag 选择弹窗。
 *
 * 设计要点：
 *   1. **独立于列表页面** —— 不把全部 Tag 常驻展开在搜索栏下方
 *   2. **草稿语义**：窗口内维护临时选择，只有点「确认」才应用到列表；
 *      「取消」丢弃草稿，不影响当前筛选
 *   3. 支持 **AND / OR** 模式切换
 *   4. 支持**新建 Tag**：复用后端 `POST /api/tags`，不重复实现接口
 *   5. 空列表 / 加载中 / 请求失败都有明确呈现
 *
 * ⚠️ 本组件只产出「选中的 Tag 名称 + 模式」，不发起列表请求。
 */

interface Props {
  open: boolean
  /** 全部已有 Tag */
  allTags: RecipeTagItem[]
  /** 当前已应用的选中 Tag（用于初始化草稿） */
  selectedTags: string[]
  /** 当前已应用的模式 */
  tagMode: RecipeTagMode
  loadingTags: boolean
  tagsError: string | null
  /** 请求父级重新加载 Tag 列表（新建成功后调用） */
  onReloadTags: () => void
  onCancel: () => void
  onConfirm: (tags: string[], mode: RecipeTagMode) => void
}

export default function TagSelectDialog({
  open,
  allTags,
  selectedTags,
  tagMode,
  loadingTags,
  tagsError,
  onReloadTags,
  onCancel,
  onConfirm,
}: Props) {
  /* ---------- 草稿状态（只有「确认」才提交）---------- */
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftMode, setDraftMode] = useState<RecipeTagMode>('and')

  /* ---------- 新建 Tag ---------- */
  const [showCreate, setShowCreate] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // 每次打开时用「当前已应用的选择」重置草稿 —— 取消后不会残留上次改动
  useEffect(() => {
    if (open) {
      setDraftTags(selectedTags)
      setDraftMode(tagMode)
      setShowCreate(false)
      setNewTagName('')
      setCreateError(null)
      setCreating(false)
    }
  }, [open, selectedTags, tagMode])

  if (!open) return null

  function toggleTag(name: string) {
    setDraftTags((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    )
  }

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (name.length === 0) {
      setCreateError('Tag 名称不能为空')
      return
    }
    // 前端预检：已存在同名（按 trim + 小写比较），直接选中而不重复创建
    const existing = allTags.find((t) => t.name.toLowerCase() === name.toLowerCase())
    if (existing) {
      setDraftTags((prev) => (prev.includes(existing.name) ? prev : [...prev, existing.name]))
      setNewTagName('')
      setShowCreate(false)
      setCreateError(null)
      return
    }

    setCreating(true)
    setCreateError(null)
    try {
      const created = await createTag(name)
      void created
      // 后端统一保存时以**名称**关联，这里用输入的名称加入草稿
      setDraftTags((prev) => (prev.includes(name) ? prev : [...prev, name]))
      setNewTagName('')
      setShowCreate(false)
      // 让父级重新拉取 Tag 列表，新 Tag 立即可见可选
      onReloadTags()
    } catch (e) {
      // ⚠️ 失败必须明确提示，不得假装创建成功
      if (e instanceof ApiError && e.code === 'DUPLICATE_NAME') {
        setCreateError('该 Tag 已存在')
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
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="选择 Tag">
      <div className="modal tag-select-dialog">
        <h2>选择 Tag</h2>

        {/* ---------- 模式切换 ---------- */}
        <div className="tag-select-mode">
          <span className="field-label">筛选模式</span>
          <div className="recipe-tag-mode" role="group" aria-label="Tag 筛选模式">
            <button
              type="button"
              className={draftMode === 'and' ? 'recipe-tag-mode-btn active' : 'recipe-tag-mode-btn'}
              aria-pressed={draftMode === 'and'}
              onClick={() => setDraftMode('and')}
              title="菜谱必须包含全部已选 Tag"
            >
              全部满足
            </button>
            <button
              type="button"
              className={draftMode === 'or' ? 'recipe-tag-mode-btn active' : 'recipe-tag-mode-btn'}
              aria-pressed={draftMode === 'or'}
              onClick={() => setDraftMode('or')}
              title="菜谱包含任意一个已选 Tag 即可"
            >
              任一满足
            </button>
          </div>
        </div>

        {/* ---------- Tag 列表 ---------- */}
        <div className="tag-select-list-wrap">
          {loadingTags && <p className="status">加载中…</p>}

          {!loadingTags && tagsError !== null && (
            <div className="load-error">
              <p>{tagsError}</p>
              <button type="button" onClick={onReloadTags}>
                重试
              </button>
            </div>
          )}

          {!loadingTags && tagsError === null && allTags.length === 0 && (
            <p className="empty-state">还没有 Tag。可以用下方「新建 Tag」创建。</p>
          )}

          {!loadingTags && tagsError === null && allTags.length > 0 && (
            <ul className="tag-select-list">
              {allTags.map((t) => {
                const checked = draftTags.includes(t.name)
                return (
                  <li key={t.id}>
                    <label className={checked ? 'tag-select-item checked' : 'tag-select-item'}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTag(t.name)}
                      />
                      <span>{t.name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {/* ---------- 新建 Tag ---------- */}
        <div className="tag-create-block">
          {!showCreate ? (
            <button
              type="button"
              className="tag-create-toggle"
              onClick={() => {
                setShowCreate(true)
                setCreateError(null)
              }}
            >
              + 新建 Tag
            </button>
          ) : (
            <div className="tag-create-form">
              <input
                type="text"
                className="tag-create-input"
                placeholder="输入新 Tag 名称"
                value={newTagName}
                disabled={creating}
                autoFocus
                onChange={(e) => {
                  setNewTagName(e.target.value)
                  setCreateError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleCreateTag()
                  }
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={creating}
                onClick={() => void handleCreateTag()}
              >
                {creating ? '创建中…' : '创建'}
              </button>
              <button
                type="button"
                disabled={creating}
                onClick={() => {
                  setShowCreate(false)
                  setNewTagName('')
                  setCreateError(null)
                }}
              >
                取消
              </button>
            </div>
          )}

          {createError !== null && <p className="field-error">{createError}</p>}
        </div>

        {/* ---------- 操作 ---------- */}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onConfirm(draftTags, draftMode)}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  )
}
