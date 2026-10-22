// SPDX-License-Identifier: MIT
/**
 * Live test for the Studio detector against the real bridge and real Studio.
 *
 * The verdict itself depends on what the machine is doing right now (Studio may
 * be closed, mid-start, or fully loaded), so the assertions are about the
 * detector's CONTRACT: the ladder is walked in order, the verdict agrees with
 * the layers it reports, and a real tool call backs up "connected".
 *
 *   node tests/detect.test.mjs
 */
import { ZeroScriptBridge } from '../lib/bridge.js'
import { StudioDetector, VERDICTS } from '../lib/detect.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}

const bridge = new ZeroScriptBridge({ port: 17613, log: () => {}, logError: (m) => console.log(`  ! ${m}`), statusPollMs: 0 })
const detected = []
const detector = new StudioDetector({
  bridge,
  intervalMs: 0,
  verify: true,
  log: (m) => console.log(`  · ${m}`),
})
detector.subscribe((event) => {
  if (event.type === 'change') detected.push(`${event.previous} → ${event.state.verdict}`)
})

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

const state = await detector.detect()
console.log(`  verdict=${state.verdict} verified=${state.verified} tools=${state.tools}`)
console.log(`  layers=${JSON.stringify(state.layers)}`)
console.log(`  proof=${JSON.stringify(state.proof)}`)

check('verdict is a known one', Object.values(VERDICTS).includes(state.verdict), state.verdict)
check('bridge layer is true while the socket is open', state.layers.bridge === true)
check('a transition was recorded', detected.length >= 1, detected.join(' | ') || '(none)')
check('state carries a timestamp and a check count', state.at > 0 && state.checks >= 1)

// The verdict must agree with the layers it reports - this is the whole point
// of the ladder, and the easiest thing to get wrong.
const consistent = {
  [VERDICTS.CONNECTED]: () => state.layers.mcp && state.layers.place,
  [VERDICTS.STUDIO_NO_PLACE]: () => state.layers.mcp && state.layers.studioApp && !state.layers.place,
  [VERDICTS.STUDIO_NO_MCP]: () => state.layers.mcp && !state.layers.studioApp && state.layers.studioProc,
  [VERDICTS.STUDIO_CLOSED]: () => !state.layers.studioApp && !state.layers.studioProc,
  [VERDICTS.MCP_DOWN]: () => !state.layers.mcp || state.tools === 0,
  [VERDICTS.PROBE_UNKNOWN]: () => true,
  [VERDICTS.BRIDGE_OFFLINE]: () => false,
  [VERDICTS.BRIDGE_CONNECTING]: () => false,
}
check(`verdict "${state.verdict}" matches its own layers`, (consistent[state.verdict] ?? (() => false))())

if (state.verdict === VERDICTS.CONNECTED) {
  check('"connected" was proven by a real tool call', state.verified === true, String(state.proof))
  check('the proof names what the call returned', typeof state.proof === 'string' && state.proof.length > 0)
} else {
  console.log(`  (Studio is not fully ready right now, so verification was not expected: ${state.detail})`)
  check('a non-connected verdict carries an action for the user', typeof state.action === 'string' && state.action.length > 0, String(state.action))
}

// A second probe with the same machine state must not invent a transition.
const before = detected.length
const again = await detector.detect()
check('re-probing the same state reports no new transition', detected.length === before, `${detected.length - before} new`)
check('re-probing still returns a verdict', Object.values(VERDICTS).includes(again.verdict))

detector.stop()
bridge.stop()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
