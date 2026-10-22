// SPDX-License-Identifier: MIT
/**
 * Multi-server tool-naming test.
 *
 * The bridge is a multi-server aggregator, so the plugin must name tools after
 * the server they came from. This runs against a fake catalog instead of a real
 * second MCP server: the point is the naming and collision contract, not the
 * transport, and a real Blender/3ds Max install is not required to check it.
 *
 *   node tests/multiserver.test.mjs
 */
import { createAlwaysOnTools, createRemoteTools } from '../lib/tools.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}

const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }

const fakeBridge = {
  isOpen: true,
  url: 'ws://127.0.0.1:17613',
  status: { studio: true, studioProc: true, studioApp: true, mcpAlive: true, servers: [] },
  tools: [
    { name: 'script_read', description: 'Read a script.', server: 'roblox', inputSchema: { type: 'object', properties: { target_file: { type: 'string' }, studio_id: { type: 'string' } }, required: ['target_file', 'studio_id'] } },
    { name: 'execute_code', description: 'Run Python inside Blender.', server: 'blender', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
    { name: 'get_scene_info', description: 'Describe the Blender scene.', server: 'blender', inputSchema: { type: 'object', properties: {} } },
    { name: 'create_box', description: 'Create a box in 3ds Max.', server: 'dcc-mcp-3dsmax', inputSchema: { type: 'object', properties: { size: { type: 'number' } } } },
    // Deliberately collides with the roblox tool above once prefixed, to prove
    // a duplicate registration cannot silently drop a tool.
    { name: 'script_read', description: 'A different server with the same tool name.', server: 'other', inputSchema: { type: 'object', properties: {} } },
  ],
}

const definitions = createRemoteTools(ctx, fakeBridge, { prefix: 'roblox_', timeoutMs: 1000, log: () => {} })
const names = definitions.map((d) => d.name)

check('one definition per advertised tool', definitions.length === fakeBridge.tools.length, `${definitions.length}`)
check('the primary server keeps the configured prefix', names.includes('roblox_script_read'), names.join(', '))
check('another server gets its own prefix', names.includes('blender_execute_code'), names.join(', '))
check('a server id with dashes is still usable as a prefix', names.includes('dcc-mcp-3dsmax_create_box'), names.join(', '))
check('two servers advertising the same tool name both survive', names.filter((n) => n.startsWith('other_script_read')).length === 1, names.join(', '))
check('tool names are unique', new Set(names).size === names.length, names.join(', '))
check('no tool from another server is mislabelled as roblox', !names.some((n) => n.startsWith('roblox_') && !['roblox_script_read'].includes(n)), names.join(', '))

const robloxTool = definitions.find((d) => d.name === 'roblox_script_read')
const blender = definitions.find((d) => d.name === 'blender_execute_code')
check('a non-primary tool still declares its schema', blender.parameters.properties.code.type === 'string')
check('a non-primary tool names its own server', /blender/i.test(blender.description), blender.description)
check(
  'a non-primary tool is NOT attributed to Roblox Studio',
  !/Roblox Studio/i.test(blender.description),
  blender.description,
)
check(
  'the primary server keeps its attribution',
  /^Roblox Studio/.test(robloxTool.description),
  robloxTool.description,
)

check('studio_id stays optional on the primary server', !(robloxTool.parameters.required ?? []).includes('studio_id'), JSON.stringify(robloxTool.parameters.required))
const alwaysOn = createAlwaysOnTools(ctx, fakeBridge, { prefix: 'roblox_', timeoutMs: 1000, log: () => {}, detector: null })
check('the three always-on tools are still registered', alwaysOn.length === 3, alwaysOn.map((d) => d.name).join(', '))
check(
  'the always-on tools keep the primary prefix',
  alwaysOn.every((d) => d.name.startsWith('roblox_')),
  alwaysOn.map((d) => d.name).join(', '),
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
