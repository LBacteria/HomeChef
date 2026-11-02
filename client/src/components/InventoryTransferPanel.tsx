import { useState } from 'react'
import InventoryTransfer from './InventoryTransfer'

export default function InventoryTransferPanel() {
  const [open, setOpen] = useState(false)
  return <section className="settings-group">
    <h3>库存导入 / 导出</h3>
    <p className="hint">使用库存码、二维码图片或 Excel 传递库存，导入前先预览确认。</p>
    <button type="button" onClick={() => setOpen(true)}>库存导入 / 导出</button>
    {open && <InventoryTransfer onClose={() => setOpen(false)} onImported={async () => {}} />}
  </section>
}
