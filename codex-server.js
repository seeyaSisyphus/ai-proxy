const http = require('http')
const http2 = require('http2')
const fs = require('fs')
const path = require('path')
const config = require('./config')
const { SsePlaintextArgsInjector, sanitizeEncryptedContentInInput, downgradeAgentMessageItems, injectSubagentAggregationHint } = require('./codex-multiagent')
// 上游只提供 Chat Completions 时的协议桥（Responses <-> Chat）与 HTTP/1.1 转发。
const { responsesToChatCompletions, chatCompletionToResponse, ChatToResponsesStream, extractChatSseError } = require('./codex-chat-bridge')
const { ChatSsePump, postChatCompletions } = require('./chat-upstream')
// 提供方注册表：上游按「声明的协议端点」路由，不再硬编码在本文件里。
const providers = require('./providers')

// ========== 日志模块 ==========
const LOG_DIR = path.join(__dirname, 'logs')
const DATA_DIR = path.join(__dirname, 'data')

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (_) {}
}
ensureDir(LOG_DIR)
ensureDir(DATA_DIR)

function writeLog(level, message, extra) {
  const entry = { timestamp: new Date().toISOString(), level, service: 'ai-codex-http2-proxy', message, ...(extra || {}) }
  const line = JSON.stringify(entry) + '\n'
  const filename = level === 'error' ? 'codex-http2-proxy-error.log' : 'codex-http2-proxy-combined.log'
  fs.appendFile(path.join(LOG_DIR, filename), line, () => {})
  if (level === 'error' || level === 'warn') {
    console.error('[' + level.toUpperCase() + '] ' + message, Object.keys(extra || {}).length ? extra : '')
  }
}

// ========== 统计数据持久化 ==========
const STATS_FILE = path.join(DATA_DIR, 'codex-http2-stats.json')
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

// HTTP/2 转发时需要过滤的 hop-by-hop 头（模块级常量，只创建一次）
const H2_FORBIDDEN_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te'])
const OPENAI_META_HEADERS = new Set(['openai-organization', 'openai-project', 'openai-beta', 'x-api-key'])

// ========== Token 统计（兼容 Responses / Chat 两种流式与非流式 usage）==========
// Responses API usage 结构:
//   { input_tokens, output_tokens, input_tokens_details: { cached_tokens }, output_tokens_details: { reasoning_tokens } }
// Chat Completions usage 结构:
//   { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens }, completion_tokens_details: { reasoning_tokens } }
class TokenStats {
  constructor() {
    this.buffer = ''
    this.inputTokens = 0
    this.outputTokens = 0
    this.reasoningTokens = 0
    this.cachedTokens = 0
  }

  // 处理 SSE 流式数据块
  feed(chunk) {
    this.buffer += chunk.toString()
    const events = this.buffer.split('\n\n')
    this.buffer = events.pop()
    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue
        const trimmed = line.slice(5).trimStart()
        if (!trimmed || trimmed === '[DONE]') continue
        // 快速过滤：只有包含 "usage" 的事件才值得 JSON.parse
        // 流式中 99% 的 delta 事件不含 usage，跳过可省大量 CPU
        if (!trimmed.includes('"usage"')) continue
        try {
          const data = JSON.parse(trimmed)
          this._absorbUsage(this._pickUsage(data))
        } catch (_) {}
      }
    }
  }

  // 处理剩余缓冲区（非流式整块 JSON 响应）
  finalize(fullBody) {
    if (this.buffer.trim()) {
      try {
        const raw = this.buffer.trim().replace(/^data:\s*/, '')
        const data = JSON.parse(raw)
        this._absorbUsage(this._pickUsage(data))
      } catch (_) {}
      this.buffer = ''
    }
    if (fullBody) {
      try {
        const data = JSON.parse(fullBody)
        this._absorbUsage(this._pickUsage(data))
      } catch (_) {}
    }
  }

  _pickUsage(data) {
    if (!data) return null
    if (data.usage) return data.usage
    if (data.response && data.response.usage) return data.response.usage
    if (data.prompt_tokens !== undefined) return data
    return null
  }

  _absorbUsage(u) {
    if (!u) return
    // 注意：用 += 而不是 =，支持多轮循环跨轮累加 token
    if (u.input_tokens != null) this.inputTokens += u.input_tokens
    if (u.prompt_tokens != null) this.inputTokens += u.prompt_tokens
    if (u.output_tokens != null) this.outputTokens += u.output_tokens
    if (u.completion_tokens != null) this.outputTokens += u.completion_tokens
    if (u.output_tokens_details && u.output_tokens_details.reasoning_tokens != null) {
      this.reasoningTokens += u.output_tokens_details.reasoning_tokens
    }
    if (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens != null) {
      this.reasoningTokens += u.completion_tokens_details.reasoning_tokens
    }
    // 兼容两种格式的缓存 token：
    //   Chat Completions: prompt_tokens_details.cached_tokens
    //   Responses API:    input_tokens_details.cached_tokens
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
      || (u.input_tokens_details && u.input_tokens_details.cached_tokens)
      || u.cached_tokens
    if (cached != null) this.cachedTokens += cached
  }

  getUsage() {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cachedTokens: this.cachedTokens,
      totalTokens: this.inputTokens + this.outputTokens,
    }
  }
}

// ========== 请求日志记录 ==========
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
function recordRequestLog({ startTime, status, modelName, clientName, stats, upstreamStatusCode, routeName }) {
  const elapsed = (Date.now() - startTime) / 1000
  const usage = stats.getUsage ? stats.getUsage() : stats
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const displayName = padEndW(truncW(modelName || 'unknown', 18), 18)
  const displayClient = padEndW(truncW(clientName, 8), 8)
  const sec = (elapsed.toFixed(2) + 's').padStart(7)
  const fmt = (n) => padStartW(humanizeTokens(n), 13)
  const fmtOut = (n) => (Number(n) || 0).toLocaleString('en-US').padStart(8)

  if (status === 'ok') {
    const cachePct = usage.inputTokens > 0 ? (usage.cachedTokens / usage.inputTokens * 100).toFixed(2) : '0.00'
    const cachedStr = usage.cachedTokens > 0 ? ('(' + padStartW(cachePct, 7) + '%)') : padEndW('', 10)
    const tps = elapsed > 0 ? Math.round(usage.outputTokens / elapsed) : 0
    const tpsStr = (tps + ' t/s').padStart(8)
    console.log(`[${ts}] ${displayClient} -> ${displayName} | ${upstreamStatusCode || 200} ${tpsStr} ${sec} |     in:${fmt(usage.inputTokens)}  ${cachedStr}  out:${fmtOut(usage.outputTokens)}`)
  } else if (status === 'cancelled') {
    console.log(`[${ts}] ${displayClient} -> ${displayName} | ${padEndW('取消', 12)} ${sec}`)
  } else {
    console.log(`[${ts}] ${displayClient} -> ${displayName} | ${padEndW('失败', 12)} ${sec}`)
  }

  statsRecords.push({
    time: new Date().toISOString(),
    name: clientName,
    model: modelName,
    route: routeName,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedTokens: usage.cachedTokens,
    totalTokens: usage.totalTokens,
    elapsed,
    status,
  })
  if (statsRecords.length > 5000) statsRecords = statsRecords.slice(-5000)
  markStatsDirty()
}

// ========== 客户端 IP / 白名单 ==========
function getClientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for']
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket && req.socket.remoteAddress
  return String(ip || '').replace(/^::ffff:/, '')
}
function getClientName(req) { return getClientIp(req) }

// ========== 路由解析 ==========
// 客户端接入协议固定为 Responses（codex CLI 只会说这一种）。
// 上游在 config.providers 里声明自己有哪些协议端点，providers.js 比对后给出：
//   mode='direct'       上游原生支持 Responses → 字节透传
//   mode='chat_bridge'  上游只有 Chat Completions → 走 codex-chat-bridge 转换
//   mode='unsupported'  上游两种都没有（如 Kimi 只有 anthropic 端点）→ 明确报错
const CLIENT_PROTOCOL = 'openai_responses'
// 本服务有两种转发通道：http2 直连（原生 Responses 上游）与 http1 协议桥（只讲 Chat 的上游）。
const SERVER_TRANSPORTS = ['http2', 'http1']

function resolveRoute(modelName) {
  return providers.resolveRoute(modelName, CLIENT_PROTOCOL, SERVER_TRANSPORTS)
}

// 提供方级别的单并发队列与 Key 轮换游标。
// 按 name 归并：union / stealth / openrouter / opus 是同一上游（OpenRouter）的多个
// 匹配关键字，必须共享一个队列与一把 Key 游标，否则单并发保护会失效。
const serialQueues = new Map()
const keyIndexes = new Map()

function serialQueueFor(provider) {
  let queue = serialQueues.get(provider.name)
  if (!queue) {
    queue = new providers.SerialQueue()
    serialQueues.set(provider.name, queue)
  }
  return queue
}

function keyIndexFor(provider) {
  return keyIndexes.get(provider.name) || 0
}

// ========== 模型名与思考深度归一化 ==========
// 全部由提供方注册表字段驱动（forceModel / stripModelSuffix / effort），
// 这里不再出现任何厂商名判断。直接操作 JS 对象（原地修改），避免冗余 JSON.parse/stringify。

function normalizeModel(body, route) {
  if (!body || !route.provider) return body && body.model
  const before = body.model
  // 以 route.modelId 为准：它已包含 provider 解析 + models 表别名改写。
  const after = providers.normalizeRequest(route.provider, body, route.modelId || before)
  if (after !== before) {
    writeLog('info', `模型名归一化(${route.provider.name}): "${before}" -> "${after}"`)
  }
  return after
}

function normalizeEffort(body, route) {
  if (!body || !route.provider) return
  const changes = providers.normalizeEffort(route.provider, CLIENT_PROTOCOL, body)
  for (const change of changes) {
    writeLog('info', `思考深度映射(${route.provider.name}): ${change.from} -> ${change.to}`)
  }
}

// ========== MCP 扁平调用名兜底拆分（mcp__server__tool → namespace+name）==========
// codex 0.146+ 把 MCP 工具以 namespace 容器发给上游；实测 DeepSeek/MiniMax 原生支持该
// 容器，模型回程 function_call 自带 namespace 字段，代理无需改写。但若模型偶发按
// 扁平名 mcp__server__tool 发起调用（chat 协议没有 namespace 字段，第三方模型可能
// 这么做），codex 会报「unsupported call」路由失败 —— 这里按第一个 `__` 切开补回
// namespace 兜底（server 名含单下划线不受影响）。已是 namespace 格式则不匹配、原样放行。
function splitMcpCallName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name || ''))
  if (!m) return null
  return { namespace: 'mcp__' + m[1], name: m[2] }
}

// 就地改写 function_call item：命中 mcp__ 扁平名则补 namespace、name 换成内层名。
function rewriteMcpFunctionCallItem(item) {
  if (!item || item.type !== 'function_call') return false
  const split = splitMcpCallName(item.name)
  if (!split) return false
  item.namespace = split.namespace
  item.name = split.name
  return true
}

// SSE 下行流改写器：把事件 data JSON 里的 function_call item（含 response.completed
// 的 output 数组）中的 mcp__ 扁平名改写成 namespace+name。按 SSE 事件边界（空行）
// 缓冲，未命中 mcp__/function_call 的事件原样透传（零开销路径）。
function createSseMcpCallRewriter() {
  let buf = ''
  const rewriteEvent = (raw) => {
    if (!raw.includes('mcp__') || !raw.includes('function_call')) return raw
    const m = /^data: (.*)$/m.exec(raw)
    if (!m) return raw
    let j
    try { j = JSON.parse(m[1]) } catch { return raw }
    let changed = false
    if (j && j.item && typeof j.item === 'object') changed = rewriteMcpFunctionCallItem(j.item) || changed
    const output = j && j.response && Array.isArray(j.response.output) ? j.response.output : null
    if (output) for (const item of output) changed = rewriteMcpFunctionCallItem(item) || changed
    return changed ? raw.replace(m[1], JSON.stringify(j)) : raw
  }
  return {
    push(chunk, emit) {
      buf += chunk
      let idx
      // 事件边界：\n\n 或 \r\n\r\n
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const sep = /\r?\n\r?\n/.exec(buf.slice(idx))[0]
        const raw = buf.slice(0, idx + sep.length)
        buf = buf.slice(idx + sep.length)
        emit(rewriteEvent(raw))
      }
    },
    flush(emit) {
      if (buf) { emit(rewriteEvent(buf)); buf = '' }
    },
  }
}

// 读取完整请求体（回调式，不阻塞事件循环）
function readBodyCb(req, cb) {
  const chunks = []
  let aborted = false
  req.on('data', c => { if (!aborted) chunks.push(c) })
  req.on('end', () => cb(null, Buffer.concat(chunks)))
  req.on('error', err => { aborted = true; cb(err, null) })
  req.on('aborted', () => { aborted = true; cb(new Error('aborted'), null) })
}

// Codex CLI 可能发送的所有 responses 路径变体（参考 cc-switch 路由表）
const RESPONSES_PATHS = new Set([
  '/responses',
  '/v1/responses',
  '/codex/v1/responses',
])
const RESPONSES_COMPACT_PATHS = new Set([
  '/responses/compact',
  '/v1/responses/compact',
  '/codex/v1/responses/compact',
])

// Codex CLI 启动时会探测的模型清单（OpenAI GET /v1/models 标准格式）。
// 从注册表派生（providers.listModels），不硬编码 —— 见 providers.js 里 listModels 的注释。
function buildModelsResponse() {
  return JSON.stringify({
    object: 'list',
    data: providers.listModels(CLIENT_PROTOCOL, SERVER_TRANSPORTS),
  })
}

// ========== HTTP/2 Session 池（按 origin 复用持久连接）==========
const h2SessionPool = new Map()

function getH2Session(origin) {
  const existing = h2SessionPool.get(origin)
  if (existing && !existing.destroyed && !existing.closed) {
    return existing
  }
  const session = http2.connect(origin, { rejectUnauthorized: false })
  session.on('error', (err) => {
    writeLog('warn', '[H2Session] 连接错误: ' + err.message, { origin, code: err.code })
    h2SessionPool.delete(origin)
  })
  session.on('close', () => {
    if (h2SessionPool.get(origin) === session) {
      h2SessionPool.delete(origin)
    }
  })
  session.on('goaway', () => {
    if (h2SessionPool.get(origin) === session) {
      h2SessionPool.delete(origin)
    }
    try { session.destroy() } catch (_) {}
  })
  h2SessionPool.set(origin, session)
  return session
}

// ========== 单并发排队与 429 Key 轮换（提供方注册表驱动）==========
// 是否排队、冷却多久、用哪把 Key，全部读自提供方的 serialize / keyPools 声明，
// 本文件不再判断厂商名。同一上游的多个匹配关键字（union/stealth/openrouter）
// 按 provider.name 归并，共享一个队列与一把 Key 游标。

// ========== http2 转发核心 ==========
function forwardWithHttp2({ method, targetUrl, headers, body, modelName, req, res, route }) {
  const cooldown = providers.serializeCooldown(route.provider, CLIENT_PROTOCOL)
  if (cooldown > 0) {
    serialQueueFor(route.provider).run(cooldown, (done) => {
      let doneCalled = false
      const safeDone = () => {
        if (!doneCalled) {
          doneCalled = true
          done()
        }
      }
      res.once('finish', safeDone)
      res.once('close', safeDone)
      forwardWithHttp2Impl({ method, targetUrl, headers, body, modelName, req, res, route, retryCount: 0, onComplete: safeDone })
    }, depth => {
      writeLog('info', `[${route.provider.name} 排队] 上游正在生成，新请求进入队列排队 (队列深度: ${depth})`)
    })
  } else {
    forwardWithHttp2Impl({ method, targetUrl, headers, body, modelName, req, res, route, retryCount: 0 })
  }
}

function forwardWithHttp2Impl({ method, targetUrl, headers, body, modelName, req, res, route, retryCount = 0, onComplete, keyIndex }) {
  const startTime = Date.now()
  const clientName = getClientName(req)
  const stats = new TokenStats()
  let finished = false
  let upstreamStatusCode = 0
  const provider = route.provider
  const endpoint = route.endpoint
  const routeName = (provider && provider.name) || 'Unknown'
  const keyPool = providers.keyPoolFor(provider, CLIENT_PROTOCOL)
  const activeKeyIndex = keyIndex === undefined ? keyIndexFor(provider) : keyIndex
  let isRetrying = false

  function finish(status) {
    if (finished) return
    finished = true
    if (onComplete) onComplete()
    recordRequestLog({ startTime, status, modelName, clientName, stats, upstreamStatusCode, routeName })
  }

  const urlObj = new URL(targetUrl)
  const origin = urlObj.origin
  const h2Path = urlObj.pathname + (urlObj.search || '')
  const session = getH2Session(origin)

  const h2Headers = {
    ':method': method,
    ':path': h2Path,
    'content-type': 'application/json',
    'authorization': 'Bearer ' + (keyPool ? keyPool[activeKeyIndex % keyPool.length] : endpoint.apiKey),
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'host' || k === ':authority' || k === 'content-length') continue
    if (k === 'authorization') continue
    if (k.toLowerCase() === 'accept-encoding') continue
    if (H2_FORBIDDEN_HEADERS.has(k.toLowerCase())) continue
    if (OPENAI_META_HEADERS.has(k.toLowerCase())) continue
    h2Headers[k] = v
  }
  h2Headers['accept-encoding'] = 'identity'

  const h2Req = session.request(h2Headers)

  let cancelled = false
  // multi-agent 兼容：对直通响应注入 encrypted_function_args（按 content-type 选模式）
  // SSE 回程 mcp__ 调用改写器（命中 text/event-stream 时创建，见 on('response')）
  let sseRewriter = null
  let sseInjector = null
  req.on('aborted', () => {
    if (!finished && !cancelled) {
      cancelled = true
      try { h2Req.close(http2.constants.NGHTTP2_CANCEL) } catch (_) {}
      finish('cancelled')
    }
  })

  h2Req.on('response', h2resp => {
    upstreamStatusCode = h2resp[':status']
    const rotateKey = keyPool && upstreamStatusCode === 429
    if (keyPool && upstreamStatusCode >= 200 && upstreamStatusCode < 300) keyIndexes.set(provider.name, activeKeyIndex)
    if (rotateKey && retryCount + 1 < keyPool.length && !cancelled && !res.headersSent) {
      const nextKeyIndex = (activeKeyIndex + 1) % keyPool.length
      isRetrying = true
      writeLog('warn', `[${routeName} 429] 切换到 Key #${nextKeyIndex + 1}，尝试 ${retryCount + 2}/${keyPool.length}，等待 4 秒`)
      try { h2Req.close() } catch (_) {}
      setTimeout(() => {
        if (!cancelled && !res.headersSent && !res.destroyed) {
          forwardWithHttp2Impl({ method, targetUrl, headers, body, modelName, req, res, route, retryCount: retryCount + 1, onComplete, keyIndex: nextKeyIndex })
        } else {
          if (onComplete) onComplete()
        }
      }, 4000)
      return
    }
    const responseHeaders = {}
    for (const [k, v] of Object.entries(h2resp)) {
      if (k.startsWith(':')) continue
      // 跳过 content-length：转换后的 body 长度与上游不一致
      if (k.toLowerCase() === 'content-length') continue
      responseHeaders[k] = v
    }
    responseHeaders['access-control-allow-origin'] = '*'
    // multi-agent 兼容：按上游响应 content-type 建注入器（SSE 增量 / JSON 整体）
    const ct = String(h2resp['content-type'] || '').toLowerCase()
    if (ct.includes('text/event-stream')) {
      sseInjector = new SsePlaintextArgsInjector('sse')
      // SSE 流回程兜底：模型偶发按扁平名 mcp__server__tool 发起 function_call 时
      // 拆回 namespace+name，否则 codex 报「unsupported call」（见 createSseMcpCallRewriter）。
      sseRewriter = createSseMcpCallRewriter()
    } else if (ct.includes('application/json')) {
      sseInjector = new SsePlaintextArgsInjector('json')
    }
    try {
      res.writeHead(upstreamStatusCode, responseHeaders)
      res.flushHeaders && res.flushHeaders()
    } catch (err) {
      writeLog('warn', 'writeHead 失败: ' + err.message, { status: upstreamStatusCode })
      try { h2Req.close() } catch (_) {}
      finish('error')
    }
  })

  h2Req.on('data', chunk => {
    if (isRetrying) return
    stats.feed(chunk)
    // MiniMax Responses 直通：纯透传不累积 body，避免 O(n²) Buffer.concat。
    // 两级串联：mcp__ 回程改写（SSE 事件边界缓冲）→ multi-agent 注入器。
    const feedInjector = (data) => {
      if (!sseInjector) {
        try { res.write(data) } catch (_) {}
        return
      }
      try {
        const out = sseInjector.feed(data)
        if (out && out.length) res.write(out)
      } catch (_) {
        // 注入失败回退写原数据，绝不丢数据
        try { res.write(data) } catch (_) {}
      }
    }
    if (sseRewriter) {
      sseRewriter.push(String(chunk), feedInjector)
      return
    }
    feedInjector(chunk)
  })

  h2Req.on('end', () => {
    if (isRetrying) return
    try {
      if (sseRewriter) {
        // 残尾先过注入器保持串联语义
        sseRewriter.flush((data) => {
          if (sseInjector) {
            try {
              const out = sseInjector.feed(data)
              if (out && out.length) res.write(out)
              return
            } catch (_) { /* 注入失败回退写原数据 */ }
          }
          try { res.write(data) } catch (_) {}
        })
      }
      if (sseInjector) {
        const tail = sseInjector.end()
        if (tail && tail.length) res.write(tail)
        if (sseInjector.patchedCount > 0) {
          writeLog('info', '[' + routeName + '] multi-agent 兼容: 注入 encrypted_function_args x' + sseInjector.patchedCount)
        }
      }
      res.end()
    } catch (_) {}
    finish('ok')
  })

  h2Req.on('error', err => {
    if (isRetrying) return
    if (!res.headersSent) {
      try {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
      } catch (_) {}
    } else {
      try { res.destroy() } catch (_) {}
    }
    finish('error')
  })

  h2Req.on('frameError', (type, code) => {
    writeLog('warn', '[' + routeName + '] h2 frameError: type=' + type + ' code=' + code)
  })

  if (body && body.length > 0) h2Req.write(body)
  h2Req.end()
}

// ========== Chat Completions 上游转发（协议桥路径）==========
//
// 上游（WorkBuddy2API）只提供 OpenAI Chat Completions，而 codex 只说 Responses：
// 请求经 codex-chat-bridge 降级成 Chat，响应再升回 Responses SSE。
//
// 与 Responses 直通路径的区别：不能原样透传字节，必须整条流经转换器，
// 所以这里累积 Chat 事件而不是直接 res.write(chunk)。

function forwardToChatUpstream({ route, bodyForLog, modelName, req, res }) {
  const startTime = Date.now()
  const clientName = getClientName(req)
  const stats = new TokenStats()
  let finished = false
  let upstreamStatusCode = 0
  const routeName = route.provider.name
  const endpoint = route.endpoint
  const displayModel = modelName

  function finish(status) {
    if (finished) return
    finished = true
    recordRequestLog({ startTime, status, modelName: displayModel, clientName, stats, upstreamStatusCode, routeName })
  }

  let converted
  let toolContext
  try {
    const out = responsesToChatCompletions(bodyForLog)
    converted = out.body
    toolContext = out.toolContext
    // 提供方声明的 Chat 专属字段（如 MiniMax 的 reasoning_split）
    providers.applyChatExtras(route.provider, converted)
    // 提供方声明的会话粘性键映射（客户端只发 HTTP 头、上游只读请求体的场景）
    providers.applySessionSticky(route.provider, converted, req.headers)
  } catch (err) {
    writeLog('error', '[' + routeName + '] 请求转换失败: ' + err.message)
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({ error: 'Transform Error', message: err.message }))
    finish('error')
    return
  }

  const isStream = converted.stream !== false
  const payload = Buffer.from(JSON.stringify(converted))

  // 非流式：响应是整块 JSON 而非 SSE，不能过 SSE 泵，直接累积原始字节后整体转换。
  const jsonChunks = []
  const streamConverter = new ChatToResponsesStream(toolContext)
  const ssePump = isStream
    ? new ChatSsePump({
        onChunk: chunk => {
          const [message, errorType] = extractChatSseError(chunk)
          if (message && (chunk.error !== undefined || chunk.type === 'error')) {
            // 上游在流中途报错：如实转成 response.failed，别让 codex 收到空回合并静默收尾。
            try {
              for (const event of streamConverter.failedEvent(message, errorType || 'upstream_error')) res.write(event)
            } catch (err) {
              writeLog('error', '[' + routeName + '] 错误事件转换失败: ' + err.message)
            }
            return
          }
          try {
            for (const event of streamConverter.handleChatChunk(chunk)) res.write(event)
          } catch (err) {
            writeLog('error', '[' + routeName + '] 流式转换失败: ' + err.message)
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
    headers: { 'x-conversation-id': String(req.headers['x-conversation-id'] || '') },
    handlers: {
      onResponse: (status, headers) => {
        upstreamStatusCode = status
        const responseHeaders = { 'access-control-allow-origin': '*' }
        // 透传上游 content-type 会把 Chat 的 JSON/SSE 类型带给 codex（它要 Responses SSE），
        // 因此统一改写；错误响应保持 JSON 以便 codex 解析报错正文。
        if (status >= 200 && status < 300) {
          // 非流式请求必须回普通 JSON Response；只有流式才是 SSE 帧。
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
          writeLog('warn', '[' + routeName + '] writeHead 失败: ' + err.message)
          try { upstreamReq.destroy() } catch (_) {}
          finish('error')
        }
      },
      onData: chunk => {
        stats.feed(chunk)
        if (upstreamStatusCode < 200 || upstreamStatusCode >= 300) return
        if (ssePump) ssePump.push(chunk)
        else jsonChunks.push(chunk)
      },
      onEnd: () => {
        if (upstreamStatusCode >= 200 && upstreamStatusCode < 300) {
          try {
            if (ssePump) {
              ssePump.flush()
              for (const event of streamConverter.finish()) res.write(event)
            } else {
              const raw = Buffer.concat(jsonChunks).toString()
              stats.finalize(raw)
              const response = chatCompletionToResponse(JSON.parse(raw), toolContext)
              // 非流式回整块 JSON Response（不是 SSE 帧）。
              res.end(JSON.stringify(response))
              finish('ok')
              return
            }
          } catch (err) {
            writeLog('error', '[' + routeName + '] 响应转换失败: ' + err.message)
            if (ssePump) {
              for (const event of streamConverter.failedEvent('Upstream response could not be converted: ' + err.message, 'upstream_transform_failed')) res.write(event)
            } else if (!res.headersSent) {
              try {
                res.writeHead(502, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
              } catch (_) {}
            }
          }
        }
        try { res.end() } catch (_) {}
        finish('ok')
      },
      onError: err => {
        writeLog('error', '[' + routeName + '] chat 上游错误: ' + err.message, { code: err.code })
        if (!responseStarted && !res.headersSent) {
          try {
            res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
            res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }))
          } catch (_) {}
        } else {
          // 已发响应头：客户端不知道出错，必须断链，否则 codex 一直等
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

// ========== 主请求处理 ==========
function handleRequest(req, res) {
  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, OpenAI-Organization, OpenAI-Project, OpenAI-Beta, x-api-key',
    })
    res.end()
    return
  }

  if (req.method === 'HEAD') {
    res.writeHead(200)
    res.end()
    return
  }


  const [pathOnly, queryStr] = req.url.split('?')

  // GET /health —— 健康检查端点
  if (req.method === 'GET' && pathOnly === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'codex-server' }))
    return
  }

  // GET /v1/models 或 /models —— Codex CLI 启动时探测可用模型
  if (req.method === 'GET' && (pathOnly === '/v1/models' || pathOnly === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(buildModelsResponse())
    return
  }

  // 只接受 POST
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    return
  }

  // 多路径路由（参考 cc-switch 路由表风格）
  const isResponses = RESPONSES_PATHS.has(pathOnly)
  const isCompact = RESPONSES_COMPACT_PATHS.has(pathOnly)
  if (!isResponses && !isCompact) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      error: 'Not Found',
      message: 'Codex 代理不支持该路径: ' + req.url,
    }))
    return
  }

  readBodyCb(req, (err, bodyBuffer) => {
    if (err) {
      writeLog('error', '读取请求体失败: ' + err.message, { code: err.code })
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }))
      } else {
        res.end()
      }
      return
    }

    // 解析原始 body 用于路由决策
    let originalBody = null
    try { originalBody = JSON.parse(bodyBuffer.toString()) } catch (_) {}
    const modelName = (originalBody && originalBody.model) || 'unknown'

    // 1) 路由选择：按上游声明的协议端点决定直连还是转换
    const route = resolveRoute(modelName)
    if (route.mode === 'unsupported') {
      writeLog('warn', `路由失败: ${route.reason}`, { model: modelName })
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unsupported protocol', message: route.reason }))
      return
    }

    // 2) 模型名与思考深度归一化（原地修改 originalBody，全部由注册表字段驱动）
    let upstreamModelName = normalizeModel(originalBody, route) || modelName
    normalizeEffort(originalBody, route)
    // 直接使用 originalBody 作为后续步骤的数据源（不再重复解析）
    const bodyForLog = originalBody

    // multi-agent 兼容：把历史里被误标为 encrypted_content 的明文块还原为文本块
    // （codex 子代理协作消息在无 encrypted_function_args 标记时会把 prompt 包成 encrypted_content，
    //   DeepSeek 不认该块 → 子代理盲；还原后所有上游都能正常读到任务正文）
    const restoredBlocks = sanitizeEncryptedContentInInput(bodyForLog)
    if (restoredBlocks > 0) {
      writeLog('info', 'multi-agent 兼容: 还原 encrypted_content 明文块 x' + restoredBlocks)
    }

    // multi-agent 兼容：把 agent_message 输入项降级为普通 message 项
    // （codex 以 {"type":"agent_message"} 下发子代理任务/回报，DeepSeek/MiniMax 等第三方
    //  Responses 上游会静默丢弃整项 → 子代理收不到任务正文、主线程收不到子代理回报）
    const downgradedItems = downgradeAgentMessageItems(bodyForLog)
    if (downgradedItems > 0) {
      writeLog('info', 'multi-agent 兼容: agent_message 降级为 message x' + downgradedItems)
    }

    // multi-agent 聚合兜底：input 尾部是 collab 工具 function_call_output 时，
    // 追加聚合提示防止主线程模型跳过子代理结果（自定义提供方模型不主动 wait/聚合）
    const aggHints = injectSubagentAggregationHint(bodyForLog)
    if (aggHints > 0) {
      writeLog('info', 'multi-agent 聚合: 注入子代理结果聚合提示 x' + aggHints)
    }

    // 3) 日志
    const routeTag = isCompact ? 'compact' : 'responses'
    writeLog('info', `路由: ${upstreamModelName} -> ${route.provider.name} [${providers.modeLabel(route.mode)}/${routeTag}]`, {
      ip: getClientIp(req),
      name: getClientName(req),
      reason: route.reason,
    })

    // 4) 转发
    if (route.mode === 'chat_bridge') {
      forwardToChatUpstream({
        route,
        bodyForLog,
        modelName: upstreamModelName,
        req, res,
      })
      return
    }
    const upstreamBuffer = Buffer.from(JSON.stringify(bodyForLog))
    const targetUrl = providers.buildTargetUrl(route.endpoint, CLIENT_PROTOCOL, queryStr)
    forwardWithHttp2({
      method: 'POST',
      targetUrl,
      headers: req.headers,
      body: upstreamBuffer,
      modelName: upstreamModelName,
      req, res, route,
    })
  })
}

// ========== 启动服务 ==========
const PORT = process.env.CODEX_PORT_OVERRIDE
  ? Number(process.env.CODEX_PORT_OVERRIDE)
  : ((config.ports && config.ports.codex) || 3722)

const server = http.createServer(handleRequest)
server.on('connection', socket => socket.setNoDelay(true))

server.on('clientError', (err, socket) => {
  const quiet = err.code === 'ECONNRESET' || err.code === 'ERR_HTTP_REQUEST_TIMEOUT'
  writeLog(quiet ? 'info' : 'error', '客户端请求异常: ' + err.message, { code: err.code })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
})

process.on('uncaughtException', (err, origin) => {
  writeLog('error', '未捕获异常(' + origin + '): ' + err.message, { name: err.name, code: err.code, stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason))
  writeLog('error', '未处理的 Promise Rejection: ' + err.message, { name: err.name, code: err.code, stack: err.stack })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('\n[错误] 端口 ' + PORT + ' 已被占用：可能已有一个代理实例在运行。')
    console.error('       先停止旧实例（taskkill /FI "IMAGENAME eq node.exe" 或关闭旧的启动窗口）再重试。\n')
    writeLog('error', '启动失败: 端口 ' + PORT + ' 已被占用 (EADDRINUSE)')
  } else {
    console.error('\n[错误] 服务启动失败: ' + err.message + '\n')
    writeLog('error', '服务启动失败: ' + err.message, { code: err.code })
  }
  process.exit(1)
})

server.listen(PORT, () => {
  console.log('\n🤖 Codex 多路由代理已启动 (port=' + PORT + ')\n')
  writeLog('info', 'Codex 多路由代理已启动', { port: PORT, routes: Object.keys(providers.PROVIDERS) })
})
