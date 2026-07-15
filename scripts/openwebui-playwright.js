const fs = require('node:fs')
const path = require('node:path')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function deadlineAfter(ms) {
  return Date.now() + ms
}

async function firstVisible(locator) {
  const count = await locator.count()
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index)
    if (await candidate.isVisible().catch(() => false)) return candidate
  }
  return null
}

class OpenWebUiPlaywrightTransport {
  constructor(options) {
    this.options = options
    this.context = null
    this.page = null
  }

  async start() {
    const { chromium } = require('playwright-core')
    fs.mkdirSync(this.options.profileDir, { recursive: true })

    const launchOptions = {
      headless: this.options.headless,
      viewport: null,
      args: ['--start-maximized'],
    }
    if (this.options.executablePath) {
      launchOptions.executablePath = this.options.executablePath
    } else {
      launchOptions.channel = 'chrome'
    }

    this.context = await chromium.launchPersistentContext(
      this.options.profileDir,
      launchOptions,
    )
    this.page = this.context.pages()[0] || await this.context.newPage()
    await this.page.bringToFront()
    await this.page.goto(this.options.url, { waitUntil: 'domcontentloaded' })

    console.log('[browser] Open WebUIをChromeで開きました。')
    console.log('[browser] 初回は、開いた画面でOpen WebUIへログインしてください。')
    console.log(`[browser] プロファイル: ${this.options.profileDir}`)

    await this.waitForComposer()
    await this.selectHumanModel()
  }

  async waitForComposer() {
    const deadline = deadlineAfter(this.options.setupTimeoutMs)
    while (Date.now() < deadline) {
      if (this.page.isClosed()) throw new Error('Open WebUIのブラウザが閉じられました')
      const input = await this.findEditableInput()
      if (input) return input
      await sleep(500)
    }
    throw new Error(
      `Open WebUIの入力欄を確認できませんでした。ログインを完了してください (${this.options.url})`,
    )
  }

  async findEditableInput() {
    const candidates = this.page.locator([
      '#chat-input[contenteditable="true"]',
      'textarea#chat-input',
      '#chat-input textarea',
      '#chat-input [contenteditable="true"]',
    ].join(', '))
    return firstVisible(candidates)
  }

  async selectHumanModel() {
    const modelButtons = this.page.locator(
      'button[id^="model-selector-"][id$="-button"]',
    )
    const modelButton = await firstVisible(modelButtons)
    if (!modelButton) {
      throw new Error('Open WebUIのモデル選択ボタンが見つかりません')
    }

    const selected = (await modelButton.innerText()).trim()
    if (selected.toLowerCase().includes(this.options.requiredModel.toLowerCase())) {
      console.log(`[browser] モデル: ${selected}`)
      return
    }

    await modelButton.click()
    const search = this.page.locator('#model-search-input')
    await search.waitFor({ state: 'visible', timeout: 10_000 })
    await search.fill(this.options.requiredModel)

    const exactOption = this.page.locator(
      `button[data-value="${this.options.requiredModel}"]`,
    )
    const option = await firstVisible(exactOption)
    if (!option) {
      await this.page.keyboard.press('Escape')
      throw new Error(
        `Open WebUIでモデル「${this.options.requiredModel}」が見つかりません。OpenAI互換接続を確認してください。`,
      )
    }
    await option.click()
    console.log(`[browser] モデル「${this.options.requiredModel}」を選択しました。`)
  }

  async typeMessage(input, text) {
    await input.fill('')
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]) {
        await input.pressSequentially(lines[index], { delay: this.options.typingDelayMs })
      }
      if (index < lines.length - 1) await input.press('Shift+Enter')
    }
  }

  async waitForNewAssistant(previousCount) {
    const rows = this.page.locator('div[id^="message-"]:has(.chat-assistant)')
    const deadline = deadlineAfter(this.options.responseTimeoutMs)
    while (Date.now() < deadline) {
      const count = await rows.count()
      if (count > previousCount) return rows.last()
      await sleep(250)
    }
    throw new Error('Open WebUIに人間LLMの返答が現れる前にタイムアウトしました')
  }

  async waitForCompletedResponse(row) {
    const deadline = deadlineAfter(this.options.responseTimeoutMs)
    const actionButtons = row.locator('.buttons button')
    while (Date.now() < deadline) {
      if (await actionButtons.count() > 0) {
        await sleep(300)
        return
      }
      await sleep(250)
    }
    throw new Error('Open WebUIで人間LLMの返答完了を待っている間にタイムアウトしました')
  }

  async readVisibleResponse(row) {
    const content = row.locator('.chat-assistant').first()
    return content.evaluate((element) => {
      const clone = element.cloneNode(true)
      clone.querySelectorAll('details, button, [aria-hidden="true"]').forEach((node) => node.remove())
      return (clone.innerText || clone.textContent || '').trim()
    })
  }

  async ask({ text }) {
    const input = await this.waitForComposer()
    const assistantRows = this.page.locator('div[id^="message-"]:has(.chat-assistant)')
    const previousCount = await assistantRows.count()

    await this.typeMessage(input, text)
    await input.press('Enter')

    const row = await this.waitForNewAssistant(previousCount)
    await this.waitForCompletedResponse(row)
    const answer = await this.readVisibleResponse(row)
    return answer || '（Open WebUIにテキスト以外の返答が表示されました）'
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {})
  }
}

async function createOpenWebUiTransport(options) {
  const transport = new OpenWebUiPlaywrightTransport({
    url: 'http://localhost:8080/',
    profileDir: path.resolve('data/ai-user-browser-profile'),
    requiredModel: 'human',
    setupTimeoutMs: 10 * 60 * 1000,
    responseTimeoutMs: 60 * 60 * 1000,
    typingDelayMs: 35,
    headless: false,
    executablePath: '',
    ...options,
  })
  try {
    await transport.start()
    return transport
  } catch (error) {
    await transport.close()
    throw error
  }
}

module.exports = { createOpenWebUiTransport }
