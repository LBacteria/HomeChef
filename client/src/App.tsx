import { useCallback, useState } from 'react'

import DefinitionsPage from './pages/DefinitionsPage'
import InventoryPage from './pages/InventoryPage'
import SettingsPage from './pages/SettingsPage'

/**
 * 应用根组件。
 *
 * 三个视图，用 useState 切换（不引入 react-router）。
 * 食材库发生变化时，通过 definitionsVersion 通知库存页刷新定义列表。
 */

type View = 'inventory' | 'definitions' | 'settings'

export default function App() {
  const [view, setView] = useState<View>('inventory')
  /** 定义变化计数，用于让库存页重新拉取定义 */
  const [definitionsVersion, setDefinitionsVersion] = useState(0)
  /** 设置变化计数：临期设置会影响库存页的临期状态显示 */
  const [settingsVersion, setSettingsVersion] = useState(0)

  const handleDefinitionsChanged = useCallback(() => {
    setDefinitionsVersion((v) => v + 1)
  }, [])

  /** 从设置页切回库存页时，让库存重新拉取（临期状态由后端按最新设置计算） */
  const handleOpenSettings = useCallback(() => {
    setView('settings')
  }, [])

  const handleLeaveSettings = useCallback(() => {
    setSettingsVersion((v) => v + 1)
    setView('inventory')
  }, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1>HomeChef</h1>
        <nav className="nav">
          <button
            type="button"
            className={view === 'inventory' ? 'nav-item active' : 'nav-item'}
            onClick={() => (view === 'settings' ? handleLeaveSettings() : setView('inventory'))}
          >
            库存
          </button>
          <button
            type="button"
            className={view === 'definitions' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('definitions')}
          >
            食材库
          </button>
          <button
            type="button"
            className={view === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={handleOpenSettings}
          >
            设置
          </button>
        </nav>
      </header>

      {view === 'inventory' && (
        <InventoryPage
          definitionsVersion={definitionsVersion}
          settingsVersion={settingsVersion}
        />
      )}
      {view === 'definitions' && (
        <DefinitionsPage onDefinitionsChanged={handleDefinitionsChanged} />
      )}
      {view === 'settings' && <SettingsPage />}
    </div>
  )
}
