// SPDX-License-Identifier: MIT
/**
 * Auto-launch of the ZeroScript bridge (bridge.py).
 *
 * The bridge is a plain Python program that owns the Roblox Studio MCP child
 * process. DSH should not require the user to remember to double-click
 * start.bat, so when the plugin is up and nothing is listening on the bridge
 * port, we start bridge.py ourselves.
 *
 * Deliberate choices:
 *  - windowless: the bridge is started through a hidden-console launcher, so the
 *    user never sees the "keep this terminal open" window that ZeroScript's own
 *    start.bat requires - and neither do its MCP grandchildren (see
 *    {@link spawnHidden} for why the obvious `windowsHide` spawn is wrong).
 *  - durable: the bridge is not tied to this process, so it survives a DSH
 *    restart or a plugin reload.
 *  - we never kill a bridge we did not start unless explicitly asked, because
 *    the user's manually started bridge may be serving their browser extension.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

/** Cheap TCP probe: is something accepting connections on this loopback port? */
export function isPortListening(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.connect(port, host)
  })
}

/** Where a ZeroScript checkout may live, most specific first. */
export function candidateBridgeDirs(explicit) {
  const dirs = []
  if (explicit) dirs.push(explicit)
  const envDir = process.env.ZS_BRIDGE_DIR
  if (envDir) dirs.push(envDir)
  dirs.push(...discoverBridgeDirs())
  const home = os.homedir()
  dirs.push(
    path.join(home, '.dsh', 'zeroscript'),
    path.join(home, 'zeroscript'),
    path.join(home, 'Downloads', 'ZeroScript-Free-1.5.5'),
    path.join(home, 'Desktop', 'ZeroScript-Free-1.5.5'),
    'C:\\SSP\\E\\zeroscript', // the checkout this plugin was authored against
  )
  return dirs
}

/**
 * Look for a `ZeroScript*` folder holding bridge.py near the usual places.
 *
 * Users extract the ZeroScript zip wherever their browser put it, so a fixed
 * candidate list misses the copy they actually run. This is a bounded scan -
 * one readdir per root, no recursion - that finds it without configuration.
 */
function rawDiscoveredDirs() {
  const home = os.homedir()
  const roots = [
    home,
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    process.env.USERPROFILE ? path.join(String(process.env.USERPROFILE), 'Downloads') : null,
    // The scan is one level deep, so a download folder nested inside another
    // (D:\下载\文件\ZeroScript-Free-1.5.5 is the common Chinese-locale layout)
    // needs its container listed as a root in its own right.
    'D:\\',
    'D:\\下载',
    'D:\\下载\\文件',
    'D:\\Downloads',
    'E:\\',
    'E:\\下载',
    'C:\\SSP\\E',
  ].filter(Boolean)

  const found = []
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue // root does not exist or is unreadable - normal
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^ZeroScript/i.test(entry.name)) continue
      const dir = path.join(root, entry.name)
      if (existsSync(path.join(dir, 'bridge.py')) && !found.includes(dir)) found.push(dir)
    }
  }
  return found
}

/**
 * Version rank of a ZeroScript directory name, newest first.
 *
 * Several copies are common (an old 1.5.0 next to the current 1.5.5), and
 * launching the stale one silently downgrades the user's Studio integration.
 * Names without a parseable version sort last.
 */
function versionRank(dir) {
  const match = /ZeroScript[^0-9]*(\d+)\.(\d+)\.(\d+)/i.exec(path.basename(dir))
  if (!match) return -1
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3])
}

/** Discovered installs, newest version first. */
export function discoverBridgeDirs() {
  return rawDiscoveredDirs().sort((a, b) => versionRank(b) - versionRank(a))
}

/** First candidate directory that actually contains bridge.py. */
export function findBridgeScript(explicit) {
  for (const dir of candidateBridgeDirs(explicit)) {
    if (!dir) continue
    for (const rel of ['bridge.py', path.join('ZeroScript-Free-1.5.5', 'bridge.py')]) {
      const candidate = path.join(dir, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Locate a Python interpreter. Returns the argv prefix to use. */
export async function findPython() {
  const candidates = []
  if (process.env.ZS_PYTHON) candidates.push([process.env.ZS_PYTHON])
  candidates.push(['python'], ['python3'], ['py', '-3'])
  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    for (const version of ['Python313', 'Python312', 'Python311', 'Python310']) {
      candidates.push([path.join(localAppData, 'Programs', 'Python', version, 'python.exe')])
    }
  }
  for (const argv of candidates) {
    if (await canRun(argv)) return argv
  }
  return null
}

function canRun(argv) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(argv[0], [...argv.slice(1), '--version'], { stdio: 'ignore', windowsHide: true })
    } catch {
      return resolve(false)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve(false)
    }, 4000)
    child.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * Start the bridge with a console that exists but is never shown.
 *
 * Why not just `spawn(python, ..., { windowsHide: true })`?
 *
 * Windows decides a console-subsystem child's window like this:
 *   - parent HAS a console      -> child shares it (dies when that console closes)
 *   - parent has NO console     -> child gets a brand new console
 *
 * bridge.py fans out to `launch_studio_mcp.py` -> `StudioMCP.exe` with plain
 * `subprocess.Popen`, which passes no creation flags. So whatever console
 * bridge.py ends up with decides what the whole tree looks like:
 *
 *   detached: true   -> bridge.py has NO console, so launch_studio_mcp.py gets
 *                       a NEW one, which Windows 11 renders as a Windows
 *                       Terminal window that pops up blank. (Observed live.)
 *   detached: false  -> bridge.py shares OUR console and is killed the moment
 *                       the spawning shell closes. (Also observed live.)
 *
 * `WScript.Shell.Run` with window style 0 creates the console with SW_HIDE: it
 * exists, nothing is painted, descendants inherit it, and wscript exits
 * immediately so the bridge is not tied to our lifetime. That is the only
 * combination that is simultaneously windowless and durable.
 *
 * @returns the wscript child, or null when wscript is unavailable.
 */
function spawnHidden({ python, script, cwd, port }) {
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  if (!existsSync(wscript)) return null

  const command = [python[0], ...python.slice(1), script].map(quoteVbs).join(' ')
  const lines = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = ${quoteVbs(cwd)}`,
    `sh.Environment("Process")("ZS_BRIDGE_PORT") = ${quoteVbs(String(port))}`,
    // 0 = hidden window, False = do not wait, so wscript returns at once.
    `sh.Run ${quoteVbs(command)}, 0, False`,
  ]

  const file = path.join(os.tmpdir(), 'dsh-zeroscript-bridge.vbs')
  // wscript reads a .vbs as ANSI unless it is UTF-16LE with a BOM, and
  // ZeroScript directories routinely contain non-ASCII names (D:\下载\文件\...).
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join('\r\n'), 'utf16le')]))

  return spawn(wscript, [file], { detached: true, stdio: 'ignore', windowsHide: true })
}

/** Quote one value as a VBScript string literal. */
function quoteVbs(value) {
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Start bridge.py in the background when the port is free.
 *
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.bridgeDir] explicit ZeroScript directory
 * @param {(msg: string) => void} [options.log]
 * @param {number} [options.waitMs] how long to wait for the port to come up
 * @returns {Promise<{started: boolean, reason: string, pid?: number, script?: string, python?: string}>}
 */
export async function ensureBridgeRunning(options) {
  const { port, bridgeDir, log = () => {}, waitMs = 20_000 } = options

  if (await isPortListening(port)) {
    return { started: false, reason: 'already-running' }
  }

  const script = findBridgeScript(bridgeDir)
  if (!script) {
    return {
      started: false,
      reason: 'bridge.py not found; set the bridgeDir option or ZS_BRIDGE_DIR',
    }
  }

  const python = await findPython()
  if (!python) {
    return { started: false, reason: 'no Python interpreter found; install Python 3.9+ or set ZS_PYTHON', script }
  }

  const cwd = path.dirname(script)
  log(`starting ZeroScript bridge: ${[...python, path.basename(script)].join(' ')} (cwd ${cwd})`)

  let child
  let how
  try {
    const hidden = spawnHidden({ python, script, cwd, port })
    if (hidden) {
      child = hidden
      how = 'wscript'
    } else {
      child = spawn(python[0], [...python.slice(1), script], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ZS_BRIDGE_PORT: String(port) },
      })
      how = 'direct'
    }
  } catch (error) {
    return { started: false, reason: `failed to spawn bridge: ${error?.message ?? error}`, script, python: python[0] }
  }
  child.unref()

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await isPortListening(port)) {
      log(`bridge is listening on ${port} (started via ${how})`)
      return { started: true, reason: 'started', how, pid: child.pid, script, python: python[0] }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return {
    started: false,
    reason: `bridge did not start listening on ${port} within ${waitMs}ms (see ${path.join(cwd, 'logs', 'bridge_debug.log')})`,
    how,
    pid: child.pid,
    script,
    python: python[0],
  }
}
