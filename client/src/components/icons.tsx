/**
 * 主页图标（v0.2.2 主页改版）。
 *
 * ⚠️ 全部为**内联 SVG**，用 `currentColor` 跟随文字颜色：
 *    - 不引入图标库、不依赖外部图片热链
 *    - `aria-hidden` —— 图标纯装饰，语义由按钮文字与 aria-label 提供
 */

interface IconProps {
  className?: string
}

/** 锅 + 蒸汽：主页 Logo 与中央「开始烹饪」共用 */
export function PotIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* 蒸汽 */}
      <path d="M18 12c0-2.6 2.8-3 2.8-5.4S18 4 18 2.2" />
      <path d="M27 12c0-2.6 2.8-3 2.8-5.4S27 4 27 2.2" />
      {/* 锅盖提手 */}
      <path d="M24 24v-4.6" />
      <circle cx="24" cy="17.2" r="2.6" fill="currentColor" stroke="none" />
      {/* 锅沿与锅身 */}
      <path d="M7.5 24h33" />
      <path d="M11 24c0 9.6 5.6 15.4 13 15.4S37 33.6 37 24" />
    </svg>
  )
}

/** 陶罐：库存 */
export function JarIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6.4" y="10" width="11.2" height="12" rx="3.6" />
      <rect x="8" y="6.6" width="8" height="4" rx="1.7" />
      <rect x="10.1" y="4" width="3.8" height="2.6" rx="1.2" />
    </svg>
  )
}

/** 菜谱本：菜谱 */
export function RecipeIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.6" y="4.2" width="14.8" height="15.6" rx="2.6" />
      <path d="M8.2 9h7.6" />
      <path d="M8.2 12.6h7.6" />
      <path d="M8.2 16.2h4.4" />
    </svg>
  )
}

/** 旋钮 + 刻度：设置 */
export function DialIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4.4" />
      <path d="M12 12l2.9-2.9" />
      <path d="M12 3.4v2" />
      <path d="M12 18.6v2" />
      <path d="M3.4 12h2" />
      <path d="M18.6 12h2" />
      <path d="M5.9 5.9l1.4 1.4" />
      <path d="M16.7 16.7l1.4 1.4" />
      <path d="M18.1 5.9l-1.4 1.4" />
      <path d="M7.3 16.7l-1.4 1.4" />
    </svg>
  )
}

/** 圆圈省略号：更多功能 */
export function MoreIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="8.2" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.8" cy="12" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  )
}
