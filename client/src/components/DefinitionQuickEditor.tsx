import { useCallback, useEffect, useState } from 'react'

import { getDefinition } from '../api/definitions'
import { listCategories } from '../api/categories'
import { DefinitionEditor } from './DefinitionEditor'
import type { Category, IngredientDefinitionDetail } from '../types/api'

/**
 * 食材快捷设置弹窗（v0.1.4）。
 *
 * 用途：在「新增库存 / 编辑库存」表单中，直接修改当前所选食材的配置，
 *      而不必退出表单去食材库。
 *
 * 设计要点：
 *   - **复用 DefinitionEditor**（它自带 modal 外壳与关闭按钮），
 *     保证字段、校验、保存逻辑与食材库完全一致
 *   - 弹窗自行**重新拉取最新 definition**，避免用到过期的 props
 *   - 保存成功后调用 `onSaved(最新 definition)`，由父组件刷新依赖数据；
 *     **弹窗自身不触碰库存表单的任何其他字段**
 *   - 取消 / 关闭不提交未保存的修改
 *
 * ⚠️ 所有业务校验（名称唯一、单位在用、最后单位、跨类切换等）都在后端，
 *    本组件只负责加载、展示与传递错误信息。
 */

interface Props {
  /** 要编辑的食材定义 id */
  definitionId: number
  /**
   * 保存成功后回调，参数为该食材的最新定义。
   * 允许返回 Promise，便于父组件等待数据刷新完成。
   */
  onSaved: (updated: IngredientDefinitionDetail) => void | Promise<void>
  onClose: () => void
}

export default function DefinitionQuickEditor({ definitionId, onSaved, onClose }: Props) {
  const [definition, setDefinition] = useState<IngredientDefinitionDetail | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** 重新拉取该食材的最新配置（含 aliases 与 allowed_units） */
  const loadDefinition = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [def, cats] = await Promise.all([getDefinition(definitionId), listCategories()])
      setDefinition(def)
      setCategories(cats)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [definitionId])

  useEffect(() => {
    void loadDefinition()
  }, [loadDefinition])

  /**
   * DefinitionEditor 统一保存成功后调用（v0.1.4 第二批）。
   *
   * ⚠️ 现在只在用户点「保存」且全部字段提交成功后才触发一次，
   *    不再是每次增删别名/单位都触发。
   *    这里重新拉取最新定义并通知父组件（库存表单据此刷新单位选项）。
   */
  const handleChanged = useCallback(async () => {
    const fresh = await getDefinition(definitionId)
    setDefinition(fresh)
    await onSaved(fresh)
  }, [definitionId, onSaved])

  // 加载中 / 加载失败时使用本组件自己的轻量外壳；
  // 加载成功后交给 DefinitionEditor 渲染它自带的 modal 外壳，避免双层遮罩。
  if (loading) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>食材设置</h2>
          <p className="status">加载中...</p>
        </div>
      </div>
    )
  }

  if (loadError || !definition) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <h2>食材设置</h2>
          <div className="load-error">
            <p>加载失败：{loadError ?? '未找到该食材'}</p>
            <button type="button" onClick={() => void loadDefinition()}>
              重试
            </button>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <DefinitionEditor
      definition={definition}
      categories={categories}
      onChanged={handleChanged}
      onClose={onClose}
    />
  )
}
