// SPDX-License-Identifier: MIT
/**
 * Roblox Open Cloud asset upload.
 *
 * The last mile of the modelling pipeline: a mesh built in Blender or 3ds Max
 * is a file on disk, and Roblox has no way to see it until it exists as an
 * asset. Open Cloud's Assets API accepts an FBX/GLB directly, so the whole
 * chain can run without a human dragging files into Studio.
 *
 *   POST /assets/v1/assets            multipart: `request` JSON + `fileContent`
 *   GET  /assets/v1/operations/{id}   poll until done, then read response.assetId
 *
 * Authoritative details this implements (Roblox creator docs, usage-assets):
 *  - `Model` accepts .fbx / .gltf / .glb / .rbxm / .rbxmx, max 20 MB per call.
 *  - The creator is `{ userId }` or `{ groupId }` inside `creationContext`.
 *  - An API key needs Access Permission `assets` with Read+Write operations.
 *  - Uploaded models become PACKAGES and pass through moderation.
 */

/** Roblox's accepted content type per extension, from the supported-types table. */
export const CONTENT_TYPES = {
  '.fbx': 'model/fbx',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.rbxm': 'model/x-rbxm',
  '.rbxmx': 'model/x-rbxm',
}

/** Documented hard limit for a single Create Asset call. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

const API_BASE = 'https://apis.roblox.com/assets/v1'

export class UploadError extends Error {
  constructor(message, kind = 'upload_error', detail = null, extra = {}) {
    super(message)
    this.name = 'UploadError'
    this.kind = kind
    this.detail = detail
    /** Socket-level code (UND_ERR_*, ECONNRESET, ...) when the failure was transport-level. */
    this.code = extra.code ?? null
    /** HTTP status when the failure was a response. */
    this.status = extra.status ?? null
  }
}

/**
 * Transport failures that prove the request never reached Roblox: the socket
 * could not be established at all. Only these are safe to repeat blindly,
 * because a POST that DID arrive may already have created an asset.
 */
const NEVER_ARRIVED = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_DNS_LOOKUP_FAILED',
  'UND_ERR_CONNECT_ERROR',
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/** Gateway/overload responses - the request was refused, not processed. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters here: without it, a flaky link makes every retry of every
 * caller fire in lockstep and re-congest the same path.
 */
export function backoffDelay(attempt, baseMs = 1000, capMs = 15_000) {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt - 1), capMs)
  return Math.round(exponential * (1 + Math.random() * 0.3))
}

/**
 * Whether a failed attempt may be repeated, and why.
 *
 * Deliberately conservative: an ambiguous failure (a socket that died
 * mid-request) is NOT retried, because a duplicate mesh asset on the creator
 * account is worse than a clear error the user can act on.
 */
export function retryDecision(error) {
  if (!(error instanceof UploadError)) return { retry: false, why: 'unclassified failure' }
  if (error.kind === 'network') {
    return NEVER_ARRIVED.has(error.code)
      ? { retry: true, why: `connection never established (${error.code})` }
      : {
          retry: false,
          why: `the request may have reached Roblox (${error.code ?? 'unknown'}); repeating it could create a duplicate asset`,
        }
  }
  if (error.kind === 'rate_limited') return { retry: true, why: 'rate limited (429)' }
  if (error.kind === 'http_error' && RETRYABLE_STATUS.has(error.status)) {
    return { retry: true, why: `gateway refused the request (HTTP ${error.status})` }
  }
  return { retry: false, why: error.kind }
}

/** Content type for a path, or null when Roblox would reject the format. */
export function contentTypeFor(filePath) {
  // Lower-case the whole path first: Windows tools happily emit `Model.FBX`,
  // and looking the extension up un-normalised would refuse a valid file.
  const lower = String(filePath ?? '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return null
  return CONTENT_TYPES[lower.slice(dot)] ?? null
}

/**
 * Build the multipart body Roblox expects.
 * Separated from the request so the wire shape can be asserted without network.
 */
export function buildUploadForm({ filePath, fileName, bytes, assetType = 'Model', displayName, description, creator }) {
  if (!creator?.userId && !creator?.groupId) {
    throw new UploadError('a creator is required: set creatorUserId (or creatorGroupId) in the plugin config', 'no_creator')
  }
  const contentType = contentTypeFor(filePath)
  if (!contentType) {
    throw new UploadError(
      `Roblox does not accept "${filePath}" as a Model. Supported: ${Object.keys(CONTENT_TYPES).join(', ')}`,
      'bad_format',
    )
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `the file is ${(bytes.length / 1048576).toFixed(1)} MB; Roblox accepts at most 20 MB per upload`,
      'too_large',
    )
  }

  const request = {
    assetType,
    displayName: displayName || fileName,
    description: description || '',
    creationContext: { creator: creator.userId ? { userId: String(creator.userId) } : { groupId: String(creator.groupId) } },
  }

  const form = new FormData()
  form.append('request', JSON.stringify(request))
  form.append('fileContent', new Blob([bytes], { type: contentType }), fileName)
  return { form, request, contentType }
}

/**
 * Describe an API key WITHOUT revealing it.
 *
 * Roblox keys embed a double-base64url JWT carrying `ownerId`, `exp` and
 * `baseApiKey`. Decoding those three facts turns "User not authenticated" into
 * an actionable answer: a key that will not parse was mangled in transit (a
 * config file, a copy-paste), one that is expired is expired, and one that
 * parses but is rejected simply lacks permission.
 *
 * @returns {{length: number, parseable: boolean, ownerId?: string, expiresAt?: string, expired?: boolean}}
 */
export function describeApiKey(apiKey) {
  const key = String(apiKey ?? '')
  const summary = { length: key.length, parseable: false }
  if (!key) return summary

  const decode = (value) => {
    try {
      return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    } catch {
      return ''
    }
  }

  // Roblox keys are not consistent about their alphabet: some carry standard
  // base64 (`+` and `/`), others the URL-safe variant (`-` and `_`). Matching
  // only one alphabet silently fails to find the JWT in half of all keys.
  for (const run of key.match(/[A-Za-z0-9+/_-]{80,}/g) ?? []) {
    const decoded = decode(run)
    const jwt = decoded.match(/[A-Za-z0-9+/_-]{20,}\.[A-Za-z0-9+/_-]{20,}\.[A-Za-z0-9+/_-]{20,}/)
    if (!jwt) continue
    const payloadText = decode(jwt[0].split('.')[1])
    let payload
    try {
      payload = JSON.parse(payloadText)
    } catch {
      continue
    }
    if (!payload?.ownerId) continue
    const expSeconds = Number(payload.exp)
    summary.parseable = true
    summary.ownerId = String(payload.ownerId)
    if (Number.isFinite(expSeconds)) {
      summary.expiresAt = new Date(expSeconds * 1000).toISOString()
      summary.expired = Date.now() > expSeconds * 1000
    }
    return summary
  }
  return summary
}

/** Human-readable one-liner about a key, for an error message. */
export function describeApiKeyBriefly(apiKey) {
  const info = describeApiKey(apiKey)
  if (!info.length) return 'no key is configured'
  if (!info.parseable) {
    return `the configured key is ${info.length} characters but does not parse as a Roblox Open Cloud key - it was probably truncated or mangled (check the config file quoting)`
  }
  return `the key parses (ownerId ${info.ownerId}, expires ${info.expiresAt}${info.expired ? ' - EXPIRED' : ''})`
}

/** Shape of an in-flight upload, kept out of the caller. */
function describeFailure(status, body, apiKey) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  if (status === 401 || status === 403) {
    return new UploadError(
      `Roblox rejected the API key (HTTP ${status}). ${describeApiKeyBriefly(apiKey)}. ` +
        'Check in the Creator Dashboard that the key is active, that Access Permissions include "assets", ' +
        'that the operation permissions include Read AND Write, and that any IP restriction includes this machine. ' +
        `Response: ${text.slice(0, 300)}`,
      'unauthorized',
      null,
      { status },
    )
  }
  if (status === 429) {
    return new UploadError(
      `Roblox rate-limited the upload (HTTP 429). ${text.slice(0, 200)}`,
      'rate_limited',
      null,
      { status },
    )
  }
  return new UploadError(`Roblox returned HTTP ${status}: ${text.slice(0, 400)}`, 'http_error', null, { status })
}

/**
 * fetch() that reports WHY it failed.
 *
 * A bare `fetch failed` tells the user nothing, and this is the failure a
 * machine behind a proxy - or one that simply cannot reach Roblox - will hit.
 * undici puts the real reason in `error.cause`; surface it, and keep the code so
 * the retry policy can tell "never connected" from "died mid-request".
 */
async function safeFetch(url, init, what) {
  try {
    return await fetch(url, init)
  } catch (error) {
    const cause = error?.cause
    const code = cause?.code ?? null
    const detail = code ?? cause?.message ?? error?.message ?? String(error)
    const hint = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|CERT/i.test(String(detail))
      ? ' This machine may need a proxy or VPN to reach Roblox; set HTTPS_PROXY (and NO_PROXY for localhost) for the DSH process.'
      : ''
    throw new UploadError(`${what} could not reach apis.roblox.com: ${detail}.${hint}`, 'network', null, { code })
  }
}

/** Per-request deadline, combined with the caller's cancellation signal. */
function withDeadline(signal, ms) {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        reject(new UploadError('upload cancelled', 'cancelled'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(new UploadError('upload cancelled', 'cancelled'))
        },
        { once: true },
      )
    }
  })

/**
 * Run `attempt` until it succeeds, or a retry decision says stop.
 *
 * Everything risky about retrying lives in {@link retryDecision}; this only
 * handles the loop, the backoff and the reporting.
 */
async function withRetry(attempt, { label, maxAttempts, baseMs, log, signal, onAttempt }) {
  let lastError = null
  for (let tries = 1; tries <= maxAttempts; tries++) {
    if (signal?.aborted) throw new UploadError('upload cancelled', 'cancelled')
    try {
      const value = await attempt(tries)
      onAttempt?.(tries)
      return { value, attempts: tries }
    } catch (error) {
      lastError = error
      if (error instanceof UploadError && error.kind === 'cancelled') throw error
      const decision = retryDecision(error)
      if (!decision.retry || tries === maxAttempts) {
        if (!decision.retry && tries < maxAttempts) {
          log(`${label} failed and will NOT be retried: ${decision.why}`)
        }
        throw error
      }
      const delay = backoffDelay(tries, baseMs)
      log(`${label} attempt ${tries}/${maxAttempts} failed (${decision.why}); retrying in ${delay}ms`)
      await sleep(delay, signal)
    }
  }
  throw lastError ?? new UploadError(`${label} failed`, 'upload_error')
}

/**
 * Upload one model and wait for the operation to settle.
 *
 * Retries connection-level failures and gateway refusals with exponential
 * backoff - this path is genuinely flaky from some networks - while refusing to
 * repeat anything that might already have created an asset. The poll phase is a
 * plain GET, so it retries far more freely.
 *
 * @returns {Promise<{assetId: string, moderation: string|null, operation: object, attempts: number}>}
 */
export async function uploadModel({
  apiKey,
  creator,
  filePath,
  fileName,
  bytes,
  displayName,
  description,
  assetType = 'Model',
  pollMs = 2000,
  timeoutMs = 180_000,
  maxAttempts = 4,
  retryBaseMs = 1000,
  log = () => {},
  signal,
}) {
  if (!apiKey) {
    throw new UploadError('no Open Cloud API key configured', 'no_key')
  }

  log(`uploading ${fileName} (${(bytes.length / 1024).toFixed(0)} KB) to Roblox as ${assetType}`)

  const { value: created, attempts } = await withRetry(
    async () => {
      // A fresh form per attempt: a body is bound to one request.
      const { form } = buildUploadForm({ filePath, fileName, bytes, assetType, displayName, description, creator })
      const response = await safeFetch(
        `${API_BASE}/assets`,
        { method: 'POST', headers: { 'x-api-key': apiKey }, body: form, signal: withDeadline(signal, 120_000) },
        'the upload request',
      )
      const bodyText = await response.text()
      if (!response.ok) throw describeFailure(response.status, bodyText, apiKey)
      try {
        return JSON.parse(bodyText)
      } catch {
        throw new UploadError(`Roblox returned a non-JSON create response: ${bodyText.slice(0, 300)}`, 'bad_response')
      }
    },
    { label: 'upload', maxAttempts, baseMs: retryBaseMs, log, signal },
  )

  const operationPath = created?.path
  if (!operationPath) {
    // Some responses already carry the asset; accept that instead of failing.
    if (created?.assetId) return { assetId: String(created.assetId), moderation: null, operation: created, attempts }
    throw new UploadError(`Roblox did not return an operation path: ${JSON.stringify(created).slice(0, 300)}`, 'bad_response')
  }

  const operationId = String(operationPath).replace(/^operations\//, '')
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new UploadError('upload cancelled', 'cancelled')

    // Idempotent GET: safe to repeat on any transient transport failure.
    const { value: operation } = await withRetry(
      async () => {
        const poll = await safeFetch(
          `${API_BASE}/operations/${encodeURIComponent(operationId)}`,
          { headers: { 'x-api-key': apiKey }, signal: withDeadline(signal, 60_000) },
          'the operation poll',
        )
        const pollText = await poll.text()
        if (!poll.ok) throw describeFailure(poll.status, pollText, apiKey)
        try {
          return JSON.parse(pollText)
        } catch {
          throw new UploadError(`Roblox returned a non-JSON operation: ${pollText.slice(0, 300)}`, 'bad_response')
        }
      },
      { label: 'poll', maxAttempts: 3, baseMs: retryBaseMs, log, signal },
    )

    last = operation
    if (operation.done === true) {
      const assetId = operation?.response?.assetId
      if (!assetId) {
        const why = operation?.error?.message ?? operation?.status ?? 'no reason given'
        throw new UploadError(`the upload operation finished without an asset: ${why}`, 'operation_failed', operation)
      }
      const moderation = operation?.response?.moderationResult?.moderationState ?? null
      log(`upload complete: asset ${assetId}${moderation ? ` (${moderation})` : ''} after ${attempts} attempt(s)`)
      return { assetId: String(assetId), moderation, operation, attempts }
    }
    await sleep(pollMs, signal)
  }

  throw new UploadError(`the upload did not finish within ${Math.round(timeoutMs / 1000)}s`, 'timeout', last)
}
