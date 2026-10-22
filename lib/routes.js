// SPDX-License-Identifier: MIT
/**
 * HTTP surface of the ZeroScript plugin.
 *
 * Everything here is framework-free: handlers take a WHATWG `Request` and
 * return a WHATWG `Response`, so they can be mounted on the DSH web server
 * (`ctx.webServer.register`) and equally exercised from a plain node:http
 * smoke test. DSH wiring lives in index.js.
 *
 * Routes (all under /zeroscript):
 *   GET  /zeroscript                the standalone console page
 *   GET  /zeroscript/console.css    its stylesheet
 *   GET  /zeroscript/console.js     its script
 *   GET  /zeroscript/api/status     bridge + Studio snapshot + tool count
 *   GET  /zeroscript/api/tools      full remote tool catalog (?refresh=1 re-queries Studio)
 *   POST /zeroscript/api/call       {name, arguments, timeoutMs} -> tool result
 *   POST /zeroscript/api/launch     start bridge.py when the port is free
 *   POST /zeroscript/api/reconnect  drop and re-open the bridge socket
 *   GET  /zeroscript/api/detect     run the full Studio detection probe now
 *   GET  /zeroscript/api/events     Server-Sent Events: status | tools | call | detection
 *   GET  /zeroscript/api/host       self-diagnosis: mounted services + client module rows
 */
import { readFile } from 'node:fs/promises'
import dns from 'node:dns/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(HERE, 'web')

const STATIC = {
  '/zeroscript': { file: 'console.html', type: 'text/html; charset=utf-8' },
  '/zeroscript/': { file: 'console.html', type: 'text/html; charset=utf-8' },
  '/zeroscript/console.css': { file: 'console.css', type: 'text/css; charset=utf-8' },
  '/zeroscript/console.js': { file: 'console.js', type: 'text/javascript; charset=utf-8' },
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const fail = (message, status = 400) => json({ ok: false, error: String(message) }, status)

/**
 * @param {object} deps
 * @param {import('./bridge.js').ZeroScriptBridge} deps.bridge
 * @param {import('./detect.js').StudioDetector} [deps.detector]
 * @param {(options?: object) => Promise<object>} [deps.launchBridge]
 * @param {() => string} [deps.bridgeDir] resolved bridge.py directory, for the UI
 * @param {() => object} [deps.hostInfo] host self-diagnosis callback (services, client module rows)
 * @param {(msg: string, level?: string) => void} [deps.log]
 */
export function createConsoleRoutes({ bridge, detector, launchBridge, bridgeDir, hostInfo, log = () => {} }) {
  /** @type {Set<ReadableStreamDefaultController<Uint8Array>>} */
  const streams = new Set()
  const encoder = new TextEncoder()

  const frame = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const push = (event, data) => {
    const payload = frame(event, data)
    for (const controller of [...streams]) {
      try {
        controller.enqueue(payload)
      } catch {
        streams.delete(controller)
      }
    }
  }

  // Mirror bridge activity to every open console page.
  const unsubscribe = bridge.subscribe((event) => {
    if (event.type === 'status') push('status', snapshot(event.status))
    else if (event.type === 'tools') push('tools', { tools: event.tools, at: Date.now() })
    else if (event.type === 'call-start') push('call', { phase: 'start', name: event.name, at: event.at, origin: 'agent' })
    else if (event.type === 'call-end')
      push('call', { phase: 'end', name: event.name, ok: event.ok, ms: event.ms, at: Date.now(), origin: 'agent' })
  })

  // ...and every Studio detection verdict transition.
  const unsubscribeDetection = detector
    ? detector.subscribe((event) => {
        if (event.type === 'change') push('detection', { previous: event.previous, detection: event.state, at: Date.now() })
      })
    : () => {}

  function snapshot(status = bridge.status) {
    return {
      status,
      bridge: {
        url: bridge.url,
        state: bridge.state,
        connected: bridge.isOpen,
        port: bridge.port,
      },
      detection: detector ? detector.state : null,
      bridgeDir: typeof bridgeDir === 'function' ? bridgeDir() : bridgeDir,
      tools: bridge.tools.map((t) => ({ name: t.name, server: t.server })),
      at: Date.now(),
    }
  }

  async function handle(request) {
    const url = new URL(request.url)
    const route = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method.toUpperCase()

    // ---- static console assets -------------------------------------------
    const asset = STATIC[url.pathname] || (route === '/zeroscript' ? STATIC['/zeroscript'] : null)
    if (asset && (method === 'GET' || method === 'HEAD')) {
      try {
        const body = await readFile(path.join(WEB_DIR, asset.file))
        return new Response(body, {
          headers: {
            'content-type': asset.type,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          },
        })
      } catch (error) {
        return fail(`console asset missing: ${error?.message ?? error}`, 500)
      }
    }

    // ---- API --------------------------------------------------------------
    if (!url.pathname.startsWith('/zeroscript/api/')) return null

    try {
      switch (route) {
        case '/zeroscript/api/status': {
          // First paint must not show an all-grey dashboard: if the bridge has
          // never reported a snapshot yet, ask for one now instead of serving
          // the empty cache.
          if (!bridge.status.updatedAt && bridge.isOpen) {
            await bridge.refreshStatus().catch(() => {})
          }
          // Same reasoning for the verdict: serve a live one, not the initial
          // default. Cheap and unverified - the periodic detector tick and the
          // explicit /detect route own the proving call.
          if (detector && (!detector.state.at || Date.now() - detector.state.at > 8_000)) {
            await detector.detect({ force: false, verify: false }).catch(() => {})
          }
          return json({ ok: true, ...snapshot() })
        }

        case '/zeroscript/api/tools': {
          if (url.searchParams.get('refresh')) await bridge.listTools(true)
          else if (!bridge.tools.length && bridge.isOpen) await bridge.listTools(false)
          // `snapshot()` also carries a `tools` key (the compact name/server
          // index for the status pills); the full catalog must win here.
          return json({ ...snapshot(), ok: true, tools: bridge.tools })
        }

        case '/zeroscript/api/call': {
          if (method !== 'POST') return fail('POST required', 405)
          const body = await request.json().catch(() => null)
          if (!body?.name) return fail('missing tool name')
          const timeoutMs = clampTimeout(body.timeoutMs)
          const started = Date.now()
          try {
            const result = await bridge.callTool(body.name, body.arguments || {}, timeoutMs)
            return json({ ...result, ms: Date.now() - started })
          } catch (error) {
            return json(
              { ok: false, text: '', images: [], error: error?.message ?? String(error), kind: error?.kind ?? 'bridge_error', ms: Date.now() - started },
              200,
            )
          }
        }

        case '/zeroscript/api/launch': {
          if (method !== 'POST') return fail('POST required', 405)
          if (!launchBridge) return fail('launcher is not available', 501)
          const result = await launchBridge()
          log(`manual launch requested: ${JSON.stringify(result)}`)
          if (result.started) setTimeout(() => bridge.restart(), 300)
          return json({ ok: true, ...result })
        }

        case '/zeroscript/api/reconnect': {
          if (method !== 'POST') return fail('POST required', 405)
          bridge.restart()
          return json({ ok: true, state: bridge.state })
        }

        case '/zeroscript/api/detect': {
          // Force a fresh probe of every layer, including a real tool call.
          if (!detector) return fail('detector is not available', 501)
          const state = await detector.detect({ force: true, verify: true })
          // The full catalog must win over snapshot()'s compact name/server index,
          // so one click both re-probes Studio and refreshes the tool list.
          return json({ ...snapshot(), ok: true, detection: state, tools: bridge.tools })
        }

        case '/zeroscript/api/netcheck': {
          // Outbound reachability FROM THIS PROCESS. A plugin that talks to
          // Roblox Open Cloud can fail with a bare "fetch failed" while the OS
          // and every other shell on the machine reach the host fine - Electron's
          // process has its own network stack, DNS result order and proxy
          // handling. Fixed probe list only: never fetch a caller-supplied URL.
          const probes = ['https://apis.roblox.com/assets/v1/assets', 'https://www.roblox.com/', 'https://api.deepseek.com/']
          const results = []
          for (const url of probes) {
            const started = Date.now()
            const host = new URL(url).hostname
            const entry = { url, host }
            try {
              const addresses = await dns.lookup(host, { all: true })
              entry.dns = addresses.map((a) => `${a.address}/${a.family}`)
            } catch (error) {
              entry.dns = [`lookup failed: ${error?.code ?? error?.message}`]
            }
            // Raw TCP, so a DNS-vs-routing difference cannot hide behind fetch.
            entry.tcp = await new Promise((resolve) => {
              const socket = net.connect({ host, port: 443, timeout: 6_000 })
              const done = (value) => {
                socket.destroy()
                resolve(value)
              }
              socket.once('connect', () => done('connected'))
              socket.once('timeout', () => done('timeout'))
              socket.once('error', (error) => done(`error:${error?.code ?? error?.message}`))
            })
            try {
              const controller = AbortSignal.timeout(15_000)
              const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: controller })
              entry.ok = true
              entry.status = response.status
            } catch (error) {
              const cause = error?.cause
              entry.ok = false
              entry.error = error?.message ?? String(error)
              entry.code = cause?.code ?? null
              entry.cause = cause?.message ?? null
            }
            entry.ms = Date.now() - started
            results.push(entry)
          }
          return json({
            ok: true,
            node: process.version,
            execPath: process.execPath,
            envProxy: {
              HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
              https_proxy: process.env.https_proxy ?? null,
              NO_PROXY: process.env.NO_PROXY ?? null,
            },
            results,
          })
        }

        case '/zeroscript/api/host': {          // Self-diagnosis. The client half only reaches the browser when the
          // host's client-module scan picked this package up, and that graph is
          // otherwise only visible inside an authenticated index response.
          const info = hostInfo ? await hostInfo() : {}
          return json({ ok: true, ...info })
        }

        case '/zeroscript/api/events': {
          const stream = new ReadableStream({
            start(controller) {
              streams.add(controller)
              controller.enqueue(frame('status', snapshot()))
              controller.enqueue(encoder.encode(': connected\n\n'))
            },
            cancel(controller) {
              streams.delete(controller)
            },
          })
          const keepAlive = setInterval(() => {
            for (const controller of [...streams]) {
              try {
                controller.enqueue(encoder.encode(': ping\n\n'))
              } catch {
                streams.delete(controller)
              }
            }
          }, 25_000)
          if (typeof keepAlive?.unref === 'function') keepAlive.unref()
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            },
          })
        }

        default:
          return fail(`unknown ZeroScript API route: ${route}`, 404)
      }
    } catch (error) {
      return fail(error?.message ?? String(error), 500)
    }
  }

  handle.dispose = () => {
    unsubscribe()
    unsubscribeDetection()
    for (const controller of [...streams]) {
      try {
        controller.close()
      } catch {
        /* already closed */
      }
    }
    streams.clear()
  }

  /** The paths this plugin owns, so the host can mount them explicitly. */
  handle.paths = ['/zeroscript', '/zeroscript/console.css', '/zeroscript/console.js']

  return handle
}

function clampTimeout(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 120_000
  return Math.min(Math.max(num, 1_000), 600_000)
}

export { json, fail }
