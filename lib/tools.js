// SPDX-License-Identifier: MIT
/**
 * Roblox Studio tools for DSH.
 *
 * Every tool here is a hand-written ToolRuntime definition, matching exactly
 * the shape `@deepseek-ai/dsh-tools`'s `defineTool()` produces and the shape
 * the shipped `dsh-mcp-client` registers for upstream MCP tools:
 *
 *   { name, description, parameters: <raw JSON Schema>, output: { schema, render },
 *     execute(args, exec), projectContent?(exec, result) }
 *
 * We hand-write rather than call defineTool because the parameters come from
 * Roblox's own MCP server as raw JSON Schema, which is the same thing the MCP
 * client passes through.
 *
 * Two deliberate departures from a naive passthrough:
 *
 *  1. `studio_id` is dropped from `required`. Roblox marks it required on 29 of
 *     its 30 tools, but its own server resolves the focused Studio instance when
 *     it is omitted (verified live against Studio 2026-10-15: `get_studio_state`
 *     and `screen_capture` both succeed with no studio_id). Keeping it required
 *     would force the model to call `list_roblox_studios` before every single
 *     action for no benefit. A caller can still pin one explicitly.
 *
 *  2. Advertised schemas are narrowed to the JSON Schema subset DSH enforces
 *     (type / oneOf / properties / required / additionalProperties / items /
 *     enum / const + annotations). Anything outside it degrades to a permissive
 *     object schema instead of failing registration.
 */
import { Buffer } from 'node:buffer'

const TEXT = (text) => ({ type: 'text', text })

const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
])

/** Permissive fallback: accept anything, advertise nothing. */
const OPEN_OBJECT = () => ({
  type: 'object',
  properties: {},
  additionalProperties: true,
})

let assertSupportedJsonSchema = null
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  assertSupportedJsonSchema = mod?.assertSupportedJsonSchema ?? null
} catch {
  // Resolution against DSH internals failed; the local narrowing below is the
  // only guard left, which is fine - an over-narrow schema still runs.
}

/**
 * Narrow an advertised JSON Schema to the subset DSH accepts.
 * @param {any} schema the upstream `inputSchema`
 * @param {object} [options]
 * @param {string[]} [options.optionalize] properties to drop from `required`
 */
export function narrowSchema(schema, { optionalize = ['studio_id'] } = {}) {
  const narrowed = narrow(schema, 0)
  if (!narrowed || narrowed.type !== 'object') return OPEN_OBJECT()

  if (Array.isArray(narrowed.required) && optionalize.length) {
    const filtered = narrowed.required.filter((key) => !optionalize.includes(key))
    if (filtered.length) narrowed.required = filtered
    else delete narrowed.required
  }

  if (assertSupportedJsonSchema) {
    try {
      assertSupportedJsonSchema(narrowed)
      return narrowed
    } catch {
      return OPEN_OBJECT()
    }
  }
  return narrowed
}

function narrow(node, depth) {
  if (depth > 12) return undefined
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined

  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED_KEYWORDS.has(key)) continue
    if (key === 'properties') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const props = {}
      for (const [propName, propSchema] of Object.entries(value)) {
        const child = narrow(propSchema, depth + 1)
        if (child !== undefined) props[propName] = child
      }
      out.properties = props
    } else if (key === 'items') {
      const child = narrow(value, depth + 1)
      if (child !== undefined) out.items = child
    } else if (key === 'oneOf') {
      if (!Array.isArray(value)) continue
      const branches = value.map((branch) => narrow(branch, depth + 1)).filter((b) => b !== undefined)
      if (branches.length >= 2) out.oneOf = branches
    } else if (key === 'required') {
      if (Array.isArray(value)) out.required = value.filter((v) => typeof v === 'string')
    } else if (key === 'description' || key === 'title') {
      if (typeof value === 'string') out[key] = value
    } else {
      out[key] = value
    }
  }

  // `type` and `oneOf` are mutually exclusive in the enforced subset.
  if (out.oneOf !== undefined && out.type !== undefined) delete out.type
  if (out.type === undefined && out.oneOf === undefined) {
    // A property with no declared type is still legal; a root without one is not.
    if (depth === 0) return undefined
  }
  return out
}

/** Canonical result schema every tool shares. */
export const RESULT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      content: { type: 'array', items: {} },
      structuredContent: {},
    },
    required: ['content'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [TEXT(textOf(value))]
  },
}

function textOf(value) {
  const blocks = Array.isArray(value?.content) ? value.content : []
  const lines = blocks.filter((b) => b?.type === 'text').map((b) => b.text)
  if (lines.length) return lines.join('\n')
  const images = blocks.filter((b) => b?.type === 'image').length
  if (images) return `(${images} image(s) returned; they could not be attached to this model)`
  return '(empty result)'
}

/** Turn one bridge result into the canonical content array. */
function toContentBlocks(name, result) {
  const blocks = []
  const text = typeof result?.text === 'string' ? result.text.trim() : ''
  if (text) blocks.push(TEXT(text))
  else if (result?.ok === false) blocks.push(TEXT(`Error: ${result.error ?? 'unknown failure'}`))
  else blocks.push(TEXT(`(${name} returned no text)`))
  for (const image of result?.images ?? []) {
    if (image?.data) blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType || 'image/png' })
  }
  return blocks
}

/**
 * Run one remote tool and normalise the outcome.
 *
 * The bridge already guarantees a reply (result or structured error) for every
 * call, so a transport failure here means the bridge itself went away - worth
 * throwing so the turn records a real tool failure instead of a silent empty
 * success.
 */
async function runRemote(bridge, name, args, timeoutMs) {
  let result
  try {
    result = await bridge.callTool(name, args, timeoutMs)
  } catch (error) {
    throw new Error(
      `ZeroScript bridge could not run '${name}': ${error?.message ?? error}. ` +
        `Check that the bridge is running (bridge.py) and that Roblox Studio has a place open.`,
    )
  }
  if (result.ok === false) {
    const kind = result.kind ? ` [${result.kind}]` : ''
    throw new Error(`${name}${kind}: ${result.error ?? 'the tool failed'}`)
  }
  return { content: toContentBlocks(name, result), images: result.images ?? [] }
}

/**
 * Durable-image projection, mirroring dsh-mcp-client: admit images only when an
 * attachment store exists AND the routed model declares image input; otherwise
 * leave the text in place and say so.
 */
export function createImageProjection(ctx, log) {  const projections = new WeakMap()

  async function admit(exec, images) {
    if (!images.length) return null
    const attachments = ctx.get?.('attachments')
    if (!attachments?.saveImages) throw new Error('no attachment store is mounted')
    const llm = ctx.get?.('llm')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!llm || !provider || !model) throw new Error('the current model route could not be resolved')
    const info = await llm.resolveModelInfo(provider, model, exec.signal)
    if (!info?.inputModalities?.includes('image')) throw new Error(`model "${model}" does not declare image input`)
    if (exec.signal?.aborted) throw new Error('the tool call was canceled before image storage')
    const refs = await attachments.saveImages(
      images.map((image) => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mimeType || 'image/png',
      })),
    )
    return refs
  }

  return {
    /** @returns canonical content blocks when images were admitted, else null */
    async project(exec, blocks, images) {
      if (!images.length) return null
      let refs
      try {
        refs = await admit(exec, images)
      } catch (error) {
        log(`image not attached: ${error?.message ?? error}`)
        return null
      }
      if (!refs) return null
      const out = []
      let cursor = 0
      for (const block of blocks) {
        if (block.type !== 'image') {
          out.push(block)
          continue
        }
        const ref = refs[cursor++]
        out.push(ref ? { type: 'image', attachment: ref } : TEXT('[image unavailable]'))
      }
      return out
    },
    remember(exec, content) {
      projections.set(exec, content)
    },
    take(exec) {
      const value = projections.get(exec)
      projections.delete(exec)
      return value
    },
  }
}

function buildDefinition(ctx, bridge, remote, { prefix, timeoutMs, log, images }) {
  const wireName = wireNameFor(remote, prefix)
  return {
    name: wireName,
    description: describe(remote),
    parameters: narrowSchema(remote.inputSchema),
    output: RESULT_OUTPUT,
    async execute(args, exec) {
      const call = await runRemote(bridge, remote.name, args ?? {}, timeoutMs)
      const projected = await images.project(exec, call.content, call.images)
      if (projected) images.remember(exec, projected)
      return { content: call.content }
    },
    projectContent(exec, result) {
      const projected = images.take(exec)
      if (!projected) return undefined
      if (!Array.isArray(result?.content)) return undefined
      return projected
    },
  }
}

/**
 * Wire name for one remote tool.
 *
 * The bridge aggregates EVERY configured MCP server, not just Roblox Studio -
 * that is what its addon-server support is for. Prefixing all of them with
 * `roblox_` would misname a Blender or 3ds Max tool and risk collisions, so the
 * primary server keeps the configured prefix and every other server gets its
 * own: `roblox_script_read`, `blender_execute_code`, `dcc-mcp-3dsmax_...`.
 */
function wireNameFor(remote, prefix) {
  const server = typeof remote.server === 'string' && remote.server.length ? remote.server : 'roblox'
  const base = server === 'roblox' ? prefix : `${server}_`
  return `${base}${remote.name}`
}

function describe(remote) {
  const text = String(remote.description || '').replace(/\s+/g, ' ').trim()
  const server = typeof remote.server === 'string' && remote.server.length ? remote.server : 'roblox'
  // Attributing a Blender tool to "Roblox Studio" would be actively misleading
  // to the model, so only the primary server gets that name.
  const origin = server === 'roblox' ? 'Roblox Studio' : `MCP server "${server}"`
  return `${origin} · ${text}`.slice(0, 1024)
}

/**
 * The three tools that exist even when Studio is not connected, so the model can
 * always diagnose the setup and still reach a tool that only appears later.
 */
export function createAlwaysOnTools(ctx, bridge, { prefix = 'roblox_', timeoutMs = 120_000, log = () => {}, detector = null }) {
  const images = createImageProjection(ctx, log)

  const status = {
    name: `${prefix}status`,
    description:
      'Report whether Roblox Studio is reachable and USABLE right now. Returns one verdict that separates the four ' +
      'different failure modes - bridge offline, Studio MCP down, Studio open but its MCP server not enabled, ' +
      'Studio connected but no place loaded - and, when everything looks healthy, proves it by actually running a ' +
      'read-only Studio call. Call this first whenever a Roblox tool fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render(_args, value) {
        return [TEXT(value.text)]
      },
    },
    async execute() {
      // Force a fresh probe: a cached "connected" is exactly what misleads here.
      const detection = detector ? await detector.detect({ force: true }).catch(() => null) : null
      const snapshot = bridge.status
      const lines = []

      if (detection) {
        lines.push(
          `verdict: ${detection.verdict}  (${detection.label})` +
            (detection.verified ? '  [verified by a real Studio call]' : ''),
        )
        if (detection.proof) lines.push(`proof: ${detection.proof}`)
        if (detection.action) lines.push(`action needed: ${detection.action}`)
        lines.push('')
      }

      lines.push(
        `bridge: ${bridge.isOpen ? 'connected' : 'NOT connected'} (${bridge.url})`,
        `studio process running: ${snapshot.studioProc ? 'yes' : 'no'}`,
        `studio MCP attached: ${snapshot.studioApp ? 'yes' : 'no'}`,
        `place loaded: ${snapshot.studio ? 'yes' : 'no'}`,
        `studio MCP alive: ${snapshot.mcpAlive ? 'yes' : 'no'}`,
        `servers: ${snapshot.servers.map((s) => `${s.id}(${s.alive ? 'up' : 'down'}, ${s.tools} tools)`).join(', ') || 'none'}`,
        `tools available: ${bridge.tools.length}`,
      )
      if (detection && !detection.layers?.place) {
        lines.push(
          '',
          'Recovery ladder:',
          '  1. Roblox Studio must be running.',
          '  2. A place must be loaded (not the home screen).',
          '  3. MCP must be on: Assistant Settings > MCP Servers > "Enable Studio as MCP server".',
        )
      }
      return { text: lines.join('\n') }
    },
  }

  const list = {
    name: `${prefix}list_tools`,
    description:
      'List every Roblox Studio capability currently exposed through the bridge, with each tool\'s name and ' +
      'description. Use it when you need a capability that is not already in your tool list.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: RESULT_OUTPUT,
    async execute() {
      if (bridge.isOpen) await bridge.listTools(false).catch(() => {})
      const tools = bridge.tools
      if (!tools.length) {
        return { content: [TEXT('No Studio tools are available. Call ' + prefix + 'status to diagnose.')] }
      }
      const lines = tools.map((t) => `- ${prefix}${t.name}: ${String(t.description || '').replace(/\s+/g, ' ').slice(0, 160)}`)
      return { content: [TEXT(`${tools.length} Studio tool(s):\n${lines.join('\n')}`)] }
    },
  }

  const call = {
    name: `${prefix}call`,
    description:
      'Call any Roblox Studio tool by its raw name, bypassing the per-tool wrappers. Use this for a Studio ' +
      `capability that has no ${prefix}<name> tool, or to retry with arguments the wrapper schema rejected. ` +
      `Valid names are listed by ${prefix}list_tools.`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Remote Studio tool name, e.g. "execute_luau".' },
        arguments: {
          type: 'object',
          additionalProperties: true,
          description: 'Arguments object for that tool, exactly as the Studio tool expects.',
        },
        timeoutMs: { type: 'number', description: 'Optional call timeout in milliseconds (default 120000).' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: RESULT_OUTPUT,
    async execute(args, exec) {
      if (!args?.name) throw new Error('name is required')
      const timeout = Number(args.timeoutMs) > 0 ? Math.min(Number(args.timeoutMs), 600_000) : timeoutMs
      const result = await runRemote(bridge, args.name, args.arguments ?? {}, timeout)
      const projected = await images.project(exec, result.content, result.images)
      if (projected) images.remember(exec, projected)
      return { content: result.content }
    },
    projectContent(exec, result) {
      const projected = images.take(exec)
      if (!projected) return undefined
      if (!Array.isArray(result?.content)) return undefined
      return projected
    },
  }

  return [status, list, call]
}

/** One wrapper per advertised tool, across every MCP server the bridge aggregates. */
export function createRemoteTools(ctx, bridge, options) {
  const images = createImageProjection(ctx, options.log ?? (() => {}))
  const seen = new Set()
  const definitions = []
  for (const remote of bridge.tools) {
    const definition = buildDefinition(ctx, bridge, remote, { ...options, images })
    // Two servers may legitimately advertise the same tool name; a duplicate
    // registration would throw and silently drop the later one.
    let name = definition.name
    let suffix = 2
    while (seen.has(name)) name = `${definition.name}_${suffix++}`
    seen.add(name)
    if (name !== definition.name) {
      options.log?.(`tool name collision: ${definition.name} already taken; registered as ${name}`)
      definition.name = name
    }
    definitions.push(definition)
  }
  return definitions
}
