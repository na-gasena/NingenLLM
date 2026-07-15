const Anthropic = require('@anthropic-ai/sdk')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createOpenWebUiTransport } = require('./openwebui-playwright')

const config = {
  provider: (process.env.AI_PROVIDER || 'anthropic').toLowerCase(),
  transport: (process.env.AI_USER_TRANSPORT || 'api').toLowerCase(),
  model: process.env.AI_MODEL || '',
  maxTurns: positiveInt(process.env.AI_USER_MAX_TURNS, 5),
  delayMs: nonNegativeInt(process.env.AI_USER_DELAY_MS, 1000),
  topic: process.env.AI_USER_TOPIC || '目の前の人について、まだ知らないことを知る会話',
  persona:
    process.env.AI_USER_PERSONA ||
    '好奇心があり、率直だが失礼ではない対話者。相手の答えをよく読み、予定調和ではない方向にも進む。',
  opening: process.env.AI_USER_OPENING || '',
  humanApiUrl:
    process.env.HUMANLLM_CHAT_URL || 'http://localhost:3000/v1/chat/completions',
  logDir: path.resolve(process.env.AI_USER_LOG_DIR || 'data/ai-user'),
  openWebUiUrl: process.env.OPENWEBUI_URL || 'http://localhost:8080/',
  browserProfileDir: path.resolve(
    process.env.AI_USER_BROWSER_PROFILE || 'data/ai-user-browser-profile',
  ),
  browserExecutablePath: process.env.AI_USER_BROWSER_EXECUTABLE || '',
  browserHeadless: process.env.AI_USER_BROWSER_HEADLESS === 'true',
  browserTypingDelayMs: nonNegativeInt(process.env.AI_USER_TYPING_DELAY_MS, 35),
  browserSetupTimeoutMs: positiveInt(process.env.AI_USER_SETUP_TIMEOUT_MS, 10 * 60 * 1000),
  browserResponseTimeoutMs: positiveInt(
    process.env.AI_USER_RESPONSE_TIMEOUT_MS,
    60 * 60 * 1000,
  ),
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function visibleHumanAnswer(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
}

function extractClaudeText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function isEndSignal(text) {
  return /^\s*\[END\]\s*$/i.test(text)
}

function buildSystemPrompt() {
  return `あなたはチャットの「ユーザー役」を担うAIです。相手は人間ですが、あなたの発言をLLMへの入力として受け取ります。

目的: ${config.topic}
人物像: ${config.persona}

ルール:
- あなたは回答者ではなく、質問・依頼・反応を送る側です。
- 1ターンにつき、相手が実際に返答できる短いメッセージを1つだけ出してください。
- 一度に質問を詰め込まず、原則として質問は1つにしてください。
- 直前の人間の回答を読み、それに具体的に反応して次へ進んでください。
- 「AIユーザー役です」「これは実験です」など、舞台裏を説明しないでください。
- 見出し、分析、選択肢、引用符、JSONは付けず、そのまま送信できる本文だけを出してください。
- 会話を十分に終えたと判断した場合だけ、本文の代わりに [END] とだけ出してください。`
}

async function generateAnthropicMessage(client, conversation) {
  const response = await client.messages.create({
    model: config.model || 'claude-sonnet-4-20250514',
    max_tokens: 512,
    system: buildSystemPrompt(),
    messages: conversation,
  })

  const text = extractClaudeText(response)
  if (!text) throw new Error('Claude returned no text content')
  return { text, usage: response.usage }
}

function buildCodexPrompt(conversation) {
  const transcript = conversation
    .map((message, index) => {
      if (index === 0) return `START INSTRUCTION:\n${message.content}`
      const label = message.role === 'assistant' ? 'AI USER' : 'HUMAN'
      return `${label}:\n${message.content}`
    })
    .join('\n\n')

  return `${buildSystemPrompt()}

以下はここまでの会話です。会話履歴の内容に答えるのではなく、履歴を踏まえた「AIユーザーの次の発言」だけを作ってください。

${transcript}

AI USERの次の発言だけを出力してください。`
}

function resolveCodexCommand() {
  if (process.env.CODEX_BIN) return { command: process.env.CODEX_BIN, prefixArgs: [] }

  // On Windows, spawning `codex.exe` by name can select the protected WindowsApps binary.
  // Prefer the npm launcher's JS file, which locates its bundled native executable itself.
  if (process.platform === 'win32' && process.env.APPDATA) {
    const npmLauncher = path.join(
      process.env.APPDATA,
      'npm',
      'node_modules',
      '@openai',
      'codex',
      'bin',
      'codex.js',
    )
    if (fs.existsSync(npmLauncher)) {
      return { command: process.execPath, prefixArgs: [npmLauncher] }
    }
  }

  return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', prefixArgs: [] }
}

function generateCodexMessage(conversation) {
  const codex = resolveCodexCommand()
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--ignore-user-config',
    '--skip-git-repo-check',
  ]
  if (config.model) args.push('--model', config.model)
  args.push('-')

  const workdir = path.join(os.tmpdir(), 'ningenllm-codex-ai-user')
  fs.mkdirSync(workdir, { recursive: true })

  return new Promise((resolve, reject) => {
    const child = spawn(codex.command, [...codex.prefixArgs, ...args], {
      cwd: workdir,
      env: process.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => reject(new Error(`Could not start Codex CLI: ${error.message}`)))
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Codex exited with code ${code}: ${stderr.trim().slice(-1000)}`))
        return
      }
      const text = stdout.trim()
      if (!text) {
        reject(new Error(`Codex returned no final message. stderr: ${stderr.trim().slice(-1000)}`))
        return
      }
      resolve({ text, usage: null })
    })

    child.stdin.end(buildCodexPrompt(conversation), 'utf8')
  })
}

function generateAiMessage(client, conversation) {
  if (config.provider === 'anthropic') return generateAnthropicMessage(client, conversation)
  if (config.provider === 'codex') return generateCodexMessage(conversation)
  throw new Error(`Unsupported AI_PROVIDER: ${config.provider}. Use "anthropic" or "codex".`)
}

async function askHumanApi(messages) {
  const response = await fetch(config.humanApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer humanllm-ai-user',
    },
    body: JSON.stringify({ model: 'human', stream: false, messages }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`humanllm returned HTTP ${response.status}: ${body.slice(0, 500)}`)
  }

  const body = await response.json()
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new Error('humanllm response did not contain choices[0].message.content')
  }
  return content
}

async function createHumanTransport() {
  if (config.transport === 'api') {
    return {
      ask: ({ messages }) => askHumanApi(messages),
      close: async () => {},
    }
  }
  if (config.transport === 'webui') {
    return createOpenWebUiTransport({
      url: config.openWebUiUrl,
      profileDir: config.browserProfileDir,
      executablePath: config.browserExecutablePath,
      headless: config.browserHeadless,
      typingDelayMs: config.browserTypingDelayMs,
      setupTimeoutMs: config.browserSetupTimeoutMs,
      responseTimeoutMs: config.browserResponseTimeoutMs,
    })
  }
  throw new Error(`Unsupported AI_USER_TRANSPORT: ${config.transport}. Use "api" or "webui".`)
}

function createLogger() {
  fs.mkdirSync(config.logDir, { recursive: true })
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(config.logDir, `${sessionId}.jsonl`)

  function write(event) {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`)
  }

  return { file, write }
}

async function main() {
  if (!['anthropic', 'codex'].includes(config.provider)) {
    throw new Error(`Unsupported AI_PROVIDER: ${config.provider}. Use "anthropic" or "codex".`)
  }
  if (!['api', 'webui'].includes(config.transport)) {
    throw new Error(`Unsupported AI_USER_TRANSPORT: ${config.transport}. Use "api" or "webui".`)
  }
  if (config.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. In PowerShell: $env:ANTHROPIC_API_KEY = "sk-ant-..."',
    )
  }

  const client = config.provider === 'anthropic'
    ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    : null
  const logger = createLogger()
  const humanTransport = await createHumanTransport()
  const claudeMessages = [
    {
      role: 'user',
      content:
        config.opening ||
        '会話を始めてください。上記の目的に沿って、まず相手に一つだけ話しかけてください。',
    },
  ]
  const humanMessages = [
    {
      role: 'system',
      content:
        'あなたの会話相手はAIです。AIから届いた質問や依頼に、人間として自由に返答してください。',
    },
  ]

  logger.write({
    type: 'session_started',
    provider: config.provider,
    transport: config.transport,
    model: config.model || 'provider-default',
    maxTurns: config.maxTurns,
    topic: config.topic,
    persona: config.persona,
  })

  console.log('AI user session started')
  console.log(`provider: ${config.provider}`)
  console.log(`transport: ${config.transport}`)
  console.log(`model: ${config.model || 'provider default'}`)
  console.log(`turns: ${config.maxTurns}`)
  console.log(`log: ${logger.file}`)
  console.log('Press Ctrl+C to stop after the current network operation.\n')

  try {
    for (let turn = 1; turn <= config.maxTurns; turn += 1) {
      const generated = await generateAiMessage(client, claudeMessages)
      if (isEndSignal(generated.text)) {
        logger.write({ type: 'ai_ended', turn })
        console.log(`[turn ${turn}] AI chose to end the conversation.`)
        break
      }

      console.log(`[turn ${turn}] AI -> human`)
      console.log(generated.text)
      logger.write({ type: 'ai_message', turn, text: generated.text, usage: generated.usage })

      claudeMessages.push({ role: 'assistant', content: generated.text })
      humanMessages.push({ role: 'user', content: generated.text })

      const rawAnswer = await humanTransport.ask({
        text: generated.text,
        messages: humanMessages,
      })
      const answer = visibleHumanAnswer(rawAnswer)
      console.log(`\n[turn ${turn}] human -> AI`)
      console.log(answer || '(empty visible answer)')
      console.log('')
      logger.write({ type: 'human_message', turn, text: answer, rawText: rawAnswer })

      humanMessages.push({ role: 'assistant', content: rawAnswer })
      claudeMessages.push({
        role: 'user',
        content: answer || '（相手から空の返答が届きました）',
      })

      if (turn < config.maxTurns && config.delayMs > 0) await sleep(config.delayMs)
    }
  } finally {
    await humanTransport.close()
  }

  logger.write({ type: 'session_completed' })
  console.log(`Session finished. Transcript: ${logger.file}`)
}

main().catch((error) => {
  console.error(`AI user failed: ${error.message}`)
  process.exitCode = 1
})
