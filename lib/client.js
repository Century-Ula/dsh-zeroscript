/**
 * ZeroScript for DeepSeek Harness — browser client half.
 *
 * Shipped client plugins are pre-bundled into this exact
 * `window.__ModuleLoader__.load({ id, factory })` wrapper, so this file is
 * hand-written in that form: no JSX (plain `createElement`), no build step, and
 * every dependency resolved through the loader's frozen platform table
 * (`react` is part of it).
 *
 * Two seats are claimed:
 *   - `sidebar.panellist` — the sidebar glyph; the shell turns a click into
 *     `layout.selectPanel('<id>')`.
 *   - `main` (keyed)      — the central panel the shell then renders.
 *
 * The panel deliberately talks to the plugin's own HTTP API
 * (`/zeroscript/api/*`) rather than a generated Remote: it is the same origin,
 * the same API the standalone console page uses, and it keeps the client half
 * free of any host-side schema generation.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zeroscript',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const SLOT_ID = 'zeroscript'
    const API = '/zeroscript/api'
    const NS = 'dsh-zeroscript'

    const CSS = `
.zs-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.zs-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zs-title{font-size:15px;font-weight:600;margin:0}
.zs-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;margin:0}
.zs-verdict-ok{color:var(--dsw-alias-state-success-primary)}
.zs-verdict-warn{color:var(--dsw-alias-state-warn-primary)}
.zs-verdict-error{color:var(--dsw-alias-state-error-primary)}
.zs-pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.zs-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.zs-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}
.zs-dot.ok{background:var(--dsw-alias-state-success-primary)}
.zs-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.zs-dot.err{background:var(--dsw-alias-state-error-primary)}
.zs-body{display:grid;grid-template-columns:minmax(200px,270px) 1fr;gap:12px;padding:12px 16px;flex:1;min-height:0}
.zs-col{display:flex;flex-direction:column;min-height:0;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.zs-colhead{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.zs-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dsw-alias-label-secondary)}
.zs-input,.zs-area{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:ui-monospace,Consolas,monospace}
.zs-area{min-height:120px;resize:vertical}
.zs-list{list-style:none;margin:0;padding:6px;overflow:auto;flex:1}
.zs-item{padding:6px 8px;border-radius:7px;cursor:pointer;border:1px solid transparent}
.zs-item:hover{background:var(--dsw-alias-bg-layer-2)}
.zs-item.active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary)}
.zs-name{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.zs-desc{color:var(--dsw-alias-label-secondary);font-size:11px;margin:2px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.zs-btn{padding:5px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}
.zs-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.zs-btn:disabled{opacity:.5;cursor:not-allowed}
.zs-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}
.zs-run{display:flex;flex-direction:column;gap:8px;padding:10px;overflow:auto;min-height:0}
.zs-pre{margin:0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);font-family:ui-monospace,Consolas,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.zs-pre.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.zs-img{max-width:100%;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}
.zs-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,Consolas,monospace}
.zs-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px}
.zs-note{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.zs-link{color:var(--dsw-alias-brand-primary);text-decoration:none}
`

    /** Sidebar glyph: a rounded cube with an "S" notch — reads at 16px. */
    function Glyph(props) {
      const size = props.size || 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M12 2.6 20.4 7v10L12 21.4 3.6 17V7z' }),
        h('path', { d: 'M12 21.4V12l8.4-5' }),
        h('path', { d: 'M3.6 7 12 12l8.4-5' }),
      )
    }

    async function api(path, init) {
      const res = await fetch(API + path, init)
      const text = await res.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
      }
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    function StatusPill({ kind, label }) {
      return h('span', { className: 'zs-pill' }, h('i', { className: `zs-dot ${kind || ''}` }), label)
    }

    function Panel() {
      const [status, setStatus] = React.useState(null)
      const [tools, setTools] = React.useState([])
      const [selected, setSelected] = React.useState(null)
      const [args, setArgs] = React.useState('{}')
      const [result, setResult] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const body = await api('/status')
            if (!alive) return
            setStatus(body)
            setError('')
            if (!tools.length && body.tools) {
              const full = await api('/tools')
              if (alive) setTools(full.tools || [])
            }
          } catch (err) {
            if (alive) setError(err.message)
          }
        }
        tick()
        const timer = setInterval(tick, 3000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [tools.length])

      const snapshot = status?.status || {}
      const detection = status?.detection || null
      const live = Boolean(status?.bridge?.connected)
      // Studio/MCP values are the bridge's last report; without a live bridge
      // they are stale, and a green "ready" beside a red "offline" misleads.
      const studioKind = !live ? '' : snapshot.studio ? 'ok' : snapshot.studioProc ? 'warn' : 'err'
      const mcpKind = !live ? '' : snapshot.mcpAlive ? 'ok' : 'err'
      const shown = tools.filter((t) => {
        if (!filter) return true
        const needle = filter.toLowerCase()
        return t.name.toLowerCase().includes(needle) || String(t.description || '').toLowerCase().includes(needle)
      })

      const pick = (tool) => {
        setSelected(tool)
        setResult(null)
        const props = tool.inputSchema?.properties || {}
        const seed = {}
        for (const [key, spec] of Object.entries(props)) {
          if (spec.type === 'boolean') seed[key] = false
          else if (spec.type === 'number' || spec.type === 'integer') continue
          else if (spec.type === 'array') continue
          else if (spec.type === 'object') continue
          else continue
        }
        setArgs(JSON.stringify(seed, null, 2))
      }

      const run = async () => {
        if (!selected || busy) return
        let parsed
        try {
          parsed = JSON.parse(args || '{}')
        } catch (err) {
          setResult({ ok: false, error: `JSON 解析失败：${err.message}` })
          return
        }
        setBusy(true)
        setResult(null)
        const started = Date.now()
        try {
          const body = await api('/call', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: selected.name, arguments: parsed }),
          })
          setResult({ ...body, ms: body.ms ?? Date.now() - started })
        } catch (err) {
          setResult({ ok: false, error: err.message, images: [] })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { className: 'zs-panel' },
        h(
          'div',
          { className: 'zs-head' },
          h(
            'div',
            null,
            h('h2', { className: 'zs-title' }, 'ZeroScript · Roblox Studio'),
            h(
              'p',
              { className: `zs-sub zs-verdict-${detection?.level || 'idle'}` },
              detection
                ? `${detection.label}${detection.verified ? ' · 已实测通过' : ''}${detection.action ? ` · ${detection.action}` : ''}`
                : 'DSH → 本地 Bridge → Studio MCP',
            ),
          ),
          h(
            'div',
            { className: 'zs-pills' },
            h(StatusPill, { kind: status?.bridge?.connected ? 'ok' : 'err', label: `Bridge :${status?.bridge?.port ?? '—'}` }),
            h(StatusPill, { kind: studioKind, label: live ? 'Studio' : 'Studio —' }),
            h(StatusPill, { kind: mcpKind, label: live ? 'MCP' : 'MCP —' }),
            h(StatusPill, { label: `工具 ${tools.length}` }),
          ),
        ),
        error
          ? h('div', { className: 'zs-note' }, `无法连接插件 API：${error}`, ' ', h('a', { className: 'zs-link', href: '/zeroscript', target: '_blank', rel: 'noreferrer' }, '打开控制台网页'))
          : null,
        h(
          'div',
          { className: 'zs-body' },
          h(
            'div',
            { className: 'zs-col' },
            h('div', { className: 'zs-colhead' }, h('span', { className: 'zs-label' }, 'Studio 工具'), h('input', { className: 'zs-input', placeholder: '搜索…', value: filter, onChange: (e) => setFilter(e.target.value) })),
            shown.length
              ? h(
                  'ul',
                  { className: 'zs-list' },
                  shown.map((tool) =>
                    h(
                      'li',
                      {
                        key: tool.name,
                        className: `zs-item${selected?.name === tool.name ? ' active' : ''}`,
                        onClick: () => pick(tool),
                      },
                      h('div', { className: 'zs-name' }, tool.name),
                      h('p', { className: 'zs-desc' }, String(tool.description || '')),
                    ),
                  ),
                )
              : h('p', { className: 'zs-empty' }, '还没有工具。确认 Bridge 与 Studio 就绪后点击刷新。'),
          ),
          h(
            'div',
            { className: 'zs-col' },
            h(
              'div',
              { className: 'zs-colhead' },
              h('span', { className: 'zs-label' }, selected ? selected.name : '选择一个工具'),
              h('div', { style: { marginLeft: 'auto', display: 'flex', gap: 6 } },
                h('button', { className: 'zs-btn', onClick: async () => { const b = await api('/detect').catch(() => null); if (b) { setStatus(b); if (Array.isArray(b.tools)) setTools(b.tools) } } }, '检测'),
                h('button', { className: 'zs-btn', onClick: async () => { const b = await api('/tools?refresh=1').catch(() => null); if (b) setTools(b.tools || []) } }, '刷新'),
                h('button', { className: 'zs-btn primary', disabled: !selected || busy, onClick: run }, busy ? '执行中…' : '执行'),
              ),
            ),
            h(
              'div',
              { className: 'zs-run' },
              selected ? h('p', { className: 'zs-desc' }, String(selected.description || '')) : h('p', { className: 'zs-empty' }, '从左侧选一个 Roblox Studio 工具，填入 JSON 参数后执行。'),
              selected ? h('textarea', { className: 'zs-area', spellcheck: 'false', value: args, onChange: (e) => setArgs(e.target.value) }) : null,
              result
                ? h(
                    'div',
                    null,
                    h('div', { className: `zs-meta`, style: { marginBottom: 6, color: result.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } },
                      `${result.ok ? '成功' : '失败'}${result.ms ? ` · ${result.ms} ms` : ''}`),
                    h('pre', { className: `zs-pre${result.ok ? '' : ' err'}` }, result.ok ? result.text || '(空结果)' : result.error || '未知错误'),
                    ...(result.images || []).filter((i) => i?.data).map((image, index) =>
                      h('img', { key: index, className: 'zs-img', style: { marginTop: 8, display: 'block' }, alt: 'Studio 截图', src: `data:${image.mimeType || 'image/png'};base64,${image.data}` }),
                    ),
                  )
                : null,
            ),
          ),
        ),
        h('div', { className: 'zs-note' }, '完整控制台（含参数表单与调用记录）：', ' ', h('a', { className: 'zs-link', href: '/zeroscript', target: '_blank', rel: 'noreferrer' }, 'http://127.0.0.1:19387/zeroscript')),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = NS
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'zeroscript: panel styles')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: SLOT_ID, order: 40, label: 'ZeroScript' }, Glyph),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: SLOT_ID, label: 'ZeroScript' }, Panel),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
