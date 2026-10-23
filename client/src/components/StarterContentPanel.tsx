import { useRef, useState } from 'react'
import { request } from '../api/definitions'

interface Summary {
  inserted_definitions: number
  inserted_recipes: number
  skipped_duplicate: number
  skipped_invalid: number
}
interface Props { disabled?: boolean; onBusyChange?: (busy: boolean) => void }

export default function StarterContentPanel({ disabled = false, onBusyChange }: Props) {
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)

  async function importContent() {
    if (disabled || inFlight.current) return
    if (!window.confirm('导入常用食材和 1211 道测试菜谱？只补充缺少的内容，不覆盖已有内容，也不添加库存。已有食材的单位不兼容时，相应菜谱会跳过。')) return
    inFlight.current = true
    setImporting(true)
    onBusyChange?.(true)
    setMessage('正在导入，请保持应用打开，等待完成提示…')
    try {
      await new Promise(resolve => setTimeout(resolve, 80))
      const result = await request<Summary>('/content/starter', { method: 'POST', body: JSON.stringify({ pack: 'v024' }) })
      setMessage(`导入完成：新增 ${result.inserted_definitions} 种食材、${result.inserted_recipes} 道菜谱。已存在 ${result.skipped_duplicate} 道，未重复添加；单位或标签不兼容等原因跳过 ${result.skipped_invalid} 道。库存未改变。`)
    } catch (error) {
      setMessage(`导入未完成，请重试。${error instanceof Error ? error.message : String(error)}`)
    } finally {
      inFlight.current = false
      setImporting(false)
      onBusyChange?.(false)
    }
  }

  return <section className="settings-group starter-content-panel" aria-busy={importing}>
    <h3>初始内容（可选）</h3>
    <p>添加常用食材和 1211 道测试菜谱，让你从录入家里的库存开始使用。不会自动导入，也不会添加库存。</p>
    <p className="hint">菜谱按家常做法规则整理，未逐条核验；导入后可以修改或删除。已有内容保留，重名跳过，单位或标签不兼容的菜谱会跳过。</p>
    <button type="button" className="btn" disabled={disabled || importing} onClick={() => void importContent()}>导入食材和菜谱</button>
    <p role="status" aria-live="polite">{message}</p>
  </section>
}
