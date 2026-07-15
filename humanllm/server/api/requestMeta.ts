import type { ChatMessage, RequestMeta } from '../../shared/types'

function readToolName(tool: Record<string, unknown>): string | null {
  if (typeof tool.name === 'string') return tool.name
  const fn = tool.function
  if (typeof fn === 'object' && fn !== null && 'name' in fn && typeof fn.name === 'string') {
    return fn.name
  }
  return null
}

export function buildRequestMeta(
  model: string,
  messages: ChatMessage[],
  tools?: Array<Record<string, unknown>>,
): RequestMeta {
  const toolNames = (tools ?? []).flatMap((tool) => {
    const name = readToolName(tool)
    return name ? [name] : []
  })
  const modelMode = model.endsWith('-thinking')
    ? 'thinking'
    : model.endsWith('-mini')
      ? 'mini'
      : undefined

  return {
    webSearch: toolNames.includes('search_web'),
    codeInterpreter: messages.some(
      (message) => message.role === 'system' && message.content.includes('<code_interpreter'),
    ),
    toolNames,
    modelMode,
  }
}
