// npm scripts経由だとパス中のスペース(例: "C:\Program Files (x86)\...")の引用符が
// cmd.exeの解釈で崩れるため、spawn(引数配列渡し)でシェルを経由せず直接起動する。
const { spawn } = require('node:child_process')

const CLOUDFLARED_PATH = 'C:/Program Files (x86)/cloudflared/cloudflared.exe'
const TARGET_URL = 'http://localhost:8080'

const child = spawn(CLOUDFLARED_PATH, ['tunnel', '--url', TARGET_URL], { stdio: 'inherit' })

child.on('error', (err) => {
  console.error('Failed to start cloudflared:', err.message)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))
