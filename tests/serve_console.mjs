// SPDX-License-Identifier: MIT
/**
 * Dev server: mounts the console routes on a plain node:http server so the
 * page can be opened (and screenshotted) without installing the DSH plugin.
 *
 *   node tests/serve_console.mjs [port]
 */
import http from 'node:http'
import { ZeroScriptBridge } from '../lib/bridge.js'
import { createConsoleRoutes } from '../lib/routes.js'
import { ensureBridgeRunning, findBridgeScript } from '../lib/launcher.js'

const port = Number(process.argv[2]) || 17890

const bridge = new ZeroScriptBridge({ port: 17613, log: (m) => console.log(`  · ${m}`) })
const handler = createConsoleRoutes({
  bridge,
  bridgeDir: () => findBridgeScript(),
  launchBridge: () => ensureBridgeRunning({ port: 17613, log: (m) => console.log(`  · ${m}`) }),
  log: (m) => console.log(`  · ${m}`),
})

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const hasBody = chunks.length > 0
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: hasBody && req.method !== 'GET' && req.method !== 'HEAD' ? Buffer.concat(chunks) : undefined,
  })
  const response = await handler(request)
  if (!response) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not a ZeroScript route')
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

server.listen(port, '127.0.0.1', () => {
  console.log(`ZeroScript console dev server: http://127.0.0.1:${port}/zeroscript`)
  bridge.start()
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    handler.dispose()
    bridge.stop()
    server.close(() => process.exit(0))
  })
}
