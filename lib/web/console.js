// SPDX-License-Identifier: MIT — ZeroScript console for DSH (no build step, plain browser JS)
/* global EventSource, fetch */
;(() => {
  'use strict'

  const API = '/zeroscript/api'
  const $ = (id) => document.getElementById(id)

  const el = {
    pillBridge: $('pill-bridge'),
    pillStudio: $('pill-studio'),
    pillMcp: $('pill-mcp'),
    pillTools: $('pill-tools'),
    studioId: $('studio-id'),
    btnRefresh: $('btn-refresh'),
    btnLaunch: $('btn-launch'),
    btnReconnect: $('btn-reconnect'),
    notice: $('notice'),
    verdict: $('verdict'),
    verdictLabel: $('verdict-label'),
    verdictDetail: $('verdict-detail'),
    verdictAction: $('verdict-action'),
    verdictProof: $('verdict-proof'),
    btnDetect: $('btn-detect'),
    search: $('tool-search'),
    toolList: $('tool-list'),
    runTitle: $('run-title'),
    runDesc: $('run-desc'),
    paramForm: $('param-form'),
    rawWrap: $('raw-wrap'),
    rawArgs: $('raw-args'),
    btnRaw: $('btn-raw'),
    btnRun: $('btn-run'),
    result: $('result'),
    resultMeta: $('result-meta'),
    callLog: $('call-log'),
    btnClearLog: $('btn-clear-log'),
  }

  const state = {
    tools: [],
    selected: null,
    rawMode: false,
    busy: false,
    running: 0,
  }

  // ------------------------------------------------------------------ helpers

  function setPill(node, kind, label) {
    node.classList.remove('is-ok', 'is-warn', 'is-err')
    if (kind) node.classList.add(kind)
    if (label) {
      const span = node.querySelector('.pill-label')
      if (span) span.textContent = label
    }
  }

  function showNotice(message, isError) {
    if (!message) {
      el.notice.hidden = true
      el.notice.textContent = ''
      return
    }
    el.notice.hidden = false
    el.notice.textContent = message
    el.notice.classList.toggle('is-err', Boolean(isError))
  }

  function timeLabel(ts) {
    const d = new Date(ts)
    return d.toLocaleTimeString('zh-CN', { hour12: false })
  }

  async function api(path, options) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...options,
    })
    const text = await res.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`服务返回了非 JSON 内容 (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    if (!res.ok || body.ok === false) {
      throw new Error(body.error || body.message || `HTTP ${res.status}`)
    }
    return body
  }

  const TOOL_LABELS = {
    script_read: '读取脚本',
    multi_edit: '编辑脚本',
    script_search: '按名搜索脚本',
    script_grep: '全库内容搜索',
    search_game_tree: '浏览游戏树',
    get_studio_state: '读取 Studio 状态',
    get_console_output: '读取输出日志',
    start_stop_play: '开始/停止播放测试',
    screen_capture: '截屏',
    generate_procedural_model: '生成程序化模型',
    store_image: '本地图片转 URI',
    upload_image: '上传图片为资产',
    list_plugin_guis: '列出插件 GUI',
    capture_plugin_gui: '截取插件 GUI',
    wait_job_finished: '等待后台任务',
    http_get: 'HTTP GET',
    skill: '读取技能资料',
    character_navigation: '角色导航',
    user_mouse_input: '模拟鼠标输入',
    segment_mesh: 'AI 网格分割',
  }

  // -------------------------------------------------------------------- status

  /**
   * The verdict banner is the authoritative answer to "is Studio connected?".
   * It fuses what the pills cannot: Studio running vs MCP enabled vs place
   * loaded, plus whether a real Studio call has actually succeeded.
   */
  function renderVerdict(detection) {
    if (!detection) {
      el.verdict.hidden = true
      return
    }
    el.verdict.hidden = false
    el.verdict.classList.remove('is-ok', 'is-warn', 'is-error')
    if (detection.level) el.verdict.classList.add(`is-${detection.level}`)

    el.verdictLabel.textContent = detection.label || detection.verdict
    el.verdictDetail.textContent = detection.detail || ''
    if (detection.action) {
      el.verdictAction.hidden = false
      el.verdictAction.textContent = `需要：${detection.action}`
    } else {
      el.verdictAction.hidden = true
      el.verdictAction.textContent = ''
    }
    el.verdictProof.textContent = detection.verified
      ? `✓ 已实测通过 · ${detection.proof || ''}`
      : detection.proof
        ? `未通过实测 · ${detection.proof}`
        : ''
    el.verdictProof.title = el.verdictProof.textContent
  }

  function renderStatus(payload) {
    const status = payload.status || {}
    const bridge = payload.bridge || {}
    const tools = payload.tools || []

    renderVerdict(payload.detection)

    if (bridge.connected) {
      setPill(el.pillBridge, 'is-ok', `Bridge :${status.port || bridge.port || '—'}`)
    } else if (bridge.state === 'connecting') {
      setPill(el.pillBridge, 'is-warn', 'Bridge 连接中')
    } else {
      setPill(el.pillBridge, 'is-err', 'Bridge 离线')
    }

    // Studio and MCP come from the bridge's last report. Once the bridge is
    // gone that snapshot is stale, and showing a green "ready" beside a red
    // "offline" reads as a working connection - so report them as unknown.
    if (bridge.connected) {
      if (status.studio) setPill(el.pillStudio, 'is-ok', 'Studio 就绪')
      else if (status.studioProc) setPill(el.pillStudio, 'is-warn', 'Studio 未开 place')
      else setPill(el.pillStudio, 'is-err', 'Studio 未运行')

      if (status.mcpAlive) setPill(el.pillMcp, 'is-ok', 'MCP 正常')
      else setPill(el.pillMcp, 'is-err', 'MCP 无响应')
    } else {
      setPill(el.pillStudio, '', 'Studio —')
      setPill(el.pillMcp, '', 'MCP —')
    }

    el.pillTools.querySelector('.pill-label').textContent = `工具 ${tools.length}`

    if (!bridge.connected) {
      showNotice(
        'Bridge 未连接。插件会自动尝试启动 bridge.py（最多每分钟一次）；也可以点右上角「启动 Bridge」立即重试。',
        true,
      )
    } else if (!status.studio) {
      showNotice(
        status.studioProc
          ? 'Studio 已打开，但还没有加载 place，或未启用 MCP：Assistant Settings → MCP Servers → Enable Studio as MCP server。'
          : '还没有检测到 Roblox Studio 进程：请打开 Roblox Studio 并加载一个 place。',
        false,
      )
    } else showNotice('')
  }

  async function pollStatus() {
    try {
      const payload = await api('/status')
      renderStatus(payload)
      if (payload.tools && payload.tools.length !== state.tools.length) {
        state.tools = payload.tools
        renderToolList()
      }
    } catch (error) {
      setPill(el.pillBridge, 'is-err', 'Bridge 离线')
      showNotice(`状态查询失败：${error.message}`, true)
    }
  }

  // --------------------------------------------------------------- tool list

  function renderToolList() {
    const needle = el.search.value.trim().toLowerCase()
    const tools = state.tools.filter((t) => {
      if (!needle) return true
      return (
        t.name.toLowerCase().includes(needle) ||
        (t.description || '').toLowerCase().includes(needle) ||
        (TOOL_LABELS[t.name] || '').includes(needle)
      )
    })

    if (!tools.length) {
      el.toolList.innerHTML = `<li class="empty">${
        state.tools.length ? '没有匹配的工具。' : '还没有拿到工具列表 —— 确认 Bridge 与 Studio 都就绪。'
      }</li>`
      return
    }

    const frag = document.createDocumentFragment()
    for (const tool of tools) {
      const li = document.createElement('li')
      li.className = 'tool' + (state.selected?.name === tool.name ? ' is-active' : '')
      const label = TOOL_LABELS[tool.name] ? `${TOOL_LABELS[tool.name]} · ` : ''
      li.innerHTML = `
        <span class="tserver">${escapeHtml(tool.server || '')}</span>
        <div class="tname">${escapeHtml(tool.name)}</div>
        <p class="tdesc">${escapeHtml(label + (tool.description || ''))}</p>`
      li.addEventListener('click', () => selectTool(tool))
      frag.appendChild(li)
    }
    el.toolList.replaceChildren(frag)
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  // ---------------------------------------------------------------- param form

  function selectTool(tool) {
    state.selected = tool
    el.runTitle.textContent = tool.name
    el.runDesc.textContent = tool.description || ''
    el.btnRun.disabled = false
    el.resultMeta.textContent = ''
    el.resultMeta.className = 'meta'
    renderToolList()
    renderParams(tool)
    el.rawArgs.value = JSON.stringify(defaultArgs(tool), null, 2)
  }

  function defaultArgs(tool) {
    const args = {}
    const props = tool.inputSchema?.properties || {}
    for (const [key, spec] of Object.entries(props)) {
      if (spec.default !== undefined) args[key] = spec.default
      else if (spec.type === 'boolean') args[key] = false
      else if (spec.type === 'integer' || spec.type === 'number') args[key] = 0
      else if (spec.type === 'array') args[key] = []
      else if (spec.type === 'object') args[key] = {}
      else args[key] = ''
    }
    return args
  }

  function renderParams(tool) {
    const props = tool.inputSchema?.properties || {}
    const required = new Set(tool.inputSchema?.required || [])
    const frag = document.createDocumentFragment()
    const keys = Object.keys(props)

    if (!keys.length) {
      const p = document.createElement('p')
      p.className = 'empty'
      p.textContent = '该工具不需要参数，直接点「执行」。'
      frag.appendChild(p)
      el.paramForm.replaceChildren(frag)
      return
    }

    for (const key of keys) {
      const spec = props[key] || {}
      const wrap = document.createElement('div')
      wrap.className = 'param'

      const label = document.createElement('label')
      label.className = 'param-label'
      label.htmlFor = `p-${key}`
      label.innerHTML = `${escapeHtml(key)}${required.has(key) ? '<span class="req">*</span>' : ''}`
      wrap.appendChild(label)

      let input
      const type = spec.type || 'string'
      if (type === 'boolean') {
        const row = document.createElement('div')
        row.className = 'bool-row'
        input = document.createElement('input')
        input.type = 'checkbox'
        input.id = `p-${key}`
        input.dataset.key = key
        input.dataset.kind = 'boolean'
        row.appendChild(input)
        const hint = document.createElement('span')
        hint.textContent = spec.description || '启用'
        hint.title = spec.description || ''
        row.appendChild(hint)
        wrap.appendChild(row)
      } else if (type === 'array' || type === 'object' || spec.type === 'json') {
        input = document.createElement('textarea')
        input.id = `p-${key}`
        input.dataset.key = key
        input.dataset.kind = 'json'
        input.spellcheck = false
        input.placeholder = type === 'array' ? '[]' : '{}'
        wrap.appendChild(input)
      } else {
        input = document.createElement('input')
        input.type = type === 'number' || type === 'integer' ? 'number' : 'text'
        input.id = `p-${key}`
        input.dataset.key = key
        input.dataset.kind = type === 'number' || type === 'integer' ? 'number' : 'string'
        input.autocomplete = 'off'
        wrap.appendChild(input)
      }

      if (spec.description && type !== 'boolean') {
        const help = document.createElement('span')
        help.className = 'param-help'
        help.textContent = spec.description
        help.title = spec.description
        wrap.appendChild(help)
      }
      frag.appendChild(wrap)
    }
    el.paramForm.replaceChildren(frag)
  }

  function collectParams() {
    if (state.rawMode) {
      const text = el.rawArgs.value.trim() || '{}'
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        throw new Error(`JSON 参数解析失败：${error.message}`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('JSON 参数必须是一个对象，例如 {"path":"..."}')
      }
      return parsed
    }

    const args = {}
    for (const input of el.paramForm.querySelectorAll('[data-key]')) {
      const key = input.dataset.key
      const kind = input.dataset.kind
      if (kind === 'boolean') {
        args[key] = input.checked
        continue
      }
      const raw = input.value
      if (raw === '') continue // let Studio's own defaults apply
      if (kind === 'number') {
        const num = Number(raw)
        if (Number.isNaN(num)) throw new Error(`参数 ${key} 需要数字`)
        args[key] = num
      } else if (kind === 'json') {
        try {
          args[key] = JSON.parse(raw)
        } catch (error) {
          throw new Error(`参数 ${key} 不是合法 JSON：${error.message}`)
        }
      } else {
        args[key] = raw
      }
    }

    const studioId = el.studioId.value.trim()
    if (studioId && args.studio_id === undefined) args.studio_id = studioId
    return args
  }

  // -------------------------------------------------------------------- run

  async function run() {
    if (!state.selected || state.busy) return
    let args
    try {
      args = collectParams()
    } catch (error) {
      showNotice(error.message, true)
      return
    }
    showNotice('')

    const name = state.selected.name
    state.busy = true
    state.running++
    el.btnRun.disabled = true
    el.btnRun.textContent = '执行中…'
    el.resultMeta.textContent = '运行中'
    el.resultMeta.className = 'meta'
    addLog({ name, at: Date.now(), state: 'running' })

    const started = Date.now()
    try {
      const body = await api('/call', { method: 'POST', body: JSON.stringify({ name, arguments: args, timeoutMs: 180_000 }) })
      const ms = Date.now() - started
      renderResult(body, ms)
      addLog({ name, at: started, ms, state: body.ok ? 'ok' : 'err', detail: body.ok ? '' : body.error })
    } catch (error) {
      const ms = Date.now() - started
      renderResult({ ok: false, error: error.message, text: '', images: [] }, ms)
      addLog({ name, at: started, ms, state: 'err', detail: error.message })
    } finally {
      state.busy = false
      state.running--
      el.btnRun.disabled = false
      el.btnRun.textContent = '执行'
    }
  }

  function renderResult(body, ms) {
    el.resultMeta.textContent = `${body.ok ? '成功' : '失败'} · ${ms} ms`
    el.resultMeta.className = `meta ${body.ok ? 'is-ok' : 'is-err'}`
    el.result.classList.toggle('is-err', !body.ok)

    const frag = document.createDocumentFragment()
    const text = body.ok ? body.text : body.error || body.text || '未知错误'
    const pre = document.createElement('pre')
    pre.textContent = text && text.length ? text : '(空结果)'
    frag.appendChild(pre)

    for (const image of body.images || []) {
      if (!image?.data) continue
      const img = document.createElement('img')
      img.src = `data:${image.mimeType || 'image/png'};base64,${image.data}`
      img.alt = 'Studio 截图'
      frag.appendChild(img)
    }
    el.result.replaceChildren(frag)
  }

  // -------------------------------------------------------------------- log

  function addLog(entry) {
    if (el.callLog.querySelector('.empty')) el.callLog.replaceChildren()
    const li = document.createElement('li')
    li.className = `entry ${entry.state === 'ok' ? 'ok' : entry.state === 'err' ? 'err' : ''}`
    const ms = entry.ms !== undefined ? `<span class="ems">${entry.ms} ms</span>` : '<span class="ems">…</span>'
    li.innerHTML = `${ms}<span class="ename">${escapeHtml(entry.name)}</span><span class="etime">${timeLabel(entry.at)}${
      entry.detail ? ` · ${escapeHtml(String(entry.detail).slice(0, 90))}` : ''
    }</span>`
    el.callLog.prepend(li)
    while (el.callLog.children.length > 200) el.callLog.lastElementChild.remove()
  }

  // ------------------------------------------------------------------ events

  function connectEvents() {
    let source
    try {
      source = new EventSource(`${API}/events`)
    } catch {
      return
    }
    source.addEventListener('status', (event) => {
      try {
        renderStatus(JSON.parse(event.data))
      } catch {
        /* ignore malformed frame */
      }
    })
    source.addEventListener('tools', (event) => {
      try {
        const payload = JSON.parse(event.data)
        state.tools = payload.tools || []
        renderToolList()
      } catch {
        /* ignore */
      }
    })
    source.addEventListener('call', (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.phase === 'end' && payload.origin === 'agent') {
          addLog({ name: payload.name, at: payload.at, ms: payload.ms, state: payload.ok ? 'ok' : 'err' })
        }
      } catch {
        /* ignore */
      }
    })
    source.addEventListener('detection', (event) => {
      try {
        const payload = JSON.parse(event.data)
        renderVerdict(payload.detection)
      } catch {
        /* ignore */
      }
    })
    source.addEventListener('error', () => {
      // EventSource auto-reconnects; polling keeps the UI fresh meanwhile.
    })
  }

  // ------------------------------------------------------------------ wiring

  el.search.addEventListener('input', renderToolList)
  el.btnRun.addEventListener('click', run)
  el.btnClearLog.addEventListener('click', () => {
    el.callLog.innerHTML = '<li class="empty">暂无记录。</li>'
  })

  el.btnRaw.addEventListener('click', () => {
    state.rawMode = !state.rawMode
    el.btnRaw.classList.toggle('is-on', state.rawMode)
    el.rawWrap.hidden = !state.rawMode
    el.paramForm.hidden = state.rawMode
    if (state.rawMode && state.selected) {
      try {
        el.rawArgs.value = JSON.stringify(collectParams(), null, 2)
      } catch {
        el.rawArgs.value = JSON.stringify(defaultArgs(state.selected), null, 2)
      }
    }
  })

  el.btnDetect.addEventListener('click', async () => {
    el.btnDetect.disabled = true
    el.btnDetect.textContent = '检测中…'
    try {
      const body = await api('/detect')
      renderVerdict(body.detection)
      if (Array.isArray(body.tools) && body.tools.length) {
        state.tools = body.tools
        renderToolList()
      }
      const detection = body.detection || {}
      showNotice(
        detection.verdict === 'connected'
          ? `检测通过：Studio 已连接${detection.verified ? '，并用真实调用验证成功' : ''}。`
          : `检测结果：${detection.label || detection.verdict}${detection.action ? ` —— ${detection.action}` : ''}`,
        detection.verdict !== 'connected',
      )
    } catch (error) {
      showNotice(`检测失败：${error.message}`, true)
    } finally {
      el.btnDetect.disabled = false
      el.btnDetect.textContent = '检测 Studio'
    }
  })

  el.btnRefresh.addEventListener('click', async () => {
    el.btnRefresh.disabled = true
    try {
      const payload = await api('/tools?refresh=1')
      state.tools = payload.tools || []
      renderToolList()
      showNotice(`已刷新，共 ${state.tools.length} 个工具。`, false)
    } catch (error) {
      showNotice(`刷新失败：${error.message}`, true)
    } finally {
      el.btnRefresh.disabled = false
    }
  })

  el.btnLaunch.addEventListener('click', async () => {
    el.btnLaunch.disabled = true
    el.btnLaunch.textContent = '启动中…'
    try {
      const body = await api('/launch', { method: 'POST', body: '{}' })
      showNotice(body.started ? 'Bridge 已启动。' : `未启动：${body.reason}`, !body.started && body.reason !== 'already-running')
      await pollStatus()
    } catch (error) {
      showNotice(`启动失败：${error.message}`, true)
    } finally {
      el.btnLaunch.disabled = false
      el.btnLaunch.textContent = '启动 Bridge'
    }
  })

  el.btnReconnect.addEventListener('click', async () => {
    try {
      await api('/reconnect', { method: 'POST', body: '{}' })
      showNotice('已请求重连。', false)
    } catch (error) {
      showNotice(`重连失败：${error.message}`, true)
    }
  })

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      run()
    }
  })

  // ------------------------------------------------------------------- boot
  pollStatus()
  setInterval(pollStatus, 3000)
  connectEvents()
})()
