import { useCallback, useEffect, useRef, useState } from 'react'

import { listRecipes, getRecipe, deleteRecipe } from '../api/recipes'
import { listTags } from '../api/tags'
import {
  getRecipeListSettings,
  updateRecipeListSettings,
} from '../api/recipeListSettings'
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog'
import RecipeCreateForm from '../components/RecipeCreateForm'
import RecipeDetailView from '../components/RecipeDetailView'
import RecipeFilterBar from '../components/RecipeFilterBar'
import RecipeList from '../components/RecipeList'
import TagSelectDialog from '../components/TagSelectDialog'
import { ApiError } from '../types/api'
import type {
  RecipeDetail,
  RecipeListSettings,
  RecipeSortField,
  RecipeSortOrder,
  RecipeSummary,
  RecipeTagItem,
  RecipeTagMode,
} from '../types/api'

/**
 * 菜谱页面（v0.2.0 Phase 3）。
 *
 * 页面布局（三行）：
 *   第一行： 菜谱标题 + 「新建菜谱」按钮
 *   第二行： 名称搜索（左） + 排序控件（右）
 *   第三行： 已选 Tag（左） + 「选择 Tag」按钮（右）
 *
 * 能力：
 *   - 列表（名称 / Tag / 整体备注）
 *   - **名称搜索**（⚠️ 只搜菜谱名称，Tag 名称不参与 —— 后端语义已同步）
 *   - Tag 多选筛选（AND / OR），通过**独立弹窗**选择
 *   - 排序（最近修改 / 创建时间 / 名称 × 升/降）
 *   - 排序、Tag 选择、AND/OR 模式**持久化**到后端 `app_settings`
 *   - **新建菜谱**（独立表单弹窗，真实写入数据库）
 *
 * ---------------------------------------------------------------------------
 * 并发处理策略（重要，勿删）
 * ---------------------------------------------------------------------------
 *
 * 1. **列表请求竞态** → 递增请求序号 `requestSeq`
 *    只有序号等于最新值的响应才写入状态；卸载时把序号推高使在途请求全部失效。
 *
 * 2. **搜索防抖 300ms** → 用 `latestFilters` ref 镜像最新筛选/排序状态
 *    debounce 回调**读 ref**而不是闭包捕获值，避免
 *    「等待期内改了 Tag/排序，回调仍用旧值」导致界面与列表不一致。
 *
 * 3. **设置 PATCH 串行化** → `patchInFlight` 保证最多一个在途；
 *    `pendingSettings` 表示「尚未成功持久化的最新完整设置」：
 *      - 成功且期间未被覆盖 → 清空
 *      - 失败 → **保留**，通过界面「重试」按钮手动重发（不自动循环）
 *      - 成功且有更新值 → 立即补发（避免在途期间的新操作一直不落库）
 */

/** 搜索防抖延迟（毫秒） */
const SEARCH_DEBOUNCE_MS = 300

export default function RecipesPage() {
  /* ---------- 列表数据 ---------- */
  const [recipes, setRecipes] = useState<RecipeSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  /* ---------- 筛选与排序状态 ---------- */
  const [search, setSearch] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagMode, setTagMode] = useState<RecipeTagMode>('and')
  const [sortField, setSortField] = useState<RecipeSortField>('updated_at')
  const [sortOrder, setSortOrder] = useState<RecipeSortOrder>('desc')

  /* ---------- 参考数据 ---------- */
  const [tags, setTags] = useState<RecipeTagItem[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const [tagsError, setTagsError] = useState<string | null>(null)
  /** 首次设置加载完成前不请求列表（避免用默认值多发一次请求） */
  const [settingsReady, setSettingsReady] = useState(false)

  /* ---------- 弹窗 ---------- */
  const [tagDialogOpen, setTagDialogOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  /* ---------- 详情 / 编辑 / 删除（批次 4 剩余功能）---------- */
  /** 当前查看的菜谱详情；null 且不在加载中 = 处于列表视图 */
  const [detail, setDetail] = useState<RecipeDetail | null>(null)
  /** 正在查看/加载的菜谱 id（加载失败时用于重试） */
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  /** 非 null = 打开编辑弹窗（传入待编辑的详情用于回填） */
  const [editing, setEditing] = useState<RecipeDetail | null>(null)
  /** 非 null = 打开删除确认弹窗 */
  const [deleteTarget, setDeleteTarget] = useState<RecipeDetail | null>(null)
  /** 详情请求竞态（避免旧响应覆盖新详情） */
  const detailSeq = useRef(0)

  /* ---------- 提示 ---------- */
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [isSavingSettings, setIsSavingSettings] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  /* ---------- 竞态控制 ---------- */
  const requestSeq = useRef(0)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---------- 设置串行化控制 ---------- */
  const patchInFlight = useRef(false)
  const pendingSettings = useRef<RecipeListSettings | null>(null)

  /** 最新筛选/排序状态镜像（供 debounce 回调读取，见文件头说明） */
  const latestFilters = useRef({ selectedTags, tagMode, sortField, sortOrder })
  useEffect(() => {
    latestFilters.current = { selectedTags, tagMode, sortField, sortOrder }
  }, [selectedTags, tagMode, sortField, sortOrder])

  /* ============================================================
   * 拉取列表
   * ============================================================ */
  const fetchRecipes = useCallback(
    async (params: {
      search: string
      selectedTags: string[]
      tagMode: RecipeTagMode
      sortField: RecipeSortField
      sortOrder: RecipeSortOrder
    }) => {
      const seq = ++requestSeq.current
      setLoading(true)
      setListError(null)

      try {
        const data = await listRecipes({
          search: params.search,
          tags: params.selectedTags,
          tagMode: params.tagMode,
          sortField: params.sortField,
          sortOrder: params.sortOrder,
        })

        // ⚠️ 过期响应直接丢弃，绝不覆盖较新的结果
        if (seq !== requestSeq.current) return

        setRecipes(data)
      } catch (e) {
        if (seq !== requestSeq.current) return

        setRecipes([])
        setListError(e instanceof ApiError ? e.message : '加载菜谱失败，请稍后重试。')
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false)
        }
      }
    },
    [],
  )

  /* ============================================================
   * 设置持久化（串行 + 合并最后一次 + 失败可手动重试）
   * ============================================================ */
  const flushSettings = useCallback(async () => {
    if (patchInFlight.current) return

    const next = pendingSettings.current
    if (next === null) return

    patchInFlight.current = true
    setIsSavingSettings(true)
    let succeeded = false

    try {
      await updateRecipeListSettings({
        sort_field: next.sort_field,
        sort_order: next.sort_order,
        tag_mode: next.tag_mode,
        selected_tags: next.selected_tags,
      })
      succeeded = true

      // 期间未被覆盖才清空；否则保留最新值
      if (pendingSettings.current === next) {
        pendingSettings.current = null
        setSettingsError(null)
      }
    } catch (e) {
      // 失败保留 pendingSettings —— 不静默丢失，等用户点「重试」
      setSettingsError(e instanceof ApiError ? `设置保存失败：${e.message}` : '设置保存失败。')
    } finally {
      patchInFlight.current = false
      setIsSavingSettings(false)

      // 成功且有更新值 → 补发；失败 → 不补发（避免快速循环重试）
      if (succeeded && pendingSettings.current !== null) {
        void flushSettings()
      }
    }
  }, [])

  const persistSettings = useCallback(
    (next: RecipeListSettings) => {
      pendingSettings.current = next
      void flushSettings()
    },
    [flushSettings],
  )

  const retrySaveSettings = useCallback(() => {
    void flushSettings()
  }, [flushSettings])

  /* ============================================================
   * Tag 列表加载（供弹窗与新建表单使用）
   * ============================================================ */
  const loadTags = useCallback(async () => {
    setTagsLoading(true)
    setTagsError(null)
    try {
      const data = await listTags()
      setTags(data)
      return data
    } catch (e) {
      setTagsError(e instanceof ApiError ? e.message : '加载 Tag 失败')
      return [] as RecipeTagItem[]
    } finally {
      setTagsLoading(false)
    }
  }, [])

  /* ============================================================
   * 首次加载：设置 → Tag（清理无效已选）→ 列表
   * ============================================================ */
  useEffect(() => {
    let cancelled = false

    async function bootstrap() {
      try {
        const settings = await getRecipeListSettings()
        if (cancelled) return

        const availableTags = await loadTags()
        if (cancelled) return

        const validNames = new Set(availableTags.map((t) => t.name))
        // ⚠️ Tag 拉取失败（availableTags 为空且 tagsError 非空）时不清理，
        //    避免把"暂时取不到"误判为"已删除"
        const cleanedTags =
          availableTags.length > 0
            ? settings.selected_tags.filter((n) => validNames.has(n))
            : settings.selected_tags

        setSortField(settings.sort_field)
        setSortOrder(settings.sort_order)
        setTagMode(settings.tag_mode)
        setSelectedTags(cleanedTags)

        if (cleanedTags.length !== settings.selected_tags.length) {
          persistSettings({
            sort_field: settings.sort_field,
            sort_order: settings.sort_order,
            tag_mode: settings.tag_mode,
            selected_tags: cleanedTags,
          })
        }

        setSettingsReady(true)

        void fetchRecipes({
          search: '',
          selectedTags: cleanedTags,
          tagMode: settings.tag_mode,
          sortField: settings.sort_field,
          sortOrder: settings.sort_order,
        })
      } catch (e) {
        if (cancelled) return
        setListError(e instanceof ApiError ? e.message : '加载设置失败，请稍后重试。')
        setLoading(false)
      }
    }

    void bootstrap()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ============================================================
   * 交互处理
   * ============================================================ */

  /** 搜索：300ms debounce；**不持久化**搜索词 */
  function handleSearchChange(value: string) {
    setSearch(value)
    setNotice(null)

    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current)
    }

    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null
      // ⚠️ 读 ref 镜像，而不是闭包捕获的旧值
      const f = latestFilters.current
      void fetchRecipes({
        search: value,
        selectedTags: f.selectedTags,
        tagMode: f.tagMode,
        sortField: f.sortField,
        sortOrder: f.sortOrder,
      })
    }, SEARCH_DEBOUNCE_MS)
  }

  /** 应用「选择 Tag」弹窗的确认结果 */
  function handleConfirmTags(nextTags: string[], nextMode: RecipeTagMode) {
    setTagDialogOpen(false)
    setSelectedTags(nextTags)
    setTagMode(nextMode)
    void fetchRecipes({ search, selectedTags: nextTags, tagMode: nextMode, sortField, sortOrder })
    persistSettings({
      sort_field: sortField,
      sort_order: sortOrder,
      tag_mode: nextMode,
      selected_tags: nextTags,
    })
  }

  /** 移除单个已选 Tag */
  function handleRemoveTag(tagName: string) {
    const next = selectedTags.filter((t) => t !== tagName)
    setSelectedTags(next)
    void fetchRecipes({ search, selectedTags: next, tagMode, sortField, sortOrder })
    persistSettings({
      sort_field: sortField,
      sort_order: sortOrder,
      tag_mode: tagMode,
      selected_tags: next,
    })
  }

  function handleSortChange(field: RecipeSortField, order: RecipeSortOrder) {
    setSortField(field)
    setSortOrder(order)
    void fetchRecipes({ search, selectedTags, tagMode, sortField: field, sortOrder: order })
    persistSettings({
      sort_field: field,
      sort_order: order,
      tag_mode: tagMode,
      selected_tags: selectedTags,
    })
  }

  /** 判断新菜谱在当前搜索 + Tag 筛选下是否可见（用于给出反馈） */
  function isVisibleUnderCurrentFilter(detail: RecipeDetail): boolean {
    const needle = search.trim().toLowerCase()
    if (needle.length > 0 && !detail.name.toLowerCase().includes(needle)) return false

    if (selectedTags.length > 0) {
      const owned = new Set(detail.tags)
      const matched =
        tagMode === 'and'
          ? selectedTags.every((t) => owned.has(t))
          : selectedTags.some((t) => owned.has(t))
      if (!matched) return false
    }
    return true
  }

  /** 打开菜谱详情（真实从后端加载，不用列表里的摘要数据拼凑） */
  async function openDetail(id: number) {
    const seq = ++detailSeq.current
    // ⚠️ 列表的 Tag 筛选弹窗属于列表视图，进入详情时必须关闭，避免残留悬浮
    setTagDialogOpen(false)
    setDetailId(id)
    setDetailLoading(true)
    setDetailError(null)
    setDetail(null)

    try {
      const data = await getRecipe(id)
      // ⚠️ 过期响应丢弃
      if (seq !== detailSeq.current) return
      setDetail(data)
    } catch (e) {
      if (seq !== detailSeq.current) return
      setDetailError(e instanceof ApiError ? e.message : '加载菜谱详情失败，请稍后重试。')
    } finally {
      if (seq === detailSeq.current) {
        setDetailLoading(false)
      }
    }
  }

  /** 返回列表（丢弃详情与编辑状态） */
  function backToList() {
    detailSeq.current++
    setDetail(null)
    setDetailError(null)
    setDetailLoading(false)
    setEditing(null)
    // ⚠️ 返回列表时同样关闭 Tag 弹窗，保持状态干净
    setTagDialogOpen(false)
  }

  /**
   * 保存成功（**新建与编辑共用**）。
   *
   * - 刷新列表（沿用当前筛选与排序）
   * - 编辑：重新拉取详情，让详情页反映最新数据
   * - 新建：给出可见性反馈
   */
  function handleSaved(saved: RecipeDetail) {
    const wasEdit = editing !== null

    setCreateOpen(false)
    setEditing(null)
    void fetchRecipes({ search, selectedTags, tagMode, sortField, sortOrder })

    if (wasEdit) {
      void openDetail(saved.id)
      setNotice(`「${saved.name}」已更新。`)
      return
    }

    // 新建：若当前筛选条件会让新菜谱不可见，明确告知，避免误以为保存失败
    if (!isVisibleUnderCurrentFilter(saved)) {
      setNotice(`「${saved.name}」已保存，但当前搜索或 Tag 筛选条件下不会显示。`)
    } else {
      setNotice(`「${saved.name}」已保存。`)
    }
  }

  /** 确认删除：调用真实 API，成功后回列表并刷新 */
  async function handleConfirmDelete() {
    if (deleteTarget === null) return

    // ⚠️ 失败会抛出，由 ConfirmDeleteDialog 捕获并显示错误 —— 绝不假装成功
    await deleteRecipe(deleteTarget.id)

    const name = deleteTarget.name
    setDeleteTarget(null)
    backToList()
    void fetchRecipes({ search, selectedTags, tagMode, sortField, sortOrder })
    setNotice(`「${name}」已删除。`)
  }

  /** 从列表进入详情 */
  function handleSelect(recipe: RecipeSummary) {
    void openDetail(recipe.id)
  }

  /* ---------- 卸载清理 ---------- */
  useEffect(() => {
    return () => {
      requestSeq.current++
      // ⚠️ 详情请求同样需要失效，否则卸载后返回的响应会写入已卸载组件
      detailSeq.current++
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current)
      }
    }
  }, [])

  /* ============================================================
   * 渲染
   * ============================================================ */

  /** 是否处于详情视图（详情已加载 / 正在加载 / 加载失败） */
  const inDetail = detail !== null || detailLoading || detailError !== null

  return (
    <section className="recipe-page">
      {/* ============================================================
       * 详情视图（批次 4 剩余功能）
       * ============================================================ */}
      {inDetail ? (
        <>
          {detailLoading && <p className="status">加载中…</p>}

          {!detailLoading && detailError !== null && (
            <div className="load-error">
              <p>{detailError}</p>
              <button type="button" onClick={() => detailId !== null && void openDetail(detailId)}>
                重试
              </button>
              <button type="button" onClick={backToList}>
                返回列表
              </button>
            </div>
          )}

          {!detailLoading && detailError === null && detail !== null && (
            <RecipeDetailView
              detail={detail}
              onBack={backToList}
              onEdit={() => setEditing(detail)}
              onDelete={() => setDeleteTarget(detail)}
            />
          )}
        </>
      ) : (
        <>
      {/* ---------- 第一行：标题 + 新建菜谱 ---------- */}
      <div className="section-header">
        <h2>菜谱</h2>
        <button
          type="button"
          className="primary"
          disabled={!settingsReady}
          onClick={() => {
            setNotice(null)
            setCreateOpen(true)
          }}
        >
          + 新建菜谱
        </button>
      </div>

      {/* ---------- 第二行 + 第三行 ---------- */}
      <RecipeFilterBar
        search={search}
        onSearchChange={handleSearchChange}
        selectedTags={selectedTags}
        onRemoveTag={handleRemoveTag}
        onOpenTagDialog={() => setTagDialogOpen(true)}
        tagMode={tagMode}
        sortField={sortField}
        sortOrder={sortOrder}
        onSortChange={handleSortChange}
        disabled={!settingsReady}
      />

      {/* 设置保存失败：不阻塞列表，仅提示 + 手动重试 */}
      {settingsError !== null && (
        <div className="recipe-settings-error" role="status">
          <span>{settingsError}</span>
          <button
            type="button"
            className="recipe-settings-retry"
            disabled={isSavingSettings}
            onClick={retrySaveSettings}
          >
            {isSavingSettings ? '保存中…' : '重试'}
          </button>
        </div>
      )}

      {/* 加载中 */}
      {loading && <p className="status">加载中…</p>}

      {/* 加载失败 */}
      {!loading && listError !== null && (
        <div className="load-error">
          <p>{listError}</p>
          <button
            type="button"
            onClick={() => void fetchRecipes({ search, selectedTags, tagMode, sortField, sortOrder })}
          >
            重试
          </button>
        </div>
      )}

      {/* 空列表 */}
      {!loading && listError === null && recipes.length === 0 && (
        <p className="empty-state">
          {search.trim().length > 0 || selectedTags.length > 0
            ? '没有符合当前搜索或筛选条件的菜谱。'
            : '还没有菜谱。点击右上角「新建菜谱」开始。'}
        </p>
      )}

      {/* 列表 */}
      {!loading && listError === null && recipes.length > 0 && (
        <RecipeList recipes={recipes} onSelect={handleSelect} />
      )}
        </>
      )}

      {/*
        操作结果提示（列表与详情**共用**一处）：
        ⚠️ 编辑保存成功后停留在详情视图，若只放在列表分支会导致提示不可见。
      */}
      {notice !== null && (
        <p className="recipe-notice" role="status">
          {notice}
          <button type="button" className="recipe-notice-close" onClick={() => setNotice(null)}>
            ×
          </button>
        </p>
      )}

      {/* ---------- Tag 选择弹窗 ---------- */}
      <TagSelectDialog
        open={tagDialogOpen}
        allTags={tags}
        selectedTags={selectedTags}
        tagMode={tagMode}
        loadingTags={tagsLoading}
        tagsError={tagsError}
        onReloadTags={() => void loadTags()}
        onCancel={() => setTagDialogOpen(false)}
        onConfirm={handleConfirmTags}
      />

      {/* ---------- 菜谱表单（新建 / 编辑共用同一实现）---------- */}
      <RecipeCreateForm
        open={createOpen || editing !== null}
        allTags={tags}
        initial={editing}
        onCancel={() => {
          setCreateOpen(false)
          setEditing(null)
        }}
        onSaved={handleSaved}
      />

      {/* ---------- 删除确认（复用既有 ConfirmDeleteDialog）---------- */}
      {deleteTarget !== null && (
        <ConfirmDeleteDialog
          title="删除菜谱"
          ingredientName={deleteTarget.name}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  )
}
