// anthropic-chat-bridge.js — Anthropic Messages API  <->  OpenAI Chat Completions 协议桥。
//
// 用途：Claude Code 只说 Anthropic 协议，而上游只提供 Chat Completions 时，
// 在代理内做双向转换。
//
// 转换语义移植自 cc-switch（src-tauri/src/proxy/providers/transform.rs、
// streaming.rs），那是经过生产验证的实现。要点：
//   - system 合并成唯一一条首部 system 消息（跨轮字节稳定 -> 前缀缓存）；
//   - tool_result 变成独立的 tool 消息，排在所属 assistant 消息之前；
//   - 工具输出里的媒体摘出来放进紧随的合成 user 消息（Chat tool 消息只能带文本）；
//   - 响应侧最多一条 message_delta（延迟到 [DONE] 以便 usage 完整），恰好一条 message_stop；
//   - usage 保持恒等 input_tokens + cache_read + cache_creation == prompt_tokens。

'use strict'

const {
  canonicalJsonString,
  extractReasoningFieldText,
  isOpenAiOSeries,
  sseEvent,
  mediaPartFromToolPart,
  planChatToolOutputMedia,
  queueChatToolOutputMedia,
  flushPendingChatToolMedia,
} = require('./chat-bridge-common')

// Claude Code 会在 system 开头塞一行动态计费头（含轮转的 cch=），
// 原样转发会让每轮请求的前缀都不同、前缀缓存永远 miss。只剥离开头这一行，
// 后续出现的一律保留（避免误删用户自己写的正文）。
const ANTHROPIC_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'

function stripLeadingAnthropicBillingHeader(text) {
  if (!text.startsWith(ANTHROPIC_BILLING_HEADER_PREFIX)) return text
  const newlineIndex = text.search(/[\r\n]/)
  if (newlineIndex < 0) return ''
  // \r\n 是「一个」换行：不把它拆成两次消耗，否则 CRLF 会留下裸 \n 前缀，
  // 每轮请求头部字节不同，前缀缓存照样 miss。
  let restStart = newlineIndex + 1
  if (text[newlineIndex] === '\r' && text[restStart] === '\n') restStart += 1
  const rest = text.slice(restStart)
  if (rest.startsWith('\r\n')) return rest.slice(2)
  if (rest.startsWith('\n')) return rest.slice(1)
  if (rest.startsWith('\r')) return rest.slice(1)
  return rest
}

// ========== 工具 schema 清理 ==========
// 根 schema 必须显式是 object，否则 OpenAI 兼容上游会拒绝；`format: "uri"`
// 不被多数上游接受，直接丢掉。

function cleanSchema(schema) {
  return cleanSchemaInner(schema, true)
}

function cleanSchemaInner(schema, isRoot) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    if (isRoot) return { type: 'object', properties: {} }
    return schema
  }
  const out = { ...schema }
  if (isRoot && out.type === undefined) {
    out.type = 'object'
    if (out.properties === undefined) out.properties = {}
  }
  if (out.format === 'uri') delete out.format
  if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
    const properties = {}
    for (const [key, value] of Object.entries(out.properties)) properties[key] = cleanSchemaInner(value, false)
    out.properties = properties
  }
  if (out.items !== undefined) out.items = cleanSchemaInner(out.items, false)
  return out
}

// Anthropic tool_choice -> Chat tool_choice。
// Anthropic 的 "any" 在 Chat 里没有对应值，映射成 "required"。
function mapToolChoiceToChat(toolChoice) {
  if (typeof toolChoice === 'string') return toolChoice === 'any' ? 'required' : toolChoice
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  switch (toolChoice.type) {
    case 'any':
      return 'required'
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'tool':
      return { type: 'function', function: { name: toolChoice.name || '' } }
    default:
      return toolChoice
  }
}

// ========== 思考深度（effort）解析 ==========
// 移植自 cc-switch transform.rs::resolve_reasoning_effort。优先级：
//  1. 显式 output_config.effort（Claude Code 的 /effort 档位）：low/medium/high/xhigh 一一对应；
//     max 仅对支持独立 max 档的模型保留，否则退到 xhigh；未知值不注入（不猜）。
//  2. thinking.type + budget_tokens：adaptive → xhigh；enabled 按预算分档
//     （<4000 → low，<16000 → medium，否则 high）；enabled 无预算 → high；disabled/缺失 → 不注入。

// 支持独立 max 档的模型（与 Rust 侧白名单一致）。
const MAX_EFFORT_MODELS = new Set(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'])

function supportsMaxReasoningEffort(model) {
  return MAX_EFFORT_MODELS.has(String(model || '').toLowerCase())
}

function resolveReasoningEffort(body) {
  if (!body || typeof body !== 'object') return null

  const explicit = body.output_config && body.output_config.effort
  if (typeof explicit === 'string') {
    switch (explicit) {
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
        return explicit
      case 'max':
        return supportsMaxReasoningEffort(body.model) ? 'max' : 'xhigh'
      default:
        return null // 未知档位：宁可不注入，也不要猜一个上游不认的值
    }
  }

  const thinking = body.thinking
  if (!thinking || typeof thinking !== 'object') return null
  switch (thinking.type) {
    case 'adaptive':
      return 'xhigh'
    case 'enabled': {
      const budget = typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : null
      if (budget === null) return 'high' // 开了思考但没给预算 —— 按强推理处理
      if (budget < 4000) return 'low'
      if (budget < 16000) return 'medium'
      return 'high'
    }
    default:
      return null // disabled 或缺失
  }
}

// ========== 请求方向：Anthropic -> Chat ==========

// 单条 Anthropic 消息可能展开成多条 Chat 消息：tool_result 各自独立成 tool 消息，
// 且必须排在承载正文/tool_use 的所属消息之前。
//
// `hasTools` = 本次请求最终带不带 tools（决定历史思考的回传口径，见下方 attachReasoning）。
function convertMessageToChat(role, content, preserveReasoningContent, hasTools) {
  const result = []

  if (content === undefined || content === null) {
    result.push({ role, content: null })
    return result
  }

  if (typeof content === 'string') {
    result.push({ role, content })
    return result
  }

  if (!Array.isArray(content)) {
    result.push({ role, content })
    return result
  }

  const contentParts = []
  const toolCalls = []
  const pendingMedia = []
  const reasoningParts = []

  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') contentParts.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const media = mediaPartFromAnthropicBlock(block)
        if (media) contentParts.push(media)
        break
      }
      case 'tool_use':
        toolCalls.push({
          id: block.id || '',
          type: 'function',
          function: {
            name: block.name || '',
            arguments: canonicalJsonString(block.input === undefined ? {} : block.input),
          },
        })
        break
      case 'tool_result': {
        const toolUseId = block.tool_use_id || ''
        const contentValue = block.content
        const plan = contentValue === undefined ? null : planChatToolOutputMedia(contentValue)
        let contentStr
        if (plan) {
          queueChatToolOutputMedia(pendingMedia, toolUseId, plan.mediaParts)
          contentStr = plan.toolContent
        } else if (typeof contentValue === 'string') {
          contentStr = contentValue
        } else if (contentValue === undefined || contentValue === null) {
          contentStr = ''
        } else {
          contentStr = canonicalJsonString(contentValue)
        }
        result.push({ role: 'tool', tool_call_id: toolUseId, content: contentStr })
        break
      }
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking) reasoningParts.push(block.thinking)
        break
      case 'redacted_thinking':
        // Claude Code 把历史思考加密成 redacted_thinking。thinking 型上游要求带
        // tool_calls 的 assistant 消息必须有非空 reasoning_content，真实内容拿不到时
        // 给个占位。
        if (preserveReasoningContent) reasoningParts.push('[redacted thinking]')
        break
      default:
        break
    }
  }

  // Chat 的 tool 消息不能带图片，摘出的媒体统一放进一条 user 消息，
  // 排在同一个 Anthropic 回合的正文之前。
  flushPendingChatToolMedia(result, pendingMedia)

  if (contentParts.length > 0 || toolCalls.length > 0) {
    const message = { role }
    if (contentParts.length === 0) {
      message.content = null
    } else if (contentParts.length === 1 && contentParts[0].type === 'text') {
      message.content = contentParts[0].text
    } else {
      message.content = contentParts
    }
    if (toolCalls.length > 0) message.tool_calls = toolCalls
    // 历史思考的回传口径 —— 判据是**本次请求带不带 tools**，不是「这条消息有没有
    // tool_calls」（2026-10-01 按上游规范改正，此前只认后者）：
    //   · 带 tools（Claude Code 的请求恒带）：**所有** assistant 消息的历史思考
    //     全量回传。DeepSeek Thinking Mode 文档原文：`for requests carrying the
    //     tools parameter, the reasoning_content must be fully passed back to the
    //     API in all subsequent requests — even for turns where the model did not
    //     perform a tool call. If your code does not correctly pass back
    //     reasoning_content, the API will return a 400 error`，并且
    //     `the reasoning_content of all previous turns ... will be concatenated
    //     into the context`（即会被计入上下文）。
    //   · 不带 tools：同文档 `does not need to be passed back; even if passed to
    //     the API, it will be ignored and will not be concatenated into the
    //     context` → 丢弃（保留工具调用消息的非空要求，见下）。
    //   · 带 tool_calls 的 assistant 消息必须给**非空** reasoning_content（部分
    //     思考型上游的硬要求）；拿不到真实内容时给占位。
    // 实测（探针在 CyberSlots 仓库：`D:\ai-agent\cyberslots\.dev\`，各发两次同形请求）：
    //   · `probe-reasoning-replay.mjs`（工具调用消息形）：WorkBuddy 桥上游
    //     **忽略** reasoning_content（带/不带思考 prompt 都是 368，差 0，也不 400）；
    //     DeepSeek 直连（Anthropic 协议）全额计入（635 vs 314，差 321）。
    //   · `probe-bridge-reasoning-shadow.mjs`（**本改动后的形态**：非工具调用的
    //     assistant 也带思考；影子实例 :3799 跑本文件的新代码，不动生产 :3718）：
    //     WorkBuddy 桥上游 200 / 296 tokens，带与不带思考同值 → 仍是忽略。
    //   即：本改动在该上游零成本（只多上行字节），在严格上游则免掉「该回传没回传」
    //   的 400。数字随 payload 而变，别把某一版数字当恒定判据 —— 复跑探针为准。
    const attachReasoning =
      preserveReasoningContent &&
      role === 'assistant' &&
      (hasTools ? reasoningParts.length > 0 || toolCalls.length > 0 : toolCalls.length > 0)
    if (attachReasoning) {
      message.reasoning_content = reasoningParts.length ? reasoningParts.join('\n') : 'tool call'
    }
    result.push(message)
  }

  return result
}

// Anthropic 的 image 块（{type:'image', source:{...}}）转 Chat 的 image_url 块。
function mediaPartFromAnthropicBlock(block) {
  return mediaPartFromToolPart(block)
}

// Anthropic 请求体 -> Chat Completions 请求体。
// 工具表清理与映射（单独成函数：消息转换要先知道「本次请求带不带 tools」，
// 但 result.tools 的赋值位置保持原样 —— 输出键序不变，上游前缀缓存不受影响）。
function buildChatTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    if (tool.type === 'BatchTool') continue
    const fn = { name: tool.name || '' }
    // 缺失 description 时省略而非发 null：严格上游会因 null 拒绝整个请求。
    if (tool.description !== undefined && tool.description !== null) fn.description = tool.description
    fn.parameters = cleanSchema(tool.input_schema === undefined ? {} : tool.input_schema)
    out.push({ type: 'function', function: fn })
  }
  return out
}

function anthropicToChatCompletions(body, options) {
  const opts = options || {}
  const result = {}

  if (body.model !== undefined) result.model = body.model

  const chatTools = buildChatTools(body.tools)
  const hasTools = chatTools.length > 0

  const messages = []

  if (body.system !== undefined) {
    if (typeof body.system === 'string') {
      const text = stripLeadingAnthropicBillingHeader(body.system)
      if (text) messages.push({ role: 'system', content: text })
    } else if (Array.isArray(body.system)) {
      const parts = []
      for (const block of body.system) {
        if (!block || typeof block !== 'object') continue
        if (typeof block.text !== 'string') continue
        const text = stripLeadingAnthropicBillingHeader(block.text)
        if (text) parts.push(text)
      }
      if (parts.length) messages.push({ role: 'system', content: parts.join('\n') })
    }
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') continue
      const role = typeof message.role === 'string' ? message.role : 'user'
      messages.push(...convertMessageToChat(role, message.content, opts.preserveReasoningContent !== false, hasTools))
    }
  }
  result.messages = messages

  if (body.max_tokens !== undefined) {
    if (isOpenAiOSeries(body.model)) result.max_completion_tokens = body.max_tokens
    else result.max_tokens = body.max_tokens
  }
  if (body.temperature !== undefined) result.temperature = body.temperature
  if (body.top_p !== undefined) result.top_p = body.top_p
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences
  if (body.stream !== undefined) result.stream = body.stream

  // 思考深度：优先显式 output_config.effort，其次 thinking 预算；解析不出就不注入
  // （严格上游对未知档位直接 400，宁缺勿错）。
  const reasoningEffort = opts.reasoningEffort || resolveReasoningEffort(body)
  if (reasoningEffort) result.reasoning_effort = reasoningEffort

  if (chatTools.length) result.tools = chatTools

  if (body.tool_choice !== undefined) result.tool_choice = mapToolChoiceToChat(body.tool_choice)

  // Claude Code 在 metadata.user_id 里带稳定的 session_id；上游网关（WorkBuddy2API）
  // 用它做会话粘性选号 —— 丢掉它会让每次请求换一个账号，前缀缓存必然 miss
  // （同账号才可能命中上游 prompt cache）。metadata 本身对 Chat 协议是合法字段。
  if (body.metadata !== undefined) result.metadata = body.metadata

  // 流式下上游默认不回 usage，必须显式声明。
  if (result.stream === true) result.stream_options = { include_usage: true }

  return result
}

// ========== 响应方向（非流式）：Chat -> Anthropic ==========

function openaiToAnthropic(body) {
  const choices = Array.isArray(body.choices) ? body.choices : null
  if (!choices || choices.length === 0) throw new Error('No choices in chat response')
  const choice = choices[0]
  const message = choice.message
  if (!message) throw new Error('No message in chat choice')

  const content = []
  let hasToolUse = false

  const reasoning = extractReasoningFieldText(message)
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning })

  if (typeof message.content === 'string') {
    if (message.content) content.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      if ((part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string' && part.text) {
        content.push({ type: 'text', text: part.text })
      } else if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal) {
        content.push({ type: 'text', text: part.refusal })
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal) {
    content.push({ type: 'text', text: message.refusal })
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    hasToolUse = true
    for (const toolCall of message.tool_calls) {
      const fn = toolCall.function || {}
      let input
      try {
        input = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}')
      } catch (_) {
        input = {}
      }
      content.push({ type: 'tool_use', id: toolCall.id || '', name: fn.name || '', input })
    }
  }

  if (!hasToolUse && message.function_call) {
    const fn = message.function_call
    const hasArguments = fn.arguments !== undefined
    let input = {}
    if (typeof fn.arguments === 'string') {
      try {
        input = JSON.parse(fn.arguments)
      } catch (_) {
        input = {}
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      input = fn.arguments
    }
    if (fn.name || hasArguments) {
      content.push({ type: 'tool_use', id: fn.id || '', name: fn.name || '', input })
      hasToolUse = true
    }
  }

  let stopReason = null
  if (typeof choice.finish_reason === 'string') {
    switch (choice.finish_reason) {
      case 'stop':
        stopReason = 'end_turn'
        break
      case 'length':
        stopReason = 'max_tokens'
        break
      case 'tool_calls':
      case 'function_call':
        stopReason = 'tool_use'
        break
      case 'content_filter':
        stopReason = 'end_turn'
        break
      default:
        stopReason = 'end_turn'
        break
    }
  } else if (hasToolUse) {
    stopReason = 'tool_use'
  }

  return {
    id: body.id || '',
    type: 'message',
    role: 'assistant',
    content,
    model: body.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: buildAnthropicUsage(body.usage),
  }
}

// OpenAI prompt_tokens 含缓存命中，Anthropic input_tokens 不含 -> 相减。
// 三桶互斥，恒等 input + cache_read + cache_creation == prompt_tokens。
function buildAnthropicUsage(usage) {
  if (!usage || typeof usage !== 'object') return { input_tokens: 0, output_tokens: 0 }

  const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  // 上游可能同时下发 `cache_read_input_tokens: 0`（占位）与
  // `prompt_tokens_details.cached_tokens: 640`（真实命中）。0 是「无值」而非
  // 「有值为 0」，必须继续往下兜，否则缓存恒记 0、input_tokens 被高估。
  const details = usage.prompt_tokens_details || usage.input_tokens_details || {}
  const directCached = num(usage.cache_read_input_tokens)
  const cached = directCached > 0 ? directCached : num(details.cached_tokens)
  const directCreation = num(usage.cache_creation_input_tokens)
  const cacheCreation = directCreation > 0 ? directCreation : num(details.cache_write_tokens)
  const inputTokens = Math.max(0, num(usage.prompt_tokens) - cached - cacheCreation)
  const outputTokens = num(usage.completion_tokens)

  const out = { input_tokens: inputTokens, output_tokens: outputTokens }
  if (cached > 0) out.cache_read_input_tokens = cached
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation
  return out
}

function mapStopReason(finishReason) {
  if (typeof finishReason !== 'string') return null
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

// ========== 响应方向（流式）：Chat SSE -> Anthropic SSE ==========

// 上游可能因 bug 在工具参数里吐出无限空白（Copilot 已知问题），
// 达到阈值就中止该工具调用，避免把上下文撑爆。
const INFINITE_WHITESPACE_THRESHOLD = 500

class ChatToAnthropicStream {
  constructor() {
    this.messageId = null
    this.model = null
    this.nextContentIndex = 0
    this.hasSentMessageStart = false
    this.hasEmittedMessageDelta = false
    this.pendingMessageDelta = null
    this.hasSentMessageStop = false
    this.latestUsage = null
    this.streamEndedWithError = false
    // 正文与思考共用同一个「非工具块」槽位：开一个就关掉另一个。
    this.currentNonToolBlockType = null
    this.currentNonToolBlockIndex = null
    this.toolBlocksByIndex = new Map()
    this.openToolBlockIndices = new Set()
  }

  usageJsonFrom(usage) {
    return buildAnthropicUsage(usage)
  }

  ensureMessageStart() {
    if (this.hasSentMessageStart) return []
    this.hasSentMessageStart = true
    return [
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId || '',
          type: 'message',
          role: 'assistant',
          model: this.model || '',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    ]
  }

  closeNonToolBlock() {
    if (this.currentNonToolBlockIndex === null) return []
    const index = this.currentNonToolBlockIndex
    this.currentNonToolBlockIndex = null
    this.currentNonToolBlockType = null
    return [sseEvent('content_block_stop', { type: 'content_block_stop', index })]
  }

  openNonToolBlock(type, field) {
    const events = []
    events.push(...this.closeNonToolBlock())
    const index = this.nextContentIndex
    this.nextContentIndex += 1
    const block = type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' }
    events.push(sseEvent('content_block_start', { type: 'content_block_start', index, content_block: block }))
    this.currentNonToolBlockType = type
    this.currentNonToolBlockIndex = index
    return events
  }

  handleChunk(chunk) {
    const events = []
    if (this.messageId === null && typeof chunk.id === 'string' && chunk.id) this.messageId = chunk.id
    if (this.model === null && typeof chunk.model === 'string' && chunk.model) this.model = chunk.model

    events.push(...this.ensureMessageStart())

    const usageJson = chunk.usage !== undefined && chunk.usage !== null ? this.usageJsonFrom(chunk.usage) : null
    if (usageJson) {
      this.latestUsage = usageJson
      if (this.pendingMessageDelta) this.pendingMessageDelta.usage = usageJson
    }

    const choice = Array.isArray(chunk.choices) && chunk.choices.length ? chunk.choices[0] : null
    if (!choice) return events
    const delta = choice.delta || {}

    // 思考：某些上游在输出正文时也带空字符串，空值必须过滤，否则 text/thinking
    // 块会在单个 chunk 内反复关闭重开，正文碎片化。
    const reasoning = extractReasoningFieldText(delta)
    if (reasoning) {
      if (this.currentNonToolBlockType !== 'thinking') events.push(...this.openNonToolBlock('thinking', 'thinking'))
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentNonToolBlockIndex,
          delta: { type: 'thinking_delta', thinking: reasoning },
        })
      )
    }

    if (typeof delta.content === 'string' && delta.content) {
      if (this.currentNonToolBlockType !== 'text') events.push(...this.openNonToolBlock('text', 'text'))
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: this.currentNonToolBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        })
      )
    }

    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
      events.push(...this.closeNonToolBlock())
      this.currentNonToolBlockType = null

      for (const toolCall of delta.tool_calls) {
        events.push(...this.pushToolCallDelta(toolCall))
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      events.push(...this.handleFinishReason(choice.finish_reason, usageJson))
    }

    return events
  }

  pushToolCallDelta(toolCall) {
    const events = []
    let state = this.toolBlocksByIndex.get(toolCall.index)
    if (!state) {
      const anthropicIndex = this.nextContentIndex
      this.nextContentIndex += 1
      state = {
        anthropicIndex,
        id: '',
        name: '',
        started: false,
        pendingArgs: '',
        consecutiveWhitespace: 0,
        aborted: false,
      }
      this.toolBlocksByIndex.set(toolCall.index, state)
    }

    if (state.aborted) return events

    if (typeof toolCall.id === 'string' && toolCall.id) state.id = toolCall.id
    if (toolCall.function) {
      if (typeof toolCall.function.name === 'string' && toolCall.function.name) state.name = toolCall.function.name
    }

    // id 与 name 齐备才开块；早到的参数先攒着，开块后立刻补发。
    let shouldStart = false
    if (!state.started && state.id && state.name) {
      state.started = true
      shouldStart = true
    }
    const pendingAfterStart = shouldStart && state.pendingArgs ? state.pendingArgs : null
    if (shouldStart) state.pendingArgs = ''

    const argsDelta = toolCall.function && typeof toolCall.function.arguments === 'string' ? toolCall.function.arguments : null
    let immediateDelta = null
    if (argsDelta) {
      for (const ch of argsDelta) {
        if (/\s/.test(ch)) state.consecutiveWhitespace += 1
        else state.consecutiveWhitespace = 0
      }
      if (state.consecutiveWhitespace >= INFINITE_WHITESPACE_THRESHOLD) {
        state.aborted = true
      } else if (state.started) {
        immediateDelta = argsDelta
      } else {
        state.pendingArgs += argsDelta
      }
    }

    if (shouldStart) {
      events.push(
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: state.anthropicIndex,
          content_block: { type: 'tool_use', id: state.id, name: state.name, input: {} },
        })
      )
      this.openToolBlockIndices.add(state.anthropicIndex)
    }

    for (const args of [pendingAfterStart, immediateDelta]) {
      if (!args) continue
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: state.anthropicIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        })
      )
    }

    return events
  }

  // 上游可能发多个带 finish_reason 的 chunk（第一个 usage 为 null，后续才补全）。
  // Anthropic 要求每条流只能有一条 message_delta，所以只处理第一个，并把它
  // 延迟到 [DONE] / 流末尾发送，确保 usage 完整。
  handleFinishReason(finishReason, usageJson) {
    const events = []
    const stopReason = mapStopReason(finishReason)
    const usage = usageJson || this.latestUsage

    if (this.hasEmittedMessageDelta) {
      if (this.pendingMessageDelta && usageJson) this.pendingMessageDelta.usage = usageJson
      return events
    }
    this.hasEmittedMessageDelta = true

    events.push(...this.closeNonToolBlock())
    this.currentNonToolBlockType = null

    // 迟到的工具调用：id/name 直到 finish_reason 才齐备的，此刻补开块。
    const lateStarts = []
    for (const [toolIndex, state] of this.toolBlocksByIndex) {
      if (state.started) continue
      const hasPayload = state.pendingArgs || state.id || state.name
      if (!hasPayload) continue
      state.started = true
      const fallbackId = state.id || 'tool_call_' + toolIndex
      const fallbackName = state.name || 'unknown_tool'
      lateStarts.push({ index: state.anthropicIndex, id: fallbackId, name: fallbackName, pending: state.pendingArgs })
      state.pendingArgs = ''
    }
    lateStarts.sort((a, b) => a.index - b.index)
    for (const late of lateStarts) {
      events.push(
        sseEvent('content_block_start', {
          type: 'content_block_start',
          index: late.index,
          content_block: { type: 'tool_use', id: late.id, name: late.name, input: {} },
        })
      )
      this.openToolBlockIndices.add(late.index)
      if (late.pending) {
        events.push(
          sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: late.index,
            delta: { type: 'input_json_delta', partial_json: late.pending },
          })
        )
      }
    }

    for (const index of [...this.openToolBlockIndices].sort((a, b) => a - b)) {
      events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }))
    }
    this.openToolBlockIndices.clear()

    this.pendingMessageDelta = { stopReason, usage }
    return events
  }

  buildMessageDelta() {
    const pending = this.pendingMessageDelta
    const usage = pending && pending.usage && typeof pending.usage === 'object' ? pending.usage : { input_tokens: 0, output_tokens: 0 }
    return sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: pending ? pending.stopReason : null, stop_sequence: null },
      usage,
    })
  }

  // [DONE]：发缓存的 message_delta + message_stop。
  handleDone() {
    const events = []
    if (this.pendingMessageDelta) {
      events.push(this.buildMessageDelta())
      this.pendingMessageDelta = null
    }
    events.push(sseEvent('message_stop', { type: 'message_stop' }))
    this.hasSentMessageStop = true
    return events
  }

  handleError(message, type) {
    this.streamEndedWithError = true
    return [
      sseEvent('error', {
        type: 'error',
        error: { type: type || 'stream_error', message },
      }),
    ]
  }

  // 流结束收尾：未收到 [DONE] 时补齐 message_delta / message_stop，
  // 并关闭仍开着的块（Anthropic 协议要求每个 content_block_start 都有 stop）。
  finish() {
    if (this.streamEndedWithError) return []
    const events = []
    events.push(...this.closeNonToolBlock())
    for (const index of [...this.openToolBlockIndices].sort((a, b) => a - b)) {
      events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }))
    }
    this.openToolBlockIndices.clear()

    let emitted = false
    if (this.pendingMessageDelta) {
      events.push(this.buildMessageDelta())
      this.pendingMessageDelta = null
      emitted = true
    }
    if (emitted && !this.hasSentMessageStop) {
      events.push(sseEvent('message_stop', { type: 'message_stop' }))
      this.hasSentMessageStop = true
    }
    return events
  }
}

module.exports = {
  anthropicToChatCompletions,
  openaiToAnthropic,
  ChatToAnthropicStream,
  cleanSchema,
  mapToolChoiceToChat,
  mapStopReason,
  resolveReasoningEffort,
  stripLeadingAnthropicBillingHeader,
}
