// SPDX-License-Identifier: MIT
/**
 * Roblox Open Cloud upload tests.
 *
 * Most of this asserts the WIRE SHAPE without uploading anything: the multipart
 * fields, the creator encoding, the content-type mapping and the size limit are
 * all things Roblox will reject the request for, and all things that are cheap
 * to get wrong.
 *
 * The last check is a real HTTP call to Roblox with a deliberately invalid key:
 * a 401 proves the request reached the API and was parsed as an upload (rather
 * than being malformed), which is as far as this can be verified without a key.
 *
 *   node tests/robloxUpload.test.mjs
 */
import { buildUploadForm, contentTypeFor, MAX_UPLOAD_BYTES, uploadModel, UploadError, backoffDelay, retryDecision } from '../lib/robloxUpload.js'

let failures = 0
let skipped = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}
const skip = (label, why) => {
  skipped++
  console.log(`[SKIP] ${label}  ${why}`)
}

// ------------------------------------------------------------ content types
check('FBX maps to model/fbx', contentTypeFor('C:/x/model.fbx') === 'model/fbx')
check('GLB maps to model/gltf-binary', contentTypeFor('model.GLB') === 'model/gltf-binary')
check('glTF maps to model/gltf+json', contentTypeFor('a/b/model.gltf') === 'model/gltf+json')
check('an unsupported extension is refused', contentTypeFor('model.stl') === null, String(contentTypeFor('model.stl')))

// -------------------------------------------------------------- form shape
const bytes = Buffer.from('fake-fbx-payload')
const { form, request, contentType } = buildUploadForm({
  filePath: 'C:/tmp/model.fbx',
  fileName: 'model.fbx',
  bytes,
  displayName: 'Test Sword',
  description: 'built by the agent',
  creator: { userId: '1234567' },
})

check('the content type is attached to the file part', contentType === 'model/fbx')
check('the multipart body is a FormData', typeof form?.get === 'function')
check('field "request" exists', form.get('request') !== null)
check('field "fileContent" carries the bytes', form.get('fileContent') !== null)
check('the request declares assetType Model', request.assetType === 'Model')
check('the creator is encoded as userId', request.creationContext.creator.userId === '1234567', JSON.stringify(request.creationContext))
check('a group creator is encoded as groupId', (() => {
  const g = buildUploadForm({ filePath: 'm.glb', fileName: 'm.glb', bytes, creator: { groupId: 99 } })
  return g.request.creationContext.creator.groupId === '99' && g.request.creationContext.creator.userId === undefined
})())

// ---------------------------------------------------------------- refusals
const expectThrow = (label, fn, kind) => {
  try {
    fn()
    check(label, false, 'no error thrown')
  } catch (error) {
    check(label, error instanceof UploadError && (!kind || error.kind === kind), `${error.kind}: ${error.message.slice(0, 120)}`)
  }
}

expectThrow('a missing creator is refused before any request', () => buildUploadForm({ filePath: 'm.fbx', fileName: 'm.fbx', bytes, creator: null }), 'no_creator')
expectThrow('an unsupported format is refused', () => buildUploadForm({ filePath: 'm.stl', fileName: 'm.stl', bytes, creator: { userId: '1' } }), 'bad_format')
expectThrow(
  'a file over 20 MB is refused locally',
  () => buildUploadForm({ filePath: 'm.fbx', fileName: 'm.fbx', bytes: Buffer.alloc(MAX_UPLOAD_BYTES + 1), creator: { userId: '1' } }),
  'too_large',
)

// A missing key must fail loudly rather than sending an unauthenticated request.
try {
  await uploadModel({ apiKey: '', creator: { userId: '1' }, filePath: 'm.fbx', fileName: 'm.fbx', bytes })
  check('a missing API key is refused', false, 'no error thrown')
} catch (error) {
  check('a missing API key is refused', error instanceof UploadError && error.kind === 'no_key', error.kind)
}

// ------------------------------------------------------------ retry policy
const netError = (code) => new UploadError('boom', 'network', null, { code })
const httpError = (status, kind = 'http_error') => new UploadError('boom', kind, null, { status })

check('a connection that never opened is retried', retryDecision(netError('UND_ERR_CONNECT_TIMEOUT')).retry === true)
check('a DNS failure is retried', retryDecision(netError('EAI_AGAIN')).retry === true)
check('a refused connection is retried', retryDecision(netError('ECONNREFUSED')).retry === true)
check('429 is retried', retryDecision(httpError(429, 'rate_limited')).retry === true)
check('502 is retried', retryDecision(httpError(502)).retry === true)
check('503 is retried', retryDecision(httpError(503)).retry === true)
check('a permission failure is NOT retried', retryDecision(httpError(403, 'unauthorized')).retry === false)
check('a bad request is NOT retried', retryDecision(httpError(400)).retry === false)
// The important one: this could already have created an asset.
const ambiguous = retryDecision(netError('UND_ERR_SOCKET'))
check('a socket that died mid-request is NOT retried', ambiguous.retry === false, ambiguous.why)
check('and it says why', /duplicate/i.test(ambiguous.why), ambiguous.why)

const d1 = backoffDelay(1, 1000)
const d2 = backoffDelay(2, 1000)
const d4 = backoffDelay(4, 1000)
check('backoff grows', d1 < d2 && d2 < d4, `${d1}, ${d2}, ${d4}`)
check('backoff is capped', backoffDelay(10, 1000, 5000) <= 6500, String(backoffDelay(10, 1000, 5000)))
check('backoff carries jitter', new Set(Array.from({ length: 6 }, () => backoffDelay(3, 1000))).size > 1)

// --------------------------------------------- retry behaviour, no network
const realFetch = globalThis.fetch
const bytes2 = Buffer.from('fbx')
const stub = (handler) => {
  const state = { calls: 0, urls: [] }
  globalThis.fetch = async (url, init) => {
    state.calls++
    state.urls.push(String(url))
    return handler(String(url), init, state.calls)
  }
  return state
}
/** Create-asset calls only; the poll is a separate request. */
const uploadsTo = (state) => state.urls.filter((url) => url.endsWith('/assets')).length
const ok = (body, status = 200) => new Response(JSON.stringify(body), { status })
const connectFail = () => {
  const error = new Error('fetch failed')
  error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' }
  return error
}

try {
  const state = stub(async (url, _init, call) => {
    if (call === 1) throw connectFail()
    if (url.endsWith('/assets')) return ok({ path: 'operations/op-1' })
    return ok({ done: true, response: { assetId: '987654', moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } })
  })
  const result = await uploadModel({
    apiKey: 'k',
    creator: { userId: '1' },
    filePath: 'm.fbx',
    fileName: 'm.fbx',
    bytes: bytes2,
    retryBaseMs: 5,
    log: () => {},
  })
  check('a transient connect failure is retried and the upload succeeds', result.assetId === '987654', `asset ${result.assetId}`)
  check('the retry count is reported', result.attempts === 2, String(result.attempts))
  check('the moderation state is reported', result.moderation === 'MODERATION_STATE_APPROVED')
  // One rejected POST, one accepted POST, one poll.
  check('the upload was POSTed exactly twice', uploadsTo(state) === 2, `uploads=${uploadsTo(state)} total=${state.calls}`)

  const forbidden = stub(async () => ok({ code: 'PERMISSION_DENIED' }, 403))
  let denied = null
  try {
    await uploadModel({ apiKey: 'k', creator: { userId: '1' }, filePath: 'm.fbx', fileName: 'm.fbx', bytes: bytes2, retryBaseMs: 5, log: () => {} })
  } catch (error) {
    denied = error
  }
  check('a 403 fails without retrying', denied?.kind === 'unauthorized' && forbidden.calls === 1, `calls=${forbidden.calls}`)

  const alwaysDown = stub(async () => {
    throw connectFail()
  })
  let exhausted = null
  try {
    await uploadModel({ apiKey: 'k', creator: { userId: '1' }, filePath: 'm.fbx', fileName: 'm.fbx', bytes: bytes2, maxAttempts: 3, retryBaseMs: 5, log: () => {} })
  } catch (error) {
    exhausted = error
  }
  check('a permanent outage exhausts the attempt budget', exhausted?.kind === 'network' && alwaysDown.calls === 3, `calls=${alwaysDown.calls}`)
} finally {
  globalThis.fetch = realFetch
}

// ------------------------------------------------------- live reachability
try {
  await uploadModel({
    apiKey: 'definitely-not-a-valid-key',
    creator: { userId: '1' },
    filePath: 'probe.fbx',
    fileName: 'probe.fbx',
    bytes: Buffer.from('not really an fbx'),
    timeoutMs: 15_000,
  })
  check('Roblox rejects an invalid key', false, 'the upload unexpectedly succeeded')
} catch (error) {
  if (error?.kind === 'unauthorized') {
    check('Roblox rejects an invalid key with 401/403 (request shape is accepted)', true, 'HTTP 401/403')
  } else if (error?.cause?.code || /fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(String(error?.message))) {
    skip('Roblox rejects an invalid key', 'no network access to apis.roblox.com')
  } else {
    check('Roblox rejects an invalid key with 401/403 (request shape is accepted)', false, `${error?.kind}: ${String(error?.message).slice(0, 200)}`)
  }
}

console.log(failures === 0 ? `\nALL PASS${skipped ? ` (${skipped} skipped)` : ''}` : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
