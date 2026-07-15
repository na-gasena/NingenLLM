import { useState, useCallback, useEffect, useRef } from 'react'
import type { ChatMessage, RequestMeta, WsServerMessage } from '../shared/types'
import { useWebSocket } from './hooks/useWebSocket'
import { useNotificationSound } from './hooks/useNotificationSound'
import { RequestQueue } from './components/RequestQueue'
import { HistoryList } from './components/HistoryList'
import { PromptDisplay } from './components/PromptDisplay'
import { ResponseInput } from './components/ResponseInput'
import { RequestMetaBar } from './components/RequestMetaBar'
import type { SoundType } from './hooks/useNotificationSound'
import './App.css'

export type RequestItem = {
  requestId: string
  messages: ChatMessage[]
  model: string
  createdAt: number
  meta?: RequestMeta
}

export type HistoryItem = RequestItem & {
  response: string
  completedAt: number
}

function App() {
  const [requests, setRequests] = useState<RequestItem[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [responseText, setResponseText] = useState('')
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [soundPanelOpen, setSoundPanelOpen] = useState(false)
  const soundSettingsRef = useRef<HTMLDivElement | null>(null)
  const {
    enabled: notificationSoundEnabled,
    toggle: toggleNotificationSound,
    play: playNotificationSound,
    preview: previewNotificationSound,
    volume: notificationVolume,
    setVolume: setNotificationVolume,
    soundType: notificationSoundType,
    setSoundType: setNotificationSoundType,
  } = useNotificationSound()

  useEffect(() => {
    if (!soundPanelOpen) return
    const closeFromOutside = (event: PointerEvent) => {
      if (!soundSettingsRef.current?.contains(event.target as Node)) setSoundPanelOpen(false)
    }
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSoundPanelOpen(false)
    }
    window.addEventListener('pointerdown', closeFromOutside)
    window.addEventListener('keydown', closeFromEscape)
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside)
      window.removeEventListener('keydown', closeFromEscape)
    }
  }, [soundPanelOpen])

  const handleMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type === 'request') {
      playNotificationSound()
      setRequests((prev) => {
        const next = [...prev, msg]
        if (prev.length === 0) {
          setSelectedId(msg.requestId)
        }
        return next
      })
    } else if (msg.type === 'timeout') {
      setRequests((prev) => {
        const next = prev.filter((r) => r.requestId !== msg.requestId)
        setSelectedId((id) => {
          if (id === msg.requestId) {
            return next[0]?.requestId ?? null
          }
          return id
        })
        return next
      })
    }
  }, [playNotificationSound])

  const { status, send } = useWebSocket(handleMessage)

  const selectedRequest = requests.find((r) => r.requestId === selectedId) ?? null
  const selectedHistory = history.find((h) => h.requestId === selectedHistoryId) ?? null

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id)
    setSelectedHistoryId(null)
    setResponseText('')
  }, [])

  const handleSelectHistory = useCallback((id: string) => {
    setSelectedHistoryId(id)
    setSelectedId(null)
    setResponseText('')
  }, [])

  const handleDelta = useCallback(() => {
    if (!selectedId || !responseText.trim()) return
    send({ type: 'delta', requestId: selectedId, content: responseText.trim() + '\n' })
    setResponseText('')
  }, [selectedId, responseText, send])

  const completeRequest = useCallback((responseLabel: string) => {
    setRequests((prev) => {
      const completed = prev.find((r) => r.requestId === selectedId)
      if (completed) {
        setHistory((h) => [
          { ...completed, response: responseLabel, completedAt: Math.floor(Date.now() / 1000) },
          ...h,
        ])
        setSelectedHistoryId(completed.requestId)
      }
      const next = prev.filter((r) => r.requestId !== selectedId)
      setSelectedId(next[0]?.requestId ?? null)
      return next
    })
    setResponseText('')
  }, [selectedId])

  const handleSubmit = useCallback(() => {
    if (!selectedId || !responseText.trim()) return
    const content = responseText.trim()
    send({ type: 'response', requestId: selectedId, content })
    completeRequest(content)
  }, [selectedId, responseText, send, completeRequest])

  const handleCommand = useCallback((command: string[], workingDirectory: string | null) => {
    if (!selectedId) return
    const callId = crypto.randomUUID()
    // local_shell_call は codex-rs の build_tool_call で無視されるため、
    // 実際に登録されているツール shell_command (function_call) として送信する。
    // command = ["sh", "-c", "script"] で渡されるので、スクリプト部分を取り出す。
    const shellScript = command.length >= 3 ? command[2] : command.join(' ')
    const argsObj: Record<string, string> = { command: shellScript }
    if (workingDirectory) argsObj.workdir = workingDirectory
    send({ type: 'function_call', requestId: selectedId, callId, name: 'shell_command', arguments: JSON.stringify(argsObj) })
    completeRequest(`[shell_command: ${shellScript}]`)
  }, [selectedId, send, completeRequest])

  // Open WebUI の Code Interpreter (Pyodide) を発火する。
  // <code_interpreter type="code" lang="python">...</code_interpreter> タグを応答本文として送ると、
  // Open WebUI がブラウザ上の Pyodide で実行し、結果を付けて再度こちらに問い合わせてくる。
  const handleCodeInterpreter = useCallback((code: string) => {
    if (!selectedId) return
    const content = `<code_interpreter type="code" lang="python">\n${code}\n</code_interpreter>`
    send({ type: 'response', requestId: selectedId, content })
    completeRequest(`[code_interpreter]\n${code}`)
  }, [selectedId, send, completeRequest])

  // Open WebUI の Web検索 (builtin tool: search_web) を発火する。
  // search_web tool_call を返すと、Open WebUI が実際に検索(DuckDuckGo)して結果を付け再問い合わせしてくる。
  const handleWebSearch = useCallback((query: string) => {
    if (!selectedId) return
    const callId = crypto.randomUUID()
    send({ type: 'function_call', requestId: selectedId, callId, name: 'search_web', arguments: JSON.stringify({ query }) })
    completeRequest(`[search_web: ${query}]`)
  }, [selectedId, send, completeRequest])

  const statusLabel = {
    connecting: { text: 'Syncing', cls: 'status-connecting' },
    open: { text: 'Online', cls: 'status-open' },
    closed: { text: 'Offline', cls: 'status-closed' },
  }[status]

  return (
    <div className="layout">
      <header className="header">
        <h1 className="header-title">humanllm://operator</h1>
        <div className="header-controls">
          <div className="sound-settings" ref={soundSettingsRef}>
            <button
              type="button"
              className={`sound-toggle ${notificationSoundEnabled ? 'enabled' : ''}`}
              aria-expanded={soundPanelOpen}
              aria-controls="sound-settings-panel"
              onClick={() => setSoundPanelOpen((open) => !open)}
              title="新しいプロンプトの通知音設定"
            >
              {notificationSoundEnabled ? 'SOUND ON' : 'SOUND OFF'}
            </button>
            {soundPanelOpen && (
              <div id="sound-settings-panel" className="sound-panel">
                <div className="sound-panel-title">notification_audio</div>
                <div className="sound-setting-row">
                  <span>power</span>
                  <button
                    type="button"
                    className={`sound-power ${notificationSoundEnabled ? 'enabled' : ''}`}
                    aria-pressed={notificationSoundEnabled}
                    onClick={toggleNotificationSound}
                  >
                    [{notificationSoundEnabled ? 'ON' : 'OFF'}]
                  </button>
                </div>
                <label className="sound-setting-block">
                  <span>volume <output>{Math.round(notificationVolume * 100)}%</output></span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(notificationVolume * 100)}
                    onChange={(event) => setNotificationVolume(Number(event.target.value) / 100)}
                  />
                </label>
                <label className="sound-setting-block">
                  <span>preset</span>
                  <select
                    value={notificationSoundType}
                    onChange={(event) => setNotificationSoundType(event.target.value as SoundType)}
                  >
                    <option value="chime">chime</option>
                    <option value="bell">bell</option>
                    <option value="alarm">alarm</option>
                    <option value="retro">retro</option>
                  </select>
                </label>
                <button type="button" className="sound-test" onClick={previewNotificationSound}>
                  [TEST]
                </button>
              </div>
            )}
          </div>
          <span className={`header-status ${statusLabel.cls}`}>{statusLabel.text}</span>
        </div>
      </header>

      <div className="main">
        <aside className="sidebar">
          <RequestQueue
            requests={requests}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
          <HistoryList
            history={history}
            selectedId={selectedHistoryId}
            onSelect={handleSelectHistory}
          />
        </aside>

        <section className="content">
          {selectedRequest ? (
            <>
              <RequestMetaBar model={selectedRequest.model} meta={selectedRequest.meta} />
              <PromptDisplay messages={selectedRequest.messages} />
              {selectedRequest.meta?.modelMode === 'thinking' && (
                <div className="thinking-mode-hint">
                  thinking モデル: [Send progress] で思考の途中経過を流すことが期待されています
                </div>
              )}
              <ResponseInput
                value={responseText}
                onChange={setResponseText}
                onSubmit={handleSubmit}
                onDelta={handleDelta}
                onCommand={handleCommand}
                onCodeInterpreter={handleCodeInterpreter}
                onWebSearch={handleWebSearch}
                disabled={false}
              />
            </>
          ) : selectedHistory ? (
            <>
              <RequestMetaBar model={selectedHistory.model} meta={selectedHistory.meta} />
              <PromptDisplay
                messages={[
                  ...selectedHistory.messages,
                  { role: 'assistant', content: selectedHistory.response },
                ]}
              />
            </>
          ) : (
            <div className="content-empty">
              <p>Waiting for an API request…</p>
              <code>POST /v1/chat/completions</code>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default App
