import { Hono } from 'hono'
import { cors } from 'hono/cors'

export const app = new Hono()

app.use('*', cors())

// POST /v1/chat/completions は server/api/chat-node.ts で処理する（ストリーミング対応のため
// Hono を経由せず生ソケットで SSE を返す）。ここでは /v1/models のみ担当する。
app.get('/v1/models', (c) => {
  return c.json({
    object: 'list',
    data: [
      {
        id: 'human',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'humanllm',
      },
    ],
  })
})
