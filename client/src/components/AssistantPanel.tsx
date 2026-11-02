import { useEffect, useRef, useState } from 'react'
import type { AssistantChoice, AssistantConditions } from '../assistant'
import type { AssistantChatMessage } from '../assistant-dialogue'

interface Props {
  people: string
  conditions: AssistantConditions
  messages: AssistantChatMessage[]
  busy: boolean
  choices: AssistantChoice[]
  onSay: (text: string) => void
}

export default function AssistantPanel({ people, conditions, messages, busy, choices, onSay }: Props) {
  const [text, setText] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    if (list && !collapsed) list.scrollTop = list.scrollHeight
  }, [messages, collapsed])
  const say = (value: string) => { if (!busy && value.trim()) { onSay(value.trim()); setText('') } }
  return (
    <aside className="chef-assistant" aria-label="做饭小助手">
      <div className="chef-chat-heading">
        <h2>本餐助手</h2>
        <button type="button" aria-expanded={!collapsed} aria-controls="chef-chat-body" onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开聊天' : '收起聊天'}</button>
      </div>
      <p className="chef-assistant-conditions">已有要求：{people || '未定'} 人
        {conditions.light && !conditions.no_spicy && ' · 清淡'}{conditions.no_spicy && ' · 偏清淡、避开常见辣味'}
        {conditions.ingredients?.length ? ' · 食材：' + conditions.ingredients.join('、') : ''}{conditions.cuisine && ' · 菜系：' + conditions.cuisine}
        {conditions.simple > 0 && ' · 快手菜'}{conditions.simple >= 2 && ' · 最多两道菜'}
      </p>
      <div id="chef-chat-body" hidden={collapsed}>
        <div className="chef-chat-log" role="log" aria-label="本餐聊天记录" aria-live="polite" aria-relevant="additions" ref={listRef}>
          {messages.map(message => <div key={message.id} className={`chef-chat-line chef-chat-${message.role}`}>
            <span className="chef-chat-speaker">{message.role === 'user' ? '你' : '小助手'}</span>
            <p>{message.text}</p>
          </div>)}
        </div>
        {choices.length > 0 && <div className="chef-assistant-buttons" aria-label="帮我选一下">
          {choices.map(choice => <button key={choice.text} type="button" disabled={busy} onClick={() => say(choice.text)}>{choice.label}</button>)}
        </div>}
        <form onSubmit={event => { event.preventDefault(); say(text) }}>
          <label htmlFor="chef-assistant-input">跟我说一句</label>
          <div className="chef-assistant-input-row">
            <input id="chef-assistant-input" value={text} maxLength={200} disabled={busy} placeholder="也可以接着补充或解释" onChange={event => setText(event.target.value)} />
            <button type="submit" disabled={busy || !text.trim()}>{busy ? '处理中…' : '发送'}</button>
          </div>
        </form>
        <div className="chef-chat-footer">
          <small>聊天不扣库存。仅保留本次选餐的最近 40 条消息，收起不清空；重新开始、离开选餐或关闭应用后清空。</small>
          <button type="button" disabled={busy} onClick={() => say('重新开始')}>重新开始这餐</button>
        </div>
      </div>
    </aside>
  )
}
