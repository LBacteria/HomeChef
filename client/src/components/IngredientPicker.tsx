import { useCallback, useEffect, useRef, useState } from 'react'

import { listDefinitions } from '../api/definitions'
import type { IngredientDefinitionDetail } from '../types/api'

/**
 * 可搜索的食材选择器。
 *
 * ---------------------------------------------------------------------------
 * 设计要点
 * ---------------------------------------------------------------------------
 * 1. **复用现有搜索 API**：GET /api/definitions?search=
 *    后端 searchDefinitions() 已实现「默认名称 + 别名」的 substring 匹配，
 *    本组件不重新设计搜索算法，也不做任何本地过滤。
 *
 * 2. **选中的是 definition.id**，不是名称。
 *    onChange 回调传递完整 definition 对象，调用方只使用其中的 id。
 *    绝不通过名称反查 ID。
 *
 * 3. 别名只是**同一条结果的补充说明**，不会作为独立条目出现。
 *
 * 4. 无结果时显示提示，**不自动创建** ingredient_definition。
 *
 * 5. 不引入任何新依赖；debounce 用原生 setTimeout 实现。
 */

interface Props {
  /** 当前选中的 definition id（受控） */
  value: number | ''
  /** 选中变化时回调；清空时传 null */
  onChange: (definition: IngredientDefinitionDetail | null) => void
  /** 已选中的 definition（用于回显名称，可选） */
  selected?: IngredientDefinitionDetail
  /** 搜索框占位符 */
  placeholder?: string
  /** 是否自动聚焦 */
  autoFocus?: boolean
  /** 禁用 */
  disabled?: boolean
}

/** 轻量 debounce 延迟（毫秒）。不引入依赖。 */
const DEBOUNCE_MS = 200

export default function IngredientPicker({
  value,
  onChange,
  selected,
  placeholder = '搜索食材（支持别名）…',
  autoFocus = false,
  disabled = false,
}: Props) {
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<IngredientDefinitionDetail[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  /** 丢弃过期响应，避免竞态 */
  const requestSeq = useRef(0)
  /** debounce 定时器 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 容器引用，用于点击外部关闭 */
  const containerRef = useRef<HTMLDivElement | null>(null)

  /* ------------------------------------------------------------
   * 搜索：调用现有 API，不做本地过滤
   * ------------------------------------------------------------ */
  const runSearch = useCallback(async (search: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)

    try {
      // search 为空时后端返回全部定义
      const data = await listDefinitions(search)
      if (seq === requestSeq.current) {
        setOptions(data)
      }
    } catch (err) {
      if (seq === requestSeq.current) {
        setError(err instanceof Error ? err.message : String(err))
        setOptions([])
      }
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false)
      }
    }
  }, [])

  /* ------------------------------------------------------------
   * 打开面板时才加载；输入变化时 debounce 搜索
   * ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return

    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
    }

    timerRef.current = setTimeout(() => {
      void runSearch(query)
    }, DEBOUNCE_MS)

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
      }
    }
  }, [open, query, runSearch])

  /* ------------------------------------------------------------
   * 点击外部关闭
   * ------------------------------------------------------------ */
  useEffect(() => {
    if (!open) return

    function handleClickOutside(event: MouseEvent) {
      const el = containerRef.current
      if (el && !el.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  function handleSelect(definition: IngredientDefinitionDetail) {
    // ⚠️ 传出的是 definition 对象，调用方只应使用其中的 id
    onChange(definition)
    setOpen(false)
    setQuery('')
  }

  function handleClear() {
    onChange(null)
    setQuery('')
  }

  const hasSelection = value !== '' && selected !== undefined

  return (
    <div className="picker" ref={containerRef}>
      {/* 已选中：显示当前食材 + 更换/清除 */}
      {hasSelection ? (
        <div className="picker-selected">
          <div className="picker-selected-main">
            <span className="picker-selected-name">{selected.name}</span>
            {selected.aliases.length > 0 && (
              <span className="picker-selected-aliases">
                {selected.aliases.map((a) => a.alias).join(' · ')}
              </span>
            )}
          </div>
          {!disabled && (
            <div className="picker-selected-actions">
              <button
                type="button"
                onClick={() => {
                  setOpen((v) => !v)
                }}
              >
                更换
              </button>
              <button type="button" onClick={handleClear}>
                清除
              </button>
            </div>
          )}
        </div>
      ) : (
        <input
          type="text"
          className="picker-input"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
        />
      )}

      {/* 面板 */}
      {open && !disabled && (
        <div className="picker-panel">
          {hasSelection && (
            <input
              type="text"
              className="picker-input picker-input-inline"
              value={query}
              placeholder={placeholder}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {loading && <p className="picker-status">加载中...</p>}

          {!loading && error && (
            <div className="picker-status picker-error">
              <p>搜索失败：{error}</p>
              <button type="button" onClick={() => void runSearch(query)}>
                重试
              </button>
            </div>
          )}

          {!loading && !error && options.length === 0 && (
            <p className="picker-status">未找到匹配的食材</p>
          )}

          {!loading && !error && options.length > 0 && (
            <ul className="picker-list">
              {options.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className={
                      d.id === value ? 'picker-option picker-option-active' : 'picker-option'
                    }
                    onClick={() => handleSelect(d)}
                  >
                    <span className="picker-option-name">{d.name}</span>
                    {d.aliases.length > 0 && (
                      <span className="picker-option-aliases">
                        {d.aliases.map((a) => a.alias).join(' · ')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
