// SPDX-License-Identifier: MIT
/**
 * Standalone smoke test for the console HTTP surface, independent of DSH.
 *
 * Boots a throwaway node:http server on a free loopback port, mounts the same
 * handlers index.js hands to ctx.webServer, and exercises every route against
 * the *real* ZeroScript bridge.
 *
 *   node tests/routes.test.mjs
 */
import http from 'node:http'
import { ZeroScriptBridge } from '../lib/bridge.js'
import { StudioDetector } from '../lib/detect.js'
import { createConsoleRoutes } from '../lib/routes.js'

let failures = 0
let skipped = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}
/** For assertions that need Roblox Studio itself to be open. */
const requireStudio = (label, why) => {
  skipped++
  console.log(`[SKIP] ${label}  ${why}`)
}

const bridge = new ZeroScriptBridge({ port: 17613, log: () => {}, logError: (m) => console.log(`  ! ${m}`), statusPollMs: 0 })
const detector = new StudioDetector({ bridge, intervalMs: 0, verify: true, log: () => {} })
const handler = createConsoleRoutes({
  bridge,
  detector,
  launchBridge: async () => ({ started: false, reason: 'already-running' }),
})

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const hasBody = chunks.length > 0
  const request = new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
  })
  const response = await handler(request)
  if (!response) {
    res.writeHead(404).end('no route')
    return
  }
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body) return res.end()
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(Buffer.from(value))
  }
  res.end()
})

const request = (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init)

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
bridge.start()
await new Promise((resolve) => {
  const started = Date.now()
  const timer = setInterval(() => {
    if (bridge.isOpen || Date.now() - started > 8000) {
      clearInterval(timer)
      resolve()
    }
  }, 100)
})
check('bridge connected for the test', bridge.isOpen)

try {
  const page = await request('/zeroscript')
  const html = await page.text()
  check('GET /zeroscript serves the console page', page.status === 200 && html.includes('ZeroScript 控制台'))
  check('console page references its own assets', html.includes('/zeroscript/console.css') && html.includes('/zeroscript/console.js'))

  const css = await request('/zeroscript/console.css')
  check('GET console.css', css.status === 200 && (await css.text()).includes('--accent'))

  const js = await request('/zeroscript/console.js')
  check('GET console.js', js.status === 200 && (await js.text()).includes('renderStatus'))

  const status = await (await request('/zeroscript/api/status')).json()
  check('GET api/status reports bridge connected', status.ok === true && status.bridge.connected === true)
  const studioReady = status.status?.studio === true
  if (studioReady) check('GET api/status reports live Studio', true, 'place loaded')
  else requireStudio('GET api/status reports live Studio', 'Studio is not open right now')
  check(
    'GET api/status carries a Studio detection verdict',
    Boolean(status.detection?.verdict && status.detection?.label),
    JSON.stringify(status.detection?.verdict),
  )
  check(
    'the verdict is fresh, not the initial default',
    status.detection.verdict !== 'bridge-offline' || status.bridge.connected === false,
    `${status.detection.verdict} with bridge.connected=${status.bridge.connected}`,
  )

  const detect = await (await request('/zeroscript/api/detect')).json()
  check('GET api/detect returns a verdict', detect.ok === true && Boolean(detect.detection?.verdict), detect.detection?.verdict)
  check(
    'the verdict agrees with the layers it reports',
    detect.detection.verdict !== 'connected' || (detect.detection.layers.mcp && detect.detection.layers.place),
    JSON.stringify(detect.detection.layers),
  )
  check(
    'a closed Studio is reported as such, not as connected',
    studioReady || ['studio-closed', 'studio-no-mcp', 'studio-no-place', 'probe-unknown'].includes(detect.detection.verdict),
    detect.detection.verdict,
  )
  check('api/detect returns the full tool catalog, not the compact index', detect.tools.every((t) => t.name && t.inputSchema))

  const tools = await (await request('/zeroscript/api/tools')).json()
  // The exact count depends on whether Studio is attached (the MCP proxy
  // advertises a few tools only with a live Studio), so assert the contract.
  check('GET api/tools returns the catalog', tools.ok === true && tools.tools.length > 0, `${tools.tools.length} tool(s)`)
  check('tool entries carry name + inputSchema', tools.tools.every((t) => t.name && t.inputSchema))

  // Several Studios can be attached to MCP at once, and then every Studio tool
  // requires an explicit studio_id. Resolve one the same way the agent would,
  // so this case tests the API and not the user's window layout.
  const studioList = await (
    await request('/zeroscript/api/call', {
      method: 'POST',
      body: JSON.stringify({ name: 'list_roblox_studios', arguments: {} }),
    })
  ).json()
  let firstStudioId = ''
  try {
    firstStudioId = JSON.parse(studioList.text ?? '')?.studios?.[0]?.id ?? ''
  } catch {
    /* no Studio list - fall back to the id-less call */
  }

  const good = await (
    await request('/zeroscript/api/call', {
      method: 'POST',
      body: JSON.stringify({
        name: 'get_studio_state',
        arguments: firstStudioId ? { studio_id: firstStudioId } : {},
      }),
    })
  ).json()
  if (studioReady) {
    check('POST api/call runs a real Studio tool', good.ok === true && /Studio Mode/.test(good.text), JSON.stringify(good).slice(0, 140))
  } else {
    requireStudio('POST api/call runs a real Studio tool', 'Studio is not open right now')
  }

  const bad = await (
    await request('/zeroscript/api/call', { method: 'POST', body: JSON.stringify({ name: 'nope_not_real', arguments: {} }) })
  ).json()
  check('POST api/call surfaces a tool failure without a 500', bad.ok === false && typeof bad.error === 'string', bad.error)

  const missing = await request('/zeroscript/api/call', { method: 'POST', body: JSON.stringify({}) })
  check('POST api/call rejects a missing name', missing.status === 400)

  const launch = await (await request('/zeroscript/api/launch', { method: 'POST' })).json()
  check('POST api/launch is idempotent when the port is busy', launch.ok === true && launch.reason === 'already-running')

  const reconnect = await (await request('/zeroscript/api/reconnect', { method: 'POST' })).json()
  check('POST api/reconnect acks', reconnect.ok === true)

  const unknown = await request('/zeroscript/api/nope')
  check('unknown API route returns 404 JSON', unknown.status === 404)

  const sse = await request('/zeroscript/api/events')
  check('GET api/events is an SSE stream', sse.status === 200 && (sse.headers.get('content-type') || '').includes('text/event-stream'))
  const reader = sse.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  check('SSE sends an initial status frame', first.includes('event: status'))
  await reader.cancel()
} catch (error) {
  check('test run completed without throwing', false, String(error?.stack ?? error))
}

handler.dispose()
bridge.stop()
server.close()
console.log(failures === 0 ? `\nALL PASS${skipped ? ` (${skipped} skipped - Roblox Studio not open)` : ''}` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
