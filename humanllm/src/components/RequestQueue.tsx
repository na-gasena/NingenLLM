import { useEffect, useState } from 'react'
import type { RequestItem } from '../App'
import { RequestMetaBar } from './RequestMetaBar'

type Props = {
  requests: RequestItem[]
  selectedId: string | null
  onSelect: (id: string) => void
}

export function RequestQueue({ requests, selectedId, onSelect }: Props) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (requests.length === 0) {
    return (
      <div className="queue empty">
        <span className="queue-empty-icon">·</span>
        <p>No pending requests</p>
      </div>
    )
  }

  return (
    <div className="queue">
      <div className="queue-header">
        Pending requests <span className="queue-badge">{requests.length}</span>
      </div>
      <ul className="queue-list">
        {requests.map((req) => {
          const lastUserMsg = [...req.messages]
            .reverse()
            .find((m) => m.role === 'user')
          const elapsed = Math.max(0, Math.floor((now - req.createdAt * 1000) / 1000))

          return (
            <li
              key={req.requestId}
              className={`queue-item ${req.requestId === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(req.requestId)}
            >
              <div className="queue-item-preview">
                {lastUserMsg?.content.slice(0, 60) ?? '(no message)'}
                {(lastUserMsg?.content.length ?? 0) > 60 ? '…' : ''}
              </div>
              <div className="queue-item-meta">
                <RequestMetaBar model={req.model} meta={req.meta} compact />
                <span>{elapsed}s ago</span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
