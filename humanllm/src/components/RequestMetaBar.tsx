import type { RequestMeta } from '../../shared/types'

type Props = {
  model: string
  meta?: RequestMeta
  compact?: boolean
}

export function RequestMetaBar({ model, meta, compact = false }: Props) {
  const modelName = model === 'human' ? 'human (deprecated)' : model
  const modelMode = meta?.modelMode
    ?? (model.endsWith('-thinking') ? 'thinking' : model.endsWith('-mini') ? 'mini' : undefined)

  return (
    <div className={`request-meta-bar${compact ? ' compact' : ''}`}>
      <span className="request-model">{modelName}</span>
      {modelMode === 'thinking' && <span className="request-tag tag-thinking">[THINKING]</span>}
      {modelMode === 'mini' && <span className="request-tag tag-mini">[MINI]</span>}
      {meta?.webSearch && <span className="request-tag tag-web">[WEB]</span>}
      {meta?.codeInterpreter && <span className="request-tag tag-python">[PY]</span>}
    </div>
  )
}
