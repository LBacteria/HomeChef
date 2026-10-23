import { registerPlugin } from '@capacitor/core';
import { useState } from 'react';
import StarterContentPanel from '@homechef/client/src/components/StarterContentPanel';

const files = registerPlugin<{
  exportBackup(): Promise<{ cancelled: boolean }>;
  importBackup(): Promise<{ cancelled: boolean }>;
}>('HomeChefFiles');

export default function MobileDataTools() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function perform(restore: boolean) {
    if (busy) return;
    if (restore && !window.confirm('恢复备份会替换这台手机上当前的所有HomeChef数据。建议先导出一份备份。继续选择备份文件？')) return;
    setBusy(true);
    setMessage('');
    try {
      const result = restore ? await files.importBackup() : await files.exportBackup();
      if (result.cancelled) setMessage('已取消，当前数据未改变。');
      else if (restore) { setMessage('恢复完成，正在重新打开…'); window.location.reload(); }
      else setMessage('备份已导出，请妥善保存。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  return <>
    <StarterContentPanel disabled={busy} onBusyChange={setBusy} />
    <section className="settings-group mobile-data-tools">
      <h3>手机数据</h3>
      <p>数据保存在这台手机里，不需要电脑或网络。卸载或清除数据前，请先导出备份。</p>
      <div className="mobile-data-actions">
        <button className="btn" disabled={busy} onClick={() => perform(false)}>导出备份</button>
        <button className="btn" disabled={busy} onClick={() => perform(true)}>恢复备份</button>
      </div>
      <p className="hint">恢复会替换手机上的当前数据。仅支持结构兼容的安卓备份，不会自动同步电脑数据。</p>
      <p role="status">{message}</p>
      <small>HomeChef Android · v0.2.5</small>
    </section>
  </>;
}
