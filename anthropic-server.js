const http = require('http')
const http2 = require('http2')
const fs = require('fs')
const path = require('path')
const config = require('./config')
// 上游只提供 Chat Completions 时的协议桥（Anthropic <-> Chat）与 HTTP/1.1 转发。
const { anthropicToChatCompletions, openaiToAnthropic, ChatToAnthropicStream } = require('./anthropic-chat-bridge')
const { ChatSsePump, postChatCompletions } = require('./chat-upstream')
// 提供方注册表：上游按「声明的协议端点」路由，不再硬编码在本文件里。
const providers = require('./providers')
// 本地 Files API：llm-deepseek 的带图请求会先尝试上传，本代理无上游 Files 端点，
// 因此在这里提供兼容实现，并在转发前把本地 file_id 还原成内联 base64。
const filesApi = require('./files-api')

const LOG_DIR = path.join(__dirname, 'logs')
const DATA_DIR = path.join(__dirname, 'data')
function ensureDir(dir) { try { fs.mkdirSync(dir, { recursive: true}) } catch (_) {} }
ensureDir(LOG_DIR)
ensureDir(DATA_DIR)

function writeLog(level, message, extra = {}) {
  const entry = {timestamp: new Date().toISOString(), level, service: 'ai-anthropic-http2-proxy', message, ...extra}
  const line = JSON.stringify(entry) + '\n'
  const filename = level === 'error' ? 'anthropic-http2-proxy-error.log' : 'anthropic-http2-proxy-combined.log'
  fs.appendFile(path.join(LOG_DIR, filename), line, () => {})
  if (level === 'error' || level === 'warn') {
    console.error(`[${level.toUpperCase()}] ${message}`, Object.keys(extra).length ? extra : '')
  }
}

// ========== 路由解析 ==========
// 客户端接入协议固定为 Anthropic Messages（Claude Code 只会说这一种）。
// 上游在 config.providers 里声明自己有哪些协议端点，providers.js 比对后给出：
//   mode='direct'       上游原生支持 Anthropic → 字节透传
//   mode='chat_bridge'  上游只有 Chat Completions → 走 anthropic-chat-bridge 转换
//   mode='unsupported'  上游两种都没有 → 明确报错
const CLIENT_PROTOCOL = 'anthropic'
// 本服务有两种转发通道：http2 直连（原生 Anthropic 上游）与 http1 协议桥（只讲 Chat 的上游）。
const SERVER_TRANSPORTS = ['http2', 'http1']

function resolveRoute(model) {
  return providers.resolveRoute(model, CLIENT_PROTOCOL, SERVER_TRANSPORTS)
}

// GET 请求（/v1/models 等探测）按 URL 路径前缀选提供方。
// 前缀匹配的提供方（global: / cn:）不参与：它们的关键字是模型名前缀，不是路径段。
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

function getClientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for']
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket && req.socket.remoteAddress
  return String(ip || '').replace(/^::ffff:/, '')
}
function getClientName(req) { return getClientIp(req) }

function readBodyCb(req, cb) {
  const chunks = []
  let aborted = false
  req.on('data', c => { if (!aborted) chunks.push(c) })
  req.on('end', () => cb(null, Buffer.concat(chunks)))
  req.on('error', err => { aborted = true; cb(err, null) })
  req.on('aborted', () => { aborted = true; cb(new Error('aborted'), null) })
}

class TokenStats {
  constructor() { this.buffer = ''; this.cacheReadInputTokens = 0; this.cacheCreationInputTokens = 0; this.inputTokens = 0; this.outputTokens = 0 }
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
          this._absorbUsage(data.message?.usage || data.usage)
        } catch (_) {}
      }
    }
  }
  finalize(fullBody) {
    if (this.buffer.trim()) {
      try {
        const data = JSON.parse(this.buffer.trim().replace(/^data:\s*/, ''))
        this._absorbUsage(data.message?.usage || data.usage)
      } catch (_) {}
      this.buffer = ''
    }
    if (fullBody) {
      try { const data = JSON.parse(fullBody); this._absorbUsage(data.message?.usage || data.usage) } catch (_) {}
    }
  }
  _absorbUsage(u) {
    if (!u) return
    // 两种协议形态都要吃，并把「输入 token 是否含缓存」统一成 Anthropic 口径（不含缓存）。
    // 不统一会让 getUsage 的 totalInputTokens = cache + input 把缓存重复计入：
    //   Anthropic 直连：input_tokens 已不含缓存
    //   Chat 协议桥：  prompt_tokens 含缓存（== input + cached）
    // 只认 Anthropic 形态还会让 chat 桥路径的 out 恒为 0（网关侧明明有真实 token）。
    const cached =
      u.cache_read_input_tokens ||
      u.cached_tokens ||
      (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
      0
    const cacheCreation =
      u.cache_creation_input_tokens ||
      (u.prompt_tokens_details && u.prompt_tokens_details.cache_write_tokens) ||
      0

    if (u.prompt_tokens != null) this.inputTokens = Math.max(0, u.prompt_tokens - cached - cacheCreation)
    else if (u.input_tokens != null) this.inputTokens = u.input_tokens

    if (u.output_tokens != null) this.outputTokens = u.output_tokens
    if (u.completion_tokens != null) this.outputTokens = u.completion_tokens

    if (cached) this.cacheReadInputTokens = cached
    if (cacheCreation) this.cacheCreationInputTokens = cacheCreation
  }
  getUsage() {
    return {
      cacheReadInputTokens: this.cacheReadInputTokens,
      cacheCreationInputTokens: this.cacheCreationInputTokens,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalInputTokens: this.cacheReadInputTokens + this.cacheCreationInputTokens + this.inputTokens,
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

// 按终端显示宽度补空格对齐（中文/全角字符占 2 列；→ 等箭头在中文控制台也是全角）
function dispWidth(s) {
  let w = 0
  for (const ch of String(s)) w += /[\u1100-\u115f\u2026\u2190-\u21ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 2 : 1
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
  let out = ""
  let w = 0
  for (const ch of s) {
    const cw = dispWidth(ch)
    if (w + cw > width - 2) break
    out += ch
    w += cw
  }
  return out + String.fromCharCode(0x2026)
}


// 按显示宽度截断(超宽末尾加省略号, 防止长模型名/客户端名顶歪日志列)
function truncW(s, width) {
  s = String(s)
  if (dispWidth(s) <= width) return s
  let out = ""
  let w = 0
  for (const ch of s) {
    const cw = dispWidth(ch)
    if (w + cw > width - 2) break
    out += ch
    w += cw
  }
  return out + String.fromCharCode(0x2026)
}

// 日志用的提供方名（注册表解析出的 route 是 {provider, endpoint, mode} 结构）。
function routeLabel(route) {
  return (route && route.provider && route.provider.name) || (route && route.name) || 'Unknown'
}

function recordRequestLog({startTime, status, modelName, clientName, route, stats, upstreamStatusCode}) {
  const elapsed = (Date.now() - startTime) / 1000
  const usage = stats.getUsage ? stats.getUsage() : stats
  const ts = new Date().toLocaleTimeString('zh-CN', {hour12: false})
  const displayName = padEndW(truncW(modelName || routeLabel(route), 18), 18)
  const displayClient = padEndW(truncW(clientName, 8), 8)
  const sec = `${elapsed.toFixed(2)}s`.padStart(7)
  const fmt = (n) => padStartW(humanizeTokens(n), 13)
  const fmtOut = (n) => (Number(n) || 0).toLocaleString('en-US').padStart(8)
  if (status === 'ok') {
    const cachePct = usage.totalInputTokens > 0 ? (usage.cacheReadInputTokens / usage.totalInputTokens * 100).toFixed(2) : '0.00'
    const cacheStr = usage.cacheReadInputTokens > 0 ? `(${padStartW(cachePct, 7)}%)` : padEndW('', 10)
    const tps = elapsed > 0 ? Math.round(usage.outputTokens / elapsed) : 0
    const tpsStr = `${tps} t/s`.padStart(8)
    console.log(`[${ts}] ${displayClient} → ${displayName} | ${upstreamStatusCode || 200} ${tpsStr} ${sec} |     in:${fmt(usage.totalInputTokens)}  ${cacheStr}  out:${fmtOut(usage.outputTokens)}`)
  } else if (status === 'cancelled') {
    console.log(`[${ts}] ${displayClient} → ${displayName} | ${padEndW('取消', 12)} ${sec}`)
  } else {
    console.log(`[${ts}] ${displayClient} → ${displayName} | ${padEndW('失败', 12)} ${sec}`)
  }
}

// 持久 http2 session 池(origin → session)
const h2Sessions = new Map()
const H2_IDLE_TIMEOUT_MS = 5 * 60 * 1000  // 5 分钟 idle 就主动关

function closeSession(origin, reason) {
  const s = h2Sessions.get(origin)
  if (!s) return
  h2Sessions.delete(origin)
  if (s._idleTimer) clearTimeout(s._idleTimer)
  try { s.close() } catch (_) {}
  try { s.destroy() } catch (_) {}
  if (reason) writeLog('info', `h2 session closed: ${reason}`, {origin})
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

  const session = http2.connect(origin, { rejectUnauthorized: false })
  session.on('error', err => {
    writeLog('warn', `h2 session err: ${err.message}`, {origin, code: err.code})
    closeSession(origin, 'error')
  })
  session.on('close', () => closeSession(origin, 'close'))
  session.on('goaway', (errorCode, lastStreamID) => {
    writeLog('info', `h2 goaway code=${errorCode} lastStream=${lastStreamID}`, {origin})
    closeSession(origin, 'goaway')
  })
  // idle 超时
  session._idleTimer = setTimeout(() => {
    closeSession(origin, 'idle')
  }, H2_IDLE_TIMEOUT_MS)
  h2Sessions.set(origin, session)
  return session
}

// 提供方级别的 Key 轮换游标。按 name 归并：union / stealth / openrouter / opus 是同一
// 上游（OpenRouter）的多个匹配关键字，必须共享一把 Key 游标。
const keyIndexes = new Map()

function keyIndexFor(provider) {
  return keyIndexes.get(provider.name) || 0
}

function forwardWithHttp2({method, url, headers, body, route, modelName, req, res, attempt = 0, keyIndex}) {
  const startTime = Date.now()
  if (req.aborted || res.destroyed) return
  const endpoint = route.endpoint
  const keyPool = providers.keyPoolFor(route.provider, CLIENT_PROTOCOL)
  const activeKeyIndex = keyIndex === undefined ? keyIndexFor(route.provider) : keyIndex
  const label = routeLabel(route)
  let retrying = false
  let retryTimer = null

  // 解析 origin 和 path
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
    req.removeListener('aborted', cancel)
    res.removeListener('close', cancel)
    clearTimeout(retryTimer)
    recordRequestLog({startTime, status, modelName, clientName, route, stats, upstreamStatusCode})
  }

  let cancelled = false
  function cancel() {
    if (!finished && !cancelled) {
      cancelled = true
      finish('cancelled')
      try { req2.close(http2.constants.NGHTTP2_CANCEL) } catch (_) {}
    }
  }
  req.once('aborted', cancel)
  res.once('close', cancel)

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
  if (keyPool) {
    const key = keyPool[activeKeyIndex % keyPool.length]
    h2Headers.authorization = `Bearer ${key}`
    if (h2Headers['x-api-key']) h2Headers['x-api-key'] = key
  }

  const req2 = session.request(h2Headers)
  let firstByte = 0
  let bodyBuf = Buffer.alloc(0)

  req2.on('response', h2resp => {
    upstreamStatusCode = h2resp[':status']
    if (cancelled || finished) return
    if (keyPool && upstreamStatusCode === 429 && attempt + 1 < keyPool.length && !res.headersSent) {
      retrying = true
      const nextKeyIndex = (activeKeyIndex + 1) % keyPool.length
      writeLog('warn', `[${label} 429] 切换到 Key #${nextKeyIndex + 1}，尝试 ${attempt + 2}/${keyPool.length}`)
      try { req2.close() } catch (_) {}
      retryTimer = setTimeout(() => {
        if (cancelled || res.destroyed) return
        finish('retry')
        forwardWithHttp2({method, url, headers, body, route, modelName, req, res, attempt: attempt + 1, keyIndex: nextKeyIndex})
      }, 1000)
      return
    }
    if (keyPool && upstreamStatusCode >= 200 && upstreamStatusCode < 300) keyIndexes.set(route.provider.name, activeKeyIndex)
    // 转换 h2 头到 node http 头
    const responseHeaders = {}
    for (const [k, v] of Object.entries(h2resp)) {
      if (k.startsWith(':')) continue
      responseHeaders[k] = v
    }
    responseHeaders['access-control-allow-origin'] = '*'
    try {
      res.writeHead(upstreamStatusCode, responseHeaders)
      res.flushHeaders && res.flushHeaders()
    } catch (err) {
      writeLog('warn', `writeHead err: ${err.message}`, {route: label})
      try { req2.close() } catch (_) {}
      finish('error')
      return
    }
    firstByte = Date.now() - startTime
  })

  req2.on('data', chunk => {
    if (retrying || finished) return
    stats.feed(chunk)
    bodyBuf = Buffer.concat([bodyBuf, chunk])
    try { res.write(chunk) } catch (_) {}
  })

  req2.on('end', () => {
    if (retrying || finished) return
    if (bodyBuf.length > 0) stats.finalize(bodyBuf.toString())
    try { res.end() } catch (_) {}
    finish('ok')
  })

  req2.on('error', err => {
    if (retrying || finished) return
    writeLog('error', `[${label}] h2 err: ${err.message}`, {code: err.code})
    if (!res.headersSent) {
      try {
        res.writeHead(502, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
        res.end(JSON.stringify({error: 'Bad Gateway', message: err.message}))
      } catch (_) {}
    } else {
      // 已经写了 headers,client 不知道出错,必须 destroy socket
      // 否则 Claude Code 之类会一直等响应
      try { res.destroy() } catch (_) {}
    }
    finish('error')
  })

  req2.on('frameError', (type, code) => {
    writeLog('warn', `[${label}] h2 frameError: type=${type} code=${code}`)
  })

  if (body && body.length > 0) {
    req2.write(body)
  }
  req2.end()
}

// ========== Chat Completions 上游转发（协议桥路径）==========
//
// 上游（WorkBuddy2API）只提供 OpenAI Chat Completions，而 Claude Code 只说 Anthropic
// Messages：请求经 anthropic-chat-bridge 降级成 Chat，响应再升回 Anthropic SSE。
//
// 与直通路径的区别：不能原样透传字节，必须整条流经转换器，
// 所以这里累积 Chat 事件而不是直接 res.write(chunk)。

function forwardToChatUpstream(req, res, route, bodyBuffer, modelName) {
  const startTime = Date.now()
  const clientName = getClientName(req)
  const stats = new TokenStats()
  let finished = false
  let upstreamStatusCode = 0
  const label = routeLabel(route)
  const endpoint = route.endpoint

  function finish(status) {
    if (finished) return
    finished = true
    recordRequestLog({ startTime, status, modelName, clientName, route, stats, upstreamStatusCode })
  }

  let requestBody
  let converted
  try {
    requestBody = JSON.parse(bodyBuffer.toString())
    // 思考深度：handleForward 里的 normalizeEffort 已经把档位算好并写到顶层
    // body.reasoning_effort（同时删掉了 output_config.effort）。桥只认 output_config.effort，
    // 不把结果显式传进去就会静默丢档位（ultra/max 到不了上游）。
    // 桥的 opts.reasoningEffort 优先级高于它自己的解析，故这里显式传入。
    converted = anthropicToChatCompletions(requestBody, {
      reasoningEffort: requestBody.reasoning_effort,
    })
    // 提供方声明的 Chat 专属字段（如 MiniMax 的 reasoning_split）
    providers.applyChatExtras(route.provider, converted)
    // 提供方声明的会话粘性键映射（客户端只发 HTTP 头、上游只读请求体的场景）
    providers.applySessionSticky(route.provider, converted, req.headers)
  } catch (err) {
    writeLog('error', `[${label}] 请求转换失败: ${err.message}`)
    res.writeHead(400, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
    res.end(JSON.stringify({type: 'error', error: {type: 'invalid_request_error', message: err.message}}))
    finish('error')
    return
  }

  const isStream = converted.stream === true
  const payload = Buffer.from(JSON.stringify(converted))

  // 非流式：响应是整块 JSON 而非 SSE，不能过 SSE 泵，直接累积原始字节后整体转换。
  const jsonChunks = []
  const errorChunks = []
  const streamConverter = new ChatToAnthropicStream()
  const ssePump = isStream
    ? new ChatSsePump({
        onChunk: chunk => {
          if (chunk.error !== undefined || chunk.type === 'error') {
            // 上游在流中途报错：如实转成 Anthropic error 事件，别让客户端收到半截流。
            const err = chunk.error && typeof chunk.error === 'object' ? chunk.error : chunk
            const message = typeof err.message === 'string' ? err.message : JSON.stringify(err)
            try {
              for (const event of streamConverter.handleError(message, err.type || 'upstream_error')) res.write(event)
            } catch (e) {
              writeLog('error', `[${label}] 错误事件转换失败: ${e.message}`)
            }
            return
          }
          try {
            for (const event of streamConverter.handleChunk(chunk)) res.write(event)
          } catch (err) {
            writeLog('error', `[${label}] 流式转换失败: ${err.message}`)
          }
        },
        onDone: () => {},
      })
    : null

  let responseStarted = false

  const upstreamReq = postChatCompletions({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    payload,
    handlers: {
      onResponse: (status, headers) => {
        upstreamStatusCode = status
        const responseHeaders = { 'access-control-allow-origin': '*' }
        // 透传上游 content-type 会把 Chat 的 JSON/SSE 类型带给 Claude Code（它要 Anthropic SSE），
        // 因此统一改写；错误响应保持 JSON 以便客户端解析报错正文。
        if (status >= 200 && status < 300) {
          // 非流式请求必须回普通 JSON message；只有流式才是 SSE 帧。
          responseHeaders['content-type'] = isStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'
          if (isStream) {
            responseHeaders['cache-control'] = 'no-cache'
            responseHeaders.connection = 'keep-alive'
          }
        } else {
          responseHeaders['content-type'] = 'application/json'
        }
        responseStarted = true
        try {
          res.writeHead(status, responseHeaders)
          res.flushHeaders && res.flushHeaders()
        } catch (err) {
          writeLog('warn', `[${label}] writeHead 失败: ${err.message}`)
          try { upstreamReq.destroy() } catch (_) {}
          finish('error')
        }
      },
      onData: chunk => {
        stats.feed(chunk)
        if (upstreamStatusCode < 200 || upstreamStatusCode >= 300) {
          // 上游错误正文：客户端只看到状态码，排障需要原文。
          errorChunks.push(chunk)
          return
        }
        if (ssePump) ssePump.push(chunk)
        else jsonChunks.push(chunk)
      },
      onEnd: () => {
        if (upstreamStatusCode < 200 || upstreamStatusCode >= 300) {
          const detail = Buffer.concat(errorChunks).toString().slice(0, 800)
          writeLog('error', `[${label}] 上游错误 ${upstreamStatusCode}: ${detail}`)
        }
        if (upstreamStatusCode >= 200 && upstreamStatusCode < 300) {
          try {
            if (ssePump) {
              ssePump.flush()
              for (const event of streamConverter.finish()) res.write(event)
            } else {
              const raw = Buffer.concat(jsonChunks).toString()
              stats.finalize(raw)
              const message = openaiToAnthropic(JSON.parse(raw))
              // 非流式回整块 JSON（不是 SSE 帧）。
              res.end(JSON.stringify(message))
              finish('ok')
              return
            }
          } catch (err) {
            writeLog('error', `[${label}] 响应转换失败: ${err.message}`)
            if (ssePump) {
              for (const event of streamConverter.handleError('Upstream response could not be converted: ' + err.message, 'upstream_transform_failed')) res.write(event)
            } else if (!res.headersSent) {
              try {
                res.writeHead(502, {'Content-Type': 'application/json'})
                res.end(JSON.stringify({type: 'error', error: {type: 'api_error', message: err.message}}))
              } catch (_) {}
            }
          }
        }
        try { res.end() } catch (_) {}
        finish('ok')
      },
      onError: err => {
        writeLog('error', `[${label}] chat 上游错误: ${err.message}`, {code: err.code})
        if (!responseStarted && !res.headersSent) {
          try {
            res.writeHead(502, {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'})
            res.end(JSON.stringify({type: 'error', error: {type: 'api_error', message: err.message}}))
          } catch (_) {}
        } else {
          // 已发响应头：客户端不知道出错，必须断链，否则 Claude Code 一直等
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

function handleForward(req, res, route, bodyBuffer, modelName) {
  const label = routeLabel(route)
  const endpoint = route.endpoint

  // 模型名归一化（forceModel / stripModelSuffix，全部由注册表字段驱动）。
  if (bodyBuffer.length > 0) {
    try {
      const b = JSON.parse(bodyBuffer.toString())
      const before = b.model
      // 以 route.modelId 为准：它已包含 provider 解析 + models 表别名改写。
      const after = providers.normalizeRequest(route.provider, b, route.modelId || b.model)
      if (after !== before) {
        bodyBuffer = Buffer.from(JSON.stringify(b))
        modelName = after
        writeLog('info', `模型名归一化(${label}): "${before}" -> "${after}"`)
      }
    } catch (_) {}
  }

  // 思考深度归一化（clamp/ceiling/force/field 全部读自注册表）。
  if (bodyBuffer.length > 0) {
    try {
      const b = JSON.parse(bodyBuffer.toString())
      const changes = providers.normalizeEffort(route.provider, CLIENT_PROTOCOL, b)
      for (const change of changes) {
        writeLog('info', `思考深度映射(${label}): ${change.from} -> ${change.to}`)
      }
      if (changes.length > 0) bodyBuffer = Buffer.from(JSON.stringify(b))
    } catch (_) {}
  }

  // 本地 Files 生成的 file_id 对任何上游都无效：转发前还原成内联 base64。
  if (bodyBuffer.length > 0) {
    const resolved = filesApi.resolveFileReferences(bodyBuffer)
    if (resolved.missing.length > 0) {
      // 文本需命中 llm-deepseek 的 stale-id 识别（file + not found），它才会作废本地
      // 映射并重新上传；用户请求本身不会失败。
      writeLog('warn', `文件引用失效(${label}): ${resolved.missing.join(', ')}`)
      const payload = JSON.stringify({ type: 'error', error: {
        type: 'invalid_request_error', code: 'file_not_found',
        message: `file ${resolved.missing[0]} not found` } })
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }
    if (resolved.changed) bodyBuffer = resolved.buffer
  }

  // 上游只吃 Chat Completions：走协议桥（Anthropic Messages <-> Chat）。
  if (route.mode === 'chat_bridge') {
    forwardToChatUpstream(req, res, route, bodyBuffer, modelName)
    return
  }

  const targetUrlStr = providers.buildTargetUrl(endpoint, CLIENT_PROTOCOL, '')
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
    if (req.headers['x-api-key']) forwardHeaders['x-api-key'] = endpoint.apiKey
  }

  forwardWithHttp2({method: req.method, url: targetUrlStr, headers: forwardHeaders, body: bodyBuffer, route, modelName, req, res})
}

function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta',
    })
    res.end(); return
  }
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return }

  // GET /health —— 健康检查端点（proxy-watchdog 探活用）
  // 本地 Files API：无 model 字段，必须早于按 body.model 的提供方路由。
  if (filesApi.matchesFilesRoute(req)) {
    if (req.method === 'POST' || req.method === 'DELETE') {
      readBodyCb(req, (err, bodyBuffer) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }))
          return
        }
        const outcome = filesApi.handle(req, res, bodyBuffer)
        writeLog('info', `Files API: ${req.method} ${String(req.url).split('?')[0]} -> ${outcome.action}`)
      })
      return
    }
    if (req.method === 'GET') {
      const outcome = filesApi.handle(req, res, Buffer.alloc(0))
      writeLog('info', `Files API: ${req.method} ${String(req.url).split('?')[0]} -> ${outcome.action}`)
      return
    }
  }

  if (req.method === 'GET' && String(req.url || '').split('?')[0] === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ status: 'ok', service: 'anthropic-server' }))
    return
  }

  if (req.method === 'GET') {
    const matched = resolveRouteByPath(req.url)
    if (!matched) {
      res.writeHead(400, {'Content-Type': 'application/json'})
      res.end(JSON.stringify({error: 'Unknown route', message: `GET 路径 "${req.url}" 无法匹配路由`}))
      return
    }
    const origUrl = req.url
    req.url = matched.rewritePath
    handleForward(req, res, matched.route, Buffer.alloc(0), '')
    req.url = origUrl
    return
  }

  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    readBodyCb(req, (err, bodyBuffer) => {
      if (err) {
        writeLog('error', `读取请求体失败: ${err.message}`, {code: err.code})
        if (!res.headersSent) {
          res.writeHead(500, {'Content-Type': 'application/json'})
          res.end(JSON.stringify({error: 'Internal Server Error', message: err.message}))
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
        writeLog('warn', `路由失败: ${hint}`, {model})
        res.writeHead(400, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({error: 'Unknown model', message: hint}))
        return
      }
      if (route.mode === 'unsupported') {
        writeLog('warn', `路由失败: ${route.reason}`, {model})
        res.writeHead(400, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({error: 'Unsupported protocol', message: route.reason}))
        return
      }

      writeLog('info', `路由: ${model} → ${routeLabel(route)} [${providers.modeLabel(route.mode)}]`, {ip: getClientIp(req), reason: route.reason})
      handleForward(req, res, route, bodyBuffer, model || '')
    })
    return
  }

  res.writeHead(405, {'Content-Type': 'application/json'})
  res.end(JSON.stringify({error: 'Method Not Allowed'}))
}

const PORT = (config.ports && config.ports.anthropic) || 3718
const server = http.createServer(handleRequest)
server.on('connection', socket => socket.setNoDelay(true))

server.on('clientError', (err, socket) => {
  const quiet = err.code === 'ECONNRESET' || err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
  writeLog(quiet ? 'info' : 'error', `客户端请求异常: ${err.message}`, {code: err.code})
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

process.on('uncaughtException', (err, origin) => {
  writeLog('error', `未捕获异常 (${origin}): ${err.message}`, {name: err.name, code: err.code, stack: err.stack})
})

server.listen(PORT, () => {
  console.log(`\n🚀 ANTHROPIC API (node:http2 透传) 代理服务器已启动`)
  console.log(`   地址: http://localhost:${PORT}\n`)
  writeLog('info', 'ANTHROPIC API (node:http2 透传) 代理服务器已启动', {port: PORT})
})
