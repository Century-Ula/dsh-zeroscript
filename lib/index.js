// SPDX-License-Identifier: MIT
/**
 * ZeroScript for DeepSeek Harness — host half.
 *
 * ZeroScript-Free normally drives Roblox Studio from a browser extension pasted
 * into an AI chat page: the extension scrapes commands out of the chat reply and
 * forwards them to a local Python bridge (bridge.py), which proxies Roblox's own
 * Studio MCP server. That whole path exists only to give an external chatbot a
 * way to reach Studio. Inside DSH the agent *is* the model, so the extension and
 * the chat page are dead weight — what is actually valuable is the bridge, and
 * the tool catalog it already aggregates.
 *
 * So this plugin is a second client of the same bridge:
 *
 *     DSH agent ──▶ this plugin ──ws://127.0.0.1:17613──▶ bridge.py ──▶ Studio MCP ──▶ Roblox Studio
 *
 * It contributes three things:
 *   1. every Studio capability as a first-class DSH tool (plus `roblox_status`,
 *      `roblox_list_tools` and a raw `roblox_call` escape hatch);
 *   2. a standalone console web page at /zeroscript, which replaces the browser
 *      extension's overlay bar without needing an extension at all;
 *   3. auto-start of bridge.py, so the user never has to remember start.bat.
 *
 * The bridge protocol itself is unchanged and the ZeroScript checkout is never
 * modified — we only ever connect to it.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Startup trace written straight to a file.
 *
 * The web routes are themselves one of the things that can fail, so the
 * diagnostic route is no help when registration is what broke - and a plugin
 * that dies during load leaves a Loader entry that still reads "active". This
 * log is the only channel that survives every failure mode.
 */
const LOG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'startup.log')
function fileLog(message) {
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Plugins are loaded by URL, and Node caches ES modules by resolved URL. The
 * profile's loader patch carries a `?v=N` cache-buster on this entry, but that
 * busts only THIS file: a plain `./routes.js` import keeps the previous
 * revision alive from the earlier load, so an edit to a sibling module silently
 * does nothing until the whole app restarts.
 *
 * Propagating the entry's own query to every sibling import makes the plugin's
 * module graph reload atomically. With no query (a normal install) the
 * specifiers are exactly `./routes.js` and friends, so nothing changes.
 */
const CACHE_BUST = new URL(import.meta.url).search
fileLog(`--- module load: url=${import.meta.url}`)

const { ZeroScriptBridge } = await import(`./bridge.js${CACHE_BUST}`)
const { ensureBridgeRunning, findBridgeScript } = await import(`./launcher.js${CACHE_BUST}`)
const { createConsoleRoutes } = await import(`./routes.js${CACHE_BUST}`)
const { toNodeHandler } = await import(`./adapt.js${CACHE_BUST}`)
const { createAlwaysOnTools, createRemoteTools } = await import(`./tools.js${CACHE_BUST}`)
const { StudioDetector } = await import(`./detect.js${CACHE_BUST}`)
const { createDccTools } = await import(`./dcc.js${CACHE_BUST}`)
fileLog('--- sibling modules imported')

/**
 * Summarise the host's client-module boot graph.
 *
 * The client half only reaches the browser when this package appears in that
 * graph, and the graph is otherwise visible only inside an authenticated index
 * response - so `/zeroscript/api/host` reports it here for diagnosis.
 */
function summarizeBootGraph(graph) {
  if (!graph || typeof graph !== 'object') return null
  const rows = []
  const seen = new Set()
  const visit = (node, depth) => {
    if (!node || depth > 5 || seen.has(node)) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    seen.add(node)
    if (typeof node.id === 'string' && seen.size < 5000) {
      rows.push({
        id: node.id,
        packageName: node.packageName,
        fileName: node.fileName,
        rev: node.rev,
        platform: node.platform,
      })
    }
    for (const value of Object.values(node)) visit(value, depth + 1)
  }
  visit(graph, 0)
  return {
    keys: Object.keys(graph),
    rows: rows.filter((row, index) => rows.findIndex((r) => r.id === row.id) === index),
  }
}

/**
 * Plugin identity.
 *
 * There is deliberately no `Config` schema here.
 *
 * The schema used to be declared with `@deepseek-ai/schemastery`. That package
 * is a DSH internal: it resolves only while the profile happens to carry a
 * matching link, and when that link goes stale the *static* import at the top
 * of this file fails before any line of code runs — the plugin then vanishes
 * with no tools, no routes and no startup log to explain it. Config defaults
 * are applied in `start()` instead (`config?.… || default`), so the plugin
 * keeps working with no dependency on DSH internals at all.
 */
export const name = 'zeroscript'

/** `tools` registers model-facing capabilities; `webServer` serves the console. */
export const inject = ['tools', 'webServer']

export async function apply(ctx, config) {
  fileLog('--- apply() entered')
  const log = (message) => {
    try {
      ctx.logger?.info?.(`zeroscript: ${message}`)
    } catch {
      /* logger shape changed; never let logging break the plugin */
    }
  }
  const logError = (message) => {
    try {
      ctx.logger?.warn?.(`zeroscript: ${message}`)
    } catch {
      /* as above */
    }
  }

  // Health is reported through a mutable box so the diagnostic route registered
  // below can still answer after a later failure.
  const health = { startupError: null, startedAt: Date.now(), routes: { version: false, console: false } }

  /**
   * Register one web route, tolerating a path already held by a previous
   * instance of this plugin.
   *
   * `webServer.register` throws on a duplicate (kind, path). During a reload the
   * loader normally disposes the old fiber first, but when that disposal lags -
   * which rapid reloads make easy - the throw propagates out of `apply`, the
   * plugin dies with no tools and no routes, and the Loader entry still reads
   * "active". Losing one route is recoverable; losing the whole plugin is not.
   */
  const registerRoute = (key, label, route) => {
    try {
      const dispose = ctx.webServer.register(route)
      health.routes[key] = true
      fileLog(`route ok: ${route.kind} ${route.path}`)
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      fileLog(`route FAILED: ${route.kind} ${route.path}: ${error?.message ?? error}`)
      logError(
        `could not register ${label} (${route.path}): ${error?.message ?? error}. ` +
          'Another instance of this plugin may still hold it; restart DSH to clear it.',
      )
      return () => {}
    }
  }

  // Register the diagnostic route FIRST, importing nothing and depending on
  // nothing. If a later step throws - a bad config value, a service whose shape
  // moved, a bug in this file - the plugin otherwise vanishes silently: no
  // tools, no routes, and a Loader entry that still reads "active". This route
  // is the one thing guaranteed to answer, so the failure is visible.
  ctx.effect(
    () =>
      registerRoute('version', 'version marker', {
        kind: 'exact',
        path: '/zeroscript-version',
        handler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(
            JSON.stringify({
              plugin: name,
              cacheBust: CACHE_BUST || '(none)',
              pid: process.pid,
              node: process.version,
              startedAt: new Date(health.startedAt).toISOString(),
              startupError: health.startupError,
              routes: health.routes,
            }),
          )
        },
      }),
    'zeroscript: version marker',
  )

  try {
    await start(ctx, config, { log, logError, health, registerRoute })
    fileLog(`--- start() completed, routes=${JSON.stringify(health.routes)}`)
    log('started')
  } catch (error) {
    health.startupError = String(error?.stack ?? error)
    fileLog(`--- start() FAILED: ${health.startupError}`)
    logError(`startup failed: ${health.startupError}`)
  }
}

/**
 * Accept a bare Roblox id or a profile/group URL.
 *
 * People naturally paste `https://www.roblox.com/users/3487308849/profile`,
 * and sending that whole string as `creator.userId` would be rejected by the
 * API with an unhelpful error.
 */
function normaliseId(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const match = /(\d{3,})/.exec(text)
  return match ? match[1] : text
}

async function start(ctx, config, { log, logError, health, registerRoute }) {  const options = {
    port: Number(config?.port) || 17613,
    host: config?.host || '127.0.0.1',
    bridgeDir: config?.bridgeDir || '',
    autoLaunch: config?.autoLaunch !== false,
    exposeTools: config?.exposeTools === 'generic' ? 'generic' : 'all',
    toolPrefix: config?.toolPrefix || 'roblox_',
    toolCallTimeoutMs: Number(config?.toolCallTimeoutMs) || 120_000,
    statusPollMs: config?.statusPollMs === undefined ? 5_000 : Number(config?.statusPollMs),
    dccPaths: {
      blender: config?.blender || '',
      max: config?.max || '',
      zbrush: config?.zbrush || '',
    },
    // The key is a secret, so an environment variable is the preferred source;
    // config is supported for a local single-user setup.
    openCloud: {
      key: process.env.ROBLOX_OPEN_CLOUD_KEY || config?.openCloudKey || '',
      userId: normaliseId(process.env.ROBLOX_CREATOR_USER_ID || config?.creatorUserId),
      groupId: normaliseId(process.env.ROBLOX_CREATOR_GROUP_ID || config?.creatorGroupId),
    },
  }

  // ---------------------------------------------------------------- bridge
  const bridge = new ZeroScriptBridge({
    port: options.port,
    host: options.host,
    log,
    logError,
    statusPollMs: options.statusPollMs,
  })

  ctx.effect(() => {
    bridge.start()
    return () => bridge.stop()
  }, 'zeroscript: bridge connection')

  // ------------------------------------------------------------- detection
  // Fuses the four "is Studio usable" layers into one verdict, proves it with a
  // real tool call, and reports every transition.
  const detector = new StudioDetector({
    bridge,
    log,
    intervalMs: options.statusPollMs || 5_000,
    verify: true,
  })

  ctx.effect(() => {
    detector.start()
    return () => detector.stop()
  }, 'zeroscript: studio detection')

  ctx.effect(
    () =>
      detector.subscribe((event) => {
        if (event.type !== 'change') return
        if (event.state.verdict !== 'connected') return
        // Studio just became usable: the bridge pushes its catalog on attach,
        // but ask once more so a missed push can never leave the model without
        // tools for the rest of the session.
        void bridge.listTools(true).catch((error) => logError(`catalog refresh after attach failed: ${error?.message ?? error}`))
      }),
    'zeroscript: react to Studio attach',
  )

  // ---------------------------------------------------------------- tools
  const tools = ctx.tools
  const registrations = new Set()

  const registerAll = (definitions) => {
    const disposers = []
    for (const definition of definitions) {
      try {
        const dispose = tools.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logError(`could not register tool ${definition.name}: ${error?.message ?? error}`)
      }
    }
    for (const dispose of disposers) registrations.add(dispose)
    return disposers
  }

  const alwaysOn = createAlwaysOnTools(ctx, bridge, {
    prefix: options.toolPrefix,
    timeoutMs: options.toolCallTimeoutMs,
    log: logError,
    detector,
  })

  ctx.effect(() => {
    const disposers = registerAll(alwaysOn)
    log(`registered ${disposers.length} always-on tool(s)`)
    return () => {
      for (const dispose of disposers) {
        registrations.delete(dispose)
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'zeroscript: always-on tools')

  // Real modelling software, driven headlessly. Registered only for the hosts
  // that are actually installed, so the model never sees an unusable tool.
  ctx.effect(() => {
    let dccTools = []
    try {
      dccTools = createDccTools(ctx, {
        overrides: options.dccPaths,
        log,
        roblox: {
          apiKey: options.openCloud.key,
          creator: options.openCloud.userId
            ? { userId: options.openCloud.userId }
            : options.openCloud.groupId
              ? { groupId: options.openCloud.groupId }
              : null,
        },
      })
    } catch (error) {
      logError(`DCC detection failed: ${error?.message ?? error}`)
      return () => {}
    }
    const disposers = registerAll(dccTools)
    log(`registered ${disposers.length} DCC tool(s): ${dccTools.map((t) => t.name).join(', ') || 'none'}`)
    return () => {
      for (const dispose of disposers) {
        registrations.delete(dispose)
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'zeroscript: DCC tools')

  // One DSH tool per advertised Studio tool. The catalog arrives asynchronously
  // (and changes when Studio opens or an addon MCP server is added), so the
  // wrappers are re-registered whenever the bridge publishes a new catalog.
  if (options.exposeTools === 'all') {
    let remoteDisposers = []
    const syncRemoteTools = () => {
      for (const dispose of remoteDisposers) {
        registrations.delete(dispose)
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
      remoteDisposers = []
      if (!bridge.tools.length) return
      const definitions = createRemoteTools(ctx, bridge, {
        prefix: options.toolPrefix,
        timeoutMs: options.toolCallTimeoutMs,
        log: logError,
      })
      remoteDisposers = registerAll(definitions)
      log(`registered ${remoteDisposers.length} Studio tool wrapper(s)`)
    }

    ctx.effect(() => {
      const unsubscribe = bridge.subscribe((event) => {
        if (event.type === 'tools') syncRemoteTools()
      })
      return () => {
        unsubscribe()
        for (const dispose of remoteDisposers) {
          registrations.delete(dispose)
          try {
            dispose()
          } catch {
            /* already disposed */
          }
        }
        remoteDisposers = []
      }
    }, 'zeroscript: Studio tool wrappers')

    // The bridge may already be up with a catalog in hand by the time we get here.
    if (bridge.tools.length) syncRemoteTools()
  }

  // ---------------------------------------------------------------- console
  const routes = createConsoleRoutes({
    bridge,
    detector,
    bridgeDir: () => findBridgeScript(options.bridgeDir),
    launchBridge: () => startBridge('console button'),
    hostInfo: () => {
      const services = {}
      for (const key of ['tools', 'webServer', 'clientModules', 'attachments', 'llm', 'subprocess']) {
        try {
          services[key] = ctx.get(key) !== undefined
        } catch {
          services[key] = false
        }
      }
      let clientModules = null
      try {
        clientModules = summarizeBootGraph(ctx.get('clientModules')?.graph?.())
      } catch (error) {
        clientModules = { error: String(error?.message ?? error) }
      }
      return {
        plugin: name,
        cacheBust: CACHE_BUST || '(none)',
        routes: health.routes,
        startupError: health.startupError,
        services,
        clientModules,
        consolePath: '/zeroscript',
      }
    },
    log,
  })

  ctx.effect(() => {
    const dispose = registerRoute('console', 'console page', {
      kind: 'prefix',
      path: '/zeroscript',
      handler: toNodeHandler(routes, { onError: (error) => logError(`console route failed: ${error?.message ?? error}`) }),
    })
    if (health.routes.console) log('console page served at /zeroscript')
    return () => {
      routes.dispose()
      dispose()
    }
  }, 'zeroscript: console web page')

  // ---------------------------------------------------------------- startup
  async function startBridge(trigger) {
    const result = await ensureBridgeRunning({
      port: options.port,
      bridgeDir: options.bridgeDir,
      log,
    })
    if (result.started) {
      log(`bridge started (${trigger}); pid ${result.pid}`)
      bridge.restart()
    } else if (result.reason !== 'already-running') {
      logError(`bridge not running and could not be started: ${result.reason}`)
    }
    return result
  }

  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      if (options.autoLaunch) {
        try {
          await startBridge('auto-launch')
        } catch (error) {
          logError(`auto-launch failed: ${error?.message ?? error}`)
        }
      }
      if (cancelled) return
      if (!bridge.isOpen) {
        // Nothing launched or the launch failed; connect anyway so the reconnect
        // loop picks the bridge up whenever the user starts it themselves.
        bridge.start()
      }
      try {
        await bridge.refreshStatus()
        log(
          `ready - bridge ${bridge.isOpen ? 'connected' : 'offline'}, ` +
            `Studio ${bridge.status.studio ? 'has a place open' : 'not ready'}, ${bridge.tools.length} tool(s)`,
        )
      } catch {
        log('bridge is not reachable yet; the console page and roblox_status will report details')
      }
    })()
    return () => {
      cancelled = true
    }
  }, 'zeroscript: startup probe')

  // ------------------------------------------------------------ self-healing
  // The bridge is a separate OS process, so it can be closed by the user, die
  // with its terminal, or be killed by a crash. Requiring a human to bring it
  // back is exactly the "open start.bat and leave the window alone" chore this
  // plugin exists to remove, so when it stays unreachable we start it again.
  //
  // Deliberately patient: the reconnect loop gets 15s to recover a transient
  // drop before we spawn anything, and we spawn at most once a minute. A bridge
  // that is already listening is never touched (ensureBridgeRunning checks).
  ctx.effect(() => {
    if (!options.autoLaunch) return () => {}

    const HEAL_AFTER_MS = 15_000
    const COOLDOWN_MS = 60_000
    const TICK_MS = 5_000

    let offlineSince = bridge.isOpen ? 0 : Date.now()
    let lastAttempt = 0
    let healing = false
    let disposed = false

    const timer = setInterval(() => {
      if (disposed || healing) return
      if (bridge.isOpen) {
        if (offlineSince) log('bridge is back')
        offlineSince = 0
        return
      }
      const now = Date.now()
      if (!offlineSince) {
        offlineSince = now
        return
      }
      if (now - offlineSince < HEAL_AFTER_MS) return
      if (now - lastAttempt < COOLDOWN_MS) return
      lastAttempt = now
      healing = true
      void (async () => {
        try {
          log(`bridge has been offline for ${Math.round((now - offlineSince) / 1000)}s; starting it`)
          const result = await startBridge('auto-heal')
          if (result.started) offlineSince = 0
          else if (result.reason !== 'already-running') logError(`auto-heal could not start the bridge: ${result.reason}`)
          else offlineSince = 0
        } catch (error) {
          logError(`auto-heal failed: ${error?.message ?? error}`)
        } finally {
          healing = false
        }
      })()
    }, TICK_MS)
    if (typeof timer?.unref === 'function') timer.unref()

    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, 'zeroscript: bridge self-healing')
}
