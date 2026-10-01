import { useCallback, useState } from 'react'

import DefinitionsPage from './pages/DefinitionsPage'
import InventoryPage from './pages/InventoryPage'

/**
 * 应用根组件。
 *
 * 只有两个视图，用 useState 切换（不引入 react-router）。
 * 食材库发生变化时，通过 definitionsVersion 通知库存页刷新定义列表。
 */

type View = 'inventory' | 'definitions'

export default function App() {
  const [view, setView] = useState<View>('inventory')
  /** 定义变化计数，用于让库存页重新拉取定义 */
  const [definitionsVersion, setDefinitionsVersion] = useState(0)

  const handleDefinitionsChanged = useCallback(() => {
    setDefinitionsVersion((v) => v + 1)
  }, [])

  return (
    <div className="page">
      <header className="page-header">
        <h1>HomeChef</h1>
        <nav className="nav">
          <button
            type="button"
            className={view === 'inventory' ? 'nav-item active' : 'nav-item'}
            onClick={() => setView('inventory')}
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
        </nav>
      </header>

      {view === 'inventory' ? (
        <InventoryPage definitionsVersion={definitionsVersion} />
      ) : (
        <DefinitionsPage onDefinitionsChanged={handleDefinitionsChanged} />
      )}
    </div>
  )
}
