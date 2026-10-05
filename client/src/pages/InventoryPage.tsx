import { useCallback, useEffect, useMemo, useState } from 'react'

import { listDefinitions } from '../api/definitions'
import {
  consumeInventory,
  createInventory,
  deleteInventory,
  listInventory,
  updateInventory,
} from '../api/inventory'
import ConfirmDeleteDialog from '../components/ConfirmDeleteDialog'
import ConsumeDialog from '../components/ConsumeDialog'
import InventoryForm, { type InventoryFormValue } from '../components/InventoryForm'
import type { IngredientDefinitionDetail, InventoryRecord } from '../types/api'
import { describeExpiry, formatQuantityWithUnit, groupByDefinition } from '../format'

/**
 * 库存页面。
 *
 * 第 3 节：按 **definition 分组**展示，同一食材可有多条库存记录。
 *
 * ⚠️ 不做跨单位数量聚合（"3 个 + 1 袋"无法相加）。
 *
 * 数据来源：
 *   - GET /api/ingredients  → 库存记录（含 quantity=0 的被后端隐藏）
 *   - GET /api/definitions  → 定义（用于显示分组名称与 allowed_units）
 *
 * 后端返回的库存记录只有 definition_id，没有名称，因此需要在这里做映射。
 */

type Dialog =
  | { kind: 'none' }
  | { kind: 'create' }
  | { kind: 'edit'; record: InventoryRecord }
  | { kind: 'consume'; record: InventoryRecord }
  | { kind: 'delete'; record: InventoryRecord }

interface Props {
  /** 由父组件传入，用于触发定义刷新（定义增删后库存页需要最新列表） */
  definitionsVersion?: number
}

export default function InventoryPage({ definitionsVersion = 0 }: Props) {
  const [records, setRecords] = useState<InventoryRecord[]>([])
  const [definitions, setDefinitions] = useState<IngredientDefinitionDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' })

  /** 定义 ID → 定义 的映射（用于显示名称与可用单位） */
  const definitionMap = useMemo(() => {
    const map = new Map<number, IngredientDefinitionDetail>()
    for (const d of definitions) map.set(d.id, d)
    return map
  }, [definitions])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)

    try {
      // 并行拉取库存与定义
      const [stock, defs] = await Promise.all([listInventory(), listDefinitions()])
      setRecords(stock)
      setDefinitions(defs)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, definitionsVersion])

  function closeDialog() {
    setDialog({ kind: 'none' })
  }

  const groups = useMemo(() => groupByDefinition(records), [records])

  async function handleCreate(value: InventoryFormValue) {
    await createInventory({
      definition_id: value.definition_id,
      quantity: value.quantity,
      unit: value.unit,
      purchase_date: value.purchase_date,
      production_date: value.production_date,
      // 创建时不传 expiry_date 表示交给后端估算
      ...(value.expiry_date !== undefined ? { expiry_date: value.expiry_date } : {}),
      storage_method: value.storage_method,
      note: value.note,
    })
    closeDialog()
    await load()
  }

  async function handleUpdate(id: number, value: InventoryFormValue) {
    await updateInventory(id, {
      // 编辑时也提交 definition_id：允许更换该记录所属的食材
      definition_id: value.definition_id,
      quantity: value.quantity,
      unit: value.unit,
      purchase_date: value.purchase_date,
      production_date: value.production_date,
      // undefined = 不发送（后端保持/按 source 重算）；null = 主动清空
      ...(value.expiry_date !== undefined ? { expiry_date: value.expiry_date } : {}),
      storage_method: value.storage_method,
      note: value.note,
    })
    closeDialog()
    await load()
  }

  async function handleConsume(id: number, amount: number) {
    await consumeInventory(id, { amount })
    closeDialog()
    await load()
  }

  async function handleDelete(id: number) {
    await deleteInventory(id)
    closeDialog()
    await load()
  }

  return (
    <section>
      <div className="section-header">
        <h2>当前库存</h2>
        <button
          type="button"
          className="primary"
          disabled={definitions.length === 0}
          onClick={() => setDialog({ kind: 'create' })}
          title={definitions.length === 0 ? '请先在食材库中添加食材' : undefined}
        >
          + 添加库存
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

      {!loading && !loadError && groups.length === 0 && (
        <div className="empty-state">
          <p>目前没有库存。</p>
          {definitions.length === 0 ? (
            <p className="hint">请先到「食材库」添加食材。</p>
          ) : (
            <button
              type="button"
              className="primary"
              onClick={() => setDialog({ kind: 'create' })}
            >
              添加第一条库存
            </button>
          )}
        </div>
      )}

      {!loading && !loadError && groups.length > 0 && (
        <ul className="group-list">
          {groups.map((group) => {
            const def = definitionMap.get(group.definitionId)
            return (
              <li key={group.definitionId} className="group-card">
                <div className="group-header">
                  <h3 className="group-name">{def?.name ?? `食材 #${group.definitionId}`}</h3>
                  <span className="group-count">{group.records.length} 条库存记录</span>
                </div>

                <ul className="record-list">
                  {group.records.map((record) => {
                    const expiry = describeExpiry(record)
                    return (
                      <li key={record.id} className="record-item">
                        <div className="record-main">
                          <p className="record-quantity">
                            {formatQuantityWithUnit(record.quantity, record.unit)}
                          </p>

                          <p className="record-meta">
                            入库：{record.purchase_date}
                            {record.production_date && `　生产：${record.production_date}`}
                            {`　存储：${record.storage_method}`}
                          </p>

                          {expiry && (
                            <p className={expiry.overdue ? 'record-meta overdue' : 'record-meta'}>
                              {expiry.label}：{expiry.date}
                              {expiry.overdue && <span className="overdue-badge">已超过预计日期</span>}
                            </p>
                          )}

                          {record.note && <p className="record-meta">备注：{record.note}</p>}
                        </div>

                        <div className="record-actions">
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'edit', record })}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => setDialog({ kind: 'consume', record })}
                          >
                            消耗
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => setDialog({ kind: 'delete', record })}
                          >
                            删除
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ul>
      )}

      {dialog.kind === 'create' && (
        <InventoryForm
          definitions={definitions}
          onSubmit={handleCreate}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'edit' && (
        <InventoryForm
          definitions={definitions}
          initial={dialog.record}
          initialDefinition={definitionMap.get(dialog.record.definition_id)}
          onSubmit={(value) => handleUpdate(dialog.record.id, value)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'consume' && (
        <ConsumeDialog
          record={dialog.record}
          definitionName={
            definitionMap.get(dialog.record.definition_id)?.name ??
            `食材 #${dialog.record.definition_id}`
          }
          onSubmit={(amount) => handleConsume(dialog.record.id, amount)}
          onCancel={closeDialog}
        />
      )}

      {dialog.kind === 'delete' && (
        <ConfirmDeleteDialog
          ingredientName={`${formatQuantityWithUnit(
            dialog.record.quantity,
            dialog.record.unit,
          )}（${definitionMap.get(dialog.record.definition_id)?.name ?? '库存记录'}）`}
          onConfirm={() => handleDelete(dialog.record.id)}
          onCancel={closeDialog}
        />
      )}
    </section>
  )
}
