import { parseAssistantInput } from './assistant'
import type { AssistantChoice, AssistantCommand, AssistantContext } from './assistant'

export interface AssistantChatMessage { id: number; role: 'user' | 'assistant'; text: string }
export type PendingDialogue = { kind: 'change' } | { kind: 'partial'; command: AssistantCommand; unknown: string }
export type DialogueTurn =
  | { kind: 'command'; command: AssistantCommand }
  | { kind: 'question'; message: string; choices: AssistantChoice[]; pending: PendingDialogue | null }
  | { kind: 'cancel'; message: string }

const skipUnknown: AssistantChoice = { label: '暂不应用这些要求，继续选菜', text: '暂不应用这些要求，继续选菜' }
const cancel: AssistantChoice = { label: '先不改', text: '先不改' }
const changes: AssistantChoice[] = [{ label: '只换汤', text: '只换汤' }, { label: '换整套', text: '换整套' }, cancel]

function conditionSlots(command: AssistantCommand): AssistantCommand {
  const slots: AssistantCommand = {}
  for (const key of ['people', 'light', 'no_spicy', 'simplify', 'timeRequested', 'ingredients', 'cuisine'] as const) {
    if (command[key] !== undefined) Object.assign(slots, { [key]: command[key] })
  }
  return slots
}

function askPartial(command: AssistantCommand, unknown: string): DialogueTurn {
  const parts: string[] = []
  if (command.people !== undefined) parts.push(`${command.people}个人吃`)
  if (command.light !== undefined) parts.push(command.light ? '清淡些' : '不限清淡')
  if (command.no_spicy !== undefined) parts.push(command.no_spicy ? '避开常见辣味' : '不限辣味')
  if (command.simplify !== undefined) parts.push(command.simplify ? '做法省事些' : '不限定快手菜')
  if (command.timeRequested) parts.push('半小时的耗时要求（目前无法保证）')
  if (command.ingredients !== undefined) parts.push(command.ingredients.length ? '指定食材：' + command.ingredients.join('、') : '不限食材')
  if (command.cuisine !== undefined) parts.push(command.cuisine || '不限菜系')
  return {
    kind: 'question',
    message: `已识别（待确认）：${parts.join('；')}。\n未处理：${unknown}。\n处理状态：等待确认，本餐未改变。`,
    choices: [skipUnknown, cancel],
    pending: { kind: 'partial', command, unknown },
  }
}

/** Clarifications live only in the meal page. This function never applies a meal or writes stock. */
export function resolveDialogueTurn(raw: string, context: AssistantContext, pending: PendingDialogue | null): DialogueTurn {
  const text = raw.trim().replace(/[，,。！!？?\s]+/g, '')
  const answer = pending ? text.replace(/^(?:我的意思是|我是说|我指的是|就是说|是指|就是|是)/, '') : text
  if (/^(?:先不改|取消|算了|暂时不改)$/.test(text)) return { kind: 'cancel', message: '处理结果：待确认要求已取消。本餐保持原样。' }

  if (pending?.kind === 'change') {
    if (/^(?:汤|换汤|只换汤|这道汤|换掉汤)$/.test(answer)) return { kind: 'command', command: { action: 'replace-soup' } }
    if (/^(?:整套|整套换|换整套|全部|换一套)$/.test(answer)) return { kind: 'command', command: { action: 'another' } }
    if (/^(?:可以|好|好的|就这个)$/.test(answer)) return { kind: 'question', message: '操作范围未确定。\n请输入：汤，或整套。', choices: changes, pending }
  }
  if (pending?.kind === 'partial' && /^(?:暂不应用这些要求继续选菜|暂不应用这项要求继续选菜|仅按已懂条件找菜)$/.test(text)) {
    // The explicit choice applies only recognized conditions, never the unknown request or a write action.
    return { kind: 'command', command: { ...pending.command, action: 'recommend' } }
  }

  const clarification = pending ? raw.trim().replace(/^(?:我的意思是|我是说|我指的是|就是说|是指|就是|是)\s*/, '') : raw
  if (/^(?:再)?换(?:一个|个|一下)(?:吧)?$/.test(text) && context.focus !== 'soup') {
    if (!context.hasPlans && !context.hasSelectedPlan) return { kind: 'question', message: '处理状态：无候选方案。请先生成或选择方案。', choices: [{ label: '先帮我选菜', text: '推荐一下' }], pending: null }
    return { kind: 'question', message: '未确定操作范围。\n请选择：整套餐单，或仅汤。', choices: changes, pending: { kind: 'change' } }
  }
  const parsed = parseAssistantInput(clarification, context)
  if (parsed.ok) {
    if (parsed.command.action === 'reset') return { kind: 'command', command: parsed.command }
    if (pending?.kind === 'partial') {
      // Adding another known condition does not silently discard the still-unknown requirement.
      const merged = { ...pending.command, ...conditionSlots(parsed.command) }
      if (/^(?:不要(?:吃)?太辣|微辣|少(?:放|加)点辣)[的吧呀啊呢。！!？?]*$/.test(pending.unknown) && parsed.command.no_spicy === true) return { kind: 'command', command: merged }
      return askPartial(merged, pending.unknown)
    }
    return { kind: 'command', command: parsed.command }
  }
  const slots = conditionSlots(parsed.partial ?? {})
  if (parsed.unknown && Object.keys(slots).length > 0 && (!parsed.partial?.action || ['recommend', 'another'].includes(parsed.partial.action))) {
    const unknown = pending?.kind === 'partial' && pending.unknown !== parsed.unknown ? `${pending.unknown}；${parsed.unknown}` : parsed.unknown
    return askPartial({ ...(pending?.kind === 'partial' ? pending.command : {}), ...slots }, unknown)
  }
  if (pending?.kind === 'change') {
    return { kind: 'question', message: '操作范围未确定。\n请输入：汤、整套，或先不改。', choices: changes, pending }
  }
  if (pending?.kind === 'partial') {
    return { kind: 'question', message: `未处理：${pending.unknown}。\n处理状态：等待明确选择，本餐未改变。`, choices: [skipUnknown, cancel], pending }
  }
  return { kind: 'question', message: parsed.message, choices: parsed.choices ?? [], pending: null }
}
