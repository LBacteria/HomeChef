import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import { ingredientDefinition, standardIngredient, ingredientDefinitionUnit } from '../db/schema.js'
import { createDefinition, listDefinitions } from './definitionService.js'
import { createStock, listStock } from './standardIngredientService.js'
import { listCategories } from './categoryService.js'
import { validationError, snapshotStaleError } from './errors.js'

export interface TransferRow {
  name: string; quantity: number; unit: string; purchase_date: string; production_date: string | null;
  expiry_date: string | null; storage_method: string; note: string | null;
  secondary_unit: string | null; secondary_ratio: number | null; seasoning: boolean;
}
function hash(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function stateToken() { return hash([db.select().from(ingredientDefinition).all(), db.select().from(ingredientDefinitionUnit).all(), db.select().from(standardIngredient).all(), listCategories()]) }
export function exportInventory(): {version: 1; rows: TransferRow[]} {
  const definitions = new Map(listDefinitions().map(d => [d.id, d]))
  const categories = new Map(listCategories().map(c => [c.id, c.name]))
  return { version: 1, rows: listStock().filter(s => s.quantity > 0 || categories.get(definitions.get(s.definition_id)?.category_id ?? -1) === '调味品').map(s => ({
    name: definitions.get(s.definition_id)!.name, quantity: s.quantity, unit: s.unit,
    purchase_date: s.purchase_date, production_date: s.production_date, expiry_date: s.expiry_date,
    storage_method: s.storage_method, note: s.note, secondary_unit: s.secondary_unit, secondary_ratio: s.secondary_ratio,
    seasoning: categories.get(definitions.get(s.definition_id)?.category_id ?? -1) === '调味品',
  })) }
}
const fields = ['name','quantity','unit','purchase_date','production_date','expiry_date','storage_method','note','secondary_unit','secondary_ratio','seasoning']
function validateRows(value: unknown): asserts value is TransferRow[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2000) throw validationError('一次导入 1—2000 条库存')
  for (const r of value) {
    if (!r || typeof r !== 'object' || Object.keys(r).some(k => !fields.includes(k)) || fields.some(k => !(k in r))) throw validationError('库存格式不完整，请使用本软件导出的库存码或 Excel 模板')
    if (typeof r.name !== 'string' || r.name.trim().length < 1 || r.name.length > 100 || typeof r.quantity !== 'number' || !Number.isFinite(r.quantity) || r.quantity < 0 || (!r.seasoning && r.quantity <= 0) || typeof r.unit !== 'string' || typeof r.purchase_date !== 'string' || typeof r.storage_method !== 'string' || typeof r.seasoning !== 'boolean') throw validationError('名称、数量、单位、日期或调味品标记格式有误')
    for (const k of ['production_date','expiry_date','note','secondary_unit']) if (r[k] !== null && typeof r[k] !== 'string') throw validationError('库存字段格式有误')
    if (r.note !== null && r.note.length > 2000) throw validationError('备注最多 2000 字')
    if (r.secondary_ratio !== null && (typeof r.secondary_ratio !== 'number' || !Number.isFinite(r.secondary_ratio))) throw validationError('数量关系格式有误')
  }
}
function runRows(rows: TransferRow[]) {
  const results: Array<{row: number; name: string; status: 'add'|'skip'|'error'; message: string}> = []
  const categories = listCategories(); const seasoningId = categories.find(c => c.name === '调味品')!.id
  for (const [index, r] of rows.entries()) {
    try {
      const result = db.transaction(() => {
        let def = listDefinitions().find(d => d.name.trim().toLocaleLowerCase() === r.name.trim().toLocaleLowerCase())
        let created = false
        if (!def) {
          const d = createDefinition({name: r.name, units: r.seasoning ? [] : [...new Set(rows.filter(x => x.name.trim().toLocaleLowerCase() === r.name.trim().toLocaleLowerCase() && !x.seasoning).map(x => x.unit))], category_id: r.seasoning ? seasoningId : null})
          def = listDefinitions().find(x => x.id === d.id)!; created = true
        }
        if ((def.category_id === seasoningId) !== r.seasoning) throw validationError('同名食材的调味品分类不同，请先核对食材库')
        const existing = listStock().filter(s => s.definition_id === def!.id)
        // 先用现有写入校验完整验证这一行；整行在独立保存点中执行。
        createStock({definition_id: def.id, quantity: r.quantity, unit: r.unit,
          purchase_date: r.purchase_date, production_date: r.production_date,
          ...(r.expiry_date === null ? {expiry_date: null} : {shelf_life_days: expiryDays(r)}), storage_method: r.storage_method, note: r.note,
          secondary_unit: r.secondary_unit, secondary_ratio: r.secondary_ratio})
        const sameBatch = existing.find(s => r.seasoning || (s.unit === r.unit && s.purchase_date === r.purchase_date && s.storage_method === r.storage_method && s.expiry_date === r.expiry_date && s.secondary_unit === r.secondary_unit && s.secondary_ratio === r.secondary_ratio))
        // 不合并已有批次，不覆盖数量：抛出标记使本行的试写回滚。
        if (sameBatch) throw {skip: true}
        return created ? '新增食材和库存' : '新增库存批次'
      })
      results.push({row:index+1,name:r.name,status:'add',message:result})
    } catch (e) {
      const skip = !!e && typeof e === 'object' && 'skip' in e
      results.push({row:index+1,name:r.name,status:skip?'skip':'error',message:skip?'已有此批次，跳过；保留本机数量':e instanceof Error?e.message:'库存校验未通过'})
    }
  }
  return results
}
function expiryDays(r: TransferRow) {
  const base = r.production_date ?? r.purchase_date
  const date = r.expiry_date!
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10) !== date) throw validationError('到期日期不合法')
  return (Date.parse(date+'T00:00:00Z') - Date.parse(base+'T00:00:00Z')) / 86400000
}
export function previewInventory(rows: unknown) {
  validateRows(rows)
  const token = stateToken(); const rollback = {}; let results: ReturnType<typeof runRows> = []
  try { db.transaction(() => { results = runRows(rows); throw rollback }) } catch(e) { if(e !== rollback) throw e }
  return {token, rows:results, add:results.filter(r=>r.status==='add').length, skip:results.filter(r=>r.status==='skip').length, errors:results.filter(r=>r.status==='error').length}
}
export function importInventory(rows: unknown, token: unknown) {
  validateRows(rows)
  if (typeof token !== 'string' || token !== stateToken()) throw snapshotStaleError('库存已经变化，请重新预览后确认')
  const preview = previewInventory(rows)
  if (preview.errors) throw validationError('表格中还有错误，本次没有导入任何库存')
  return db.transaction(() => { const result = runRows(rows); if(result.some(r=>r.status==='error')) throw validationError('库存校验未通过，本次导入已全部撤回'); return {added:result.filter(r=>r.status==='add').length, skipped:result.filter(r=>r.status==='skip').length} })
}
