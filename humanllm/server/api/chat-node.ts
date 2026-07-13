import type { IncomingMessage, ServerResponse } from 'http'
import type { ChatMessage, ToolCallItem } from '../../shared/types'
import { addPending, rejectPending } from '../store/pendingRequests'
import { broadcast } from '../ws/clients'

const TIMEOUT_MS = 60 * 60 * 1000 // 1 hour (暫定値、後で調整予定。docs/01_design.md参照)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

function normalizeContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'object' && c !== null && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('')
  }
  return String(content)
}

// Chat Completions の messages には tool_calls を含む assistant メッセージや
// role: 'tool' の実行結果が混在しうる。ChatMessage(system/user/assistant + string content)
// に正規化し、人間が読める形でオペレーター画面に表示できるようにする。
function normalizeChatMessages(raw: Array<Record<string, unknown>>): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of raw) {
    const role = m.role as string | undefined
    if (role === 'tool') {
      out.push({ role: 'user', content: `[tool_result]\n${normalizeContent(m.content)}` })
      continue
    }
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const calls = (m.tool_calls as Array<Record<string, unknown>>)
        .map((tc) => {
          const fn = tc.function as Record<string, unknown> | undefined
          return `[tool_call: ${fn?.name ?? 'unknown'}(${fn?.arguments ?? ''})]`
        })
        .join('\n')
      out.push({ role: 'assistant', content: calls })
      continue
    }
    if (role === 'user' || role === 'assistant' || role === 'system') {
      out.push({ role, content: normalizeContent(m.content) })
    }
  }
  return out
}

type ToolCallPayload = { id: string; type: 'function'; function: { name: string; arguments: string } }

// operator画面はどちらの経路でも type: 'function_call'（name: 'shell_command'）を送ってくる
// （App.tsx の handleCommand 参照）が、念のため local_shell_call も function 形式に変換して扱う。
function buildToolCall(item: ToolCallItem): ToolCallPayload {
  if (item.type === 'function_call') {
    return { id: item.callId, type: 'function', function: { name: item.name, arguments: item.arguments } }
  }
  const args: Record<string, unknown> = {
    command: item.command.length >= 3 ? item.command[2] : item.command.join(' '),
  }
  if (item.workingDirectory) args.working_directory = item.workingDirectory
  return { id: item.callId, type: 'function', function: { name: 'shell_command', arguments: JSON.stringify(args) } }
}

// /v1/chat/completions は Hono のストリーミング層を経由せず
// 生の Node.js res.write() / socket.write() で SSE を処理する（responses-node.ts と同方針）。
export async function handleChatNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  console.log('[chat] POST /v1/chat/completions method=' + req.method)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  const raw = await new Promise<string>((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })

  const body = JSON.parse(raw) as {
    model?: string
    messages: Array<Record<string, unknown>>
    stream?: boolean
    tools?: Array<Record<string, unknown>>
  }

  const { model = 'human', stream = false, tools } = body
  const messages = normalizeChatMessages(body.messages)
  const requestId = crypto.randomUUID()
  const id = `chatcmpl-${requestId}`
  const createdAt = Math.floor(Date.now() / 1000)
  console.log(`[chat] model=${model} stream=${stream} tools=${tools?.map((t) => (t.function as Record<string, unknown>)?.name ?? t.name).join(',') ?? 'none'}`)

  if (!stream) {
    type CompletionResult = { kind: 'text'; text: string } | { kind: 'tool'; item: ToolCallItem }
    let progressText = ''
    const result = await new Promise<CompletionResult>((resolve, reject) => {
      addPending(
        requestId, messages,
        (deltaText, isFinal) => {
          if (!isFinal) progressText += deltaText
        },
        (fullText) => {
          // "Send progress" で送られた分だけ <think> に包む。進捗が無ければ従来通りそのまま。
          const finalOnly = progressText ? fullText.slice(progressText.length) : fullText
          const text = progressText ? `<think>${progressText}</think>${finalOnly}` : finalOnly
          resolve({ kind: 'text', text })
        },
        reject,
        (item) => resolve({ kind: 'tool', item }),
      )
      broadcast({ type: 'request', requestId, messages, model, createdAt })
      setTimeout(() => {
        const rejected = rejectPending(requestId, new Error('timeout'))
        if (rejected) broadcast({ type: 'timeout', requestId })
      }, TIMEOUT_MS)
    })

    const message = result.kind === 'text'
      ? { role: 'assistant', content: result.text }
      : { role: 'assistant', content: null, tool_calls: [buildToolCall(result.item)] }
    const finishReason = result.kind === 'text' ? 'stop' : 'tool_calls'

    const responseBody = JSON.stringify({
      id,
      object: 'chat.completion',
      created: createdAt,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })

    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS })
    res.end(responseBody)
    return
  }

  // ストリーミング: Chat Completions 形式の SSE
  // data: {"choices":[{"delta":{"content":"..."}}]} ... data: [DONE]
  const socket = req.socket
  if (!socket) { res.writeHead(500); res.end(); return }

  socket.setNoDelay(true)

  const headerLines = [
    'HTTP/1.1 200 OK',
    'Content-Type: text/event-stream',
    'Cache-Control: no-cache',
    'Connection: keep-alive',
    ...Object.entries(CORS_HEADERS).map(([k, v]) => `${k}: ${v}`),
    '',
    '',
  ].join('\r\n')
  socket.write(headerLines)

  const writeChunk = (choice: object) => {
    socket.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: createdAt,
      model,
      choices: [choice],
    })}\n\n`)
  }

  // SSE の 1 行が大きすぎるとクライアント側で行長制限(既定128KB)に引っかかるため、
  // content は行長制限に収まる範囲でできるだけ大きなチャンクにまとめて流す。
  // チャンクを小さく刻むと、画像Markdown `![](data:...)` が閉じ括弧到達まで「未完成」の
  // 状態で複数フレーム描画され、base64が生テキストとしてチラつく。逆に画像が1チャンクに
  // 収まれば内容が「空→完成画像」に一気に切り替わり、途中テキストが一度も描画されない。
  // → operator側で画像を ~100KB 以下に縮小しておくことで、画像は常に1チャンクで届く。
  const CONTENT_CHUNK_SIZE = 120 * 1024
  const writeContentDelta = (text: string) => {
    for (let i = 0; i < text.length; i += CONTENT_CHUNK_SIZE) {
      writeChunk({ index: 0, delta: { content: text.slice(i, i + CONTENT_CHUNK_SIZE) }, finish_reason: null })
    }
  }

  // 最初の chunk で role を宣言する（OpenAI 準拠）。delta / done が来るまで送らない。
  let roleSent = false
  const ensureRoleSent = () => {
    if (roleSent) return
    roleSent = true
    writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
  }

  // "Send progress" (delta, isFinal=false) は <think> ブロックの中身として流し、
  // "Send"（最終回答、isFinal=true）が来た時点で </think> を閉じてから可視の回答として流す。
  let thinkOpen = false
  addPending(
    requestId,
    messages,
    (deltaText, isFinal) => {
      ensureRoleSent()
      if (isFinal) {
        if (thinkOpen) {
          thinkOpen = false
          writeChunk({ index: 0, delta: { content: '</think>' }, finish_reason: null })
        }
      } else if (!thinkOpen) {
        thinkOpen = true
        writeChunk({ index: 0, delta: { content: '<think>' }, finish_reason: null })
      }
      writeContentDelta(deltaText)
    },
    () => {
      // resolvePending は complete の前に finalText を sendDelta 済みなので、ここでは終了イベントのみ送る
      ensureRoleSent()
      writeChunk({ index: 0, delta: {}, finish_reason: 'stop' })
      socket.write('data: [DONE]\n\n')
      socket.end()
    },
    () => { socket.destroy() },
    (item) => {
      const toolCall = buildToolCall(item)
      writeChunk({
        index: 0,
        delta: { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] },
        finish_reason: null,
      })
      writeChunk({ index: 0, delta: {}, finish_reason: 'tool_calls' })
      socket.write('data: [DONE]\n\n')
      socket.end()
    },
  )

  broadcast({ type: 'request', requestId, messages, model, createdAt })

  setTimeout(() => {
    const rejected = rejectPending(requestId, new Error('timeout'))
    if (rejected) broadcast({ type: 'timeout', requestId })
  }, TIMEOUT_MS)
}
