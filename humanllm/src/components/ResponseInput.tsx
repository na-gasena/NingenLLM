import { useState, useRef, useEffect, useCallback } from 'react'

type Props = {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  onDelta: () => void
  onCommand: (command: string[], workingDirectory: string | null) => void
  onCodeInterpreter: (code: string) => void
  onWebSearch: (query: string) => void
  disabled: boolean
}

type Snippet = {
  label: string
  title: string
  before: string
  after: string
  placeholder: string
}

const SNIPPETS: Snippet[] = [
  {
    label: '表',
    title: 'テーブルを挿入',
    before: '\n| A | B |\n| --- | --- |\n| ',
    after: ' | |\n',
    placeholder: '1',
  },
  {
    label: 'コード',
    title: 'コードブロックを挿入',
    before: '\n```\n',
    after: '\n```\n',
    placeholder: 'code',
  },
  {
    label: '数式',
    title: 'LaTeX数式を挿入',
    before: '\n$$\n',
    after: '\n$$\n',
    placeholder: 'x^2 + y^2 = z^2',
  },
  {
    label: 'Mermaid',
    title: 'Mermaid図を挿入',
    before: '\n```mermaid\ngraph TD\n  ',
    after: '\n```\n',
    placeholder: 'A --> B',
  },
  {
    label: 'Artifact',
    title: 'HTML Artifactの雛形を挿入',
    before: '\n```html\n<!DOCTYPE html>\n<html>\n<head><style>\n',
    after: '\n</style></head>\n<body>\n  <h1>Hello</h1>\n</body>\n</html>\n```\n',
    placeholder: 'body { font-family: sans-serif; }',
  },
]

const MAX_IMAGE_DIMENSION = 1024
const TARGET_IMAGE_BYTES = 100 * 1024

type ToolMode = 'function_call' | 'local_shell_call' | 'code_interpreter' | 'web_search' | null

export function ResponseInput({ value, onChange, onSubmit, onDelta, onCommand, onCodeInterpreter, onWebSearch, disabled }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [toolMode, setToolMode] = useState<ToolMode>(null)
  const [fnName, setFnName] = useState('')
  const [fnArgs, setFnArgs] = useState('{}')
  const [shellCmd, setShellCmd] = useState('')
  const [shellDir, setShellDir] = useState('')
  const [pyCode, setPyCode] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)

  useEffect(() => {
    if (!disabled) {
      textareaRef.current?.focus()
    }
  }, [disabled])

  const insertText = useCallback((text: string) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const newValue = value.slice(0, start) + text + value.slice(end)
    onChange(newValue)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = start + text.length
      el?.setSelectionRange(pos, pos)
    })
  }, [value, onChange])

  const insertSnippet = useCallback((snippet: Snippet) => {
    const el = textareaRef.current
    const start = el?.selectionStart ?? value.length
    const end = el?.selectionEnd ?? value.length
    const selected = value.slice(start, end) || snippet.placeholder
    const newValue = value.slice(0, start) + snippet.before + selected + snippet.after + value.slice(end)
    onChange(newValue)
    requestAnimationFrame(() => {
      el?.focus()
      const selStart = start + snippet.before.length
      const selEnd = selStart + selected.length
      el?.setSelectionRange(selStart, selEnd)
    })
  }, [value, onChange])

  // 生画像（スマホ写真など数MB）をそのまま base64 で流すと data URL が肥大化し、
  // Open WebUI 側の Markdown 描画が重くなって画像化されず生テキスト表示になる
  // （検証で ~1.2MB の応答は描画されず、数百文字の応答は正常描画を確認）。
  // さらに、画像を 1 つの SSE チャンク（サーバ側 120KB）に収めることで、ストリーミング中の
  // 「未完成の画像Markdownが生テキストとしてチラつく」現象を消せる。そのため data URL を
  // TARGET_IMAGE_BYTES（サーバのチャンクサイズより十分小さい値）以下に確実に抑える。
  const insertImageFile = useCallback((file: File) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      URL.revokeObjectURL(objectUrl)
      if (!ctx) {
        insertText(`\n![${file.name}](${objectUrl})\n`)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      let quality = 0.85
      let dataUrl = canvas.toDataURL('image/jpeg', quality)
      // data URL のバイト長がターゲットを超える間、品質を下げて圧縮する
      while (dataUrl.length > TARGET_IMAGE_BYTES && quality > 0.4) {
        quality -= 0.1
        dataUrl = canvas.toDataURL('image/jpeg', quality)
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'image'
      insertText(`\n![${name}](${dataUrl})\n`)
    }
    img.onerror = () => {
      // 画像として読めない場合は生データURLにフォールバック
      URL.revokeObjectURL(objectUrl)
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') insertText(`\n![${file.name}](${reader.result})\n`)
      }
      reader.readAsDataURL(file)
    }
    img.src = objectUrl
  }, [insertText])

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) insertImageFile(file)
        return
      }
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLTextAreaElement>) => {
    setIsDragOver(false)
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    e.preventDefault()
    imageFiles.forEach(insertImageFile)
  }

  const handleDragOver = (e: React.DragEvent<HTMLTextAreaElement>) => {
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault()
      setIsDragOver(true)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (!disabled && value.trim()) onSubmit()
    }
  }

  const handleToggleTool = (mode: Exclude<ToolMode, null>) => {
    setToolMode((prev) => (prev === mode ? null : mode))
  }

  const handleSendShellCall = () => {
    if (!shellCmd.trim()) return
    const command = ['sh', '-c', shellCmd.trim()]
    const workingDirectory = shellDir.trim() || null
    onCommand(command, workingDirectory)
    setShellCmd('')
    setShellDir('')
    setToolMode(null)
  }

  const handleSendCode = () => {
    if (!pyCode.trim()) return
    onCodeInterpreter(pyCode.replace(/\r\n/g, '\n').trim())
    setPyCode('')
    setToolMode(null)
  }

  const handleSendSearch = () => {
    if (!searchQuery.trim()) return
    onWebSearch(searchQuery.trim())
    setSearchQuery('')
    setToolMode(null)
  }

  return (
    <div className="response-input">
      <div className="response-input-label">Your response</div>

      <div className="snippet-toolbar" role="toolbar" aria-label="挿入ツール">
        {SNIPPETS.map((s) => (
          <button
            key={s.label}
            type="button"
            className="snippet-btn"
            title={s.title}
            onClick={() => insertSnippet(s)}
            disabled={disabled}
          >
            {s.label}
          </button>
        ))}
        <label className="snippet-btn snippet-btn-file" title="画像を添付">
          画像
          <input
            type="file"
            accept="image/*"
            hidden
            disabled={disabled}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) insertImageFile(file)
              e.target.value = ''
            }}
          />
        </label>
      </div>

      <textarea
        ref={textareaRef}
        className={`response-textarea${isDragOver ? ' drag-over' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragOver(false)}
        placeholder={disabled ? 'Select a request…' : '返信を入力… (画像はペースト/ドラッグ&ドロップ可)'}
        disabled={disabled}
        rows={6}
      />

      {toolMode === 'function_call' && !disabled && (
        <div className="tool-form">
          <div className="tool-form-title">function_call</div>
          <div className="tool-form-row">
            <label className="tool-form-label">name</label>
            <input
              className="tool-form-input"
              type="text"
              placeholder="write_file"
              value={fnName}
              onChange={(e) => setFnName(e.target.value)}
            />
          </div>
          <div className="tool-form-row">
            <label className="tool-form-label">arguments</label>
            <textarea
              className="tool-form-textarea"
              placeholder='{"path": "foo.txt", "content": "hello"}'
              value={fnArgs}
              onChange={(e) => setFnArgs(e.target.value)}
              rows={3}
            />
          </div>
        </div>
      )}

      {toolMode === 'local_shell_call' && !disabled && (
        <div className="tool-form">
          <div className="tool-form-title">local_shell_call</div>
          <div className="tool-form-row">
            <label className="tool-form-label">command</label>
            <input
              className="tool-form-input"
              type="text"
              placeholder="echo hello > foo.txt  (シェル構文が使えますわ)"
              value={shellCmd}
              onChange={(e) => setShellCmd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendShellCall() }}
            />
          </div>
          <div className="tool-form-row">
            <label className="tool-form-label">working_dir</label>
            <input
              className="tool-form-input"
              type="text"
              placeholder="/home/user  (optional)"
              value={shellDir}
              onChange={(e) => setShellDir(e.target.value)}
            />
          </div>
          <div className="tool-form-actions">
            <button className="tool-form-cancel" onClick={() => setToolMode(null)}>Cancel</button>
            <button className="tool-form-send sh-send" onClick={handleSendShellCall} disabled={!shellCmd.trim()}>
              Send command
            </button>
          </div>
        </div>
      )}

      {toolMode === 'code_interpreter' && !disabled && (
        <div className="tool-form">
          <div className="tool-form-title">code_interpreter (Pyodide / browser)</div>
          <textarea
            className="tool-form-textarea"
            placeholder={'print(2 ** 100)\n# Open WebUI がブラウザ上の Python で実行し、結果を返してきます'}
            value={pyCode}
            onChange={(e) => setPyCode(e.target.value)}
            rows={5}
            spellCheck={false}
          />
          <div className="tool-form-actions">
            <button className="tool-form-cancel" onClick={() => setToolMode(null)}>Cancel</button>
            <button className="tool-form-send ci-send" onClick={handleSendCode} disabled={!pyCode.trim()}>
              Run Python
            </button>
          </div>
        </div>
      )}

      {toolMode === 'web_search' && !disabled && (
        <div className="tool-form">
          <div className="tool-form-title">search_web (DuckDuckGo)</div>
          <div className="tool-form-row">
            <label className="tool-form-label">query</label>
            <input
              className="tool-form-input"
              type="text"
              placeholder="2026年 ワールドカップ 開催地"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSendSearch() }}
            />
          </div>
          <div className="tool-form-actions">
            <button className="tool-form-cancel" onClick={() => setToolMode(null)}>Cancel</button>
            <button className="tool-form-send ws-send" onClick={handleSendSearch} disabled={!searchQuery.trim()}>
              Search web
            </button>
          </div>
        </div>
      )}

      <div className="response-actions">
        <span className="response-hint">Ctrl+Enter to send</span>
        <button
          className={`btn-tool-call btn-search${toolMode === 'web_search' ? ' active' : ''}`}
          onClick={() => handleToggleTool('web_search')}
          disabled={disabled}
          title="Web Search (search_web)"
        >
          Web Search
        </button>
        <button
          className={`btn-tool-call btn-python${toolMode === 'code_interpreter' ? ' active' : ''}`}
          onClick={() => handleToggleTool('code_interpreter')}
          disabled={disabled}
          title="Code Interpreter (Pyodide)"
        >
          Code Interp.
        </button>
        <button
          className={`btn-tool-call btn-shell${toolMode === 'local_shell_call' ? ' active' : ''}`}
          onClick={() => handleToggleTool('local_shell_call')}
          disabled={disabled}
          title="Send Command"
        >
          Run Command
        </button>
        <button
          className="response-delta"
          onClick={onDelta}
          disabled={disabled || !value.trim()}
        >
          Send progress
        </button>
        <button
          className="response-submit"
          onClick={onSubmit}
          disabled={disabled || !value.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
