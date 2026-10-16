import { useEffect, useState } from 'react'

import TagPicker from './TagPicker'
import type { RecipeTagItem, RecipeTagMode, TagCategoryDict } from '../types/api'

/**
 * 独立的 Tag 选择弹窗（v0.2.3：按五大分类分组）。
 *
 * 设计要点：
 *   1. **独立于列表页面** —— 不把全部 Tag 常驻展开在搜索栏下方；
 *   2. **草稿语义**：窗口内维护临时选择，只有点「确认」才应用到列表；
 *      「取消」丢弃草稿，不影响当前筛选；
 *   3. 支持 **AND / OR** 模式切换；
 *   4. 支持**新建 Tag（含分类）**与跳转「标签管理」，复用 `TagPicker`，
 *      **不重复实现**分组与新建逻辑；
 *   5. 空列表 / 加载中 / 请求失败都有明确呈现。
 *
 * ⚠️ 本组件只产出「选中的 Tag 名称 + 模式」，不发起列表请求。
 */

interface Props {
  open: boolean
  /** 全部已有 Tag */
  allTags: RecipeTagItem[]
  /** 五大分类字典（后端下发） */
  dict: TagCategoryDict | null
  /** 当前已应用的选中 Tag（用于初始化草稿） */
  selectedTags: string[]
  /** 当前已应用的模式 */
  tagMode: RecipeTagMode
  loadingTags: boolean
  tagsError: string | null
  /** v0.2.3：分类字典加载失败提示（原样透传） */
  dictError?: string | null
  /** v0.2.3：重试加载分类字典 */
  onRetryDict?: () => void
  /** 请求父级重新加载 Tag 列表（新建成功后调用） */
  onReloadTags: () => void
  /** 打开「标签管理」弹窗（可选） */
  onOpenManager?: () => void
  onCancel: () => void
  onConfirm: (tags: string[], mode: RecipeTagMode) => void
}

export default function TagSelectDialog({
  open,
  allTags,
  dict,
  selectedTags,
  tagMode,
  loadingTags,
  tagsError,
  dictError = null,
  onRetryDict,
  onReloadTags,
  onOpenManager,
  onCancel,
  onConfirm,
}: Props) {
  /* ---------- 草稿状态（只有「确认」才提交）---------- */
  const [draftTags, setDraftTags] = useState<string[]>([])
  const [draftMode, setDraftMode] = useState<RecipeTagMode>('and')

  // 每次打开时用「当前已应用的选择」重置草稿 —— 取消后不会残留上次改动
  useEffect(() => {
    if (open) {
      setDraftTags(selectedTags)
      setDraftMode(tagMode)
    }
  }, [open, selectedTags, tagMode])

  if (!open) return null

  function toggleTag(name: string) {
    setDraftTags((prev) => (prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name]))
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

        {/* ---------- 分组 Tag 列表（复用 TagPicker） ---------- */}
        <div className="tag-select-list-wrap">
          <TagPicker
            allTags={allTags}
            dict={dict}
            dictError={dictError}
            onRetryDict={onRetryDict}
            selected={draftTags}
            onToggle={toggleTag}
            loading={loadingTags}
            error={tagsError}
            onReload={onReloadTags}
            onOpenManager={onOpenManager}
            onCreated={(name) => {
              // 新建后立刻加入草稿；父级会重新拉列表让新 Tag 出现在分组里
              setDraftTags((prev) => (prev.includes(name) ? prev : [...prev, name]))
              onReloadTags()
            }}
          />
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
