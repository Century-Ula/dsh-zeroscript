// SPDX-License-Identifier: MIT
/**
 * Screenshot a URL through the Chrome DevTools Protocol.
 *
 * `chrome --headless --screenshot` never settles on a page that holds an open
 * EventSource (our console keeps an SSE stream up for live status), so drive
 * the browser explicitly instead: attach, navigate, wait, capture.
 *
 *   node tools/screenshot.mjs <url> <out.png> [width] [height]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const [, , url, out = 'shot.png', width = '1680', height = '1000'] = process.argv
if (!url) {
  console.error('usage: node tools/screenshot.mjs <url> <out.png> [w] [h]')
  process.exit(2)
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

const { existsSync } = await import('node:fs')
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chrome) {
  console.error('no Chrome or Edge found')
  process.exit(2)
}

const PORT = 9333
const profile = `${process.env.TEMP}\\zs-cdp-profile`
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--hide-scrollbars',
    '--mute-audio',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

const cleanup = () => {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}
process.on('exit', cleanup)

async function waitForDevtools(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) return await res.json()
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('devtools endpoint never came up')
}

const version = await waitForDevtools()
console.error(`using ${chrome} (${version['Browser']})`)

async function newTarget(targetUrl) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
  if (!res.ok) throw new Error(`cannot open target: HTTP ${res.status}`)
  return res.json()
}

const target = await newTarget(url)
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', () => reject(new Error('devtools websocket failed')), { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
})

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url })
await sleep(Number(process.env.SHOT_SETTLE_MS || 3500))

const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(out, Buffer.from(data, 'base64'))
console.error(`wrote ${out}`)

socket.close()
cleanup()
process.exit(0)
