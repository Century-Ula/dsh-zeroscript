// SPDX-License-Identifier: MIT
/**
 * Studio detection: is Roblox Studio really open, really enabled, and really
 * connected?
 *
 * "Studio is running" and "Studio is usable" are four different things, and the
 * difference matters every time someone asks why a tool failed:
 *
 *   1. the RobloxStudio process exists          (tasklist)
 *   2. Studio's MCP server is on and attached   (list_roblox_studios)
 *   3. a place is actually loaded               (get_studio_state)
 *   4. a real tool call round-trips             (this module's verification)
 *
 * The bridge already computes 1-3 (`probe_studio`) and pushes a fresh snapshot
 * whenever Studio attaches or a place opens. This module fuses those layers into
 * ONE verdict with the corrective step for the user, watches for transitions so
 * the plugin can react the moment Studio appears, and - once the ladder reaches
 * the top - proves the whole chain by actually running a read-only tool.
 *
 * Verification is deliberately a real call rather than another status read:
 * every layer below it can look healthy while the MCP child is wedged, and the
 * whole point of this feature is to answer "connected" only when it is true.
 */

/** Verdict ladder, worst to best. */
export const VERDICTS = Object.freeze({
  BRIDGE_OFFLINE: 'bridge-offline',
  BRIDGE_CONNECTING: 'bridge-connecting',
  MCP_DOWN: 'mcp-down',
  STUDIO_CLOSED: 'studio-closed',
  STUDIO_NO_MCP: 'studio-no-mcp',
  STUDIO_NO_PLACE: 'studio-no-place',
  PROBE_UNKNOWN: 'probe-unknown',
  CONNECTED: 'connected',
})

const PRESENTATION = {
  [VERDICTS.BRIDGE_OFFLINE]: {
    level: 'error',
    label: 'Bridge 离线',
    detail: '本地 ZeroScript Bridge 没有运行，插件正在后台尝试启动它。',
    action: '等待自动启动；若一直失败，点「启动 Bridge」，或检查 Python 是否可用。',
  },
  [VERDICTS.BRIDGE_CONNECTING]: {
    level: 'warn',
    label: 'Bridge 连接中',
    detail: '正在与本地 Bridge 建立 WebSocket 连接。',
    action: null,
  },
  [VERDICTS.MCP_DOWN]: {
    level: 'error',
    label: 'Studio MCP 无响应',
    detail: 'Bridge 在运行，但 StudioMCP 子进程没有发布任何工具。',
    action: 'Bridge 会自动重启它；持续无响应时重启 bridge.py。',
  },
  [VERDICTS.STUDIO_CLOSED]: {
    level: 'idle',
    label: 'Studio 未运行',
    detail: '没有检测到 Roblox Studio 进程。',
    action: '打开 Roblox Studio 并加载一个 place。',
  },
  [VERDICTS.STUDIO_NO_MCP]: {
    level: 'warn',
    label: 'Studio 已开，MCP 未启用',
    detail: 'Roblox Studio 进程在运行，但它还没有连上 MCP 服务。',
    action: '在 Studio 里打开：Assistant Settings → MCP Servers → Enable Studio as MCP server，然后加载一个 place。',
  },
  [VERDICTS.STUDIO_NO_PLACE]: {
    level: 'warn',
    label: 'Studio 已连接，未加载 place',
    detail: 'Studio 已接上 MCP，但当前没有打开任何 place。',
    action: '在 Roblox Studio 里打开或新建一个 place。',
  },
  [VERDICTS.PROBE_UNKNOWN]: {
    level: 'warn',
    label: '状态未知',
    detail: 'Studio 的探测请求没有得到明确回答（可能是 Studio 正忙或刚启动）。',
    action: '稍等几秒，插件会自动重试。',
  },
  [VERDICTS.CONNECTED]: {
    level: 'ok',
    label: '已连接',
    detail: 'Roblox Studio 已就绪，工具可以正常调用。',
    action: null,
  },
}

/** Cheap, side-effect-free tool used to prove the chain really works. */
const VERIFY_TOOL = 'get_studio_state'
/** Lists the Studio instances attached to MCP; unlike the Studio tools it needs no studio_id. */
const STUDIO_LIST_TOOL = 'list_roblox_studios'

/**
 * Parse a `list_roblox_studios` answer into `[{ id, name }]`.
 *
 * The bridge hands back the MCP content as text, which is normally the JSON the
 * tool produced (`{"studios":[{...}]}`); fall back to scraping the ids so a
 * cosmetic format change cannot break detection.
 */
function extractStudios(result) {
  for (const raw of [result?.text, result?.error]) {
    const text = String(raw ?? '').trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.studios) ? parsed.studios : null
      if (rows) {
        return rows
          .map((row) => ({ id: String(row?.id ?? ''), name: String(row?.name ?? '') }))
          .filter((row) => row.id)
      }
    } catch {
      /* not JSON - fall through to the regex */
    }
    const ids = [...text.matchAll(/"id"\s*:\s*"([0-9a-f-]{36})"/gi)].map((match) => ({
      id: match[1],
      name: '',
    }))
    if (ids.length) return ids
  }
  return []
}

export class StudioDetector {
  #bridge
  #log
  #intervalMs
  #verify
  #timer = null
  #listeners = new Set()
  #busy = false

  #state = {
    verdict: VERDICTS.BRIDGE_OFFLINE,
    label: PRESENTATION[VERDICTS.BRIDGE_OFFLINE].label,
    detail: PRESENTATION[VERDICTS.BRIDGE_OFFLINE].detail,
    action: PRESENTATION[VERDICTS.BRIDGE_OFFLINE].action,
    level: PRESENTATION[VERDICTS.BRIDGE_OFFLINE].level,
    verified: false,
    proof: null,
    tools: 0,
    layers: { bridge: false, mcp: false, studioProc: false, studioApp: false, place: false },
    at: 0,
    changedAt: 0,
    checks: 0,
  }

  /** @type {Array<{verdict: string, at: number}>} */
  #history = []

  /**
   * @param {object} options
   * @param {import('./bridge.js').ZeroScriptBridge} options.bridge
   * @param {(msg: string) => void} [options.log]
   * @param {number} [options.intervalMs] how often to re-probe
   * @param {boolean} [options.verify] run a real tool call once the ladder tops out
   */
  constructor({ bridge, log = () => {}, intervalMs = 5_000, verify = true }) {
    this.#bridge = bridge
    this.#log = log
    this.#intervalMs = intervalMs
    this.#verify = verify
  }

  get state() {
    return { ...this.#state, history: this.#history.slice(-12) }
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event) {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#log(`detector listener failed: ${error?.message ?? error}`)
      }
    }
  }

  start() {
    if (this.#timer) return this
    const tick = () => {
      void this.detect().catch(() => {})
    }
    this.#timer = setInterval(tick, this.#intervalMs)
    if (typeof this.#timer?.unref === 'function') this.#timer.unref()
    tick()
    return this
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * Probe every layer once and update the verdict.
   * @param {object} [options]
   * @param {boolean} [options.force] ask the bridge for a fresh probe (default true)
   * @param {boolean|null} [options.verify] run the proving tool call. Default:
   *   only when this probe is the one that reaches "connected" - verifying on
   *   every tick would mean a real Studio call every few seconds forever.
   * @returns {Promise<object>} the new state
   */
  async detect({ force = true, verify = null } = {}) {
    if (this.#busy) return this.state
    this.#busy = true
    try {
      const next = await this.#probe(force, verify)
      this.#apply(next)
      return this.state
    } finally {
      this.#busy = false
    }
  }

  async #probe(force, verifyOption) {
    const base = {
      verified: false,
      proof: null,
      tools: this.#bridge.tools.length,
      layers: { bridge: false, mcp: false, studioProc: false, studioApp: false, place: false },
    }

    if (!this.#bridge.isOpen) {
      const connecting = this.#bridge.state === 'connecting'
      return {
        ...base,
        verdict: connecting ? VERDICTS.BRIDGE_CONNECTING : VERDICTS.BRIDGE_OFFLINE,
        tools: 0,
      }
    }
    base.layers.bridge = true

    let snapshot
    try {
      snapshot = force ? await this.#bridge.refreshStatus() : this.#bridge.status
    } catch (error) {
      // The socket is up but the probe did not answer - report that honestly
      // rather than reusing a stale snapshot.
      return { ...base, verdict: VERDICTS.PROBE_UNKNOWN, detail: String(error?.message ?? error) }
    }

    base.layers.mcp = snapshot.mcpAlive === true
    base.layers.studioProc = snapshot.studioProc === true
    base.layers.studioApp = snapshot.studioApp === true
    base.layers.place = snapshot.studio === true
    base.tools = this.#bridge.tools.length

    if (!base.layers.mcp || base.tools === 0) return { ...base, verdict: VERDICTS.MCP_DOWN }
    if (base.layers.place) {
      const wantVerify = verifyOption === null ? this.#state.verdict !== VERDICTS.CONNECTED : verifyOption !== false
      const verified = wantVerify ? await this.#verifyChain() : { verified: false, proof: null }
      return {
        ...base,
        verdict: VERDICTS.CONNECTED,
        // Keep the last proof visible when this probe did not re-run it, so the
        // panel does not lose its evidence between verifications.
        verified: verified.verified || (!wantVerify && this.#state.verified === true),
        proof: verified.proof ?? (!wantVerify ? this.#state.proof : null),
      }
    }
    if (base.layers.studioApp) return { ...base, verdict: VERDICTS.STUDIO_NO_PLACE }
    if (base.layers.studioProc) return { ...base, verdict: VERDICTS.STUDIO_NO_MCP }
    // probe_studio returns null when it genuinely cannot tell; only claim
    // "closed" when it said so outright.
    if (snapshot.studioProc === false || snapshot.studioApp === false) return { ...base, verdict: VERDICTS.STUDIO_CLOSED }
    return { ...base, verdict: VERDICTS.PROBE_UNKNOWN }
  }

  /**
   * Prove the chain with real read-only tool calls.
   *
   * `get_studio_state {}` used to be enough, but once MORE THAN ONE Studio is
   * connected the connection requires an explicit `studio_id`, and the reply is
   * a plain tool error delivered with `ok: true` (the bridge only reports
   * transport success). That made this check pass while the "proof" was an
   * error message. So: list the attached instances first - a call that needs no
   * studio_id and therefore always round-trips - then read the state of a real
   * instance and require the actual state text back.
   *
   * A failure here does NOT downgrade an otherwise healthy-looking ladder to
   * "not connected" - the layers are still true and the failure may be a
   * transient wedge - but it is reported, because "connected but a call just
   * failed" is exactly the state a user needs to see.
   */
  async #verifyChain() {
    if (!this.#verify) return { verified: false, proof: null }
    try {
      const list = await this.#bridge.callTool(STUDIO_LIST_TOOL, {}, 20_000)
      if (list.ok === false) {
        return { verified: false, proof: list.error ?? `${STUDIO_LIST_TOOL} failed` }
      }
      const studios = extractStudios(list)
      if (!studios.length) {
        return { verified: false, proof: `${STUDIO_LIST_TOOL} returned no connected Studio` }
      }
      const state = await this.#bridge.callTool(VERIFY_TOOL, { studio_id: studios[0].id }, 20_000)
      const text = String(state.text ?? '').trim()
      if (state.ok === false) {
        return { verified: false, proof: state.error ?? 'verification call failed' }
      }
      // A tool error arrives as ordinary text, so require evidence of a real
      // state answer instead of trusting `ok`.
      if (!/Studio Mode/i.test(text)) {
        return {
          verified: false,
          proof: text ? text.split('\n')[0].slice(0, 200) : `${VERIFY_TOOL} returned no state`,
        }
      }
      const target = studios[0].name ? `${studios[0].name}: ` : ''
      const suffix =
        studios.length > 1
          ? `  (${studios.length} 个 Studio 已连接，调用工具时必须带 studio_id)`
          : ''
      return { verified: true, proof: target + text.split('\n')[0].slice(0, 160) + suffix }
    } catch (error) {
      return { verified: false, proof: String(error?.message ?? error) }
    }
  }

  #apply(next) {
    const presentation = PRESENTATION[next.verdict] ?? PRESENTATION[VERDICTS.PROBE_UNKNOWN]
    const previous = this.#state.verdict
    const now = Date.now()

    const state = {
      verdict: next.verdict,
      label: presentation.label,
      detail: next.detail ?? presentation.detail,
      action: presentation.action,
      level: presentation.level,
      verified: next.verified === true,
      proof: next.proof ?? null,
      tools: next.tools ?? 0,
      layers: next.layers,
      at: now,
      changedAt: previous === next.verdict ? this.#state.changedAt : now,
      checks: this.#state.checks + 1,
    }
    this.#state = state

    if (previous !== next.verdict) {
      this.#history.push({ verdict: next.verdict, at: now })
      if (this.#history.length > 40) this.#history.shift()
      this.#log(
        `Studio 检测: ${previous} → ${next.verdict} (${state.label})` +
          `${state.verified ? ` [已验证: ${state.proof}]` : ''}` +
          `${state.action ? ` | 需要: ${state.action}` : ''}`,
      )
      this.#emit({ type: 'change', previous, state: this.state })
    }
    this.#emit({ type: 'state', state: this.state })
  }
}

export { PRESENTATION as VERDICT_PRESENTATION, VERIFY_TOOL }
