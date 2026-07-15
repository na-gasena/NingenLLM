import { Hono } from 'hono'
import { cors } from 'hono/cors'

export const app = new Hono()

app.use('*', cors())

const MODEL_CATALOG = [
  {
    id: 'ningen-1',
    name: 'ningen-1',
    description: '標準モデル。人間が通常ペースで回答します。',
  },
  {
    id: 'ningen-1-thinking',
    name: 'ningen-1-thinking',
    description: 'じっくり考えるモード。思考の途中経過を返すことがあります。',
  },
  {
    id: 'ningen-1-mini',
    name: 'ningen-1-mini',
    description: '雑だが速い、軽量・高速回答モードです。',
  },
  {
    id: 'human',
    name: 'human (deprecated)',
    description: '旧モデルID。後方互換のため残しています。新規利用は ningen-1 を推奨します。',
  },
] as const

// POST /v1/chat/completions は server/api/chat-node.ts で処理する（ストリーミング対応のため
// Hono を経由せず生ソケットで SSE を返す）。ここでは /v1/models のみ担当する。
app.get('/v1/models', (c) => {
  const created = Math.floor(Date.now() / 1000)
  return c.json({
    object: 'list',
    data: MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      description: model.description,
      // Open WebUI は workspace model と同じ info.meta.description をUI表示に利用する。
      info: { meta: { description: model.description } },
      object: 'model',
      created,
      owned_by: 'humanllm',
    })),
  })
})
