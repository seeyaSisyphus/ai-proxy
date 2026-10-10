// chat-upstream.js — 走 OpenAI Chat Completions 的上游转发（HTTP/1.1 + SSE 泵）。
//
// workbuddy2api 是 Go net/http 服务，只支持 HTTP/1.1：实测 http2.connect('http://127.0.0.1:7863')
// 直接 ERR_HTTP2_ERROR Protocol error（h2c 未实现），所以这里单独维护 keep-alive agent，
// 不能复用其它路由的 http2 session 池。

'use strict'

const http = require('http')
const https = require('https')
const { SseBuffer, stripSseField } = require('./chat-bridge-common')

// 上游 Chat Completions 端点。
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions'

const agents = new Map()

function agentFor(urlObj) {
  const key = urlObj.protocol + '//' + urlObj.host
  let agent = agents.get(key)
  if (!agent) {
    const Ctor = urlObj.protocol === 'https:' ? https.Agent : http.Agent
    agent = new Ctor({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30000 })
    agents.set(key, agent)
  }
  return agent
}

// 上游 Chat SSE 字节流 -> 逐块事件。
//
// 按 SSE 事件边界切块（\r\n\r\n 与 \n\n 取更早者），`data:` 行解析后交给 onChunk；
// `[DONE]` 交给 onDone；心跳、注释行与坏 JSON 静默跳过 —— 上游噪声不该中断整条流。
class ChatSsePump {
  constructor(handlers) {
    this.handlers = handlers || {}
    this.buffer = new SseBuffer()
    this.sawDone = false
  }

  push(chunkBuf) {
    this.buffer.push(chunkBuf)
    let block
    while ((block = this.buffer.next()) !== null) this.dispatch(block)
  }

  dispatch(block) {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      const data = stripSseField(line, 'data')
      if (data === null) continue
      const payload = data.trim()
      if (!payload) continue
      if (payload === '[DONE]') {
        this.sawDone = true
        if (this.handlers.onDone) this.handlers.onDone()
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(payload)
      } catch (_) {
        continue
      }
      if (this.handlers.onChunk) this.handlers.onChunk(parsed)
    }
  }

  // 流结束：冲刷未以空行收尾的残块（上游异常收尾时的容错）。
  flush() {
    const rest = this.buffer.flush()
    if (rest) this.dispatch(rest)
  }
}

// 发起一次 Chat Completions 请求。
//
// handlers:
//   onResponse(status, headers) 上游响应头到达（此后才会走 onData）
//   onData(chunk)               响应体分片（Buffer）
//   onEnd()                     响应体结束
//   onError(err)                传输层错误
//
// 返回底层 ClientRequest（调用方可 close() 中止）。
function postChatCompletions({ baseUrl, apiKey, payload, headers, path, handlers }) {
  const urlObj = new URL(String(baseUrl || '').replace(/\/+$/, '') + (path || CHAT_COMPLETIONS_PATH))
  const requestHeaders = Object.assign({}, headers, {
    'content-type': 'application/json',
    'content-length': payload.length,
    // 不请求压缩：代理不解压，压缩流也会破坏 stats 的逐块 JSON 解析。
    'accept-encoding': 'identity',
  })
  if (apiKey) requestHeaders.authorization = 'Bearer ' + apiKey

  const transport = urlObj.protocol === 'https:' ? https : http
  const req = transport.request(
    {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: requestHeaders,
      agent: agentFor(urlObj),
    },
    upstreamRes => {
      handlers.onResponse(upstreamRes.statusCode, upstreamRes.headers)
      upstreamRes.on('data', chunk => handlers.onData(chunk))
      upstreamRes.on('end', () => handlers.onEnd())
      upstreamRes.on('error', err => handlers.onError(err))
    }
  )

  req.on('error', err => handlers.onError(err))
  req.end(payload)
  return req
}

module.exports = {
  CHAT_COMPLETIONS_PATH,
  ChatSsePump,
  postChatCompletions,
}
