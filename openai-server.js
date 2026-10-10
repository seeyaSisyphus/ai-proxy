// openai-server.js — node:http2 透传版(OpenAI 协议)
// 改用 Node 原生 http2 + 持久 session, 复用 HTTP/2 多路复用
// 实测比 node https + Agent 快(MiniMax/DeepSeek 等走 HTTP/2 路径)
const http = require('http')
const http2 = require('http2')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const config = require('./config')
// 提供方注册表：上游按「声明的协议端点」路由，不再硬编码在本文件里。
const providers = require('./providers')
// HTTP/1.1 中继通道（上游只讲 HTTP/1.1 时用）。
const { postChatCompletions } = require('./chat-upstream')

// ========== 日志模块 ==========
const LOG_DIR = path.join(__dirname, 'logs')
const DATA_DIR = path.join(__dirname, 'data')

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
}
ensureDir(LOG_DIR)
ensureDir(DATA_DIR)

function writeLog(level, message, extra = {}) {
  const entry = { timestamp: new Date().toISOString(), level, service: 'ai-openai-http2-proxy', message, ...extra }
  const line = JSON.stringify(entry) + '\n'
  const filename = level === 'error' ? 'openai-http2-proxy-error.log' : 'openai-http2-proxy-combined.log'
  fs.appendFile(path.join(LOG_DIR, filename), line, () => {})
  if (level === 'error' || level === 'warn') {
    console.error(`[${level.toUpperCase()}] ${message}`, Object.keys(extra).length ? extra : '')
  }
}

// ========== 统计数据持久化 ==========
const STATS_FILE = path.join(DATA_DIR, 'openai-http2-stats.json')
let statsRecords = []

function loadStats() {
  try {
    const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))
    if (Array.isArray(data.records)) statsRecords = data.records
  } catch (_) {
    statsRecords = []
  }
}

function saveStats() {
  const tmp = STATS_FILE + '.tmp'
  fs.writeFile(tmp, JSON.stringify({ records: statsRecords }), (err) => {
    if (!err) fs.rename(tmp, STATS_FILE, () => {})
  })
}

let statsDirty = false
let statsTimer = null
function markStatsDirty() {
  statsDirty = true
  if (!statsTimer) {
    statsTimer = setTimeout(() => {
      statsTimer = null
      if (statsDirty) {
        statsDirty = false
        saveStats()
      }
    }, 5000)
  }
}

loadStats()

// ========== 旁路 Token 统计(OpenAI 格式) ==========
// 兼容流式(SSE)和非流式(JSON)两种格式
class TokenStats {
  constructor() { this.buffer = ''; this.inputTokens = 0; this.outputTokens = 0; this.cachedTokens = 0 }
  feed(chunk) {
    this.buffer += chunk.toString()
    const events = this.buffer.split('\n\n')
    this.buffer = events.pop()
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const trimmed = line.slice(5).trimStart()
        if (!trimmed || trimmed === '[DONE]') continue
        try {
          const data = JSON.parse(trimmed)
          this._absorbUsage(data.usage)
        } catch (_) {}
      }
    }
  }
  finalize(fullBody) {
    if (this.buffer.trim()) {
      try {
        const data = JSON.parse(this.buffer.trim().replace(/^data:\s*/, ''))
        this._absorbUsage(data.usage)
      } catch (_) {}
      this.buffer = ''
    }
    if (fullBody) {
      try { const data = JSON.parse(fullBody); this._absorbUsage(data.usage) } catch (_) {}
    }
  }
  _absorbUsage(u) {
    if (!u) return
    if (u.prompt_tokens != null) this.inputTokens = u.prompt_tokens
    if (u.input_tokens != null) this.inputTokens = u.input_tokens
    if (u.completion_tokens != null) this.outputTokens = u.completion_tokens
    if (u.output_tokens != null) this.outputTokens = u.output_tokens
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
      || (u.input_tokens_details && u.input_tokens_details.cached_tokens)
      || u.cached_tokens
    if (cached != null) this.cachedTokens = cached
  }
  getUsage() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: this.cachedTokens,
      totalTokens: this.inputTokens + this.outputTokens,
    }
  }
}

// 输入 token 数字格式：>=1k 用 k 表示（整数 32k；有小数 32.5k）；<1k 保留 1 位小数（0.1k）
function humanizeTokens(n) {
  n = Number(n) || 0
  if (n < 0) return '0'
  // 输入 token：>=1k 用 k 表示（整数去掉小数,有小数保留 1 位）；<1k 也保留 1 位小数
  return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
}

// 按终端显示宽度补空格对齐（中文/全角字符占 2 列）
function dispWidth(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 2 : 1
  return w
}
function padStartW(s, width) {
  s = String(s)
  const p = width - dispWidth(s)
  return p > 0 ? ' '.repeat(p) + s : s
}
function padEndW(s, width) {
  s = String(s)
  const p = width - dispWidth(s)
  return p > 0 ? s + ' '.repeat(p) : s
}

// 按显示宽度截断(超宽末尾加省略号, 防止长模型名/客户端名顶歪日志列)
function truncW(s, width) {
  s = String(s)
  if (dispWidth(s) <= width) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = dispWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out + String.fromCharCode(0x2026)
}

// 日志用的提供方名（注册表解析出的 route 是 {provider, endpoint, mode} 结构）。
function routeLabel(route) {
  return (route && route.provider && route.provider.name) || (route && route.name) || 'Unknown'
}

function recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode }) {
  const elapsed = (Date.now() - startTime) / 1000
  const usage = stats.getUsage ? stats.getUsage() : stats
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const displayName = padEndW(truncW(String(modelName || routeLabel(route)).toLowerCase(), 16), 16)
  const displayClient = padEndW(truncW(clientName, 8), 8)
  const sec = `${elapsed.toFixed(2)}s`.padStart(7)
  const fmt = (n) => padStartW(humanizeTokens(n), 13)
  const fmtOut = (n) => (Number(n) || 0).toLocaleString('en-US').padStart(8)
  if (status === 'ok') {
    const cachePct = usage.inputTokens > 0 ? (usage.cachedTokens / usage.inputTokens * 100).toFixed(2) : '0.00'
    const cacheStr = usage.cachedTokens > 0 ? `(${padStartW(cachePct, 7)}%)` : padEndW('', 10)
    const tps = elapsed > 0 ? Math.round(usage.outputTokens / elapsed) : 0
    const tpsStr = `${tps} t/s`.padStart(7)
    console.log(`[${ts}] ${displayClient} → ${displayName} | ${upstreamStatusCode || 200} ${tpsStr} ${sec} |     in:${fmt(usage.inputTokens)}  ${cacheStr}  out:${fmtOut(usage.outputTokens)}`)
  } else if (status === 'cancelled') {
    console.log(`[${ts}] ${displayClient} → ${displayName} | 取消   ${sec}`)
  } else {
    console.log(`[${ts}] ${displayClient} → ${displayName} | 失败   ${sec}`)
  }

  statsRecords.push({
    time: new Date().toISOString(),
    name: clientName,
    model: modelName,
    route: routeLabel(route),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    totalTokens: usage.totalTokens,
    elapsed,
    status,
  })
  if (statsRecords.length > 5000) statsRecords = statsRecords.slice(-5000)
  markStatsDirty()
}

// ========== 获取真实客户端 IP ==========
function getClientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for']
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket && req.socket.remoteAddress
  return String(ip || '').replace(/^::ffff:/, '')
}
function getClientName(req) { return getClientIp(req) }

// 读取完整请求体(回调式,不阻塞事件循环)
function readBodyCb(req, cb) {
  const chunks = []
  let aborted = false
  req.on('data', c => { if (!aborted) chunks.push(c) })
  req.on('end', () => cb(null, Buffer.concat(chunks)))
  req.on('error', err => { aborted = true; cb(err, null) })
  req.on('aborted', () => { aborted = true; cb(new Error('aborted'), null) })
}

// ========== 路由解析 ==========
// 客户端接入协议固定为 Chat Completions（3719 就是 OpenAI 兼容入口）。
// 上游声明了 openai_chat 端点 → 直连；只有别的协议 → 明确报错（不做转换：
// 这个端口本身就是给「原生 Chat 上游」用的，转换需求走 3718/3722 的协议桥）。
const CLIENT_PROTOCOL = 'openai_chat'
// 本服务有两种转发通道：http2 透传（原生 Chat 上游）与 http1 中继（只讲 HTTP/1.1 的上游）。
const SERVER_TRANSPORTS = ['http2', 'http1']

function resolveRoute(model) {
  return providers.resolveRoute(model, CLIENT_PROTOCOL, SERVER_TRANSPORTS)
}

function resolveRouteByPath(url) {
  for (const key of Object.keys(providers.PROVIDERS)) {
    const prefix = '/' + key
    if (url.startsWith(prefix + '/') || url === prefix) {
      const rest = url.slice(prefix.length) || '/'
      const route = providers.resolveRoute(key, CLIENT_PROTOCOL, SERVER_TRANSPORTS)
      if (route.mode === 'unsupported') return null
      return { route, rewritePath: rest }
    }
  }
  return null
}


// ========== 持久 http2 session 池(origin → session) ==========
const h2Sessions = new Map()
const H2_IDLE_TIMEOUT_MS = 5 * 60 * 1000  // 5 分钟 idle 就主动关

function closeSession(origin, reason) {
  const s = h2Sessions.get(origin)
  if (!s) return
  h2Sessions.delete(origin)
  if (s._idleTimer) clearTimeout(s._idleTimer)
  try { s.close() } catch (_) {}
  try { s.destroy() } catch (_) {}
  if (reason) writeLog('info', `h2 session closed: ${reason}`, { origin })
}

function isSessionAlive(s) {
  if (!s) return false
  if (s.destroyed) return false
  if (s.closed) return false
  const socket = s.socket
  if (socket && (socket.destroyed || socket.readableEnded || socket.writableEnded)) return false
  return true
}

function getH2Session(origin) {
  const existing = h2Sessions.get(origin)
  if (isSessionAlive(existing)) {
    // 重置 idle 计时器
    if (existing._idleTimer) clearTimeout(existing._idleTimer)
    existing._idleTimer = setTimeout(() => {
      closeSession(origin, 'idle')
    }, H2_IDLE_TIMEOUT_MS)
    return existing
  }
  if (existing) closeSession(origin, 'stale')

  const session = http2.connect(origin)
  session.on('error', err => {
    writeLog('warn', `h2 session err: ${err.message}`, { origin, code: err.code })
    closeSession(origin, 'error')
  })
  session.on('close', () => closeSession(origin, 'close'))
  session.on('goaway', (errorCode, lastStreamID) => {
    writeLog('info', `h2 goaway code=${errorCode} lastStream=${lastStreamID}`, { origin })
    closeSession(origin, 'goaway')
  })
  // idle 超时
  session._idleTimer = setTimeout(() => {
    closeSession(origin, 'idle')
  }, H2_IDLE_TIMEOUT_MS)
  h2Sessions.set(origin, session)
  return session
}

// 防止下游客户端（如 Opencode）因 assistant content 为空而校验失败
function patchEmptyAssistantContent(obj) {
  if (!obj || typeof obj !== 'object') return
  if (Array.isArray(obj.choices)) {
    for (const choice of obj.choices) {
      if (!choice) continue
      if (choice.message && choice.message.content === '') choice.message.content = ' '
      if (choice.delta && choice.delta.content === '') choice.delta.content = ' '
    }
  }
}

function patchJsonResponse(raw) {
  try {
    const data = JSON.parse(raw)
    patchEmptyAssistantContent(data)
    return JSON.stringify(data)
  } catch (_) {
    return raw
  }
}

function patchSseBlock(block) {
  if (!block || !block.trim()) return block
  const lines = block.split('\n')
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trimStart()
      if (payload && payload !== '[DONE]') {
        try {
          const data = JSON.parse(payload)
          patchEmptyAssistantContent(data)
          out.push('data: ' + JSON.stringify(data))
          continue
        } catch (_) {}
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

// ========== 用 node:http(1.1) 转发 ==========
// 协议同为 Chat、只是上游只讲 HTTP/1.1（如 WorkBuddy 网关是 Go net/http）时的纯中继：
// 不做任何协议转换，只把字节转发过去，并保留与 h2 路径一致的空 content 兜底修补。
function forwardWithHttp1({ method, url, headers, body, route, modelName, req, res }) {
  const startTime = Date.now()
  const urlObj = new URL(url)
  const stats = new TokenStats()
  const clientName = getClientName(req)
  let finished = false
  let upstreamStatusCode = 0
  let responseStarted = false
  let isStreaming = false
  const jsonChunks = []

  function finish(status) {
    if (finished) return
    finished = true
    recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode })
  }

  const upstreamReq = postChatCompletions({
    baseUrl: urlObj.origin,
    apiKey: route.endpoint.apiKey,
    payload: body && body.length > 0 ? body : Buffer.alloc(0),
    path: urlObj.pathname + (urlObj.search || ''),
    headers,
    handlers: {
      onResponse: (status, responseHeaders) => {
        upstreamStatusCode = status
        isStreaming = String(responseHeaders['content-type'] || '').includes('text/event-stream')
        const outHeaders = { ...responseHeaders, 'access-control-allow-origin': '*' }
        // content-length 会与实际改写后的 body 长度不符，交给 chunked
        delete outHeaders['content-length']
        responseStarted = true
        try {
          res.writeHead(status, outHeaders)
          res.flushHeaders && res.flushHeaders()
        } catch (err) {
          writeLog('warn', `[${routeLabel(route)}] writeHead 失败: ${err.message}`)
          try { upstreamReq.destroy() } catch (_) {}
          finish('error')
        }
      },
      onData: chunk => {
        stats.feed(chunk)
        if (upstreamStatusCode < 200 || upstreamStatusCode >= 300) {
          try { res.write(chunk) } catch (_) {}
          return
        }
        if (isStreaming) {
          // SSE 逐块修补：空 assistant content 会让部分客户端校验失败
          const text = chunk.toString('utf8')
          const blocks = text.split('\n\n')
          const tail = blocks.pop()
          for (const block of blocks) {
            if (!block.trim()) continue
            try { res.write(patchSseBlock(block) + '\n\n') } catch (_) {}
          }
          if (tail) jsonChunks.push(Buffer.from(tail, 'utf8'))
          return
        }
        jsonChunks.push(chunk)
      },
      onEnd: () => {
        try {
          if (isStreaming) {
            const tail = Buffer.concat(jsonChunks).toString('utf8')
            if (tail.trim()) res.write(patchSseBlock(tail))
          } else if (jsonChunks.length > 0) {
            const raw = Buffer.concat(jsonChunks).toString('utf8')
            const patched = patchJsonResponse(raw)
            stats.finalize(patched)
            res.write(patched)
          }
        } catch (_) {}
        try { res.end() } catch (_) {}
        finish('ok')
      },
      onError: err => {
        writeLog('error', `[${routeLabel(route)}] chat 上游错误: ${err.message}`, { code: err.code })
        if (!responseStarted && !res.headersSent) {
          try {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
          } catch (_) {}
        } else {
          try { res.destroy() } catch (_) {}
        }
        finish('error')
      },
    },
  })

  req.on('aborted', () => {
    if (finished) return
    try { upstreamReq.destroy() } catch (_) {}
    finish('cancelled')
  })
}

// ========== 用 node:http2 转发 ==========
function forwardWithHttp2({ method, url, headers, body, route, modelName, req, res }) {
  const startTime = Date.now()

  const urlObj = new URL(url)
  const origin = urlObj.origin
  const path = urlObj.pathname + (urlObj.search || '')

  const session = getH2Session(origin)

  const stats = new TokenStats()
  let finished = false
  let upstreamStatusCode = 0
  const clientName = getClientName(req)

  function finish(status) {
    if (finished) return
    finished = true
    recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode })
  }

  // 客户端中途断用 aborted(close 在 res.end 后也会触发,会误判)
  let cancelled = false
  req.on('aborted', () => {
    if (!finished && !cancelled) {
      cancelled = true
      try { h2Req.close(http2.constants.NGHTTP2_CANCEL) } catch (_) {}
      finish('cancelled')
    }
  })

  // 构造 h2 头
  const h2Headers = {
    ':method': method,
    ':path': path,
    'content-type': 'application/json',
  }
  // HTTP/2 禁用的 HTTP/1.1 特定头
  const h2Forbidden = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te'])
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'host' || k === ':authority') continue
    if (h2Forbidden.has(k.toLowerCase())) continue
    h2Headers[k] = v
  }

  const h2Req = session.request(h2Headers)
  let bodyBuf = Buffer.alloc(0)
  let isStreaming = false
  let sseBuf = ''
  const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

  h2Req.on('response', h2resp => {
    upstreamStatusCode = h2resp[':status']
    // 转换 h2 头到 node http 头(去掉 :开头的伪头)
    const responseHeaders = {}
    for (const [k, v] of Object.entries(h2resp)) {
      if (k.startsWith(':')) continue
      responseHeaders[k] = v
    }
    const ct = (responseHeaders['content-type'] || '').toLowerCase()
    isStreaming = ct.includes('text/event-stream')
    responseHeaders['access-control-allow-origin'] = '*'
    try {
      res.writeHead(upstreamStatusCode, responseHeaders)
      res.flushHeaders && res.flushHeaders()
    } catch (err) {
      writeLog('warn', `writeHead 失败: ${err.message}`, { route: routeLabel(route), status: upstreamStatusCode })
      try { h2Req.close() } catch (_) {}
      finish('error')
      return
    }
  })

  h2Req.on('data', chunk => {
    stats.feed(chunk)
    bodyBuf = Buffer.concat([bodyBuf, chunk])
    if (isStreaming) {
      sseBuf += utf8Decoder.decode(chunk, { stream: true })
      const blocks = sseBuf.split('\n\n')
      sseBuf = blocks.pop() || ''
      for (const block of blocks) {
        if (!block.trim()) continue
        const patched = patchSseBlock(block)
        try { res.write(patched + '\n\n') } catch (_) {}
      }
    }
    // 非流式响应在 end 时统一 patch 后再发送
  })

  h2Req.on('end', () => {
    if (isStreaming) {
      sseBuf += utf8Decoder.decode()
      if (sseBuf.trim()) {
        const patched = patchSseBlock(sseBuf.trim())
        try { res.write(patched + '\n\n') } catch (_) {}
      }
      if (bodyBuf.length > 0) stats.finalize(bodyBuf.toString())
    } else {
      if (bodyBuf.length > 0) {
        const raw = bodyBuf.toString('utf8')
        const patched = patchJsonResponse(raw)
        stats.finalize(patched)
        try { res.write(patched) } catch (_) {}
      }
    }
    try { res.end() } catch (_) {}
    finish('ok')
  })

  h2Req.on('error', err => {
    writeLog('error', `[${routeLabel(route)}] h2 错误: ${err.message}`, { code: err.code })
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
      } catch (_) {}
    } else {
      // 已经写了 headers,client 不知道出错,必须 destroy socket
      try { res.destroy() } catch (_) {}
    }
    finish('error')
  })

  h2Req.on('frameError', (type, code) => {
    writeLog('warn', `[${routeLabel(route)}] h2 frameError: type=${type} code=${code}`)
  })

  if (body && body.length > 0) {
    h2Req.write(body)
  }
  h2Req.end()
}

function handleForward(req, res, route, bodyBuffer, modelName) {
  const endpoint = route.endpoint
  const label = route.provider.name

  // 模型名与 effort 归一化（全部由注册表字段驱动）
  if (bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      const before = bodyObj.model
      // 以 route.modelId 为准：它已包含 provider 解析 + models 表别名改写。
      const after = providers.normalizeRequest(route.provider, bodyObj, route.modelId || bodyObj.model)
      if (after !== before) {
        modelName = after
        writeLog('info', `模型名归一化(${label}): "${before}" -> "${after}"`)
      }
      for (const change of providers.normalizeEffort(route.provider, CLIENT_PROTOCOL, bodyObj)) {
        writeLog('info', `思考深度映射(${label}): ${change.from} -> ${change.to}`)
      }
      providers.applyChatExtras(route.provider, bodyObj)
      // 提供方声明的会话粘性键映射（客户端只发 HTTP 头、上游只读请求体的场景）
      providers.applySessionSticky(route.provider, bodyObj, req.headers)
      bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
    } catch (_) {}
  }

  // 流式请求必须显式声明 include_usage,否则 OpenAI 兼容上游(MiniMax/DeepSeek 等)
  // 不会在末尾 SSE 中吐 usage 块,导致 token/成本统计全为 0
  if (bodyBuffer.length > 0) {
    try {
      const bodyObj = JSON.parse(bodyBuffer.toString())
      if (bodyObj.stream === true) {
        bodyObj.stream_options = Object.assign({}, bodyObj.stream_options, { include_usage: true })
        bodyBuffer = Buffer.from(JSON.stringify(bodyObj))
      }
    } catch (_) {}
  }

  const targetUrlStr = endpoint.baseUrl + req.url
  // baseUrl 已有 /v1,客户端发的 /v1/chat/completions 会导致 /v1/v1/chat/completions
  // 剥掉路径里的 /v1 前缀
  const finalUrl = targetUrlStr.replace(/\/v1\/v1\//, '/v1/').replace(/\/v1\/v1$/, '/v1')

  const forwardHeaders = {}
  // 不透传 accept-encoding:上游可能返回 br/gzip 压缩响应,代理本身不实现解压,
  // 透传会导致客户端解压失败,同时压缩流也破坏了 stats.feed 的 JSON.parse。
  // localhost 代理场景,压缩无意义,统一用 identity。
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'content-length' || k === 'accept-encoding') continue
    forwardHeaders[k] = v
  }
  forwardHeaders['content-type'] = 'application/json'
  if (endpoint.apiKey) {
    forwardHeaders['authorization'] = `Bearer ${endpoint.apiKey}`
  }

  // 上游只讲 HTTP/1.1（如 WorkBuddy 网关）：协议同为 Chat，无需转换，走纯中继。
  if ((endpoint.transport || 'http2') === 'http1') {
    forwardWithHttp1({ method: req.method, url: finalUrl, headers: forwardHeaders, body: bodyBuffer, route, modelName, req, res })
    return
  }

  forwardWithHttp2({ method: req.method, url: finalUrl, headers: forwardHeaders, body: bodyBuffer, route, modelName, req, res })
}

// ========== 主入口 ==========
function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    })
    res.end()
    return
  }

  if (req.method === 'HEAD') {
    res.writeHead(200)
    res.end()
    return
  }

  // GET /health —— 健康检查端点（proxy-watchdog 探活用）
  if (req.method === 'GET' && String(req.url || '').split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ status: 'ok', service: 'openai-server' }))
    return
  }


  // GET 请求按 URL 路径前缀路由
  if (req.method === 'GET') {
    const matched = resolveRouteByPath(req.url)
    if (!matched) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unknown route', message: `GET 路径 "${req.url}" 无法匹配路由` }))
      return
    }
    writeLog('info', `路由: GET ${req.url} → ${routeLabel(matched.route)}`, { ip: getClientIp(req), name: getClientName(req) })
    const origUrl = req.url
    req.url = matched.rewritePath
    handleForward(req, res, matched.route, Buffer.alloc(0), '')
    req.url = origUrl
    return
  }

  // POST/PUT/PATCH: 读 body 用于路由决策
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    readBodyCb(req, (err, bodyBuffer) => {
      if (err) {
        writeLog('error', `读取请求体失败: ${err.message}`, { code: err.code })
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }))
        } else { res.end() }
        return
      }

      let model = null
      if (bodyBuffer.length > 0) {
        try { model = JSON.parse(bodyBuffer.toString()).model } catch (_) {}
      }

      const route = resolveRoute(model)
      if (!route.provider) {
        // 复用路由层给出的可读原因（含可用 provider 列表），别在这里退回笼统文案
        const hint = route.reason || (model ? `模型 "${model}" 无法匹配任何路由` : '请求体中未找到 model 字段')
        writeLog('warn', `路由失败: ${hint}`, { model })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unknown model', message: hint }))
        return
      }
      if (route.mode === 'unsupported') {
        writeLog('warn', `路由失败: ${route.reason}`, { model })
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unsupported protocol', message: route.reason }))
        return
      }

      writeLog('info', `路由: ${model} → ${routeLabel(route)} [${providers.modeLabel(route.mode)}]`, { ip: getClientIp(req), reason: route.reason })
      handleForward(req, res, route, bodyBuffer, model || '')
    })
    return
  }

  res.writeHead(405, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Method Not Allowed' }))
}

// 端口优先级: env var > config.ports.openai > 默认 3719
const PORT = process.env.OPENAI_PORT_OVERRIDE
  ? Number(process.env.OPENAI_PORT_OVERRIDE)
  : ((config.ports && config.ports.openai) || 3719)
const server = http.createServer(handleRequest)
server.on('connection', socket => socket.setNoDelay(true))

server.on('clientError', (err, socket) => {
  const quiet = err.code === 'ECONNRESET' || err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
  writeLog(quiet ? 'info' : 'error', `客户端请求异常: ${err.message}`, { code: err.code })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

process.on('uncaughtException', (err, origin) => {
  writeLog('error', `未捕获异常 (${origin}): ${err.message}`, { name: err.name, code: err.code, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  writeLog('error', `未处理的 Promise Rejection: ${err.message}`, { name: err.name, code: err.code, stack: err.stack })
})

server.listen(PORT, () => {
  const banner = [
    `🚀 OpenAI 兼容 API (node:http2 透传) 代理服务器已启动`,
    `   地址: http://localhost:${PORT}`,
  ].join('\n')
  console.log('\n' + banner + '\n')
  writeLog('info', 'OpenAI 兼容 API (node:http2 透传) 代理服务器已启动', { port: PORT })
})
