import { PotIcon } from './icons'

/**
 * 品牌标识：锅 + 蒸汽 + HomeChef 字样（纯内联 SVG，无外部图片）。
 *
 * ⚠️ 仅作视觉标识；是否需要「点击返回主页」由外层按钮决定，
 *    这里不做任何交互，避免出现嵌套按钮。
 */
interface Props {
  /** 紧凑模式：用于内页顶栏 */
  compact?: boolean
}

export default function BrandLogo({ compact = false }: Props) {
  return (
    <span className={compact ? 'brand brand-compact' : 'brand'}>
      <PotIcon className="brand-icon" />
      <span className="brand-name">HomeChef</span>
    </span>
  )
}
