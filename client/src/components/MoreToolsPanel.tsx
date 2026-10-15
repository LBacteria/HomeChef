import { useEffect, useRef } from 'react'

import { JarIcon } from './icons'

/**
 * 「更多功能」面板（v0.2.1.1 主页改版）。
 *
 * 食材库入口放在这里 —— 主页圆环与内页紧凑导航都不再单独占一个顶部 tab，
 * 避免与主页环形入口重复堆叠；食材库页面本身完整保留。
 * 仅收录**既有**功能入口，不新增任何业务能力。
 *
 * 层级（修复「标题盖住面板」）
 * ────────────────────────────
 *   `.modal-backdrop` 是 `position: fixed` 但**没有 z-index**，
 *   而主页的 `.home-inner` 有 `z-index: 1` —— 于是标题会画在遮罩之上。
 *   这里额外挂 `.more-backdrop` 类给出**明确的覆盖层**（z-index: 1000），
 *   只作用于本面板，**不改动其它业务对话框**的既有行为。
 *
 * 无障碍
 * ──────
 *   - `role="dialog"` + `aria-modal="true"`
 *   - 打开时把焦点移入面板；Tab / Shift+Tab **约束在面板内循环**，
 *     键盘不会操作到背后的主页
 *   - 关闭（按钮或 Esc）后焦点**回到触发它的元素**
 */
interface Props {
  onClose: () => void
  /** 进入食材库（由调用方负责关闭面板与切换视图）*/
  onOpenDefinitions: () => void
}

/** 焦点约束的候选元素（与项目其它对话框无关，只在本组件内使用）*/
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export default function MoreToolsPanel({ onClose, onOpenDefinitions }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const firstItemRef = useRef<HTMLButtonElement | null>(null)

  /**
   * ⚠️ 用 ref 承载 `onClose`：调用方每次渲染都会传入新的箭头函数，
   *    若把它放进 effect 依赖，effect 会反复重跑并**每次重置焦点**。
   */
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    /** 打开前的焦点位置：关闭时归还 */
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // 进入面板：焦点落到第一个可操作项
    firstItemRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return

      const root = panelRef.current
      if (root === null) return

      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) return

      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const outside = !(active instanceof Node) || !root.contains(active)

      // 到边界就环回，保证焦点始终留在面板内
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      // 焦点还给触发处，避免关闭后落到 <body>
      if (trigger !== null && document.contains(trigger)) trigger.focus()
    }
  }, [])

  return (
    <div
      className="modal-backdrop more-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="更多功能"
    >
      <div className="modal more-modal" ref={panelRef}>
        <h2>更多功能</h2>

        <ul className="tool-list">
          <li>
            <button
              type="button"
              className="tool-item"
              ref={firstItemRef}
              onClick={onOpenDefinitions}
            >
              <JarIcon className="tool-icon" />
              <span className="tool-text">
                <span className="tool-name">食材库</span>
                <span className="tool-desc">管理食材定义、别名与允许单位</span>
              </span>
            </button>
          </li>
        </ul>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
