import { useCallback, useEffect, useState } from 'react'

import {
  consumeIngredient,
  createIngredient,
  deleteIngredient,
  getIngredients,
  updateIngredient,
} from '../api/ingredients'
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog'
import ConsumeDialog from '../components/ConsumeDialog'
import IngredientCard from '../components/IngredientCard'
import IngredientForm from '../components/IngredientForm'
import type { CreateIngredientInput, Ingredient } from '../types/ingredient'

/**
 * 库存管理页面。
 *
 * 负责：
 * 1. 加载库存
 * 2. 保存库存状态
 * 3. 控制添加/编辑/消耗/删除 UI
 * 4. 调用 API
 * 5. 成功后刷新列表
 * 6. 显示错误
 *
 * 状态管理只用 useState / useEffect / fetch（不引入 Redux / React Query 等）。
 */

/** 当前打开的对话框 */
type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; ingredient: Ingredient }
  | { kind: 'consume'; ingredient: Ingredient }
  | { kind: 'delete'; ingredient: Ingredient }

export default function InventoryPage() {
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })

  /** 加载库存列表 */
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      const data = await getIngredients()
      setIngredients(data)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 关闭对话框 */
  function closeDialog() {
    setDialog({ kind: 'none' })
  }

  /** 添加食材 */
  async function handleCreate(data: CreateIngredientInput) {
    await createIngredient(data)
    closeDialog()
    await load()
  }

  /**
   * 编辑食材。
   *
   * 发送全部可编辑字段（PATCH schema 允许这些字段，
   * 未发送的字段会保持原值 —— 这里显式发送以确保"清空备注/日期"也能生效）。
   */
  async function handleUpdate(id: number, data: CreateIngredientInput) {
    await updateIngredient(id, {
      name: data.name,
      quantity: data.quantity,
      unit: data.unit,
      purchase_date: data.purchase_date ?? null,
      expiry_date: data.expiry_date ?? null,
      note: data.note ?? null,
    })
    closeDialog()
    await load()
  }

  /** 消耗食材 */
  async function handleConsume(id: number, amount: number) {
    await consumeIngredient(id, { amount })
    closeDialog()
    await load()
  }

  /** 删除食材 */
  async function handleDelete(id: number) {
    await deleteIngredient(id)
    closeDialog()
    await load()
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>HomeChef</h1>
      </header>

      <section>
        <div className="section-header">
          <h2>库存</h2>
          <button
            type="button"
            className="primary"
            onClick={() => setDialog({ kind: 'create' })}
          >
            + 添加食材
          </button>
        </div>

        {loading && <p className="status">加载中...</p>}

        {!loading && loadError && (
          <div className="load-error">
            <p>加载失败：{loadError}</p>
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {!loading && !loadError && ingredients.length === 0 && (
          <div className="empty-state">
            <p>目前没有食材。</p>
            <button
              type="button"
              className="primary"
              onClick={() => setDialog({ kind: 'create' })}
            >
              添加第一个食材
            </button>
          </div>
        )}

        {!loading && !loadError && ingredients.length > 0 && (
          <ul className="card-list">
            {ingredients.map((item) => (
              <IngredientCard
                key={item.id}
                ingredient={item}
                onEdit={(ingredient) => setDialog({ kind: 'edit', ingredient })}
                onConsume={(ingredient) => setDialog({ kind: 'consume', ingredient })}
                onDelete={(ingredient) => setDialog({ kind: 'delete', ingredient })}
              />
            ))}
          </ul>
        )}
      </section>

      {dialog.kind === 'create' && (
        <IngredientForm onSubmit={handleCreate} onCancel={closeDialog} />
      )}

      {dialog.kind === 'edit' && (
        <IngredientForm
          initial={dialog.ingredient}
          onSubmit={(data) => handleUpdate(dialog.ingredient.id, data)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'consume' && (
        <ConsumeDialog
          ingredient={dialog.ingredient}
          onSubmit={(amount) => handleConsume(dialog.ingredient.id, amount)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'delete' && (
        <ConfirmDeleteDialog
          ingredientName={dialog.ingredient.name}
          onConfirm={() => handleDelete(dialog.ingredient.id)}
          onCancel={closeDialog}
        />
      )}
    </div>
  )
}
