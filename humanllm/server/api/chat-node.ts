import type { IncomingMessage, ServerResponse } from 'http'
import type { ChatMessage } from '../../shared/types'
import { addPending, rejectPending } from '../store/pendingRequests'
import { broadcast } from '../ws/clients'

const TIMEOUT_MS = 60 * 60 * 1000 // 1 hour (暫定値、後で調整予定。docs/01_design.md参照)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
    messages: ChatMessage[]
    stream?: boolean
  }

  const { messages, model = 'human', stream = false } = body
  const requestId = crypto.randomUUID()
  const id = `chatcmpl-${requestId}`
  const createdAt = Math.floor(Date.now() / 1000)
  console.log(`[chat] model=${model} stream=${stream}`)

  if (!stream) {
    // 非ストリーミング: 人間の回答が確定してから一括で JSON を返す（従来の chat.ts と同じ挙動）
    const content = await new Promise<string>((resolve, reject) => {
      addPending(requestId, messages, () => {}, resolve, reject)
      broadcast({ type: 'request', requestId, messages, model, createdAt })
      setTimeout(() => {
        const rejected = rejectPending(requestId, new Error('timeout'))
        if (rejected) broadcast({ type: 'timeout', requestId })
      }, TIMEOUT_MS)
    })

    const responseBody = JSON.stringify({
      id,
      object: 'chat.completion',
      created: createdAt,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
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

  // 最初の chunk で role を宣言する（OpenAI 準拠）。delta / done が来るまで送らない。
  let roleSent = false
  const ensureRoleSent = () => {
    if (roleSent) return
    roleSent = true
    writeChunk({ index: 0, delta: { role: 'assistant' }, finish_reason: null })
  }

  addPending(
    requestId,
    messages,
    (deltaText) => {
      ensureRoleSent()
      writeChunk({ index: 0, delta: { content: deltaText }, finish_reason: null })
    },
    () => {
      // resolvePending は complete の前に finalText を sendDelta 済みなので、ここでは終了イベントのみ送る
      ensureRoleSent()
      writeChunk({ index: 0, delta: {}, finish_reason: 'stop' })
      socket.write('data: [DONE]\n\n')
      socket.end()
    },
    () => { socket.destroy() },
    null, // chat/completions は tool 呼び出し非対応
  )

  broadcast({ type: 'request', requestId, messages, model, createdAt })

  setTimeout(() => {
    const rejected = rejectPending(requestId, new Error('timeout'))
    if (rejected) broadcast({ type: 'timeout', requestId })
  }, TIMEOUT_MS)
}
