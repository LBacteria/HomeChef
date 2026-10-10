import { useEffect, useState } from 'react'
import { HexColorInput, HexColorPicker } from 'react-colorful'

/**
 * 网页内嵌的分类颜色选择器（v0.1.4 第一批补充修复）。
 *
 * 背景：原先使用浏览器原生 <input type="color">，其原生弹窗在点击
 *      色相条时会意外关闭，无法连续微调。此组件改为**页面内**选择器。
 *
 * 组成：
 *   - react-colorful 的 HexColorPicker（颜色区域 + 色相条）
 *   - HexColorInput（HEX 色值输入）
 *   - 常用颜色预设色块
 *
 * ⚠️ 三者共用**同一份** color state —— 预设、取色、HEX 输入
 *    不会出现显示值与实际值不一致。
 *
 * ⚠️ 本组件只负责「选色」，不负责保存。
 *    保存由调用方在用户确认（点「保存」）时执行。
 */

/** 常用颜色预设 —— 覆盖色相环并含中性色，与分类标签配色协调 */
const PRESETS: Array<{ name: string; value: string }> = [
  { name: '红色', value: '#E53935' },
  { name: '粉色', value: '#EC407A' },
  { name: '橙色', value: '#FB8C00' },
  { name: '黄色', value: '#FFC107' },
  { name: '绿色', value: '#43A047' },
  { name: '青色', value: '#00897B' },
  { name: '蓝色', value: '#1E88E5' },
  { name: '紫色', value: '#8E24AA' },
  { name: '棕色', value: '#8D6E63' },
  { name: '灰色', value: '#78909C' },
  { name: '浅绿', value: '#7CB342' },
  { name: '深红', value: '#C62828' },
]

interface Props {
  /** 当前颜色（#RRGGBB） */
  color: string
  /** 颜色变化回调（用户每次调整都会触发） */
  onChange: (color: string) => void
  /** 保存中则禁用交互 */
  disabled?: boolean
}

export default function CategoryColorPicker({ color, onChange, disabled = false }: Props) {
  /**
   * 本地状态用于 HEX 输入框的中间态（用户可能只输入了一半）。
   * ⚠️ 外部 color 变化时同步回来，保证显示值与实际值一致。
   */
  const [draft, setDraft] = useState(color)

  useEffect(() => {
    setDraft(color)
  }, [color])

  /** 校验是否为完整合法的 HEX */
  const isCompleteHex = /^#[0-9a-fA-F]{6}$/.test(draft)

  return (
    <div className="color-picker-panel">
      {/* 颜色区域 + 色相条：点击/拖动不会关闭面板 */}
      <HexColorPicker
        color={color}
        onChange={disabled ? undefined : (next) => onChange(next.toUpperCase())}
        style={{ width: '100%', height: 150 }}
      />

      {/* HEX 输入 + 当前颜色 */}
      <div className="color-picker-hex-row">
        <span
          className="color-picker-swatch"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        />
        <HexColorInput
          color={draft}
          onChange={(next) => {
            setDraft(next)
            // 只有输入完整合法的 6 位 HEX 才向上同步，避免中间态写入
            if (/^#[0-9a-fA-F]{6}$/.test(next)) {
              onChange(next.toUpperCase())
            }
          }}
          prefixed
          className="color-picker-hex-input"
          disabled={disabled}
          aria-label="HEX 色值"
        />
        {!isCompleteHex && <span className="color-picker-hint">需 6 位</span>}
      </div>

      {/* 常用颜色预设 */}
      <div className="color-preset-label">常用颜色</div>
      <div className="color-preset-grid">
        {PRESETS.map((p) => {
          const selected = p.value.toLowerCase() === color.toLowerCase()
          return (
            <button
              key={p.value}
              type="button"
              className={selected ? 'color-preset selected' : 'color-preset'}
              style={{ backgroundColor: p.value }}
              disabled={disabled}
              onClick={() => onChange(p.value)}
              title={`${p.name} ${p.value}`}
              aria-label={`${p.name} ${p.value}`}
              aria-pressed={selected}
            />
          )
        })}
      </div>
    </div>
  )
}
