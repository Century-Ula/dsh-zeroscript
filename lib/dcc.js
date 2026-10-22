// SPDX-License-Identifier: MIT
/**
 * DCC bridge: drive real modelling software from the agent, headlessly.
 *
 * Roblox's own model generators are a black box - you give a prompt and get
 * whatever it felt like making. The tools here are the opposite: Blender and
 * 3ds Max both ship a scripting host that runs without a UI, so the agent can
 * build geometry to an exact specification, export it, and render a preview to
 * look at. No addon, no MCP server, no socket, nothing to install on top.
 *
 *   Blender   blender.exe --background --python script.py   (bundled Python)
 *   3ds Max   3dsmaxbatch.exe script.ms|script.py           (MAXScript or Python)
 *
 * Each run gets its own workspace directory. The user script is wrapped with a
 * prelude that defines `workspace` and a postlude that prints a machine-readable
 * file listing, so a run always reports the artefacts it produced even when the
 * host's own stdout is unusable (3ds Max batch writes UTF-16 noise to the
 * console, which is why its convention is a report file instead of stdout).
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Share the content-block helpers with tools.js *as the same module instance*
 * the entry imports.
 *
 * The plugin is loaded by URL and reloads are cache-busted with a query on the
 * entry (see the note in index.js). A plain `./tools.js` import here would pull
 * a SECOND copy of that module - one that never sees the entry's query - which
 * is exactly the mismatch that made a reload hang. Propagating our own query
 * keeps one instance per load.
 */
const CACHE_BUST = new URL(import.meta.url).search
const { RESULT_OUTPUT, createImageProjection } = await import(`./tools.js${CACHE_BUST}`)
const { uploadModel, UploadError, CONTENT_TYPES } = await import(`./robloxUpload.js${CACHE_BUST}`)

const TEXT = (text) => ({ type: 'text', text })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_ROOT = path.join(HERE, '..', 'dcc-output')

const FILE_MARKER = '===DCC-FILES==='
const END_MARKER = '===DCC-END==='

/** Extensions worth handing back to the model as an image. */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])

/** Cap on attached images, and on the bytes of each. */
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 6 * 1024 * 1024

// ---------------------------------------------------------------- detection

/** Depth-bounded directory walk; DCC install trees are deep but we only need the exe. */
function findUnder(root, predicate, depth = 3) {
  if (depth < 0 || !existsSync(root)) return []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const hits = []
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isFile() && predicate(entry.name, full)) hits.push(full)
    else if (entry.isDirectory() && depth > 0) hits.push(...findUnder(full, predicate, depth - 1))
  }
  return hits
}

/** Highest version wins, so 5.1 beats a leftover 4.3 next to it. */
function highestVersion(paths, regex) {
  let best = null
  let bestRank = -1
  for (const candidate of paths) {
    const match = regex.exec(candidate)
    const rank = match ? Number(match[1]) * 1000 + Number(match[2] || 0) : 0
    if (rank > bestRank) {
      bestRank = rank
      best = candidate
    }
  }
  return best
}

/**
 * Locate the installed DCC applications.
 *
 * `C:\MS` is this machine's non-standard install root (the standard Program
 * Files locations are searched too); a `dcc` config block can override any of
 * them outright.
 */
export function detectDccApps(overrides = {}) {
  const roots = [
    'C:\\MS',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Blender Foundation'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Autodesk'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Maxon'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Pixologic'),
    'C:\\Program Files\\Autodesk',
    'D:\\',
  ].filter(Boolean)

  const blenderOverride = overrides.blender || ''
  const blenderExe =
    (blenderOverride && existsSync(blenderOverride) && blenderOverride) ||
    highestVersion(
      roots.flatMap((root) => findUnder(root, (name) => name.toLowerCase() === 'blender.exe')),
      /Blender[^0-9]*(\d+)\.(\d+)/i,
    ) ||
    roots.flatMap((root) => findUnder(root, (name) => name.toLowerCase() === 'blender.exe'))[0] ||
    null

  const maxOverride = overrides.max || ''
  const maxExe =
    (maxOverride && existsSync(maxOverride) && maxOverride) ||
    highestVersion(
      roots.flatMap((root) => findUnder(root, (name) => name.toLowerCase() === '3dsmaxbatch.exe')),
      /3ds ?Max[^0-9]*(\d+)/i,
    ) ||
    roots.flatMap((root) => findUnder(root, (name) => name.toLowerCase() === '3dsmaxbatch.exe'))[0] ||
    null

  const zbrushOverride = overrides.zbrush || ''
  const zbrushExe =
    (zbrushOverride && existsSync(zbrushOverride) && zbrushOverride) ||
    roots.flatMap((root) => findUnder(root, (name) => name.toLowerCase() === 'zbrush.exe'))[0] ||
    null

  return {
    blender: blenderExe ? { exe: blenderExe, dir: path.dirname(blenderExe), label: 'Blender' } : null,
    max: maxExe ? { exe: maxExe, dir: path.dirname(maxExe), label: '3ds Max (batch)' } : null,
    zbrush: zbrushExe ? { exe: zbrushExe, dir: path.dirname(zbrushExe), label: 'ZBrush' } : null,
  }
}

// ------------------------------------------------------------------ running

function makeRunDir(app) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = path.join(OUTPUT_ROOT, `${app}-${stamp}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Run a process to completion, capturing both streams, with a hard deadline. */
function exec(command, args, { timeoutMs = 300_000, cwd, log = () => {}, signal }) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(error?.message ?? error), stdoutBufs: [], ms: 0, timedOut: false })
      return
    }

    const kill = (why) => {
      log(why)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }

    let stdout = ''
    let stderr = ''
    const stdoutBufs = []
    const cap = 400_000
    child.stdout?.on('data', (chunk) => {
      stdoutBufs.push(chunk)
      if (stdout.length < cap) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < cap) stderr += chunk.toString('utf8')
    })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      kill(`${path.basename(command)} exceeded ${timeoutMs}ms; terminating`)
    }, timeoutMs)

    // A DCC run can take a minute; honour the caller's cancellation instead of
    // leaving an orphaned Blender or 3ds Max burning CPU after the turn ends.
    const onAbort = () => kill(`${path.basename(command)} cancelled by the caller`)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    child.once('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n${error?.message ?? error}`, stdoutBufs, ms: Date.now() - started, timedOut })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ ok: code === 0 && !timedOut && !signal?.aborted, code, stdout, stderr, stdoutBufs, ms: Date.now() - started, timedOut })
    })
  })
}

/**
 * Recover a console stream that was written as UTF-16LE.
 *
 * 3ds Max's batch console emits wide characters, so reading it as UTF-8 yields
 * the spaced-out gibberish ` 2 0 2 6 / 1 0 ...` and every `format "..."` line a
 * user script prints is lost. Detect the wide stream by its NUL interleave and
 * decode it properly.
 */
function decodeConsole(bufs) {
  if (!bufs || !bufs.length) return ''
  const raw = Buffer.concat(bufs)
  if (raw.length < 4) return raw.toString('utf8')

  // Count NULs sitting in the high byte of each 16-bit unit.
  let highNuls = 0
  const sample = Math.min(raw.length, 4000)
  for (let i = 1; i < sample; i += 2) if (raw[i] === 0x00) highNuls++
  const pairs = Math.floor(sample / 2)
  const looksWide = pairs > 0 && highNuls / pairs > 0.6

  if (!looksWide) return raw.toString('utf8')
  // Strip a BOM if present, otherwise the first character comes out as U+FEFF.
  const body = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2) : raw
  return body.toString('utf16le')
}

/** Split a run's combined output on the file-listing markers. */
function splitReport(text) {
  const start = text.indexOf(FILE_MARKER)
  if (start === -1) return { report: text.trim(), files: [] }
  const report = text.slice(0, start).trim()
  const tail = text.slice(start + FILE_MARKER.length)
  const end = tail.indexOf(END_MARKER)
  const listText = end === -1 ? tail : tail.slice(0, end)
  const files = listText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [filePath, size] = line.split('\t')
      return { path: filePath, bytes: Number(size) || 0 }
    })
    .filter((entry) => entry.path && existsSync(entry.path))
  return { report, files }
}

async function collectImages(files, log) {
  const images = []
  for (const file of files) {
    if (images.length >= MAX_IMAGES) break
    if (!IMAGE_EXT.has(path.extname(file.path).toLowerCase())) continue
    if (file.bytes > MAX_IMAGE_BYTES) {
      log(`skipping ${path.basename(file.path)}: ${file.bytes} bytes exceeds the attach limit`)
      continue
    }
    try {
      images.push({ data: readFileSync(file.path).toString('base64'), mimeType: mimeFor(file.path) })
    } catch (error) {
      log(`could not read ${file.path}: ${error?.message ?? error}`)
    }
  }
  return images
}

function mimeFor(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

// ------------------------------------------------------------------ Blender

/** Wrap user Python with a workspace definition and an artefact listing. */
export function wrapBlenderCode(code, workspace) {
  return `# --- dcc prelude (injected) ---
import os, sys, json
workspace = r"${workspace}"
os.makedirs(workspace, exist_ok=True)
print("DCC workspace:", workspace)

# --- user script ---
${code}

# --- dcc postlude (injected) ---
print("${FILE_MARKER}")
for _root, _dirs, _files in os.walk(workspace):
    for _name in sorted(_files):
        _full = os.path.join(_root, _name)
        try:
            print(_full + "\\t" + str(os.path.getsize(_full)))
        except OSError:
            pass
print("${END_MARKER}")
`
}

export async function runBlender({ exe, code, timeoutMs = 300_000, factoryStartup = true, log = () => {}, signal }) {
  const workspace = makeRunDir('blender')
  const scriptPath = path.join(workspace, '_dcc_script.py')
  writeFileSync(scriptPath, wrapBlenderCode(code, workspace), 'utf8')

  const args = ['--background']
  if (factoryStartup) args.push('--factory-startup')
  args.push('--python', scriptPath)

  log(`blender: ${path.basename(exe)} ${args.join(' ')}`)
  const run = await exec(exe, args, { timeoutMs, cwd: workspace, log, signal })
  const combined = `${run.stdout}\n${run.stderr}`
  const { report, files } = splitReport(combined)
  // Blender's own banner is noise for the model; keep the user's output.
  const cleaned = report
    .split(/\r?\n/)
    .filter((line) => !/^Blender \d|^Read prefs|^Blender quit|^found bundled|^Warning: |^Writing:|^Saved:/.test(line.trim()))
    .join('\n')
    .trim()

  return {
    ok: run.ok,
    app: 'blender',
    ms: run.ms,
    timedOut: run.timedOut,
    code: run.code,
    workspace,
    report: cleaned || report,
    rawTail: run.timedOut ? combined.slice(-2000) : '',
    files,
    images: await collectImages(files, log),
  }
}

// ---------------------------------------------------------------- 3ds Max

/**
 * 3ds Max batch is hostile to output: its console is UTF-16, and a plain
 * `format "..."` never reaches stdout at all in batch mode (verified against
 * Max 2025 - the stream contains only Max's own startup lines). The only
 * reliable channel is a file, so the wrapper always writes a report and
 * instruments the scene itself: a user script that prints nothing still yields
 * object and polygon counts.
 */
export function wrapMaxScript(script, workspace) {
  return `(
	local dccWorkspace = @"${workspace}"
	local dccReport = dccWorkspace + "\\\\_dcc_report.txt"
	local dccFile = createFile dccReport
	try (
		format "DCC workspace: %\\n" dccWorkspace to:dccFile
		-- --- user script ---
${script
  .split(/\r?\n/)
  .map((line) => `\t\t${line}`)
  .join('\n')}
		-- --- end user script ---
	) catch (
		format "DCC ERROR: %\\n" (getCurrentException()) to:dccFile
	)
	-- Automatic instrumentation: plain format output never reaches batch stdout,
	-- so the wrapper reports the scene state itself.
	try (
		local dccGeos = for o in objects where (superclassof o == GeometryClass) collect o
		local dccVerts = 0
		local dccFaces = 0
		for o in dccGeos do (
			try ( dccVerts += (getPolygonCount o)[1] ) catch ()
			try ( dccVerts += 0 ) catch ()
			try ( dccFaces += (getPolygonCount o)[2] ) catch ()
		)
		format "DCC STATS objects=% vertices=% faces=%\\n" dccGeos.count dccVerts dccFaces to:dccFile
	) catch (
		format "DCC STATS unavailable: %\\n" (getCurrentException()) to:dccFile
	)
	format "${FILE_MARKER}\\n" to:dccFile
	local dccFiles = getFiles (dccWorkspace + "\\\\*.*")
	for dccPath in dccFiles do (
		try ( format "%\\t%\\n" dccPath (getFileSize dccPath) to:dccFile ) catch ()
	)
	format "${END_MARKER}\\n" to:dccFile
	close dccFile
)
`
}

export async function runMax({ exe, script, timeoutMs = 600_000, log = () => {}, signal }) {
  const workspace = makeRunDir('max')
  const scriptPath = path.join(workspace, '_dcc_script.ms')
  writeFileSync(scriptPath, wrapMaxScript(script, workspace), 'utf8')

  log(`3ds max: ${path.basename(exe)} ${path.basename(scriptPath)}`)
  const run = await exec(exe, [scriptPath, '-v', '1'], { timeoutMs, cwd: workspace, log, signal })

  // Two output channels: `format ... to:dccFile` lands in the report file, and
  // a plain `format "..."` goes to the batch console, which is UTF-16.
  const reportPath = path.join(workspace, '_dcc_report.txt')
  const fileReport = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : ''
  const consoleText = normalizeMaxConsole(decodeConsole(run.stdoutBufs))
  const { report: fileBody, files } = splitReport(fileReport)

  const sections = []
  if (consoleText) sections.push(consoleText)
  if (fileBody) sections.push(fileBody)
  if (!sections.length) {
    sections.push(
      `3ds Max produced no output.\n${run.stdout}\n${run.stderr}`.trim(),
    )
  }

  return {
    ok: run.ok && /DCC ERROR/.test(fileReport) === false,
    app: 'max',
    ms: run.ms,
    timedOut: run.timedOut,
    code: run.code,
    workspace,
    report: sections.join('\n'),
    rawTail: run.timedOut ? decodeConsole(run.stdoutBufs).slice(-2000) : '',
    files,
    images: await collectImages(files, log),
  }
}

/** Drop 3ds Max's own batch chatter so the model reads only the script's output. */
function normalizeMaxConsole(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trimEnd())
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      if (/^-+$/.test(trimmed)) return false
      if (/^\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}:\d{2};/.test(trimmed)) return false
      if (/Security Tool .* enabled/i.test(trimmed)) return false
      if (/Task Completed Successfully|3ds Max Shutting Down|MAXScript .*loaded/i.test(trimmed)) return false
      return true
    })
    .join('\n')
    .trim()
}

export { OUTPUT_ROOT, FILE_MARKER, END_MARKER, splitReport }

// -------------------------------------------------------------------- tools

/** Human-readable summary block shared by both runners. */
function summarise(label, result) {
  const lines = [
    `${label} · ${result.ok ? 'ok' : 'FAILED'} · ${result.ms} ms${result.timedOut ? ' · TIMED OUT' : ''}`,
    `workspace: ${result.workspace}`,
  ]
  if (result.files.length) {
    lines.push('files produced:')
    for (const file of result.files) lines.push(`  ${file.path}  (${file.bytes} bytes)`)
  } else {
    lines.push('files produced: none')
  }
  lines.push('', 'script output:', result.report || '(the script printed nothing)')
  if (result.rawTail) lines.push('', 'tail of raw host output (the run was killed):', result.rawTail)
  return lines.join('\n')
}

function runOutput(label, result, exec, images) {
  const text = summarise(label, result)
  const blocks = [TEXT(text)]
  return (async () => {
    const projected = await images.project(exec, blocks, result.images)
    if (projected) images.remember(exec, projected)
    return { content: blocks }
  })()
}

function projectFrom(images) {
  return (exec, result) => {
    const projected = images.take(exec)
    if (!projected) return undefined
    if (!Array.isArray(result?.content)) return undefined
    return projected
  }
}

/**
 * The DCC tool set: what is installed, plus one runner per available host.
 *
 * Tools are only registered for applications actually found, so the model never
 * sees a `dcc_max` it cannot use.
 */
export function createDccTools(ctx, { overrides = {}, log = () => {}, blenderTimeoutMs = 300_000, maxTimeoutMs = 660_000, roblox = {} } = {}) {
  const apps = detectDccApps(overrides)
  const images = createImageProjection(ctx, log)
  const tools = []

  const creator = roblox.creator?.userId || roblox.creator?.groupId ? roblox.creator : null
  const uploadReady = Boolean(roblox.apiKey && creator)

  const installed = Object.entries(apps).filter(([, value]) => value)
  tools.push({
    name: 'dcc_status',
    description:
      'List the modelling applications this machine can drive headlessly, with their exact executables, and whether the ' +
      'Roblox upload step is configured. Use it before reaching for a modelling tool, and to decide which one suits a job.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [TEXT(value.text)],
    },
    async execute() {
      const lines = []
      if (installed.length) {
        lines.push('Headless modelling applications available:')
        for (const [key, app] of installed) lines.push(`- ${key}: ${app.exe}`)
      } else {
        lines.push('No headless modelling application found. Set dcc.blender / dcc.max / dcc.zbrush in the plugin config.')
      }
      lines.push(
        '',
        'Blender runs Python (bpy) with a `workspace` variable already defined; exports FBX/OBJ/GLB/STL and renders previews.',
        '3ds Max runs MAXScript; write output with `format "..." to:dccFile` because batch stdout is unusable, and the wrapper reports object/vertex/face counts for you.',
        'ZBrush has no established headless mode here - it must be driven interactively.',
        '',
        uploadReady
          ? `Roblox upload: configured (creator ${creator.userId ? `user ${creator.userId}` : `group ${creator.groupId}`}). Use dcc_upload_to_roblox to turn an exported model into an asset.`
          : 'Roblox upload: NOT configured. Set `openCloudKey` and `creatorUserId` (or `creatorGroupId`) in the plugin config, or export the model and import the file in Studio by hand.',
      )
      return { text: lines.join('\n') }
    },
  })

  if (apps.blender) {
    tools.push({
      name: 'dcc_blender',
      description:
        'Run Python inside headless Blender to model, modify, export or render. `bpy` and `mathutils` are available, and a ' +
        '`workspace` variable holds a directory for this run - write exports there (e.g. `workspace + "/model.fbx"`) and they ' +
        'come back in the result. Blender can export FBX, OBJ, GLB and STL, and any PNG/JPEG written to the workspace is ' +
        'attached to the result as an image so you can LOOK at what you built; render a preview whenever the shape matters. ' +
        'This is the tool to use for real geometry instead of guessing at a generator prompt.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source. `import bpy`, build geometry, then export into `workspace`.' },
          timeoutMs: { type: 'number', description: 'Optional run timeout in milliseconds (default 300000).' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      output: RESULT_OUTPUT,
      async execute(args, exec) {
        const result = await runBlender({
          exe: apps.blender.exe,
          code: String(args.code ?? ''),
          timeoutMs: Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : blenderTimeoutMs,
          log,
          signal: exec?.signal,
        })
        return runOutput('Blender', result, exec, images)
      },
      projectContent: projectFrom(images),
    })
  }

  if (apps.max) {
    tools.push({
      name: 'dcc_max',
      description:
        'Run MAXScript inside headless 3ds Max 2025 to model, modify or export. A `dccWorkspace` variable holds this run\'s ' +
        'directory. IMPORTANT: a plain `format "..."` never reaches batch stdout, so print anything you need to see with ' +
        '`format "..." to:dccFile`. The wrapper already reports object/vertex/face counts and lists every produced file, and ' +
        'any PNG written to `dccWorkspace` is attached to the result as an image. Use `exportFile (dccWorkspace + "\\\\model.fbx") #noPrompt` to export.',
      parameters: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'MAXScript body. Use `dccWorkspace` for output paths and `to:dccFile` for logging.' },
          timeoutMs: { type: 'number', description: 'Optional run timeout in milliseconds (default 660000; Max batch takes ~45s to start).' },
        },
        required: ['script'],
        additionalProperties: false,
      },
      output: RESULT_OUTPUT,
      async execute(args, exec) {
        const result = await runMax({
          exe: apps.max.exe,
          script: String(args.script ?? ''),
          timeoutMs: Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : maxTimeoutMs,
          log,
          signal: exec?.signal,
        })
        return runOutput('3ds Max', result, exec, images)
      },
      projectContent: projectFrom(images),
    })
  }

  if (uploadReady) {
    tools.push({
      name: 'dcc_upload_to_roblox',
      description:
        'Upload a model file (.fbx / .glb / .gltf) to Roblox as an asset through Open Cloud, returning the assetId. ' +
        'Use it to get a mesh you built with dcc_blender or dcc_max into the creator account without any manual import. ' +
        'Roblox imports a Model as a PACKAGE containing MeshPart objects, and every upload goes through moderation; ' +
        'the result reports the moderation state. After it succeeds, place it in the open place with roblox_insert_asset.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Absolute path to the exported .fbx / .glb / .gltf.' },
          displayName: { type: 'string', description: 'Asset name shown in the Creator Dashboard and Toolbox.' },
          description: { type: 'string', description: 'Optional asset description.' },
        },
        required: ['filePath'],
        additionalProperties: false,
      },
      output: RESULT_OUTPUT,
      async execute(args, exec) {
        const filePath = String(args.filePath ?? '')
        if (!existsSync(filePath)) {
          throw new Error(`no such file: ${filePath}`)
        }
        const bytes = readFileSync(filePath)
        const fileName = path.basename(filePath)
        try {
          const result = await uploadModel({
            apiKey: roblox.apiKey,
            creator,
            filePath,
            fileName,
            bytes,
            displayName: args.displayName || fileName.replace(/\.[^.]+$/, ''),
            description: args.description || '',
            log,
            signal: exec?.signal,
          })
          const lines = [
            `uploaded: ${fileName}`,
            `assetId: ${result.assetId}`,
            `moderation: ${result.moderation ?? 'not reported'}`,
            `attempts: ${result.attempts}`,
            '',
            `The asset belongs to ${creator.userId ? `user ${creator.userId}` : `group ${creator.groupId}`} and appears under`,
            'Creations > Development Items (Model uploads land in Packages).',
            `Next: call roblox_insert_asset with { "assetId": "${result.assetId}" } to put it in the open place,`,
            'or set a property to rbxassetid://' + result.assetId + ' in Studio.',
          ]
          return { content: [TEXT(lines.join('\n'))] }
        } catch (error) {
          if (error instanceof UploadError) {
            throw new Error(`${error.kind}: ${error.message}`)
          }
          throw error
        }
      },
    })
  }

  return tools
}
