import type { ChatMessage } from '../../shared/types'

type Props = {
  messages: ChatMessage[]
}

const roleLabel: Record<ChatMessage['role'], string> = {
  system: '[system]',
  user: '[client]',
  assistant: '[you]',
}

export function PromptDisplay({ messages }: Props) {
  return (
    <div className="prompt-display">
      {messages.map((msg, i) => (
        <div key={i} className={`message message-${msg.role}`}>
          <div className="message-role">{roleLabel[msg.role]}</div>
          <pre className="message-content">{msg.content}</pre>
        </div>
      ))}
    </div>
  )
}
