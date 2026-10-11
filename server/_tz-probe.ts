/**
 * 时区探针（供 verify-dates.ts 的时区测试以子进程方式调用）。
 *
 * 用法：TZ=<时区> npx tsx _tz-probe.ts <固定时刻 ISO>
 *
 * 输出：<todayDateString(固定时刻)>|<UTC 日期>
 *
 * ⚠️ 关键：第一段**必须调用真实的 todayDateString(fixedDate)**，
 *    绝不在探针里自行重算本地日期 —— 否则测的是探针自己的逻辑，
 *    即使 todayDateString 被改回 UTC 也不会失败（假阳性保护）。
 *
 * ⚠️ 固定时刻必须显式带 Z（UTC 标记），避免被解析为运行机器的本地时间。
 *    这里强制校验这一点。
 */
import { todayDateString } from './src/services/dates.js'

const fixed = process.argv[2] ?? '2026-10-11T23:30:00Z'

// 固定时刻必须显式带时区标记（Z 或 ±HH:MM），否则不同机器解析结果不同
if (!/(Z|[+-]\d{2}:\d{2})$/.test(fixed)) {
  console.error(`固定时刻必须显式带时区标记（例如 ...Z），收到：${fixed}`)
  process.exit(2)
}

const t = new Date(fixed)
if (Number.isNaN(t.getTime())) {
  console.error(`无法解析固定时刻：${fixed}`)
  process.exit(2)
}

// 第一段：**真实函数**在注入固定时刻后的结果（这才是被测对象）
const fromRealFunction = todayDateString(t)
// 第二段：同一时刻的 UTC 日期，用于对照
const utcDate = t.toISOString().slice(0, 10)

console.log(`${fromRealFunction}|${utcDate}`)
