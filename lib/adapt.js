// SPDX-License-Identifier: MIT
/**
 * Adapter between the DSH web server's Node-style route handler and the
 * WHATWG Request/Response handlers in routes.js.
 *
 * `ctx.webServer.register({ kind, path, handler })` hands the handler raw
 * Node `(req, res)` objects. routes.js is written against the standard Fetch
 * types so it can be unit-tested on a bare node:http server; this module is the
 * only place that knows about both.
 */

/** Build a WHATWG Request from a Node IncomingMessage. */
export async function nodeRequestToFetch(req, origin = 'http://127.0.0.1') {
  const url = new URL(req.url || '/', origin)
  const method = (req.method || 'GET').toUpperCase()
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, item)
    else headers.set(key, String(value))
  }

  let body
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length) body = Buffer.concat(chunks)
  }
  return new Request(url, { method, headers, body })
}

/** Stream a WHATWG Response onto a Node ServerResponse. */
export async function writeFetchResponse(res, response) {
  const headers = {}
  for (const [key, value] of response.headers) headers[key] = value
  res.writeHead(response.status, headers)
  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
      // Server-Sent Events must not sit in a buffer.
      if (typeof res.flush === 'function') res.flush()
    }
  } catch (error) {
    // Client went away mid-stream (very common for the SSE status channel).
    if (!res.writableEnded) res.end()
    return
  }
  if (!res.writableEnded) res.end()
}

/**
 * Wrap a WHATWG handler as a Node route handler.
 *
 * A `null` return means "this plugin does not own this path"; we answer 404 so
 * the browser gets a clear reason instead of a hang.
 */
export function toNodeHandler(webHandler, { onError } = {}) {
  return async function nodeHandler(req, res) {
    try {
      const request = await nodeRequestToFetch(req)
      const response = await webHandler(request)
      if (!response) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not a ZeroScript route')
        return
      }
      await writeFetchResponse(res, response)
    } catch (error) {
      if (onError) onError(error)
      if (res.writableEnded) return
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
      } catch {
        /* socket already gone */
      }
    }
  }
}
