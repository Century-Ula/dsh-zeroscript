// SPDX-License-Identifier: MIT
/**
 * Live check of lib/detect.js against a running ZeroScript bridge + Studio.
 *
 * Read-only: runs the same verification ladder the plugin runs (list the
 * attached Studios, then read one Studio's state) and prints the verdict.
 * Useful when the plugin's status looks wrong but the bridge itself is fine:
 *
 *   node tools/verify-detect.mjs [port]
 */
import { ZeroScriptBridge } from '../lib/bridge.js'
import { StudioDetector } from '../lib/detect.js'

const port = Number(process.argv[2]) || 17613
const bridge = new ZeroScriptBridge({
  port,
  log: (m) => console.log(`  · ${m}`),
  logError: (m) => console.log(`  ! ${m}`),
  statusPollMs: 0,
})

bridge.start()

const deadline = Date.now() + 10_000
while (!bridge.isOpen && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
if (!bridge.isOpen) {
  console.error(`bridge did not open ${bridge.url} within 10s`)
  process.exit(1)
}

const detector = new StudioDetector({
  bridge,
  log: (m) => console.log(`  · ${m}`),
  intervalMs: 0,
  verify: true,
})

const state = await detector.detect({ force: true, verify: true })
console.log(JSON.stringify({ verdict: state.verdict, verified: state.verified, proof: state.proof, layers: state.layers }, null, 2))

bridge.stop()
process.exit(state.verdict === 'connected' && state.verified ? 0 : 2)
