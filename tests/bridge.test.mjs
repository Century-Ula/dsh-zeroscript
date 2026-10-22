// SPDX-License-Identifier: MIT
/**
 * Live smoke test for lib/bridge.js against a running ZeroScript bridge.
 *
 * Read-only: connects, reads status + tool catalog, and calls one non-mutating
 * Studio tool to prove the round trip. Never edits the place.
 *
 *   node tests/bridge.test.mjs [port]
 */
import { ZeroScriptBridge } from '../lib/bridge.js'

const port = Number(process.argv[2]) || 17613
let failures = 0
let skipped = 0

function check(label, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures++
  console.log(`[${mark}] ${label}${detail ? `  ${detail}` : ''}`)
}

/** For assertions that need Roblox Studio itself to be open. */
function requireStudio(label, why) {
  skipped++
  console.log(`[SKIP] ${label}  ${why}`)
}

const bridge = new ZeroScriptBridge({
  port,
  log: (m) => console.log(`  · ${m}`),
  logError: (m) => console.log(`  ! ${m}`),
  statusPollMs: 0,
})

bridge.subscribe((event) => {
  if (event.type === 'status') return // noisy
  if (event.type === 'tools') console.log(`  · tools event: ${event.tools.length} tool(s)`)
  if (event.type === 'call-start') console.log(`  · call-start ${event.name}`)
  if (event.type === 'call-end') console.log(`  · call-end ${event.name} ok=${event.ok} ${event.ms}ms`)
  if (event.type === 'log') console.log(`  · [${event.level}] ${event.message}`)
})

const waitForOpen = (timeoutMs = 8000) =>
  new Promise((resolve, reject) => {
    if (bridge.isOpen) return resolve(true)
    const started = Date.now()
    const timer = setInterval(() => {
      if (bridge.isOpen) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error(`bridge did not open ${bridge.url} within ${timeoutMs}ms`))
      }
    }, 100)
  })

async function main() {
  console.log(`connecting to ${bridge.url}`)
  bridge.start()
  await waitForOpen()
  check('websocket open', bridge.isOpen)

  const status = await bridge.refreshStatus()
  console.log('  status:', JSON.stringify(status))
  check('bridge reports mcp_alive', status.mcpAlive === true)

  // Roblox Studio being open is the user's business, not a property of this
  // client - so a closed Studio skips these instead of failing the suite.
  const studioReady = status.studio === true
  if (studioReady) {
    check('bridge reports a Studio place', true, 'place loaded')
    check('bridge reports a Studio process', status.studioProc === true)
  } else {
    requireStudio('bridge reports a Studio place', `Studio is not ready right now (studioProc=${status.studioProc})`)
    requireStudio('bridge reports a Studio process', 'Studio is not running')
  }

  const tools = await bridge.listTools(true)
  check('tool catalog is non-empty', tools.length > 0, `${tools.length} tool(s)`)
  const shaped = tools.every((t) => typeof t.name === 'string' && t.inputSchema)
  check('every tool has name + inputSchema', shaped)
  check('tool catalog cached on the client', bridge.tools.length === tools.length)

  const probe = tools.find((t) => t.name === 'get_studio_state')
  if (probe && studioReady) {
    // With more than one Studio attached, MCP rejects an id-less call - the
    // error still arrives as `ok: true`, so resolve the id and require the
    // real state text instead of trusting the flag.
    const list = await bridge.callTool('list_roblox_studios', {})
    let studioId = ''
    try {
      studioId = JSON.parse(list.text ?? '')?.studios?.[0]?.id ?? ''
    } catch {
      /* fall back to id-less */
    }
    const result = await bridge.callTool('get_studio_state', studioId ? { studio_id: studioId } : {})
    check(
      'get_studio_state round trip',
      result.ok === true && /Studio Mode/.test(result.text ?? ''),
      JSON.stringify(result).slice(0, 200),
    )
  } else {
    requireStudio('get_studio_state round trip', probe ? 'Studio is not ready' : 'tool not exposed')
  }

  const missing = await bridge.callTool('definitely_not_a_tool', {}).catch((e) => ({ ok: false, error: e.message }))
  check('unknown tool fails cleanly (no hang)', missing.ok === false, String(missing.error).slice(0, 120))

  bridge.stop()
  check('client stops and reports disconnected', bridge.isOpen === false)

  console.log(failures === 0 ? `\nALL PASS${skipped ? ` (${skipped} skipped - Roblox Studio not open)` : ''}` : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('fatal:', error)
  process.exit(1)
})
