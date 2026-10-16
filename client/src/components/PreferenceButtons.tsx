import { useRef, useState } from 'react'

import { ApiError } from '../types/api'
import type { RecipePreferenceValue } from '../types/api'

/**
 * v0.2.3 单菜偏好按钮（喜欢 / 不喜欢 / 取消）。
 *
 * 设计要点：
 *   1. **只针对单道菜谱**（recipe_id），不支持整餐评价；
 *   2. 显示的是**服务端确认过**的 `value`（由父组件持有），
 *      本组件**不乐观改写**按钮状态 —— 失败时按钮保持原值并给出错误提示，
 *      避免出现「界面说点踩成功、实际没落库」的假状态；
 *   3. 防连点采用**同步 ref 锁**（与 `RecommendPage.applyLock` / 表单
 *      `submittingRef` 同一模式）：`useState` 的 `disabled` 要等重渲染才生效，
 *      同一事件循环内的连点仍会发出第二个请求；
 *      因此必须在 `await` **之前**同步置位，并在 `finally` 释放；
 *   4. 再点一次同一个评价 = **取消**（等价于传 null）；
 *   5. 键盘可操作：原生 `<button>` + `aria-pressed`。
 */

interface Props {
  /** 服务端确认的当前偏好；null = 无评价 */
  value: RecipePreferenceValue | null
  /**
   * 写入偏好。`null` 表示取消。
   * ⚠️ 成功必须 resolve，失败必须 reject —— 本组件据此显示错误。
   */
  onSet: (next: RecipePreferenceValue | null) => Promise<void>
  disabled?: boolean
  /** 紧凑样式（用于推荐页每道菜的行内） */
  compact?: boolean
}

export default function PreferenceButtons({ value, onSet, disabled = false, compact = false }: Props) {
  const [pending, setPending] = useState<RecipePreferenceValue | 'none' | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** ⚠️ 同步互斥锁：必须在任何 await **之前**置位 */
  const lockRef = useRef(false)

  const busy = pending !== null

  async function apply(next: RecipePreferenceValue | null) {
    if (lockRef.current || disabled) return
    lockRef.current = true // ← 同步置位，杜绝同一事件循环内的连点
    setPending(next ?? 'none')
    setError(null)
    try {
      await onSet(next)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存评价失败，请重试')
    } finally {
      lockRef.current = false
      setPending(null)
    }
  }

  /** 点击已选中的评价 → 取消 */
  function toggle(target: RecipePreferenceValue) {
    void apply(value === target ? null : target)
  }

  return (
    <div className={compact ? 'pref-buttons pref-buttons-compact' : 'pref-buttons'}>
      <button
        type="button"
        className={value === 'like' ? 'pref-btn pref-btn-like active' : 'pref-btn pref-btn-like'}
        aria-pressed={value === 'like'}
        disabled={disabled || busy}
        title="喜欢：推荐时软加权"
        onClick={() => toggle('like')}
      >
        {pending === 'like' ? '保存中…' : '👍 喜欢'}
      </button>
      <button
        type="button"
        className={value === 'dislike' ? 'pref-btn pref-btn-dislike active' : 'pref-btn pref-btn-dislike'}
        aria-pressed={value === 'dislike'}
        disabled={disabled || busy}
        title="不喜欢：推荐时软降权，但不会排除这道菜"
        onClick={() => toggle('dislike')}
      >
        {pending === 'dislike' ? '保存中…' : '👎 不喜欢'}
      </button>
      <button
        type="button"
        className="pref-btn pref-btn-clear"
        disabled={disabled || busy || value === null}
        title="取消评价"
        onClick={() => void apply(null)}
      >
        {pending === 'none' ? '保存中…' : '取消评价'}
      </button>
      {error !== null && (
        <span className="pref-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
