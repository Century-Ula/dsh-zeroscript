// SPDX-License-Identifier: MIT
/**
 * Launcher smoke test.
 *
 * Covers the safe, real paths:
 *   - the live bridge port is detected as busy (so we never double-start)
 *   - bridge.py discovery finds the real ZeroScript checkout
 *   - a Python interpreter is found and runnable
 *   - the full spawn -> poll -> success path, exercised against a fixture
 *     bridge.py (a stub listener) so no second real bridge - and therefore no
 *     second StudioMCP proxy - is started against the user's live Studio.
 *
 *   node tests/launcher.test.mjs
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBridgeRunning, discoverBridgeDirs, findBridgeScript, findPython, isPortListening } from '../lib/launcher.js'

/** PID listening on a loopback port, via netstat. The hidden launcher reports
 *  wscript's pid, not the bridge's, so tests must ask the OS. */
function portOwnerPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && cols[3] === 'LISTENING') return Number(cols[4])
    }
  } catch {
    /* netstat unavailable */
  }
  return null
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}

const REAL_PORT = 17613
const FIXTURE_PORT = 17777

check('live bridge port is detected as listening', (await isPortListening(REAL_PORT)) === true)
check('a free port is detected as closed', (await isPortListening(65533, '127.0.0.1', 400)) === false)

const script = findBridgeScript()
check('bridge.py discovery finds the ZeroScript checkout', Boolean(script), script || '(not found)')

const python = await findPython()
check('a runnable Python interpreter is found', Array.isArray(python) && python.length > 0, python ? python.join(' ') : '(none)')

const busy = await ensureBridgeRunning({ port: REAL_PORT, waitMs: 1000 })
check('ensureBridgeRunning is a no-op when the bridge is already up', busy.started === false && busy.reason === 'already-running', JSON.stringify(busy))

// Spawn path, against the fixture stub. ZS_BRIDGE_DIR takes precedence over the
// real checkout so findBridgeScript resolves tests/fixture/bridge.py.
process.env.ZS_BRIDGE_DIR = path.join(HERE, 'fixture')
const spawned = await ensureBridgeRunning({ port: FIXTURE_PORT, waitMs: 15_000, log: (m) => console.log(`  · ${m}`) })
check('spawn path starts a bridge.py and waits for the port', spawned.started === true, JSON.stringify(spawned))
check('the spawned process really owns the port', (await isPortListening(FIXTURE_PORT)) === true)
check('the bridge is launched without a console window', spawned.how === 'wscript', spawned.how)

const owner = portOwnerPid(FIXTURE_PORT)
check('the listening process can be identified through the OS', Number.isInteger(owner), String(owner))
if (owner) {
  try {
    process.kill(owner)
  } catch {
    /* already gone */
  }
  await new Promise((r) => setTimeout(r, 800))
  check('killing the spawned bridge frees the port', (await isPortListening(FIXTURE_PORT, '127.0.0.1', 600)) === false)
}

// The hidden launcher goes through wscript, so allow real startup time here.
const missing = await ensureBridgeRunning({ port: 65534, bridgeDir: path.join(HERE, 'fixture', 'nowhere'), waitMs: 10_000 })
check('a missing explicit bridgeDir falls back to ZS_BRIDGE_DIR', missing.started === true, JSON.stringify(missing.reason))
const strayOwner = portOwnerPid(65534)
if (strayOwner) {
  try {
    process.kill(strayOwner)
  } catch {
    /* already gone */
  }
}

// Pure discovery precedence: an unusable explicit dir must not shadow a usable
// environment-provided one, and the real checkout still resolves directly.
check(
  'findBridgeScript prefers a usable dir over a missing explicit one',
  findBridgeScript(path.join(HERE, 'fixture', 'nowhere')) === path.join(HERE, 'fixture', 'bridge.py'),
  findBridgeScript(path.join(HERE, 'fixture', 'nowhere')),
)
check(
  'findBridgeScript resolves the real checkout when asked directly',
  findBridgeScript('C:\\SSP\\E\\zeroscript') === path.join('C:\\SSP\\E\\zeroscript', 'bridge.py'),
  findBridgeScript('C:\\SSP\\E\\zeroscript'),
)

// Several ZeroScript copies side by side are normal (an old 1.5.0 next to the
// current 1.5.5); launching the stale one would silently downgrade Studio.
// Drop the fixture override so the default resolution order is what is tested.
delete process.env.ZS_BRIDGE_DIR
const discovered = discoverBridgeDirs()
const versionOf = (dir) => {
  const m = /ZeroScript[^0-9]*(\d+)\.(\d+)\.(\d+)/i.exec(path.basename(dir))
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1
}
check(
  'discovered installs are ordered newest version first',
  discovered.every((dir, i) => i === 0 || versionOf(discovered[i - 1]) >= versionOf(dir)),
  discovered.map((d) => `${path.basename(d)}(${versionOf(d)})`).join(' >= ') || '(none found)',
)
check(
  'the default choice is the newest discovered install',
  discovered.length === 0 || findBridgeScript() === path.join(discovered[0], 'bridge.py'),
  `${findBridgeScript()} vs ${discovered[0] ?? '(none)'}`,
)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
