import type { CSSProperties } from 'react'

import { DialIcon, JarIcon, MoreIcon, PotIcon, RecipeIcon } from '../components/icons'
import BrandLogo from '../components/BrandLogo'
import kitchenBg from '../assets/kitchen-bg.webp'

/**
 * 主页（v0.2.1.1 中式灶台改版）。
 *
 * 结构
 * ────
 *   - 背景：`assets/kitchen-bg.webp`（干净厨房实拍），**纯装饰层**，
 *     不承载任何交互；文字与按钮全部是**真实 DOM**。
 *   - 中央：铸铁灶眼样式的圆形「开始烹饪」按钮 → 进入**现有烹饪页**
 *     （不直接创建空会话，会话仍由烹饪页内部创建）。
 *   - 外围：四段**有间隙的圆环扇形**，真正环绕中央圆。
 *     每段是独立的 `<button>`，键盘可达、有图标与文字标签。
 *
 * 实现选择（尽量低维护成本）
 * ──────────────────────────
 *   - 圆环用**内联 SVG 扇形路径**绘制（几何由常量算出，不依赖图片）；
 *   - 每段扇形与其按钮**一一对应**：按钮铺满整个灶台并用 `clip-path`
 *     限制到自己的象限，所以 hover / focus / 按压都能直接作用在扇形本身，
 *     不会出现「看得见却点不到」的假按钮；
 *   - 不引入任何新依赖、不使用外部图片热链。
 */

/* ---------- 圆环几何（viewBox 坐标系）---------- */

const VB = 400
const C = VB / 2
/** 外半径 / 内半径：内半径与中央圆之间留出可见间隙 */
const R_OUT = 196
const R_IN = 112
/** 象限交接处的角度间隙（度） */
const GAP = 9

/** 环带中径：标签落在这里，正好是扇形厚度的一半 */
const R_MID = (R_OUT + R_IN) / 2
/**
 * 象限对角方向（45°）上，中径点距容器中心的百分比 —— 也就是标签中心位置。
 *
 * 200 + 154·cos45° = 308.9（viewBox 400 宽）→ **77.2%**；对称位置为 **22.8%**。
 */
const MID_FAR_PCT = 50 + (R_MID / VB) * 100 * Math.SQRT1_2
const MID_NEAR_PCT = 100 - MID_FAR_PCT

/** 左右/上下两侧的标签定位，供 CSS 变量复用 */
const STOVE_VARS = {
  '--arc-far': `${MID_FAR_PCT.toFixed(2)}%`,
  '--arc-near': `${MID_NEAR_PCT.toFixed(2)}%`,
} as CSSProperties

function pointAt(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [C + r * Math.cos(a), C + r * Math.sin(a)]
}

/** 生成一段圆环扇形（外弧 → 内弧闭合）*/
function arcPath(start: number, end: number): string {
  const [x1, y1] = pointAt(R_OUT, start)
  const [x2, y2] = pointAt(R_OUT, end)
  const [x3, y3] = pointAt(R_IN, end)
  const [x4, y4] = pointAt(R_IN, start)
  const f = (n: number) => n.toFixed(2)
  return [
    `M ${f(x1)} ${f(y1)}`,
    `A ${R_OUT} ${R_OUT} 0 0 1 ${f(x2)} ${f(y2)}`,
    `L ${f(x3)} ${f(y3)}`,
    `A ${R_IN} ${R_IN} 0 0 0 ${f(x4)} ${f(y4)}`,
    'Z',
  ].join(' ')
}

/**
 * 四个象限的角度区间（SVG 坐标，y 轴向下，0° = 向右）。
 *
 * 每个象限各让出 `GAP` 度，形成参考图中「有间隙的四段弧」：
 *   · 左上 180°–270° → 库存        · 右上 270°–360° → 菜谱
 *   · 左下  90°–180° → 设置        · 右下   0°– 90° → 更多功能
 */
const ARC = {
  tl: arcPath(180 + GAP, 270 - GAP),
  tr: arcPath(270 + GAP, 360 - GAP),
  bl: arcPath(90 + GAP, 180 - GAP),
  br: arcPath(0 + GAP, 90 - GAP),
} as const

export type HomeTarget =
  | 'inventory'
  | 'recipes'
  | 'settings'
  | 'cooking'
  | 'definitions'
  | 'recommend'

interface Props {
  /** 跳转到内页 */
  onNavigate: (view: HomeTarget) => void
  /** 打开「更多功能」面板（食材库入口在其中）*/
  onOpenMore: () => void
}

export default function HomePage({ onNavigate, onOpenMore }: Props) {
  return (
    <main className="home">
      <div
        className="home-bg"
        style={{ backgroundImage: `url(${kitchenBg})` }}
        aria-hidden="true"
      />
      <div className="home-veil" aria-hidden="true" />

      <div className="home-inner">
        <header className="home-top">
          <BrandLogo />
        </header>

        <h1 className="home-title">
          今天，想做点什么？
          <span className="home-title-rule" aria-hidden="true" />
        </h1>

        <div className="stove" style={STOVE_VARS}>
          {/* 左上：库存 */}
          <button
            type="button"
            className="arc-btn arc-tl"
            onClick={() => onNavigate('inventory')}
          >
            <svg className="arc-svg" viewBox={`0 0 ${VB} ${VB}`} aria-hidden="true" focusable="false">
              <path className="arc-path" d={ARC.tl} />
            </svg>
            <span className="arc-inner">
              <JarIcon className="arc-icon" />
              <span className="arc-label">库存</span>
            </span>
          </button>

          {/* 右上：菜谱 */}
          <button type="button" className="arc-btn arc-tr" onClick={() => onNavigate('recipes')}>
            <svg className="arc-svg" viewBox={`0 0 ${VB} ${VB}`} aria-hidden="true" focusable="false">
              <path className="arc-path" d={ARC.tr} />
            </svg>
            <span className="arc-inner">
              <RecipeIcon className="arc-icon" />
              <span className="arc-label">菜谱</span>
            </span>
          </button>

          {/* 左下：设置 */}
          <button type="button" className="arc-btn arc-bl" onClick={() => onNavigate('settings')}>
            <svg className="arc-svg" viewBox={`0 0 ${VB} ${VB}`} aria-hidden="true" focusable="false">
              <path className="arc-path" d={ARC.bl} />
            </svg>
            <span className="arc-inner">
              <DialIcon className="arc-icon" />
              <span className="arc-label">设置</span>
            </span>
          </button>

          {/* 右下：更多功能（食材库入口在其中）*/}
          <button type="button" className="arc-btn arc-br" onClick={onOpenMore}>
            <svg className="arc-svg" viewBox={`0 0 ${VB} ${VB}`} aria-hidden="true" focusable="false">
              <path className="arc-path" d={ARC.br} />
            </svg>
            <span className="arc-inner">
              <MoreIcon className="arc-icon" />
              <span className="arc-label">更多功能</span>
              <span className="arc-hint">食材库 · 更多工具</span>
            </span>
          </button>

          {/*
            中央：铸铁灶眼 —— v0.2.2 起进入**整餐推荐**流程
            （人数 → 推荐 → 核对 → 原子创建会话 → 既有烹饪页）。
            手动选菜入口在「更多功能」面板里，原功能完全保留。
          */}
          <button
            type="button"
            className="stove-center"
            onClick={() => onNavigate('recommend')}
          >
            <span className="stove-glow" aria-hidden="true" />
            <PotIcon className="stove-center-icon" />
            <span className="stove-center-title">开始烹饪</span>
            <span className="stove-center-sub">开启今天的美味</span>
          </button>
        </div>
      </div>
    </main>
  )
}

/** 供样式复用（避免魔法数字散落两处）*/
export const ARC_MID_PERCENT = MID_FAR_PCT
