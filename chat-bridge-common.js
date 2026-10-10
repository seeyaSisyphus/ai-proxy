// chat-bridge-common.js — OpenAI Chat Completions 协议桥的共享原语。
//
// 供两个方向模块复用：
//   - codex-chat-bridge.js     OpenAI Responses  <-> OpenAI Chat Completions
//   - anthropic-chat-bridge.js Anthropic Messages <-> OpenAI Chat Completions
//
// 移植自 cc-switch（src-tauri/src/proxy）中经过生产验证的转换语义：
//   - json_canonical.rs      规范化 JSON（键排序、无空白），保证跨轮请求字节稳定 -> 前缀缓存命中
//   - codex_chat_common.rs   reasoning 字段穷举提取、<think> 内联块拆分
//   - sse.rs                 SSE 帧切分与 UTF-8 边界安全拼接
//   - tool_media.rs          工具输出里的媒体抽取（Chat 的 tool 消息只能带文本）

'use strict'

const crypto = require('crypto')
const { StringDecoder } = require('string_decoder')

// ========== 规范化 JSON ==========
// 键排序 + 紧凑输出。用于工具调用 arguments、工具输出内容等对缓存敏感的字段：
// 同一语义的对象必须序列化成同一串字节，否则上游前缀缓存每轮都会 miss。

function canonicalJsonString(value) {
  if (value === null || value === undefined) return 'null'
  const t = typeof value
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonString).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJsonString(value[k])).join(',') + '}'
  }
  return 'null'
}

// 可解析则规范化，否则原样返回（纯文本工具输出不做任何改动）。
function canonicalizeJsonStringIfParseable(text) {
  const trimmed = String(text).trim()
  if (!trimmed) return text
  try {
    return canonicalJsonString(JSON.parse(trimmed))
  } catch (_) {
    return text
  }
}

// 工具调用 arguments 串规范化：空串强制成 "{}"。
// 无参工具调用若发 `arguments: ""`，严格上游（MiniMax 等）会 400。
function canonicalizeToolArgumentsStr(text) {
  if (text === undefined || text === null) return '{}'
  if (!String(text).trim()) return '{}'
  return canonicalizeJsonStringIfParseable(String(text))
}

// 工具调用 arguments 字段规范化：字符串 / 结构化值 / 缺失三种形态。
function canonicalizeToolArguments(value) {
  if (value === undefined || value === null) return '{}'
  if (typeof value === 'string') return canonicalizeToolArgumentsStr(value)
  return canonicalJsonString(value)
}

// 前 8 字节 SHA-256（16 个十六进制字符）。用于超长工具名折叠。
function shortSha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16)
}

// ========== SSE 帧切分 ==========

// 取出缓冲里最早的一个 SSE 事件块（不含分隔符）。\r\n\r\n 与 \n\n 取更早者。
function takeSseBlock(state) {
  const buf = state.buffer
  const crlf = buf.indexOf('\r\n\r\n')
  const lf = buf.indexOf('\n\n')
  let pos = -1
  let len = 0
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    pos = crlf
    len = 4
  } else if (lf >= 0) {
    pos = lf
    len = 2
  }
  if (pos < 0) return null
  const block = buf.slice(0, pos)
  state.buffer = buf.slice(pos + len)
  return block
}

// `data: x` / `data:x` 两种写法都接受。
function stripSseField(line, field) {
  const withSpace = field + ': '
  if (line.startsWith(withSpace)) return line.slice(withSpace.length)
  const bare = field + ':'
  if (line.startsWith(bare)) return line.slice(bare.length)
  return null
}

// UTF-8 边界安全的 SSE 文本缓冲：上游可能把多字节字符切在 chunk 边界上。
class SseBuffer {
  constructor() {
    this.buffer = ''
    this.decoder = new StringDecoder('utf8')
  }

  push(chunkBuf) {
    this.buffer += typeof chunkBuf === 'string' ? chunkBuf : this.decoder.write(chunkBuf)
  }

  // 取下一个事件块；无完整块返回 null。
  next() {
    return takeSseBlock(this)
  }

  // 冲刷残留（上游未按空行收尾时的容错）。
  flush() {
    const rest = this.buffer
    this.buffer = ''
    return rest
  }
}

// 标准 `event:` / `data:` 帧。
function sseEvent(name, data) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'
}

// ========== reasoning 字段提取 ==========
// 穷举上游可能的回传位置，优先级：
//   reasoning_content > reasoning(字符串) > reasoning.{content,text,summary} > reasoning_details
// 上游实测同时下发 `reasoning` 与 `reasoning_content`（同值），取前者即可。

function extractReasoningFieldText(value) {
  if (!value || typeof value !== 'object') return null
  for (const key of ['reasoning_content', 'reasoning']) {
    const text = value[key]
    if (typeof text === 'string' && text) return text
  }
  const reasoning = value.reasoning
  if (reasoning && typeof reasoning === 'object') {
    for (const key of ['content', 'text', 'summary']) {
      const text = reasoning[key]
      if (typeof text === 'string' && text) return text
    }
  }
  if (value.reasoning_details !== undefined) {
    const text = extractReasoningDetailsText(value.reasoning_details)
    if (text) return text
  }
  return null
}

function extractReasoningDetailsText(value) {
  if (typeof value === 'string') return value || null
  if (Array.isArray(value)) {
    const text = value.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n')
    return text || null
  }
  if (value && typeof value === 'object') return extractReasoningDetailPartText(value)
  return null
}

function extractReasoningDetailPartText(value) {
  if (!value || typeof value !== 'object') return null
  for (const key of ['text', 'content', 'summary']) {
    const text = value[key]
    if (typeof text === 'string' && text) return text
  }
  if (Array.isArray(value.parts)) {
    const text = value.parts.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n')
    return text || null
  }
  return null
}

// Responses 侧 `reasoning` 项的 summary 文本提取。
function extractReasoningSummaryText(value) {
  if (!value || typeof value !== 'object') return null
  for (const key of ['reasoning_content', 'content', 'text']) {
    const text = value[key]
    if (typeof text === 'string' && text) return text
  }
  const summary = value.summary
  if (summary === undefined || summary === null) return null
  if (typeof summary === 'string') return summary || null
  if (!Array.isArray(summary)) return null
  const text = summary
    .map(part => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      return part.text || part.content || ''
    })
    .filter(Boolean)
    .join('\n\n')
  return text || null
}

// 追加式写入 chat assistant 消息的 `reasoning_content`（多段用空行分隔）。
function appendReasoningContent(message, reasoning) {
  const text = String(reasoning || '').trim()
  if (!text) return false
  const existing = message.reasoning_content
  if (typeof existing === 'string' && existing) message.reasoning_content = existing + '\n\n' + text
  else message.reasoning_content = text
  return true
}

// ========== <think> 内联思考块 ==========
// 部分上游（MiniMax 等）把思考写进正文，用 <think>…</think> 包裹。
// Responses/Anthropic 侧必须把它拆成独立的 reasoning 项，且标签不得泄漏给客户端。

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

// 返回 [reasoning, answer]；不以 <think> 开头或缺闭合标签时返回 null。
function splitLeadingThinkBlock(text) {
  const afterWs = text.replace(/^\s+/, '')
  const leadingWsLen = text.length - afterWs.length
  if (!afterWs.startsWith(THINK_OPEN_TAG)) return null
  const bodyStart = leadingWsLen + THINK_OPEN_TAG.length
  const closeRelative = text.indexOf(THINK_CLOSE_TAG, bodyStart)
  if (closeRelative < 0) return null
  const reasoning = text.slice(bodyStart, closeRelative).trim()
  const answer = text.slice(closeRelative + THINK_CLOSE_TAG.length).replace(/^[\r\n\t ]+/, '')
  return [reasoning, answer]
}

// 只有开标签、还没有闭合标签时的降级：剥掉开标签，余下全部当思考。
function stripLeadingThinkOpenTag(text) {
  const afterWs = text.replace(/^\s+/, '')
  if (!afterWs.startsWith(THINK_OPEN_TAG)) return null
  return afterWs.slice(THINK_OPEN_TAG.length).trim()
}

// 流式前缀判定：缓冲还不足以判断时返回 'need_more'，避免误判导致正文碎片化。
function leadingThinkPrefixDecision(buffer) {
  const trimmed = buffer.replace(/^\s+/, '')
  if (!trimmed) return 'need_more'
  if (trimmed.startsWith(THINK_OPEN_TAG)) return 'reasoning'
  if (THINK_OPEN_TAG.startsWith(trimmed)) return 'need_more'
  return 'text'
}

// ========== usage 映射（Chat -> Responses）==========
// 上游把缓存命中同时放在 prompt_tokens_details.cached_tokens 与
// prompt_cache_hit_tokens（DeepSeek 文档字段），两者都兜。

function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    }
  }

  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const inputTokens = num(usage.prompt_tokens) || num(usage.input_tokens)
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens)
  const totalTokens = usage.total_tokens !== undefined ? num(usage.total_tokens) : inputTokens + outputTokens

  // 上游可能同时下发 `cache_read_input_tokens: 0`（占位）与
  // `prompt_tokens_details.cached_tokens: 640`（真实命中）。0 是「无值」而非
  // 「有值为 0」，必须继续往下兜，否则缓存恒记 0。
  const cached =
    num(usage.cache_read_input_tokens) ||
    (usage.prompt_tokens_details ? num(usage.prompt_tokens_details.cached_tokens) : 0) ||
    (usage.input_tokens_details ? num(usage.input_tokens_details.cached_tokens) : 0) ||
    num(usage.prompt_cache_hit_tokens)

  const cacheWrite =
    (usage.prompt_tokens_details ? num(usage.prompt_tokens_details.cache_write_tokens) : 0) ||
    (usage.input_tokens_details ? num(usage.input_tokens_details.cache_write_tokens) : 0) ||
    num(usage.cache_creation_input_tokens)

  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  }

  if (cached > 0 || cacheWrite > 0) {
    result.input_tokens_details = { cached_tokens: cached, cache_write_tokens: cacheWrite }
  } else {
    result.input_tokens_details = { cached_tokens: 0 }
  }

  const details = usage.completion_tokens_details
  if (details && typeof details === 'object') {
    result.output_tokens_details = details.reasoning_tokens === undefined ? { ...details, reasoning_tokens: 0 } : { ...details }
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 }
  }

  if (cached > 0) result.cache_read_input_tokens = cached
  if (cacheWrite > 0) result.cache_creation_input_tokens = cacheWrite

  return result
}

function responseIdFromChatId(id) {
  const raw = id || 'aiproxy'
  return raw.startsWith('resp_') ? raw : 'resp_' + raw
}

function responseStatusFromFinishReason(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed'
}

// ========== 模型族判定 ==========

// OpenAI o-series（o1/o3/o4-mini…）要求 max_completion_tokens 而非 max_tokens。
function isOpenAiOSeries(model) {
  const m = String(model || '')
  return m.length > 1 && m[0] === 'o' && m[1] >= '0' && m[1] <= '9'
}

// ========== 工具名折叠 ==========
// Responses 的 namespace 容器工具在 Chat 协议里没有对应概念，折叠成
// `{namespace}__{name}`；超过 64 字节时用哈希后缀截断（OpenAI 工具名上限 64）。

const CHAT_TOOL_NAME_MAX_LEN = 64

function flattenNamespaceToolName(namespace, name) {
  const full = namespace + '__' + name
  if (full.length <= CHAT_TOOL_NAME_MAX_LEN) return full
  const suffix = '__' + shortSha256Hex(full)
  const prefixLen = CHAT_TOOL_NAME_MAX_LEN - suffix.length
  let prefix = ''
  for (const ch of full) {
    if (prefix.length + ch.length > prefixLen) break
    prefix += ch
  }
  return prefix + suffix
}

// Chat 严格校验 parameters 必须是 object；Responses 工具可能给 null 或缺 type。
function normalizeFunctionParameters(params) {
  const out = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {}
  if (out.type !== 'object') out.type = 'object'
  if (!out.properties) out.properties = {}
  return out
}

// ========== 工具调用明文标记 ==========
// codex 的 collab 工具路由（core/src/tools/router.rs direct_source）只在 function_call 项
// 同时带 namespace:"collaboration" 与 encrypted_function_args:[] 时，才把
// spawn_agent / send_message / followup_task 的 message 走明文通道投递给子代理。
// 缺字段则走加密包装 -> 子代理只看到空载荷。上游返回的本来就是明文 arguments，
// 这两个标记只是「如实声明」；对非 collab 工具调用惰性无害。
const COLLAB_NAMESPACE = 'collaboration'
const COLLAB_PLAINTEXT_TOOLS = new Set(['spawn_agent', 'send_message', 'followup_task'])

function markFunctionCallArgsPlaintext(item) {
  if (!item || item.type !== 'function_call') return
  if (item.encrypted_function_args === undefined) item.encrypted_function_args = []
  if (COLLAB_PLAINTEXT_TOOLS.has(item.name) && item.namespace === undefined) {
    item.namespace = COLLAB_NAMESPACE
  }
}

// ========== 工具输出媒体抽取 ==========
// Chat 的 tool 消息只能承载文本，媒体块必须摘出来放进紧随其后的合成 user 消息。
// 否则上游要么丢图，要么把 base64 当正文吃进上下文。

const TOOL_RESULT_MEDIA_MOVED_MARKER = '[ai-proxy: tool result media moved to the following user message]'
const WHOLE_DATA_URL_MIN_BYTES = 8 * 1024
const MAX_MEDIA_TRAVERSAL_DEPTH = 32

function isImageMimeType(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
}

function isImageBase64DataUrl(text) {
  const m = /^data:([^;,]+);base64,/i.exec(text)
  return !!m && isImageMimeType(m[1])
}

// 只认「整串就是一个图片 data URL」，避免把 HTML/CSS 里内嵌的 data URL 也当图片。
function wholeStringImageDataUrl(value) {
  const trimmed = String(value).trim()
  if (trimmed.length < WHOLE_DATA_URL_MIN_BYTES) return null
  if (!isImageBase64DataUrl(trimmed)) return null
  return { type: 'image_url', image_url: { url: trimmed } }
}

function normalizeImageUrlPart(part) {
  const imageUrl = part.image_url
  let normalized
  if (typeof imageUrl === 'string') {
    if (!imageUrl.trim()) return null
    normalized = { url: imageUrl }
  } else if (imageUrl && typeof imageUrl === 'object') {
    if (typeof imageUrl.url !== 'string' || !imageUrl.url.trim()) return null
    normalized = { ...imageUrl }
  } else {
    return null
  }
  if (normalized.detail === undefined && part.detail !== undefined) normalized.detail = part.detail
  // Chat 兼容网关只接受 auto / low / high；Codex 会按模型目录下发 original，严格上游会 400。
  if (normalized.detail === 'original') normalized.detail = 'auto'
  return { type: 'image_url', image_url: normalized }
}

// Anthropic 风格 `{type:'image', source:{...}}` -> Chat image_url part。
function typedImagePart(part) {
  const source = part.source
  if (!source || typeof source !== 'object') return null
  const mime = source.media_type || source.mime_type || source.mimeType
  if (mime && !isImageMimeType(mime)) return null
  if (typeof source.url === 'string' && source.url.trim()) {
    const imageUrl = { url: source.url }
    if (part.detail !== undefined) imageUrl.detail = part.detail
    if (imageUrl.detail === 'original') imageUrl.detail = 'auto'
    return { type: 'image_url', image_url: imageUrl }
  }
  if (typeof source.data === 'string' && source.data) {
    const mediaType = mime || 'image/png'
    const imageUrl = { url: 'data:' + mediaType + ';base64,' + source.data }
    if (part.detail !== undefined) imageUrl.detail = part.detail
    if (imageUrl.detail === 'original') imageUrl.detail = 'auto'
    return { type: 'image_url', image_url: imageUrl }
  }
  return null
}

function chatFilePart(part) {
  const hasRef = part.file_id !== undefined || part.file_data !== undefined
  if (!hasRef) return null
  const file = {}
  for (const key of ['file_id', 'file_data', 'filename']) {
    if (part[key] !== undefined) file[key] = part[key]
  }
  return { type: 'file', file }
}

// 识别一个工具输出内容块是否为可搬运的媒体。
function mediaPartFromToolPart(part) {
  if (!part || typeof part !== 'object') return null
  const type = part.type
  if ((type === 'input_image' || type === 'image_url') && (part.image_url !== undefined)) {
    return normalizeImageUrlPart(part)
  }
  if (type === 'input_file') return chatFilePart(part)
  if (type === 'input_audio' && part.input_audio && typeof part.input_audio === 'object') {
    return { type: 'input_audio', input_audio: part.input_audio }
  }
  if (type === 'image' && (part.source !== undefined)) return typedImagePart(part)
  if (type === undefined && part.image_url !== undefined) {
    const normalized = normalizeImageUrlPart(part)
    if (!normalized) return null
    const url = normalized.image_url.url
    return url.slice(0, 5).toLowerCase() === 'data:' ? normalized : null
  }
  return null
}

// 就地摘除工具输出里的媒体块，替换为标记文本；返回摘除的块数。
function stripAndClampMedia(value, mediaParts, depth) {
  if (depth > MAX_MEDIA_TRAVERSAL_DEPTH) return 0
  let replaced = 0

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const media = mediaPartFromToolPart(value[i])
      if (media) {
        mediaParts.push(media)
        value[i] = { type: 'text', text: TOOL_RESULT_MEDIA_MOVED_MARKER }
        replaced++
        continue
      }
      replaced += stripAndClampMedia(value[i], mediaParts, depth + 1)
    }
    return replaced
  }

  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const child = value[key]
      if (typeof child === 'string') {
        const media = wholeStringImageDataUrl(child)
        if (media) {
          mediaParts.push(media)
          value[key] = TOOL_RESULT_MEDIA_MOVED_MARKER
          replaced++
        }
        continue
      }
      replaced += stripAndClampMedia(child, mediaParts, depth + 1)
    }
  }

  return replaced
}

// 规划一次工具输出的媒体搬运：返回 {toolContent, mediaParts}，无媒体返回 null。
// 标量字符串输出保持标量（内嵌 JSON 的字符串再加一层引号会改变模型看到的内容）。
function planChatToolOutputMedia(output) {
  const wasString = typeof output === 'string'
  let value = wasString ? output : JSON.parse(JSON.stringify(output))
  const mediaParts = []
  const replaced = stripAndClampMedia(value, mediaParts, 0)
  if (replaced === 0) return null
  const toolContent = wasString ? value : canonicalJsonString(value)
  return { toolContent, mediaParts }
}

// 把摘出的媒体挂到一条合成 user 消息上。
function queueChatToolOutputMedia(pendingMedia, callId, mediaParts) {
  if (!mediaParts || mediaParts.length === 0) return
  pendingMedia.push({ type: 'text', text: '[ai-proxy: media output of tool call ' + callId + ']' })
  for (const part of mediaParts) pendingMedia.push(part)
}

function flushPendingChatToolMedia(messages, pendingMedia) {
  if (pendingMedia.length === 0) return
  messages.push({ role: 'user', content: pendingMedia.splice(0, pendingMedia.length) })
}

module.exports = {
  canonicalJsonString,
  canonicalizeJsonStringIfParseable,
  canonicalizeToolArgumentsStr,
  canonicalizeToolArguments,
  shortSha256Hex,
  SseBuffer,
  takeSseBlock,
  stripSseField,
  sseEvent,
  extractReasoningFieldText,
  extractReasoningSummaryText,
  appendReasoningContent,
  splitLeadingThinkBlock,
  stripLeadingThinkOpenTag,
  leadingThinkPrefixDecision,
  chatUsageToResponsesUsage,
  responseIdFromChatId,
  responseStatusFromFinishReason,
  isOpenAiOSeries,
  flattenNamespaceToolName,
  normalizeFunctionParameters,
  markFunctionCallArgsPlaintext,
  COLLAB_NAMESPACE,
  CHAT_TOOL_NAME_MAX_LEN,
  TOOL_RESULT_MEDIA_MOVED_MARKER,
  mediaPartFromToolPart,
  planChatToolOutputMedia,
  queueChatToolOutputMedia,
  flushPendingChatToolMedia,
}
