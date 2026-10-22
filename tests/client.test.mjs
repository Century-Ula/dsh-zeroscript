// SPDX-License-Identifier: MIT
/**
 * Client-half test: run lib/client.js under a stub module loader and a stub
 * client context, then assert it claims the right slots.
 *
 * This is not a browser test - it cannot prove React renders - but it does prove
 * the hand-written `window.__ModuleLoader__.load` wrapper is well formed, that
 * every `require` it makes is satisfiable from the platform module table, and
 * that `apply` registers the sidebar glyph and the main panel under the ids the
 * shell dispatches with.
 *
 *   node tests/client.test.mjs
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(path.join(HERE, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? `  ${detail}` : ''}`)
}

// ------------------------------------------------------------------ stubs
const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment',
}

const REQUESTS = []
const styleNodes = []
const documentStub = {
  createElement: (tag) => {
    const node = { tag, dataset: {}, textContent: '', remove: () => styleNodes.splice(styleNodes.indexOf(node), 1) }
    return node
  },
  head: { appendChild: (node) => styleNodes.push(node) },
}

let captured = null
const windowStub = {
  __ModuleLoader__: {
    load: (config) => {
      captured = config
    },
  },
}

const requireStub = (specifier) => {
  REQUESTS.push(specifier)
  if (specifier === 'react') return REACT_STUB
  if (specifier === 'react/jsx-runtime') return { jsx: REACT_STUB.createElement, jsxs: REACT_STUB.createElement }
  if (specifier === 'react-dom') return { createPortal: REACT_STUB.createElement }
  throw new Error(`client.js requested "${specifier}", which is not in the platform module table`)
}

// ------------------------------------------------------------------- load
const previousWindow = globalThis.window
const previousDocument = globalThis.document
globalThis.window = windowStub
globalThis.document = documentStub
try {
  // The bundle is a classic script that only touches `window`.
  new Function('window', 'document', 'fetch', SOURCE)(windowStub, documentStub, () => Promise.reject(new Error('no fetch')))
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
}

check('bundle calls window.__ModuleLoader__.load', captured !== null)
check('module id is the package name', captured?.id === 'dsh-zeroscript', captured?.id)
check('factory is a function', typeof captured?.factory === 'function')

const exportsObject = captured.factory(requireStub)
check('client module only requests platform modules', REQUESTS.every((r) => r === 'react'), REQUESTS.join(', ') || '(none)')
check('exports apply()', typeof exportsObject.apply === 'function')
check('exports inject list', Array.isArray(exportsObject.inject) && exportsObject.inject.includes('slots'), JSON.stringify(exportsObject.inject))

// ------------------------------------------------------------------ apply
const registered = []
const effects = []
const ctx = {
  effect: (callback, label) => {
    effects.push(label)
    const dispose = callback()
    return () => (typeof dispose === 'function' ? dispose() : undefined)
  },
  slots: {
    inject: (slotName, callback) => {
      callback()
      return () => {}
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)

check('registers exactly two slots', registered.length === 2, registered.map((r) => r.options.name).join(', '))
check('installs a style element', styleNodes.length === 1)

const glyph = registered.find((r) => r.options.name === 'sidebar.panellist')
check('claims a sidebar.panellist entry', Boolean(glyph))
check('sidebar entry id is "zeroscript"', glyph?.options.id === 'zeroscript', glyph?.options.id)
check('sidebar entry has a label', typeof glyph?.options.label === 'string' && glyph.options.label.length > 0, glyph?.options.label)
check('sidebar entry has a numeric order', Number.isFinite(glyph?.options.order), String(glyph?.options.order))
check('sidebar component is renderable', typeof glyph?.component === 'function')

const panel = registered.find((r) => r.options.name === 'main')
check('claims a keyed main panel', Boolean(panel))
check('main panel key matches the sidebar id', panel?.options.key === glyph?.options.id, `${panel?.options.key} vs ${glyph?.options.id}`)
check('main panel component is renderable', typeof panel?.component === 'function')

// The glyph must render at the two sizes the shell asks for.
try {
  const small = glyph.component({ size: 16, active: false })
  const large = glyph.component({ size: 18, active: true })
  check('glyph renders an svg at both shell sizes', small?.type === 'svg' && large?.type === 'svg')
} catch (error) {
  check('glyph renders without throwing', false, String(error?.message ?? error))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
