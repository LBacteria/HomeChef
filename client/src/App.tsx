import { useCallback, useState } from 'react'

import BrandLogo from './components/BrandLogo'
import MoreToolsPanel from './components/MoreToolsPanel'
import CookingPage from './pages/CookingPage'
import DefinitionsPage from './pages/DefinitionsPage'
import HomePage from './pages/HomePage'
import InventoryPage from './pages/InventoryPage'
import RecipesPage from './pages/RecipesPage'
import RecommendPage from './pages/RecommendPage'
import SettingsPage from './pages/SettingsPage'

/**
 * 应用根组件。
 *
 * v0.2.1.1 主页改版：
 *   - **主页（home）是默认入口**：中式灶台环形导航，不显示旧顶部 tabs
 *     （避免与主页圆环重复堆叠）。
 *   - 内页使用**紧凑导航**：品牌标识 + 主页 / 库存 / 菜谱 / 烹饪 / 设置 / 更多。
 *   - **食材库**入口统一收进「更多功能」，页面本身完整保留。
 *   - 全部业务页面与既有状态规则不变（仍用 useState 切换，不引入 react-router）。
 *
 * 原有的两个版本号仍照旧传递：
 *   - `definitionsVersion`：食材库变化 → 库存页重新拉取定义
 *   - `settingsVersion`：离开设置页去库存时 +1（临期状态由后端按最新设置计算）
 */

type View =
  | 'home'
  | 'inventory'
  | 'definitions'
  | 'recipes'
  | 'cooking'
  | 'settings'
  | 'recommend'

export default function App() {
  const [view, setView] = useState<View>('home')
  const [moreOpen, setMoreOpen] = useState(false)

  /**
   * v0.2.2：推荐流程创建好会话后，让烹饪页**直接打开这个会话**。
   *
   * ⚠️ 只影响「初次进入要展开哪个会话」；烹饪页其余逻辑（列表、加菜、
   *    步骤、结算）完全沿用，未重写。
   * ⚠️ 走导航栏的「烹饪」入口时会被清空，仍回到会话列表。
   */
  const [cookingInitialSessionId, setCookingInitialSessionId] = useState<number | null>(null)

  /** 定义变化计数，用于让库存页重新拉取定义 */
  const [definitionsVersion, setDefinitionsVersion] = useState(0)
  /** 设置变化计数：临期设置会影响库存页的临期状态显示 */
  const [settingsVersion, setSettingsVersion] = useState(0)

  const handleDefinitionsChanged = useCallback(() => {
    setDefinitionsVersion((v) => v + 1)
  }, [])

  /**
   * 统一导航。
   *
   * ⚠️ 保留既有行为：**从设置页去库存页时**才递增 `settingsVersion`，
   *    使库存重新拉取（临期状态依赖设置）。其余切换不产生额外副作用。
   */
  function navigate(next: View) {
    setMoreOpen(false)
    // 走导航进烹饪页 = 看会话列表，清掉「直达某会话」
    if (next === 'cooking') {
      setCookingInitialSessionId(null)
    }
    if (next === 'inventory' && view === 'settings') {
      setSettingsVersion((v) => v + 1)
    }
    setView(next)
  }

  /** v0.2.2：推荐确认后直达新建的会话 */
  function openSession(sessionId: number) {
    setMoreOpen(false)
    setCookingInitialSessionId(sessionId)
    setView('cooking')
  }

  /* ---------- 主页：独立整屏，不带旧顶部 tabs ---------- */
  if (view === 'home') {
    return (
      <div className="app">
        <HomePage onNavigate={navigate} onOpenMore={() => setMoreOpen(true)} />
        {moreOpen && (
          <MoreToolsPanel
            onClose={() => setMoreOpen(false)}
            onOpenDefinitions={() => navigate('definitions')}
            onOpenManualCooking={() => navigate('cooking')}
          />
        )}
      </div>
    )
  }

  /* ---------- 内页：紧凑导航 ---------- */
  return (
    <div className="app">
      <div className="page">
        <header className="page-header app-header">
          <button
            type="button"
            className="brand-button"
            onClick={() => navigate('home')}
            aria-label="返回主页"
          >
            <BrandLogo compact />
          </button>

          <nav className="nav app-nav" aria-label="主导航">
            <button
              type="button"
              className={view === 'inventory' ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate('inventory')}
            >
              库存
            </button>
            <button
              type="button"
              className={view === 'recipes' ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate('recipes')}
            >
              菜谱
            </button>
            <button
              type="button"
              /*
               * v0.2.2：「推荐」属于烹饪流程的一部分，因此二者共用「烹饪」高亮
               * （否则处在推荐页时会出现**没有任何导航项高亮**的情况）。
               */
              className={
                view === 'cooking' || view === 'recommend' ? 'nav-item active' : 'nav-item'
              }
              onClick={() => navigate('cooking')}
            >
              烹饪
            </button>
            <button
              type="button"
              className={view === 'settings' ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate('settings')}
            >
              设置
            </button>
            <button
              type="button"
              /*
               * ⚠️ 只按**当前页面**判断高亮。
               *    食材库页（view === 'definitions'）唯一对应「更多」这一项，
               *    因此这里只看 view。
               *
               * 旧写法是 `moreOpen && view === 'definitions'`：进入食材库时
               * navigate() 会把 moreOpen 置回 false，条件永远不成立 ——
               * 导致食材库页**没有任何导航项高亮**。
               * 也不能只看 moreOpen：面板是浮层，打开它不改变所在页面。
               */
              className={view === 'definitions' ? 'nav-item active' : 'nav-item'}
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
            >
              更多
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
        {view === 'recipes' && <RecipesPage />}
        {view === 'cooking' && <CookingPage initialSessionId={cookingInitialSessionId} />}
        {view === 'recommend' && (
          <RecommendPage
            onBack={() => navigate('home')}
            onApplied={openSession}
            onManual={() => navigate('cooking')}
          />
        )}
        {view === 'settings' && <SettingsPage />}
      </div>

      {moreOpen && (
        <MoreToolsPanel
          onClose={() => setMoreOpen(false)}
          onOpenDefinitions={() => navigate('definitions')}
          onOpenManualCooking={() => navigate('cooking')}
        />
      )}
    </div>
  )
}
