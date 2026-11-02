/** Local, bounded meal grammar. No model, network, learning or database writes. */
export type AssistantAction = 'recommend' | 'another' | 'replace-soup' | 'undo-soup' | 'review' | 'start' | 'reset'
export interface AssistantConditions { ingredients?: string[]; cuisine?: string; light: boolean; no_spicy: boolean; simple: number }
export interface AssistantCommand {
  ingredients?: string[]
  cuisine?: string
  people?: number
  light?: boolean
  no_spicy?: boolean
  simplify?: boolean
  timeRequested?: boolean
  action?: AssistantAction
}
export interface AssistantChoice { label: string; text: string }
export interface AssistantContext { ingredientNames?: string[]; cuisineNames?: string[]; hasSelectedPlan?: boolean; hasPlans?: boolean; focus?: 'plan' | 'soup' }
export type ParseResult = { ok: true; command: AssistantCommand } | { ok: false; message: string; choices?: AssistantChoice[]; partial?: AssistantCommand; unknown?: string }

const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }
const help: AssistantChoice[] = [
  { label: '帮我选菜', text: '推荐一下' }, { label: '简单些', text: '简单点' }, { label: '清淡些', text: '清淡点' }, { label: '不放辣', text: '不要辣' },
]
const changeChoices: AssistantChoice[] = [{ label: '整套换', text: '换一套' }, { label: '只换汤', text: '换掉汤' }]

export function parseAssistantInput(raw: string, context: AssistantContext = {}): ParseResult {
  if (!raw.trim() || raw.length > 200) return { ok: false, message: '这句有点长，分开说吧，也可以点下面的选项。', choices: help }
  const command: AssistantCommand = {}
  const ingredientNames = [...new Set(['牛肉', ...(context.ingredientNames ?? [])])].filter(Boolean).sort((a,b)=>b.length-a.length)
  const cuisineNames = [...new Set(['川菜', '西餐', ...(context.cuisineNames ?? [])])].filter(Boolean).sort((a,b)=>b.length-a.length)
  // Normalize only known reduplications, never delete unknown ingredients or negations.
  let normalized = raw.normalize('NFKC').replace(/简简单单/g, '简单').replace(/清清淡淡/g, '清淡')
  // Only a complete explicit correction may replace a negated old count. Keep all trailing requirements.
  const numeral = '(十二|十一|十|[一二两三四五六七八九]|\\d+)'
  const person = '(?:个人|人份|人)'
  const correction = new RegExp('^(今晚|今天|这顿|这餐)?\\s*(?:不是' + numeral + person + '[，,\\s]*是' + numeral + person + '|' + numeral + person + '说错了[，,\\s]*(?:改成|改为)' + numeral + person + ')')
  const corrected = correction.exec(normalized)
  if (corrected) {
    const from = corrected[2] ?? corrected[4]
    const to = corrected[3] ?? corrected[5]
    const oldCount = numbers[from] ?? Number(from)
    const newCount = numbers[to] ?? Number(to)
    if (![oldCount, newCount].every(n => Number.isInteger(n) && n >= 1 && n <= 12)) return { ok: false, message: '人数支持 1–12 人，请重新说一下。' }
    normalized = (corrected[1] ?? '') + to + '个人' + normalized.slice(corrected[0].length)
  }
  const fragments = normalized.trim().replace(/[。！？!?；;]/g, '，').split(/[，,、\n]+/).filter(s => s.trim())
  let recognized = false
  const unknownParts: string[] = []
  const conflict = (): ParseResult => ({ ok: false, message: '这句里有两个相反的要求，选哪个？本餐还没有改。', choices: help })
  for (const fragment of fragments) {
    let rest = fragment.trim().replace(/^(?:嗯+|呃+|哦+)\s*/, '').replace(/^(?:今晚|今天|这顿|这餐|晚饭|午饭|早饭)\s*/, '')
    rest = rest.replace(/^(?:请帮我|麻烦帮我|帮我|我想要|我想|想要)\s*/, '')
    while (rest) {
      // Number slots can occur before or after taste/effort slots; never search past unknown words.
      const people = /^(?:(?:人数)?(?:改成|改为|改到|换成))?(十二|十一|十|[一二两三四五六七八九]|\d+)\s*(?:个人|人份|人)(?:吃饭|吃吃|吃|份)?/.exec(rest)
      const pair = /^(?:我们俩|咱们俩|我俩|咱俩|我们两个人)(?:吃饭|吃吃|吃)?/.exec(rest)
      const alone = /^(?:我一个人|就我一个人)(?:吃饭|吃吃|吃)?/.exec(rest)
      const countMatch = people ?? pair ?? alone
      if (countMatch) {
        const n = people ? numbers[people[1]] ?? Number(people[1]) : pair ? 2 : 1
        if (!Number.isInteger(n) || n < 1 || n > 12) return { ok: false, message: '人数支持 1–12 人，请重新选一下。' }
        if (command.people !== undefined && command.people !== n) return { ok: false, message: '这句里有不同人数，请只选一个人数。' }
        command.people = n; recognized = true; rest = rest.slice(countMatch[0].length).trim(); continue
      }
      const clearIngredient = /^(?:不限食材|取消食材要求)/.exec(rest)
      if (clearIngredient) { command.ingredients = []; rest = rest.slice(clearIngredient[0].length).trim(); recognized = true; continue }
      const clearCuisine = /^(?:不限菜系|取消菜系要求)/.exec(rest)
      if (clearCuisine) { command.cuisine = ''; rest = rest.slice(clearCuisine[0].length).trim(); recognized = true; continue }
      let named = false
      for (const [names, kind] of [[cuisineNames, 'cuisine'], [ingredientNames, 'ingredient']] as const) {
        const prefix = kind === 'cuisine' ? /^(?:想吃|吃点|吃|来点|做点|菜系[:：]?|指定菜系[:：]?)?\s*/.exec(rest)![0] : /^(?:想吃|吃点|吃|用点|用|来点|加点|食材[:：]?|指定食材[:：]?)?\s*/.exec(rest)![0]
        const name = names.find(n => rest.slice(prefix.length).startsWith(n))
        if (!name) continue
        if (kind === 'cuisine') {
          if (command.cuisine !== undefined && command.cuisine !== name) return { ok:false, message:'菜系要求冲突。请指定一个菜系；本餐未改变。' }
          command.cuisine = name
        } else command.ingredients = [...new Set([...(command.ingredients ?? []), name])]
        rest = rest.slice(prefix.length + name.length).trim(); named = true; recognized = true; break
      }
      if (named) continue
      // Full phrases, including negation. Do not reduce "不要太辣" to "不辣".
      const rules: Array<[RegExp, keyof Pick<AssistantCommand, 'light' | 'no_spicy' | 'simplify' | 'timeRequested'>, boolean]> = [
        [/^(?:不用清淡|不要求清淡|取消清淡)(?:的)?/, 'light', false],
        [/^(?:辣不辣都行|取消不辣要求)/, 'no_spicy', false],
        [/^(?:不用简单|不要求简单|取消快手要求)(?:的)?/, 'simplify', false],
        [/^(?:(?:吃得|吃的|吃|做得|做的|做)\s*)?清淡(?:一些|一点点|一点|点点|点|些)?(?:的)?/, 'light', true],
        [/^(?:不要(?:放|加)?辣|别(?:放|加|吃)辣|不(?:放|加|吃)?辣)(?:的)?/, 'no_spicy', true],
        [/^(?:(?:还是|再)\s*)?(?:太麻烦(?:了)?|有点麻烦|别太麻烦|不要太麻烦|不用太麻烦|省事(?:一些|一点|点|些)?|快手(?:菜)?(?:一些|一点|点|些)?)/, 'simplify', true],
        [/^(?:(?:还是|再)\s*)?(?:(?:吃得|做得|吃|做)\s*)?简单(?:一些|一点点|一点|点点|点|些)?(?:吃(?:吃)?(?:一点|点|些)?|做(?:做)?(?:一点|点|些)?)?(?:的)?/, 'simplify', true],
        [/^(?:做点|做个|吃点|来点)简单(?:的)?/, 'simplify', true],
        [/^(?:半小时(?:搞定|做好|内)?|30\s*分钟(?:搞定|做好|内)?)/, 'timeRequested', true],
      ]
      let matched = false
      for (const [pattern, field, value] of rules) {
        const m = pattern.exec(rest)
        if (!m) continue
        if (command[field] !== undefined && command[field] !== value) return conflict()
        command[field] = value; rest = rest.slice(m[0].length).trim(); matched = true; break
      }
      if (!matched) {
        const actions: Array<[RegExp, AssistantAction]> = [
          [/^(?:撤回(?:上一次)?换汤|撤销(?:上一次)?换汤|换回(?:刚才|原来|之前)(?:的|那个|那道)?汤|(?:刚才|原来|之前)(?:的|那个|那道)?汤还是要(?:吧)?)/, 'undo-soup'],
          [/^(?:推荐(?:一下|一套|点菜)?|选(?:一下|一套|点菜)|帮我选餐|帮我选(?:一下|一套)?)/, 'recommend'],
          [/^(?:再)?(?:换(?:一套|套|一组)(?:菜|方案)?|整套换(?:一下)?|再来一套)/, 'another'],
          [/^(?:再)?(?:换(?:掉|个|一个|一下)?(?:这个|这道)?汤|(?:这个|这道)?汤(?:换(?:掉|一个|个|一下)|不要了|不想喝了)|不要(?:这个|这道)汤(?:了)?)/, 'replace-soup'],
          [/^(?:看看缺什么|缺什么(?:食材)?|看(?:看)?备料|需要(?:准备)?什么(?:食材)?)/, 'review'],
          [/^(?:开始做饭|开始吧|就(?:做|吃)这(?:个|套)|可以(?:就这个)?|就这个|就这套)/, 'start'],
          [/^(?:重新开始|从头来|重来)/, 'reset'],
        ]
        for (const [pattern, action] of actions) {
          const m = pattern.exec(rest)
          if (!m) continue
          if (command.action && command.action !== action) return { ok: false, message: '这句里有几个操作，先选一个吧，本餐还没有改。', choices: changeChoices }
          command.action = action; rest = rest.slice(m[0].length).trim(); matched = true; break
        }
      }
      if (!matched) {
        const vague = /^(?:再)?(?:换(?:一个|个|一下)|换换)(?:吧)?$/.exec(rest)
        if (vague) {
          const action = context.hasSelectedPlan && context.focus === 'soup' ? 'replace-soup' : context.hasPlans ? 'another' : undefined
          if (!action) return { ok: false, message: '想整套换，还是只换汤？本餐还没有改。', choices: changeChoices }
          if (command.action && command.action !== action) return { ok: false, message: '先选一个操作吧，本餐还没有改。', choices: changeChoices }
          command.action = action; rest = ''; matched = true
        }
      }
      if (!matched) {
        // Connectors are accepted only between recognized clauses; they cannot hide unsupported requirements.
        if (recognized && /^(?:吧|呀|啊|呢|嘛|哦|就行|就好|就可以了|就可以)+$/.test(rest)) { rest = ''; continue }
        const connector = /^(?:然后|还有|而且|并且|再|也|就)\s*/.exec(rest)
        if (recognized && connector && rest.length > connector[0].length) { rest = rest.slice(connector[0].length); continue }
        if (/^(?:不要(?:吃)?太辣|少(?:放|加)点辣|微辣)/.test(rest)) return { ok: false, message: '现在能筛“不辣”，还不能可靠区分微辣。要改成不辣吗？本餐还没有改。', choices: [{ label: '改成不辣', text: '不要辣' }], partial: { ...command }, unknown: rest }
        // Identify known trailing food/style tokens without silently dropping the unknown prefix.
        if (!/不|别|忌|过敏|避免|无|非/.test(rest)) {
          let tail = true
          while (tail) {
            tail = false
            const style = cuisineNames.find(n => rest.endsWith(n))
            const food = ingredientNames.find(n => rest.endsWith(n))
            if (style && (command.cuisine === undefined || command.cuisine === style)) { command.cuisine = style; rest = rest.slice(0,-style.length).trim(); tail = true; recognized = true }
            else if (food) { command.ingredients = [...new Set([...(command.ingredients ?? []), food])]; rest = rest.slice(0,-food.length).trim(); tail = true; recognized = true }
          }
          if (!rest) continue
        }
        unknownParts.push(rest); rest = ''; break
      }
      recognized = true
    }
  }
  if (unknownParts.length) return { ok: false, message: '未识别内容：' + unknownParts.join('、') + '。\n处理状态：本餐未改变。', choices: help, partial: { ...command }, unknown: unknownParts.join('、') }
  if (!recognized) return { ok: false, message: '想几个人吃，或想怎么调整？', choices: help }
  if (command.action === 'reset' && Object.keys(command).length > 1) return { ok: false, message: '要重新开始的话，请单独说“重新开始”。' }
  if (command.action === 'start' && !context.hasSelectedPlan) return { ok: false, message: '先在下面选一套菜，再一起核对备料。', choices: [{ label: '先推荐一套', text: '推荐一下' }] }
  return { ok: true, command }
}
