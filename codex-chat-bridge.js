// codex-chat-bridge.js — OpenAI Responses API  <->  OpenAI Chat Completions 协议桥。
//
// 用途：codex CLI 只会说 Responses 协议，而上游只提供 Chat Completions 时，
// 在代理内做双向转换。
//
// 转换语义移植自 cc-switch（src-tauri/src/proxy/providers/transform_codex_chat.rs、
// streaming_codex_chat.rs、codex_responses_sse.rs），那是经过生产验证的实现。
// 这里保持逐条对齐，包括：
//   - Responses `input` 各项到 chat messages 的有状态映射（tool_call 批量、reasoning 归属、
//     媒体搬运）；
//   - namespace / custom / tool_search 工具名折叠与回程还原；
//   - Chat SSE -> Responses SSE 的事件序列与 output_index 分配；
//   - 工具调用无函数名时的失败判据（否则 codex 会「静默收尾」）。

'use strict'

const {
  canonicalJsonString,
  canonicalizeJsonStringIfParseable,
  canonicalizeToolArguments,
  canonicalizeToolArgumentsStr,
  extractReasoningFieldText,
  extractReasoningSummaryText,
  appendReasoningContent,
  splitLeadingThinkBlock,
  stripLeadingThinkOpenTag,
  leadingThinkPrefixDecision,
  chatUsageToResponsesUsage,
  responseIdFromChatId,
  responseStatusFromFinishReason,
  flattenNamespaceToolName,
  normalizeFunctionParameters,
  markFunctionCallArgsPlaintext,
  sseEvent,
  mediaPartFromToolPart,
  planChatToolOutputMedia,
  queueChatToolOutputMedia,
  flushPendingChatToolMedia,
} = require('./chat-bridge-common')

const TOOL_SEARCH_PROXY_NAME = 'tool_search'
const CUSTOM_TOOL_INPUT_FIELD = 'input'
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.'
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = 'Original tool definition:'

const TOOL_KIND_FUNCTION = 'function'
const TOOL_KIND_NAMESPACE = 'namespace'
const TOOL_KIND_CUSTOM = 'custom'
const TOOL_KIND_TOOL_SEARCH = 'tool_search'

// ========== 工具注册表 ==========
// Chat 协议没有 namespace 容器与 freeform 工具的概念，必须折叠成扁平函数名；
// 回程时靠这张表把 chat 名还原成 Responses 的 function_call / custom_tool_call /
// tool_search_call，并补回 namespace 字段（codex 靠它做工具路由）。

class ToolContext {
  constructor() {
    this.chatTools = []
    this.seenChatNames = new Set()
    this.chatNameToSpec = new Map()
    this.namespaceNameToChatName = new Map()
  }

  addChatTool(chatName, spec, chatTool) {
    if (!chatName || this.seenChatNames.has(chatName)) return
    this.seenChatNames.add(chatName)
    if (spec.namespace) this.namespaceNameToChatName.set(spec.namespace + '\u0000' + spec.name, chatName)
    this.chatNameToSpec.set(chatName, spec)
    this.chatTools.push(chatTool)
  }

  lookup(chatName) {
    return this.chatNameToSpec.get(chatName)
  }

  isCustomTool(chatName) {
    const spec = this.chatNameToSpec.get(chatName)
    return !!spec && spec.kind === TOOL_KIND_CUSTOM
  }

  // Responses function_call 的 (name, namespace) -> 发给上游的 chat 名。
  chatNameForResponseFunction(name, namespace) {
    if (namespace) {
      const mapped = this.namespaceNameToChatName.get(namespace + '\u0000' + name)
      if (mapped) return mapped
      return flattenNamespaceToolName(namespace, name)
    }
    return name
  }

  addFunctionTool(tool, namespace) {
    const originalName = responsesToolName(tool)
    if (!originalName) return
    const chatName = namespace ? flattenNamespaceToolName(namespace, originalName) : originalName
    const chatTool = responsesFunctionToolToChatTool(tool, chatName)
    if (!chatTool) return
    this.addChatTool(
      chatName,
      {
        kind: namespace ? TOOL_KIND_NAMESPACE : TOOL_KIND_FUNCTION,
        name: originalName,
        namespace: namespace || null,
      },
      chatTool
    )
  }

  addCustomTool(tool) {
    const name = responsesToolName(tool)
    if (!name) return
    const chatTool = {
      type: 'function',
      function: {
        name,
        description: CUSTOM_TOOL_PRESERVED_METADATA_HEADING + '\n```json\n' + canonicalJsonString(tool) + '\n```',
        parameters: {
          type: 'object',
          properties: {
            [CUSTOM_TOOL_INPUT_FIELD]: { type: 'string', description: CUSTOM_TOOL_INPUT_DESCRIPTION },
          },
          required: [CUSTOM_TOOL_INPUT_FIELD],
        },
      },
    }
    this.addChatTool(name, { kind: TOOL_KIND_CUSTOM, name, namespace: null }, chatTool)
  }

  addToolSearchTool() {
    const chatTool = {
      type: 'function',
      function: {
        name: TOOL_SEARCH_PROXY_NAME,
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for tools or connectors to load.' },
            limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
          },
          required: ['query'],
        },
      },
    }
    this.addChatTool(
      TOOL_SEARCH_PROXY_NAME,
      { kind: TOOL_KIND_TOOL_SEARCH, name: TOOL_SEARCH_PROXY_NAME, namespace: null },
      chatTool
    )
  }

  addNamespaceTool(namespaceTool) {
    const namespace = namespaceTool.name
    if (!namespace) return
    const children = namespaceTool.tools || namespaceTool.children
    if (!Array.isArray(children)) return
    for (const child of children) {
      if (child && child.type === 'function') this.addFunctionTool(child, namespace)
    }
  }

  addResponseTool(tool) {
    if (typeof tool === 'string') {
      this.addCustomTool({ type: 'custom', name: tool })
      return
    }
    if (!tool || typeof tool !== 'object') return
    switch (tool.type) {
      case 'function':
        this.addFunctionTool(tool, null)
        break
      case 'custom':
        this.addCustomTool(tool)
        break
      case 'tool_search':
        this.addToolSearchTool()
        break
      case 'namespace':
        this.addNamespaceTool(tool)
        break
      default:
        // web_search / image_generation 等 hosted 工具在 Chat 上游没有对应实现，
        // 不下发（模型看不到就不会调用，好过调用后必然失败）。
        break
    }
  }
}

function responsesToolName(tool) {
  const raw =
    (tool.function && tool.function.name) !== undefined ? tool.function.name : tool.name
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed || null
}

function responsesFunctionToolToChatTool(tool, chatName) {
  if (tool.type !== 'function') return null

  if (tool.function) {
    const fn = { ...tool.function }
    fn.parameters = normalizeFunctionParameters(fn.parameters)
    fn.name = chatName
    if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict
    return { type: 'function', function: fn }
  }

  const fn = { name: chatName }
  // 缺失 description 时省略而非发 null：严格上游会因 null 拒绝整个请求。
  if (tool.description !== undefined && tool.description !== null) fn.description = tool.description
  fn.parameters = normalizeFunctionParameters(tool.parameters)
  if (tool.strict !== undefined) fn.strict = tool.strict
  return { type: 'function', function: fn }
}

// input 内联声明的工具：tool_search_output（动态加载的工具组）与 additional_tools
// （codex 0.154+ 用这个私有扩展载体附带额外工具）。
function collectInputDeclaredTools(value, context) {
  if (Array.isArray(value)) {
    for (const item of value) collectInputDeclaredTools(item, context)
    return
  }
  if (!value || typeof value !== 'object') return
  if (value.type === 'tool_search_output' || value.type === 'additional_tools') {
    if (Array.isArray(value.tools)) for (const tool of value.tools) context.addResponseTool(tool)
  }
  for (const child of Object.values(value)) collectInputDeclaredTools(child, context)
}

function buildToolContext(body) {
  const context = new ToolContext()
  if (Array.isArray(body.tools)) for (const tool of body.tools) context.addResponseTool(tool)
  if (body.input !== undefined) collectInputDeclaredTools(body.input, context)
  return context
}

// ========== 请求方向：Responses -> Chat ==========

function instructionText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map(part => (part && typeof part === 'object' ? part.text : part))
      .filter(text => typeof text === 'string' && text)
      .join('\n\n')
  }
  return typeof value === 'string' ? value : ''
}

// MiniMax 严格要求 system 只出现在首位，否则 400。把分散的 system 合并到头部；
// 对宽松上游无损。
function collapseSystemMessagesToHead(messages) {
  const chunks = []
  const rest = []
  for (const message of messages) {
    if (message.role === 'system' && typeof message.content === 'string') {
      if (message.content.trim()) chunks.push(message.content)
      continue
    }
    rest.push(message)
  }
  if (chunks.length === 0) return rest
  return [{ role: 'system', content: chunks.join('\n\n') }, ...rest]
}

function responsesRoleToChatRole(role) {
  switch (role) {
    case 'system':
    case 'developer':
      return 'system'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool'
    default:
      return 'user'
  }
}

function responsesContentToChatContent(content) {
  if (content === null || typeof content === 'string') return content
  if (!Array.isArray(content)) return content

  const parts = []
  let hasNonTextPart = false

  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    switch (part.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (typeof part.text === 'string' && part.text) parts.push({ type: 'text', text: part.text })
        break
      case 'refusal':
        if (typeof part.refusal === 'string' && part.refusal) parts.push({ type: 'text', text: part.refusal })
        break
      case 'input_image': {
        const media = mediaPartFromToolPart(part)
        if (media) {
          parts.push(media)
          hasNonTextPart = true
        }
        break
      }
      case 'input_file': {
        const file = part.file_id !== undefined || part.file_data !== undefined ? {} : null
        if (file) {
          for (const key of ['file_id', 'file_data', 'filename']) {
            if (part[key] !== undefined) file[key] = part[key]
          }
          parts.push({ type: 'file', file })
          hasNonTextPart = true
        }
        break
      }
      case 'input_audio':
        if (part.input_audio !== undefined) {
          parts.push({ type: 'input_audio', input_audio: part.input_audio })
          hasNonTextPart = true
        }
        break
      default:
        break
    }
  }

  if (!hasNonTextPart) return parts.map(part => part.text || '').join('\n')
  return parts
}

function responsesFunctionCallToChatToolCall(item, toolContext) {
  const callId = item.call_id || item.id || ''
  const name = item.name || ''
  return {
    id: callId,
    type: 'function',
    function: {
      name: toolContext.chatNameForResponseFunction(name, item.namespace),
      arguments: canonicalizeToolArguments(item.arguments),
    },
  }
}

function responsesCustomToolCallToChatToolCall(item) {
  const callId = item.call_id || item.id || ''
  const input = item.input !== undefined ? item.input : ''
  return {
    id: callId,
    type: 'function',
    function: {
      name: item.name || '',
      arguments: canonicalJsonString({ [CUSTOM_TOOL_INPUT_FIELD]: input }),
    },
  }
}

function responsesToolSearchCallToChatToolCall(item) {
  return {
    id: item.call_id || item.id || '',
    type: 'function',
    function: {
      name: TOOL_SEARCH_PROXY_NAME,
      arguments: item.arguments === undefined ? '{}' : canonicalJsonString(item.arguments),
    },
  }
}

function responsesToolChoiceToChat(toolChoice, toolContext) {
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  switch (toolChoice.type) {
    case 'function':
      return {
        type: 'function',
        function: { name: toolContext.chatNameForResponseFunction(toolChoice.name || '', toolChoice.namespace) },
      }
    case 'tool_search':
      return { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME } }
    case 'custom':
      return { type: 'function', function: { name: toolChoice.name || '' } }
    default:
      return toolChoice
  }
}

// 输入项到 chat messages 的映射需要跨项状态：
//   pendingToolCalls  同一条 assistant 消息里累积的 tool_calls（Responses 把它们拆成
//                     多个平级 item，Chat 要求挂在同一条 assistant 消息上）
//   pendingMedia      从工具输出摘出的媒体，等下一轮 user 消息一起呈现
//   pendingReasoning  reasoning item 先入队，前向挂到其后的 message / function_call
//   lastAssistantIdx  回溯挂载点（尾部 reasoning 与跨回合边界用）
class RequestBuilder {
  constructor(toolContext) {
    this.toolContext = toolContext
    this.messages = []
    this.pendingToolCalls = []
    this.pendingMedia = []
    this.pendingReasoning = null
    this.lastAssistantIndex = null
  }

  updateLastAssistantIndex(message) {
    switch (message.role) {
      case 'assistant':
        this.lastAssistantIndex = this.messages.length
        break
      case 'tool':
        break
      default:
        this.lastAssistantIndex = null
        break
    }
  }

  appendPendingReasoning(reasoning) {
    const text = typeof reasoning === 'string' ? reasoning.trim() : ''
    if (!text) return
    this.pendingReasoning = this.pendingReasoning ? this.pendingReasoning + '\n\n' + text : text
  }

  appendUniquePendingReasoning(reasoning) {
    const text = typeof reasoning === 'string' ? reasoning.trim() : ''
    if (!text) return
    if (this.pendingReasoning && this.pendingReasoning.includes(text)) return
    this.appendPendingReasoning(text)
  }

  attachPendingReasoningToAssistant(message) {
    if (!this.pendingReasoning) return
    const reasoning = this.pendingReasoning
    this.pendingReasoning = null
    if (!reasoning.trim()) return
    appendReasoningContent(message, reasoning)
  }

  attachPendingReasoningToAssistantUnique(message) {
    if (!this.pendingReasoning) return
    const reasoning = this.pendingReasoning
    this.pendingReasoning = null
    const trimmed = reasoning.trim()
    if (!trimmed) return
    const existingText = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    const existing = existingText.split('\n\n').map(s => s.trim()).filter(Boolean)
    const missing = trimmed.split('\n\n').map(s => s.trim()).filter(s => s && !existing.includes(s))
    if (missing.length === 0) return
    message.reasoning_content = existing.length ? existing.join('\n\n') + '\n\n' + missing.join('\n\n') : missing.join('\n\n')
  }

  // 尾部 / 回合边界的 reasoning 回溯挂到上一条 assistant。
  // reasoning 不允许跨 user 回合泄漏到之后的 assistant；无挂载点时自然丢弃。
  attachPendingReasoningToPreviousAssistant() {
    if (!this.pendingReasoning) return
    const reasoning = this.pendingReasoning
    this.pendingReasoning = null
    const trimmed = reasoning.trim()
    if (!trimmed) return
    const index = this.lastAssistantIndex
    if (index === null || index === undefined) return
    const message = this.messages[index]
    if (!message || message.role !== 'assistant') return
    appendReasoningContent(message, trimmed)
  }

  // Responses 把「同一条 assistant 消息的正文 + 工具调用」拆成多个 item；
  // 序列化成两条连续 assistant 消息会让 Chat 模型模仿那条纯文本消息提前收尾，
  // 所以合并进紧邻的无 tool_calls assistant 消息。
  mergePendingToolCallsIntoAdjacentAssistant() {
    if (this.pendingToolCalls.length === 0) return false
    const message = this.messages[this.messages.length - 1]
    if (!message || message.role !== 'assistant') return false
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return false
    message.tool_calls = this.pendingToolCalls
    this.pendingToolCalls = []
    this.attachPendingReasoningToAssistantUnique(message)
    return true
  }

  flushPendingToolCalls() {
    if (this.pendingToolCalls.length === 0) return
    if (this.mergePendingToolCallsIntoAdjacentAssistant()) {
      this.lastAssistantIndex = this.messages.length - 1
      return
    }
    // 上一条工具结果的媒体必须排在新一轮 assistant 工具调用之前。
    flushPendingChatToolMedia(this.messages, this.pendingMedia)
    const message = { role: 'assistant', content: null, tool_calls: this.pendingToolCalls }
    this.pendingToolCalls = []
    this.attachPendingReasoningToAssistant(message)
    this.lastAssistantIndex = this.messages.length
    this.messages.push(message)
  }

  pushFunctionCallOutput(item) {
    this.flushPendingToolCalls()
    const callId = item.call_id || ''
    let output
    const plan = item.output === undefined ? null : planChatToolOutputMedia(item.output)
    if (plan) {
      queueChatToolOutputMedia(this.pendingMedia, callId, plan.mediaParts)
      output = plan.toolContent
    } else if (typeof item.output === 'string') {
      output = canonicalizeJsonStringIfParseable(item.output)
    } else if (item.output === undefined || item.output === null) {
      output = ''
    } else {
      output = canonicalJsonString(item.output)
    }
    this.messages.push({ role: 'tool', tool_call_id: callId, content: output })
  }

  pushCustomToolCallOutput(item) {
    this.flushPendingToolCalls()
    const callId = item.call_id || ''
    const cloned = JSON.parse(JSON.stringify(item))
    let output
    const plan = cloned.output === undefined ? null : planChatToolOutputMedia(cloned.output)
    if (plan) {
      queueChatToolOutputMedia(this.pendingMedia, callId, plan.mediaParts)
      output = canonicalJsonString(cloned)
    } else {
      output = canonicalJsonString(item)
    }
    this.messages.push({ role: 'tool', tool_call_id: callId, content: output })
  }

  pushMessageItem(item) {
    this.flushPendingToolCalls()
    flushPendingChatToolMedia(this.messages, this.pendingMedia)

    const role = typeof item.role === 'string' ? item.role : 'user'
    const chatRole = responsesRoleToChatRole(role)
    const message = {
      role: chatRole,
      content: item.content === undefined ? null : responsesContentToChatContent(item.content),
    }

    if (chatRole === 'assistant') {
      this.appendPendingReasoning(extractReasoningFieldText(item))
      this.attachPendingReasoningToAssistant(message)
    } else {
      this.attachPendingReasoningToPreviousAssistant()
    }
    this.updateLastAssistantIndex(message)
    this.messages.push(message)
  }

  pushInlineContentItem(item) {
    this.flushPendingToolCalls()
    flushPendingChatToolMedia(this.messages, this.pendingMedia)

    const role = responsesRoleToChatRole(item.role || 'user')
    const message = {
      role,
      content: responsesContentToChatContent([item]),
    }
    if (role === 'assistant') {
      this.attachPendingReasoningToAssistant(message)
      this.updateLastAssistantIndex(message)
      this.messages.push(message)
      return
    }
    this.attachPendingReasoningToPreviousAssistant()
    this.updateLastAssistantIndex(message)
    this.messages.push(message)
  }

  pushItem(item) {
    if (!item || typeof item !== 'object') return
    switch (item.type) {
      case 'function_call':
        this.appendUniquePendingReasoning(extractReasoningFieldText(item))
        this.pendingToolCalls.push(responsesFunctionCallToChatToolCall(item, this.toolContext))
        return
      case 'custom_tool_call':
        this.appendUniquePendingReasoning(extractReasoningFieldText(item))
        this.pendingToolCalls.push(responsesCustomToolCallToChatToolCall(item))
        return
      case 'tool_search_call':
        this.appendUniquePendingReasoning(extractReasoningFieldText(item))
        this.pendingToolCalls.push(responsesToolSearchCallToChatToolCall(item))
        return
      case 'function_call_output':
        this.pushFunctionCallOutput(item)
        return
      case 'custom_tool_call_output':
      case 'tool_search_output':
        this.pushCustomToolCallOutput(item)
        return
      case 'reasoning':
        // 一律先入队，前向挂到其后的 message / function_call。直接回溯挂到上一条
        // assistant 会把新一轮的思考错拼进旧消息，思考型模型多轮对话会中途断片。
        this.appendPendingReasoning(extractReasoningSummaryText(item))
        return
      case 'additional_tools':
        // 工具载体，本身不是消息（它有 role 但无 content，当消息处理会造出
        // content:null 的 system 消息，严格上游直接 400）。
        return
      case 'input_text':
      case 'input_image':
      case 'input_file':
      case 'input_audio':
        this.pushInlineContentItem(item)
        return
      case 'agent_message': {
        // codex multi-agent v2 以 agent_message 下发子代理任务与回报。
        // 上游 Chat 协议不认这个类型，降级成普通 user 消息，正文原样保留。
        const blocks = Array.isArray(item.content) ? item.content : []
        const text = blocks
          .map(block => {
            if (typeof block === 'string') return block
            if (block && typeof block === 'object') return block.text || block.encrypted_content || ''
            return ''
          })
          .filter(Boolean)
          .join('\n')
        this.pushMessageItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
        return
      }
      default:
        if (item.role !== undefined || item.content !== undefined) {
          this.pushMessageItem(item)
        } else if (this.pendingMedia.length === 0) {
          this.flushPendingToolCalls()
        }
        return
    }
  }

  finish() {
    // 后到的 assistant 工具调用批量排在更早的媒体结果之前，媒体先出。
    flushPendingChatToolMedia(this.messages, this.pendingMedia)
    this.flushPendingToolCalls()
    this.attachPendingReasoningToPreviousAssistant()
    // thinking 上游（Kimi/DeepSeek）要求每条带 tool_calls 的 assistant 消息都带非空
    // reasoning_content，否则 400。跨轮历史恢复不到真实思考时补占位。
    for (const message of this.messages) {
      if (message.role !== 'assistant') continue
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) continue
      message.reasoning_content = 'tool call'
    }
    return this.messages
  }
}

// Responses 请求体 -> Chat Completions 请求体。
function responsesToChatCompletions(body) {
  const toolContext = buildToolContext(body)
  const builder = new RequestBuilder(toolContext)

  if (body.instructions !== undefined) {
    const instructions = instructionText(body.instructions)
    if (instructions) builder.messages.push({ role: 'system', content: instructions })
  }

  if (typeof body.input === 'string') {
    builder.messages.push({ role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) builder.pushItem(item)
  } else if (body.input && typeof body.input === 'object') {
    builder.pushItem(body.input)
  }

  const result = {}
  if (body.model !== undefined) result.model = body.model
  result.messages = collapseSystemMessagesToHead(builder.finish())

  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens
  for (const key of ['temperature', 'top_p', 'stream']) {
    if (body[key] !== undefined) result[key] = body[key]
  }

  if (body.reasoning && typeof body.reasoning === 'object' && body.reasoning.effort !== undefined) {
    result.reasoning_effort = body.reasoning.effort
  }

  if (toolContext.chatTools.length > 0) result.tools = toolContext.chatTools
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoiceToChat(body.tool_choice, toolContext)

  if (body.parallel_tool_calls !== undefined) result.parallel_tool_calls = body.parallel_tool_calls

  for (const key of [
    'conversation_id',
    'frequency_penalty',
    'logit_bias',
    'logprobs',
    'metadata',
    'n',
    'presence_penalty',
    // codex 每会话稳定下发，Chat 上游（如 WorkBuddy 网关）据此复用前缀缓存；
    // 丢掉它会让上游退回按账号/空会话建键，多会话互相踩缓存。
    'prompt_cache_key',
    'response_format',
    'seed',
    'service_tier',
    'stop',
    'stream_options',
    'top_logprobs',
    'user',
  ]) {
    if (body[key] !== undefined) result[key] = body[key]
  }

  // 严格上游在 tools 为空时会拒绝 tool_choice / parallel_tool_calls。
  if (!Array.isArray(result.tools) || result.tools.length === 0) {
    delete result.tool_choice
    delete result.parallel_tool_calls
  }

  // codex 的 prompt_cache_key 是会话内稳定的 thread UUID。上游网关（WorkBuddy2API）
  // 用它做前缀缓存键，但「会话粘性选号」只认 conversation_id/user_id —— 不补这一项，
  // 每次请求会被分配到不同账号，缓存键虽同、账号不同，前缀缓存永远 miss。
  if (typeof result.prompt_cache_key === 'string' && result.prompt_cache_key && result.conversation_id === undefined) {
    result.conversation_id = result.prompt_cache_key
  }

  // 流式下上游默认不回 usage，必须显式声明，否则 token / 成本 / 缓存全部漏记。
  if (result.stream === true) {
    result.stream_options = { ...(result.stream_options || {}), include_usage: true }
  }

  return { body: result, toolContext }
}

// ========== 响应方向（非流式）：Chat -> Responses ==========

function responseToolCallItemIdFromChatName(callId, chatName, toolContext) {
  return (toolContext.isCustomTool(chatName) ? 'ctc_' : 'fc_') + callId
}

function parseToolArgumentsObject(argumentsText) {
  const trimmed = String(argumentsText || '').trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
  } catch (_) {}
  return { query: argumentsText }
}

function customToolInputFromChatArguments(argumentsText) {
  const trimmed = String(argumentsText || '').trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return typeof parsed[CUSTOM_TOOL_INPUT_FIELD] === 'string' ? parsed[CUSTOM_TOOL_INPUT_FIELD] : argumentsText
    }
  } catch (_) {}
  return argumentsText
}

function responseToolCallItemFromChatName(itemId, status, callId, chatName, args, reasoning, toolContext) {
  const spec = toolContext.lookup(chatName)
  let item

  if (spec && spec.kind === TOOL_KIND_TOOL_SEARCH) {
    item = {
      type: 'tool_search_call',
      call_id: callId,
      status,
      execution: 'client',
      arguments: parseToolArgumentsObject(args),
    }
  } else if (spec && spec.kind === TOOL_KIND_CUSTOM) {
    item = {
      id: itemId,
      type: 'custom_tool_call',
      status,
      call_id: callId,
      name: spec.name,
      input: customToolInputFromChatArguments(args),
    }
  } else {
    const name = spec ? spec.name : chatName
    item = {
      id: itemId,
      type: 'function_call',
      status,
      call_id: callId,
      name,
      arguments: args,
    }
    if (spec && spec.namespace) item.namespace = spec.namespace
  }

  if (typeof reasoning === 'string' && reasoning.trim()) item.reasoning_content = reasoning.trim()
  markFunctionCallArgsPlaintext(item)
  return item
}

function chatReasoningText(message) {
  const direct = extractReasoningFieldText(message)
  if (direct) return direct
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content)
    if (split && split[0]) return split[0]
  }
  return null
}

function chatMessageToResponseOutputItem(message, responseId) {
  const content = []
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content)
    const text = split ? split[1] : message.content
    if (text) content.push({ type: 'output_text', text, annotations: [] })
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue
      if ((part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string' && part.text) {
        content.push({ type: 'output_text', text: part.text, annotations: [] })
      } else if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal) {
        content.push({ type: 'refusal', refusal: part.refusal })
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal) {
    content.push({ type: 'refusal', refusal: message.refusal })
  }
  if (content.length === 0) return null
  return {
    id: responseId + '_msg',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content,
  }
}

// Chat 非流式响应 -> Responses 响应体。
function chatCompletionToResponse(body, toolContext) {
  const choices = Array.isArray(body.choices) ? body.choices : null
  if (!choices || choices.length === 0) throw new Error('No choices in chat response')
  const choice = choices[0]
  const message = choice.message
  if (!message) throw new Error('No message in chat choice')

  const responseId = responseIdFromChatId(body.id)
  const finishReason = choice.finish_reason === undefined ? null : choice.finish_reason
  const reasoning = chatReasoningText(message)

  const output = []
  if (reasoning) {
    output.push({
      id: 'rs_' + responseId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }],
    })
  }
  const messageItem = chatMessageToResponseOutputItem(message, responseId)
  if (messageItem) output.push(messageItem)

  const toolCalls = []
  let dropped = 0
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((toolCall, index) => {
      const fn = toolCall.function || {}
      const name = typeof fn.name === 'string' ? fn.name : ''
      if (!name.trim()) {
        dropped++
        return
      }
      const callId = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : 'call_' + index
      const args = canonicalizeToolArguments(fn.arguments)
      toolCalls.push(
        responseToolCallItemFromChatName(
          responseToolCallItemIdFromChatName(callId, name, toolContext),
          'completed',
          callId,
          name,
          args,
          reasoning,
          toolContext
        )
      )
    })
  } else if (message.function_call) {
    const name = typeof message.function_call.name === 'string' ? message.function_call.name : ''
    if (!name.trim()) {
      dropped++
    } else {
      const callId = typeof message.function_call.id === 'string' && message.function_call.id ? message.function_call.id : 'call_0'
      const args = canonicalizeToolArguments(message.function_call.arguments)
      toolCalls.push(
        responseToolCallItemFromChatName(
          responseToolCallItemIdFromChatName(callId, name, toolContext),
          'completed',
          callId,
          name,
          args,
          reasoning,
          toolContext
        )
      )
    }
  }

  // 丢过工具调用且最终一个都不剩时，codex 会收到「completed 但无工具调用」的回合而
  // 静默收尾。如实报错，不谎报成功。只对 completed 生效：length 是截断，缺 name 是
  // 截断的后果，报成工具调用丢弃会给出错误归因。
  if (responseStatusFromFinishReason(finishReason) === 'completed' && dropped > 0 && toolCalls.length === 0) {
    throw new Error(
      'Upstream returned ' + dropped + ' tool call(s) without a function name, leaving no usable tool call in this turn'
    )
  }
  for (const item of toolCalls) output.push(item)

  const response = {
    id: responseId,
    object: 'response',
    created_at: typeof body.created === 'number' ? body.created : 0,
    status: responseStatusFromFinishReason(finishReason),
    model: body.model || '',
    output,
    usage: chatUsageToResponsesUsage(body.usage),
  }
  if (finishReason === 'length') response.incomplete_details = { reason: 'max_output_tokens' }
  return response
}

// ========== 响应方向（流式）：Chat SSE -> Responses SSE ==========

const INLINE_THINK_DETECTING = 'detecting'
const INLINE_THINK_REASONING = 'reasoning'
const INLINE_THINK_TEXT = 'text'

class ChatToResponsesStream {
  constructor(toolContext) {
    this.toolContext = toolContext || new ToolContext()
    this.responseStarted = false
    this.completed = false
    this.responseId = 'resp_aiproxy'
    this.model = ''
    this.createdAt = 0
    this.nextOutputIndex = 0
    this.text = { outputIndex: null, itemId: '', text: '', added: false, done: false }
    this.reasoning = { outputIndex: null, itemId: '', text: '', added: false, done: false }
    this.inlineThink = { mode: INLINE_THINK_DETECTING, buffer: '' }
    this.tools = new Map()
    this.nextToolIndexToAdd = 0
    this.outputItems = []
    this.latestUsage = null
    this.finishReason = null
    this.droppedToolCalls = 0
  }

  nextOutputIndex_() {
    const index = this.nextOutputIndex
    this.nextOutputIndex += 1
    return index
  }

  baseResponse(status, output) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.latestUsage || chatUsageToResponsesUsage(null),
    }
  }

  ensureResponseStarted() {
    if (this.responseStarted) return []
    this.responseStarted = true
    const response = this.baseResponse('in_progress', [])
    return [sseEvent('response.created', { type: 'response.created', response }), sseEvent('response.in_progress', { type: 'response.in_progress', response })]
  }

  pushReasoningDelta(delta) {
    const events = []
    if (!this.reasoning.added) {
      const outputIndex = this.nextOutputIndex_()
      const itemId = 'rs_' + this.responseId
      this.reasoning.outputIndex = outputIndex
      this.reasoning.itemId = itemId
      this.reasoning.added = true
      events.push(
        sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
        })
      )
      events.push(
        sseEvent('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        })
      )
    }
    this.reasoning.text += delta
    events.push(
      sseEvent('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: this.reasoning.itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        delta,
      })
    )
    return events
  }

  pushTextDelta(delta) {
    const events = []
    if (!this.text.added) {
      const outputIndex = this.nextOutputIndex_()
      const itemId = this.responseId + '_msg'
      this.text.outputIndex = outputIndex
      this.text.itemId = itemId
      this.text.added = true
      events.push(
        sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        })
      )
      events.push(
        sseEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      )
    }
    this.text.text += delta
    events.push(
      sseEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: this.text.itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        delta,
      })
    )
    return events
  }

  currentReasoningText() {
    return this.reasoning.text.trim() ? this.reasoning.text.trim() : null
  }

  drainCompleteInlineThink() {
    const split = splitLeadingThinkBlock(this.inlineThink.buffer)
    if (!split) return []
    this.inlineThink.mode = INLINE_THINK_TEXT
    this.inlineThink.buffer = ''
    const events = []
    if (split[0]) {
      events.push(...this.pushReasoningDelta(split[0]))
      events.push(...this.finalizeReasoning())
    }
    if (split[1]) events.push(...this.pushTextDelta(split[1]))
    return events
  }

  pushContentDelta(delta) {
    if (this.inlineThink.mode === INLINE_THINK_TEXT) {
      return [...this.finalizeReasoning(), ...this.pushTextDelta(delta)]
    }
    if (this.inlineThink.mode === INLINE_THINK_DETECTING) {
      this.inlineThink.buffer += delta
      const decision = leadingThinkPrefixDecision(this.inlineThink.buffer)
      if (decision === 'need_more') return []
      if (decision === 'reasoning') {
        this.inlineThink.mode = INLINE_THINK_REASONING
        return this.drainCompleteInlineThink()
      }
      this.inlineThink.mode = INLINE_THINK_TEXT
      const text = this.inlineThink.buffer
      this.inlineThink.buffer = ''
      return [...this.finalizeReasoning(), ...this.pushTextDelta(text)]
    }
    this.inlineThink.buffer += delta
    return this.drainCompleteInlineThink()
  }

  // 工具调用到来时冲刷内联思考缓冲。
  flushInlineThinkAtBoundary() {
    if (this.inlineThink.mode === INLINE_THINK_TEXT) return []
    if (this.inlineThink.mode === INLINE_THINK_DETECTING) {
      this.inlineThink.mode = INLINE_THINK_TEXT
      const text = this.inlineThink.buffer
      this.inlineThink.buffer = ''
      if (!text) return []
      return [...this.finalizeReasoning(), ...this.pushTextDelta(text)]
    }
    const buffered = this.inlineThink.buffer
    this.inlineThink.buffer = ''
    this.inlineThink.mode = INLINE_THINK_TEXT
    const split = splitLeadingThinkBlock(buffered)
    if (split) {
      const events = []
      if (split[0]) {
        events.push(...this.pushReasoningDelta(split[0]))
        events.push(...this.finalizeReasoning())
      }
      if (split[1]) events.push(...this.pushTextDelta(split[1]))
      return events
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) || buffered
    if (!reasoning) return []
    return [...this.pushReasoningDelta(reasoning), ...this.finalizeReasoning()]
  }

  appendReasoningToActiveTools(delta) {
    if (!delta || !delta.trim()) return
    for (const state of this.tools.values()) {
      if (state.done) continue
      if (!state.reasoningContent) state.reasoningContent = delta.replace(/^\s+/, '')
      else state.reasoningContent += delta
    }
  }

  // 上游未下发 `index` 时的 key 解析。index 在 Chat 协议里必填，但部分网关会省略。
  // 只在能确证是新调用时才分配新 key（delta 带非空 id 且该 id 未知）；其余一律并入
  // 最后一个已知 key —— 宁可两个并行调用坍缩，也不能把续帧炸成多个 item。
  resolveToolKeyWithoutIndex(toolCall) {
    const keys = [...this.tools.keys()]
    const lastKey = keys.length ? keys[keys.length - 1] : null
    const id = typeof toolCall.id === 'string' && toolCall.id ? toolCall.id : null
    if (!id) return lastKey === null ? 0 : lastKey
    for (const [key, state] of this.tools) {
      if (state.callId === id) return key
    }
    return lastKey === null ? 0 : lastKey + 1
  }

  pushToolCallDelta(toolCall, reasoning) {
    const chatIndex =
      typeof toolCall.index === 'number' ? toolCall.index : this.resolveToolKeyWithoutIndex(toolCall)
    const fn = toolCall.function || {}
    const idDelta = typeof toolCall.id === 'string' ? toolCall.id : null
    const nameDelta = typeof fn.name === 'string' ? fn.name : null
    const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : ''

    let state = this.tools.get(chatIndex)
    if (!state) {
      state = {
        outputIndex: null,
        itemId: '',
        callId: '',
        name: '',
        arguments: '',
        reasoningContent: '',
        added: false,
        done: false,
      }
      this.tools.set(chatIndex, state)
    }

    if (idDelta) state.callId = idDelta
    if (nameDelta) state.name = nameDelta
    if (argsDelta) state.arguments += argsDelta
    if (!state.reasoningContent && reasoning && reasoning.trim()) state.reasoningContent = reasoning.trim()

    const events = []
    if (argsDelta && !this.toolContext.isCustomTool(state.name) && state.added) {
      events.push(
        sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: state.itemId,
          output_index: state.outputIndex,
          delta: argsDelta,
        })
      )
    }
    events.push(...this.flushReadyToolCalls())
    return events
  }

  // 按 chat index 升序放行已能确定身份（call_id + name 齐备）的调用，
  // 保证并行调用在 name 后到时仍按原始顺序产出。
  flushReadyToolCalls() {
    const events = []
    for (;;) {
      const key = this.nextToolIndexToAdd
      const state = this.tools.get(key)
      if (!state) break
      if (state.added || state.done) {
        this.nextToolIndexToAdd += 1
        continue
      }
      if (!state.callId || !state.name) break

      const assigned = this.nextOutputIndex_()
      state.added = true
      state.outputIndex = assigned
      state.itemId = responseToolCallItemIdFromChatName(state.callId, state.name, this.toolContext)
      const item = responseToolCallItemFromChatName(
        state.itemId,
        'in_progress',
        state.callId,
        state.name,
        '',
        state.reasoningContent,
        this.toolContext
      )
      events.push(sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item }))
      if (state.arguments && !this.toolContext.isCustomTool(state.name)) {
        events.push(
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: state.itemId,
            output_index: assigned,
            delta: state.arguments,
          })
        )
      }
      this.nextToolIndexToAdd += 1
    }
    return events
  }

  handleChatChunk(chunk) {
    const events = []
    if (typeof chunk.id === 'string' && chunk.id) this.responseId = responseIdFromChatId(chunk.id)
    if (typeof chunk.model === 'string' && chunk.model) this.model = chunk.model
    if (typeof chunk.created === 'number') this.createdAt = chunk.created

    events.push(...this.ensureResponseStarted())

    if (chunk.usage !== undefined && chunk.usage !== null) {
      this.latestUsage = chatUsageToResponsesUsage(chunk.usage)
    }

    const choice = Array.isArray(chunk.choices) && chunk.choices.length ? chunk.choices[0] : null
    if (!choice) return events

    const delta = choice.delta
    if (delta) {
      const reasoning = extractReasoningFieldText(delta)
      if (reasoning) {
        events.push(...this.pushReasoningDelta(reasoning))
        this.appendReasoningToActiveTools(reasoning)
      }

      if (typeof delta.content === 'string' && delta.content) {
        events.push(...this.pushContentDelta(delta.content))
      }

      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        events.push(...this.flushInlineThinkAtBoundary())
        const reasoningForToolCall = this.currentReasoningText()
        events.push(...this.finalizeReasoning())
        for (const toolCall of delta.tool_calls) {
          events.push(...this.pushToolCallDelta(toolCall, reasoningForToolCall))
        }
      }
    }

    if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
      this.finishReason = choice.finish_reason
    }
    return events
  }

  finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return []
    const itemId = this.reasoning.itemId
    const text = this.reasoning.text
    const item = { id: itemId, type: 'reasoning', summary: [{ type: 'summary_text', text }] }
    const events = [
      sseEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        text,
      }),
      sseEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: itemId,
        output_index: this.reasoning.outputIndex,
        summary_index: 0,
        part: { type: 'summary_text', text },
      }),
      sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: this.reasoning.outputIndex, item }),
    ]
    this.outputItems.push([this.reasoning.outputIndex, item])
    this.reasoning.done = true
    return events
  }

  finalizeText() {
    if (!this.text.added || this.text.done) return []
    const itemId = this.text.itemId
    const text = this.text.text
    const item = {
      id: itemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    const events = [
      sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        text,
      }),
      sseEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: this.text.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      }),
      sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: this.text.outputIndex, item }),
    ]
    this.outputItems.push([this.text.outputIndex, item])
    this.text.done = true
    return events
  }

  finalizeTools() {
    const events = []
    for (const key of [...this.tools.keys()]) {
      const state = this.tools.get(key)
      if (!state || state.done) continue

      // 纯空白名与空名同等对待：它对应不到任何已发布工具，若被当作「本回合还有工具调用」
      // 就会绕过下面的失败判据。
      if (!state.name || !state.name.trim()) {
        state.done = true
        this.droppedToolCalls += 1
        continue
      }

      if (!state.added) {
        const assigned = this.nextOutputIndex_()
        state.added = true
        if (!state.callId) state.callId = 'call_' + key
        state.outputIndex = assigned
        state.itemId = responseToolCallItemIdFromChatName(state.callId, state.name, this.toolContext)
        const item = responseToolCallItemFromChatName(
          state.itemId,
          'in_progress',
          state.callId,
          state.name,
          '',
          state.reasoningContent,
          this.toolContext
        )
        events.push(sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item }))
      }

      const args = canonicalizeToolArgumentsStr(state.arguments)
      const isCustom = this.toolContext.isCustomTool(state.name)
      const item = responseToolCallItemFromChatName(
        state.itemId,
        'completed',
        state.callId,
        state.name,
        args,
        state.reasoningContent,
        this.toolContext
      )
      state.done = true
      this.outputItems.push([state.outputIndex, item])

      if (isCustom) {
        const input = customToolInputFromChatArguments(args)
        if (input) {
          events.push(
            sseEvent('response.custom_tool_call_input.delta', {
              type: 'response.custom_tool_call_input.delta',
              item_id: state.itemId,
              output_index: state.outputIndex,
              delta: input,
            })
          )
        }
        events.push(
          sseEvent('response.custom_tool_call_input.done', {
            type: 'response.custom_tool_call_input.done',
            item_id: state.itemId,
            output_index: state.outputIndex,
            input,
          })
        )
      } else {
        events.push(
          sseEvent('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            item_id: state.itemId,
            output_index: state.outputIndex,
            arguments: args,
          })
        )
      }
      events.push(sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: state.outputIndex, item }))
    }
    return events
  }

  completedOutputItems() {
    return this.outputItems.slice().sort((a, b) => a[0] - b[0]).map(entry => entry[1])
  }

  hasSubstantiveOutput() {
    if (this.text.text.trim()) return true
    if (this.reasoning.text.trim()) return true
    if (this.inlineThink.buffer.trim()) return true
    if (this.outputItems.length) return true
    for (const state of this.tools.values()) {
      if (state.added || state.callId.trim() || state.name.trim() || state.arguments.trim() || state.reasoningContent.trim()) {
        return true
      }
    }
    return false
  }

  hasEmittedToolCall() {
    return this.outputItems.some(entry => {
      const type = entry[1].type
      return type === 'function_call' || type === 'custom_tool_call' || type === 'tool_search_call'
    })
  }

  failedEvent(message, errorType) {
    this.completed = true
    const error = { message }
    if (errorType) error.type = errorType
    const response = this.baseResponse('failed', this.completedOutputItems())
    response.error = error
    return sseEvent('response.failed', { type: 'response.failed', response })
  }

  finalize() {
    if (this.completed) return []
    const events = []
    events.push(...this.ensureResponseStarted())
    events.push(...this.flushInlineThinkAtBoundary())
    events.push(...this.finalizeReasoning())
    events.push(...this.finalizeText())
    events.push(...this.finalizeTools())

    const status = responseStatusFromFinishReason(this.finishReason)

    // 丢过工具调用且一个都没剩下时，codex 会收到「completed 但无工具调用」的回合并
    // 静默收尾。如实报错。只对 completed 生效：length 是截断，缺 name 是截断的后果。
    if (status === 'completed' && this.droppedToolCalls > 0 && !this.hasEmittedToolCall()) {
      events.push(
        this.failedEvent(
          'Upstream returned ' + this.droppedToolCalls + ' tool call(s) without a function name, leaving no usable tool call in this turn',
          'upstream_tool_call_dropped'
        )
      )
      return events
    }

    const response = this.baseResponse(status, this.completedOutputItems())
    if (status === 'incomplete') response.incomplete_details = { reason: 'max_output_tokens' }
    events.push(sseEvent('response.completed', { type: 'response.completed', response }))
    this.completed = true
    return events
  }

  // 流结束（无 finish_reason 时按截断处理）。
  finish() {
    if (this.completed) return []
    if (this.finishReason !== null) return this.finalize()
    if (this.hasSubstantiveOutput()) {
      this.finishReason = 'length'
      return this.finalize()
    }
    return [
      this.failedEvent(
        'Upstream Chat Completions stream ended before sending finish_reason',
        'stream_truncated'
      ),
    ]
  }
}

function extractChatSseError(value) {
  const error = value && value.error !== undefined ? value.error : value
  let message
  if (typeof error === 'string') message = error
  else if (error && typeof error === 'object') {
    message = error.message || error.detail || JSON.stringify(error)
  } else {
    message = String(error)
  }
  let errorType = null
  if (error && typeof error === 'object') {
    const raw = error.type !== undefined ? error.type : error.code
    if (typeof raw === 'string') errorType = raw
  }
  return [message, errorType]
}

module.exports = {
  ToolContext,
  buildToolContext,
  responsesToChatCompletions,
  chatCompletionToResponse,
  ChatToResponsesStream,
  extractChatSseError,
  customToolInputFromChatArguments,
  responseToolCallItemIdFromChatName,
  responseToolCallItemFromChatName,
  responsesToolChoiceToChat,
}
