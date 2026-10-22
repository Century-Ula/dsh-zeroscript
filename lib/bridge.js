// SPDX-License-Identifier: MIT
/**
 * ZeroScript Bridge client.
 *
 * The ZeroScript bridge (bridge.py, shipped by ZeroScript-Free) is a local
 * WebSocket server that aggregates one or more MCP servers - by default the
 * Roblox Studio MCP server - and exposes a tiny JSON protocol:
 *
 *   -> {type:'ping',          id}                      <- {type:'pong', id}
 *   -> {type:'studio_status', id}                      <- {type:'studio_status', ...}
 *   -> {type:'list_tools',    id}                      <- {type:'tools', tools:[...], ...}
 *   -> {type:'call_tool', id, name, arguments, timeout} <- {type:'tool_result', id, ok, text, images}
 *   -> {type:'restart_mcp', id, server}                 <- {type:'mcp_status', ...}
 *   -> {type:'add_server'|'remove_server', ...}         <- {type:'server_changed', ...}
 *
 * On every connect the bridge also pushes an unsolicited
 *   {type:'connected', mcp_alive, studio, studio_app, studio_proc, servers, tools, port}
 *
 * This class is deliberately framework-free: it owns the socket, the request
 * correlation table, the reconnect backoff and a cached status snapshot, and
 * notifies listeners. Nothing here knows about DSH.
 */

/** Default bridge port; the bridge reads ZS_BRIDGE_PORT and defaults to 17613. */
export const DEFAULT_PORT = 17613

const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 30_000
const PING_INTERVAL_MS = 20_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000

/** A structured failure the caller can render without throwing a raw Error. */
export class BridgeError extends Error {
  constructor(message, kind = 'bridge_error') {
    super(message)
    this.name = 'BridgeError'
    this.kind = kind
  }
}

export class ZeroScriptBridge {
  #port
  #host
  #log
  #logError

  /** @type {WebSocket | null} */
  #socket = null
  #state = 'idle' // idle | connecting | open | closed
  #closedByUs = false
  #reconnectDelay = RECONNECT_MIN_MS
  #reconnectTimer = null
  #pingTimer = null
  #pollTimer = null

  #nextId = 1
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  #pending = new Map()

  /** Last status snapshot the bridge told us about. */
  #status = {
    connected: false,
    port: 0,
    mcpAlive: false,
    studio: false,
    studioApp: false,
    studioProc: false,
    servers: /** @type {Array<{id: string, alive: boolean, tools: number}>} */ ([]),
    updatedAt: 0,
  }

  /** @type {Array<object>} */
  #tools = []

  /** @type {Set<(event: object) => void>} */
  #listeners = new Set()

  /** True while the launcher is spawning bridge.py on our behalf. */
  launching = false

  /**
   * @param {object} [options]
   * @param {number} [options.port]
   * @param {string} [options.host]
   * @param {(msg: string) => void} [options.log]
   * @param {(msg: string) => void} [options.logError]
   * @param {number} [options.statusPollMs] how often to re-ask the bridge for freshness
   */
  constructor(options = {}) {
    this.#host = options.host || '127.0.0.1'
    this.#port = Number(options.port) || DEFAULT_PORT
    this.#log = options.log || (() => {})
    this.#logError = options.logError || options.log || (() => {})
    this.statusPollMs = options.statusPollMs ?? 5_000
  }

  get port() {
    return this.#port
  }

  set port(value) {
    const next = Number(value) || DEFAULT_PORT
    if (next === this.#port) return
    this.#port = next
    this.#log(`bridge port changed to ${next}; reconnecting`)
    this.restart()
  }

  get url() {
    return `ws://${this.#host}:${this.#port}`
  }

  get state() {
    return this.#state
  }

  get isOpen() {
    return this.#state === 'open' && this.#socket?.readyState === 1
  }

  /** Snapshot of the most recent status the bridge reported. */
  get status() {
    return { ...this.#status, connected: this.isOpen, updatedAt: this.#status.updatedAt }
  }

  /** Cached remote tool catalog (MCP tool shape: name/description/inputSchema/server). */
  get tools() {
    return this.#tools
  }

  /** Subscribe to bridge events: status | tools | call-start | call-end | log. */
  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#logError(`listener failed: ${error?.message ?? error}`)
      }
    }
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    this.#closedByUs = false
    this.#connect()
    return this
  }

  stop() {
    this.#closedByUs = true
    this.#clearTimers()
    const socket = this.#socket
    this.#socket = null
    this.#state = 'closed'
    if (socket) {
      try {
        socket.close()
      } catch {
        /* already gone */
      }
    }
    this.#rejectAll(new BridgeError('bridge client stopped', 'stopped'))
    this.#emit({ type: 'status', status: this.status })
  }

  /** Drop the current socket and connect again immediately (port change, manual retry). */
  restart() {
    this.#clearTimers()
    const socket = this.#socket
    this.#socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
    this.#rejectAll(new BridgeError('bridge restarting', 'restart'))
    this.#reconnectDelay = RECONNECT_MIN_MS
    if (!this.#closedByUs) this.#connect()
  }

  #clearTimers() {
    for (const key of ['#reconnectTimer', '#pingTimer', '#pollTimer']) {
      const timer = this[key]
      if (timer) clearTimeout(timer)
      this[key] = null
    }
  }

  #connect() {
    if (this.#closedByUs) return
    if (this.#socket) return
    const WebSocketImpl = globalThis.WebSocket
    if (typeof WebSocketImpl !== 'function') {
      this.#logError('global WebSocket is unavailable in this runtime; cannot reach the bridge')
      this.#state = 'closed'
      return
    }
    this.#state = 'connecting'
    this.#emit({ type: 'status', status: this.status })
    let socket
    try {
      socket = new WebSocketImpl(this.url)
    } catch (error) {
      this.#state = 'closed'
      this.#scheduleReconnect(`connect threw: ${error?.message ?? error}`)
      return
    }
    this.#socket = socket

    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#state = 'open'
      this.#reconnectDelay = RECONNECT_MIN_MS
      this.#log(`bridge connected at ${this.url}`)
      this.#startPing()
      this.#startPolling()
      this.#emit({ type: 'status', status: this.status })
    })

    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return
      this.#handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
    })

    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#state = 'closed'
      this.#clearTimers()
      this.#rejectAll(new BridgeError('bridge connection closed', 'disconnected'))
      this.#status.connected = false
      this.#emit({ type: 'status', status: this.status })
      this.#scheduleReconnect('socket closed')
    })

    socket.addEventListener('error', () => {
      // 'close' always follows; keep the log quiet to avoid double reporting.
    })
  }

  #scheduleReconnect(reason) {
    if (this.#closedByUs || this.#reconnectTimer) return
    const delay = this.#reconnectDelay
    this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, RECONNECT_MAX_MS)
    this.#emit({ type: 'log', level: 'warn', message: `bridge offline (${reason}); retrying in ${delay}ms` })
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delay)
    if (typeof this.#reconnectTimer?.unref === 'function') this.#reconnectTimer.unref()
  }

  #startPing() {
    if (this.#pingTimer) return
    const tick = async () => {
      if (!this.isOpen) return
      try {
        await this.request('ping', {}, 5_000)
      } catch {
        /* the close handler owns recovery */
      }
    }
    this.#pingTimer = setInterval(tick, PING_INTERVAL_MS)
    if (typeof this.#pingTimer?.unref === 'function') this.#pingTimer.unref()
  }

  #startPolling() {
    if (this.#pollTimer || !this.statusPollMs) return
    const tick = async () => {
      if (!this.isOpen) return
      try {
        await this.refreshStatus()
      } catch {
        /* transient */
      }
    }
    this.#pollTimer = setInterval(tick, this.statusPollMs)
    if (typeof this.#pollTimer?.unref === 'function') this.#pollTimer.unref()
    void tick()
  }

  // ------------------------------------------------------------------ inbound

  #handleMessage(raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      this.#logError(`bridge sent non-JSON payload: ${raw.slice(0, 120)}`)
      return
    }
    const type = msg?.type

    // Replies correlate by id; the bridge echoes it on every response.
    if (typeof msg?.id === 'number' && this.#pending.has(msg.id)) {
      const entry = this.#pending.get(msg.id)
      this.#pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (type === 'tool_result') {
        entry.resolve({
          ok: msg.ok !== false,
          text: typeof msg.text === 'string' ? msg.text : '',
          images: Array.isArray(msg.images) ? msg.images : [],
          error: msg.error,
          kind: msg.kind,
        })
      } else {
        entry.resolve(msg)
      }
      // Several replies also carry status worth caching.
      if (Array.isArray(msg.tools)) this.#absorbTools(msg.tools, msg)
      if (type === 'studio_status' || type === 'tools' || type === 'mcp_status') this.#absorbStatus(msg)
      return
    }

    switch (type) {
      case 'connected':
        this.#absorbStatus(msg)
        if (Array.isArray(msg.tools)) this.#absorbTools(msg.tools, msg)
        break
      case 'pong':
        break
      case 'tools':
        if (Array.isArray(msg.tools)) this.#absorbTools(msg.tools, msg)
        this.#absorbStatus(msg)
        break
      case 'mcp_status':
        this.#absorbStatus(msg)
        if (Array.isArray(msg.tools)) this.#absorbTools(msg.tools, msg)
        break
      case 'error':
        this.#logError(`bridge error: ${msg.error}`)
        this.#emit({ type: 'log', level: 'error', message: String(msg.error) })
        break
      default:
        this.#emit({ type: 'message', message: msg })
    }
  }

  #absorbStatus(msg) {
    if (typeof msg.mcp_alive === 'boolean') this.#status.mcpAlive = msg.mcp_alive
    if (typeof msg.studio === 'boolean') this.#status.studio = msg.studio
    if (typeof msg.studio_app === 'boolean') this.#status.studioApp = msg.studio_app
    if (typeof msg.studio_proc === 'boolean') this.#status.studioProc = msg.studio_proc
    if (typeof msg.port === 'number') this.#status.port = msg.port
    if (Array.isArray(msg.servers)) this.#status.servers = msg.servers
    this.#status.connected = this.isOpen
    this.#status.updatedAt = Date.now()
    this.#emit({ type: 'status', status: this.status })
  }

  /** Publish a new tool catalog, but only when it actually changed. */
  #absorbTools(tools, msg) {
    const signature = tools.map((t) => t?.name).join('\u0000')
    if (signature === this.#tools.map((t) => t?.name).join('\u0000') && this.#tools.length === tools.length) {
      this.#tools = tools
      return
    }
    this.#tools = tools
    this.#log(`bridge reports ${tools.length} tool(s): ${tools.map((t) => t?.name).slice(0, 8).join(', ')}${tools.length > 8 ? ', ...' : ''}`)
    this.#emit({ type: 'tools', tools, status: this.status, servers: msg?.servers ?? this.#status.servers })
  }

  // ----------------------------------------------------------------- outbound

  /**
   * Send one request and await its reply. Rejects on timeout or disconnect so a
   * caller never hangs; the DSH tool wrapper turns that into a failed result.
   */
  request(type, payload = {}, timeoutMs = 15_000) {
    if (!this.isOpen || !this.#socket) {
      return Promise.reject(new BridgeError('ZeroScript bridge is not connected', 'disconnected'))
    }
    const id = this.#nextId++
    const socket = this.#socket
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new BridgeError(`bridge request '${type}' timed out after ${timeoutMs}ms`, 'timeout'))
      }, timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      this.#pending.set(id, { resolve, reject, timer })
      try {
        socket.send(JSON.stringify({ type, id, ...payload }))
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new BridgeError(`bridge send failed: ${error?.message ?? error}`, 'send_failed'))
      }
    })
  }

  #rejectAll(error) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  /** Ask the bridge for a fresh Studio/MCP status snapshot. */
  async refreshStatus() {
    const reply = await this.request('studio_status', {}, 8_000)
    this.#absorbStatus(reply)
    return this.status
  }

  /**
   * Ask for the aggregated tool catalog.
   * @param {boolean} [refresh] force the bridge to re-query every MCP server
   */
  async listTools(refresh = false) {
    const reply = await this.request('list_tools', refresh ? { refresh: true } : {}, 30_000)
    const tools = Array.isArray(reply.tools) ? reply.tools : []
    this.#absorbStatus(reply)
    this.#absorbTools(tools, reply)
    return tools
  }

  /**
   * Execute one remote MCP tool through the bridge.
   * @returns {Promise<{ok: boolean, text: string, images: Array<{data: string, mimeType?: string}>, error?: string, kind?: string}>}
   */
  async callTool(name, args = {}, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
    if (!name) throw new BridgeError('tool name is required', 'bad_request')
    this.#emit({ type: 'call-start', name, arguments: args, at: Date.now() })
    const started = Date.now()
    try {
      const result = await this.request('call_tool', { name, arguments: args, timeout: timeoutMs }, timeoutMs + 15_000)
      this.#emit({ type: 'call-end', name, ok: result.ok, ms: Date.now() - started, result })
      return result
    } catch (error) {
      const failure = {
        ok: false,
        text: '',
        images: [],
        error: error?.message ?? String(error),
        kind: error?.kind ?? 'bridge_error',
      }
      this.#emit({ type: 'call-end', name, ok: false, ms: Date.now() - started, result: failure })
      throw error
    }
  }

  /** Restart one MCP server child process inside the bridge. */
  async restartServer(serverId) {
    const reply = await this.request('restart_mcp', { server: serverId }, 30_000)
    if (Array.isArray(reply.tools)) this.#absorbTools(reply.tools, reply)
    this.#absorbStatus(reply)
    return reply
  }
}
