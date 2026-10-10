// codex multi-agent v2 兼容层：让「自定义 Responses 提供方」链路下的子代理能收到任务正文。
//
// 背景（2026-08-07 实测定位，codex rust-v0.146.0 源码核实）：
// codex 的 collab 工具路由（core/src/tools/router.rs direct_source）只在工具调用的
// function_call 项同时带 namespace: "collaboration"（命名空间标记）与
// encrypted_function_args: []（空数组 = 「参数是明文」标记）时，
// 才把 spawn_agent / send_message / followup_task 的 message 走明文通道投递给子代理；
// 字段缺失（None）则走 InterAgentCommunication::new_encrypted —— 把任务正文包进
// encrypted_content 内容块（core/src/tools/handlers/multi_agents_v2.rs）。
// DeepSeek / MiniMax 等自定义提供方这两个字段都不回传，且它们的模型不识别
// encrypted_content 内容块 → 子代理永远只看到 "…Payload:\n" 空载荷，齐答「没收到任务」。
// OpenAI 官方 ZDR（store=false）流程无此问题（服务端回传并解密）。
//
// 本模块做两件事：
//  1) 响应侧：给 function_call 项补 encrypted_function_args: []，collab 三工具另补
//     namespace: "collaboration" —— 上游返回的本来就是明文 arguments，这两个标记只是
//     「如实声明」；codex 读到后即走明文投递通道。
//     该字段对非 collab 工具调用是惰性的（codex 仅 collab 路由读取它），安全。
//  2) 请求侧：把历史里已被误标的 encrypted_content 内容块还原为 input_text /
//     output_text —— 让已被污染的子代理线程（resume 场景）重新对上游模型可读。
//     本链路只面向非 OpenAI 上游，encrypted_content 不会出现真密文，还原安全。

/**
 * 给 payload 里的 function_call 项补 direct_source 明文投递所需的两个标记（幂等）：
 *  ① encrypted_function_args: [] —— 「参数是明文」声明（上游返回的本来就是明文 arguments）；
 *  ② namespace: 'collaboration' —— collab 工具命名空间（OpenAI 官方流程模型会回传，
 *     DeepSeek 不回传；router.rs direct_source 两个条件缺一不可，否则走加密包装）。
 * 覆盖：output_item.added/done 的 item、response.completed 的 response.output、
 * 非流式整响应的 output 数组。返回本次补齐的项数。
 */
const COLLAB_NAMESPACE = 'collaboration'
const COLLAB_PLAINTEXT_TOOLS = new Set(['spawn_agent', 'send_message', 'followup_task'])

function markFunctionCallArgsPlaintext(payload) {
  let patched = 0
  const mark = (item) => {
    if (!item || typeof item !== 'object' || item.type !== 'function_call') return
    let changed = false
    if (item.encrypted_function_args === undefined) {
      item.encrypted_function_args = []
      changed = true
    }
    if (COLLAB_PLAINTEXT_TOOLS.has(item.name) && item.namespace === undefined) {
      item.namespace = COLLAB_NAMESPACE
      changed = true
    }
    if (changed) patched += 1
  }
  if (!payload || typeof payload !== 'object') return 0
  if (payload.item) mark(payload.item)
  if (Array.isArray(payload.output)) payload.output.forEach(mark)
  const resp = payload.response
  if (resp && Array.isArray(resp.output)) resp.output.forEach(mark)
  return patched
}

/**
 * 整响应 JSON 文本补齐（非流式直通用）：parse 失败或无改动时返回原文。
 */
function patchJsonText(text) {
  let payload
  try { payload = JSON.parse(text) } catch (_) { return { text, patched: 0 } }
  const patched = markFunctionCallArgsPlaintext(payload)
  return { text: patched > 0 ? JSON.stringify(payload) : text, patched }
}

/**
 * Responses SSE 流改写器（Responses 直通路由用）：按空行切帧、逐帧解析 data: 负载，
 * 仅对含 function_call 项的帧做补齐，其余帧字节原样透传（含 event:/id:/retry:/注释行）。
 * mode 取自上游 content-type：
 *   'sse'  text/event-stream —— 逐帧增量改写
 *   'json' application/json  —— 非流式整响应，end() 一次性处理
 *   'raw'  其它/未知        —— 完全不动（安全降级）
 */
class SsePlaintextArgsInjector {
  constructor(mode) {
    this.mode = mode === 'sse' || mode === 'json' ? mode : 'raw'
    this.buf = ''
    this.patchedCount = 0
  }

  /** 喂上游 chunk，返回可写给下游的字节（可能为空串）。 */
  feed(chunk) {
    if (this.mode === 'raw') return chunk
    this.buf += chunk.toString('utf8')
    if (this.mode === 'json') return ''
    let out = ''
    let m
    // SSE 帧以空行结尾；尾帧可能不完整，留在缓冲里等下一个 chunk
    while ((m = this.buf.match(/\r?\n\r?\n/))) {
      const idx = m.index
      const block = this.buf.slice(0, idx)
      const sep = m[0]
      this.buf = this.buf.slice(idx + sep.length)
      out += this._processBlock(block) + sep
    }
    return out
  }

  /** 流结束：冲刷残尾（json 模式在此一次性补齐）。 */
  end() {
    if (this.mode === 'raw') return ''
    const tail = this.buf
    this.buf = ''
    if (!tail) return ''
    if (this.mode === 'json') {
      const r = patchJsonText(tail)
      this.patchedCount += r.patched
      return r.text
    }
    if (!tail.trim()) return tail
    // 上游理应按空行收尾；残尾容错按一帧处理并补结束空行
    return this._processBlock(tail) + '\n\n'
  }

  _processBlock(block) {
    const lines = block.split(/\r?\n/)
    const dataLines = []
    const otherLines = []
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
      else otherLines.push(line)
    }
    // 心跳/注释帧（无 data）原样透传
    if (dataLines.length === 0) return block
    let payload
    try { payload = JSON.parse(dataLines.join('\n')) } catch (_) { return block }
    const patched = markFunctionCallArgsPlaintext(payload)
    if (patched === 0) return block
    this.patchedCount += patched
    return [...otherLines, 'data: ' + JSON.stringify(payload)].join('\n')
  }
}

/**
 * 请求侧净化：把 body.input 里 message/agent_message 项的 encrypted_content 内容块
 * 还原为文本块（assistant 角色 → output_text，其余 → input_text）。返回还原块数。
 * 只处理「明文误标」形态（encrypted_content 是字符串）；真密文场景不在本链路。
 */
function sanitizeEncryptedContentInInput(body) {
  if (!body || !Array.isArray(body.input)) return 0
  let converted = 0
  for (const item of body.input) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.content)) continue
    const textType = item.role === 'assistant' ? 'output_text' : 'input_text'
    for (let i = 0; i < item.content.length; i++) {
      const c = item.content[i]
      if (c && typeof c === 'object' && c.type === 'encrypted_content' && typeof c.encrypted_content === 'string') {
        item.content[i] = { type: textType, text: c.encrypted_content }
        converted += 1
      }
    }
  }
  return converted
}

/**
 * 请求侧：把 agent_message 输入项降级为普通 message 项。
 *
 * 背景（2026-09-10 实测定位）：codex multi-agent v2 把「子代理任务」和「子代理回报」
 * 都以 Responses 输入项 {"type":"agent_message", author, recipient, content} 下发
 * （codex-rs/protocol/src/models.rs 的 ResponseItem::AgentMessage；走的明文通道时
 * 正文已由 codex 渲染成 "Message Type: NEW_TASK / Task name / Sender / Payload:" 信封）。
 * OpenAI 官方上游认这个类型，DeepSeek / MiniMax 等第三方 Responses 实现会**静默丢弃整项**：
 * 实测同一条请求，input 里放 agent_message → input_tokens≈3（正文完全不计入，模型看不到）；
 * 换成普通 message + input_text → input_tokens 正常且模型能复述正文（直连 api.deepseek.com
 * 结果一致，故丢弃发生在上游而非本代理）。后果：子代理收���到任务（答「没收到任务」/「inbox is empty」），
 * 主线程同样读不到子代理的 FINAL_ANSWER。
 *
 * 本函数就地改写：agent_message → { type:'message', role:'user', content:[{type:'input_text'}] }，
 * 文本原样保留（多块按序拼接），丢弃上游不认的 amsg_ id / author / recipient 字段，数组顺序不变。
 * 幂等：改写后不再含 agent_message，重复调用无副作用。返回改写的项数。
 */
function downgradeAgentMessageItems(body) {
  if (!body || !Array.isArray(body.input)) return 0
  let converted = 0
  for (let i = 0; i < body.input.length; i++) {
    const item = body.input[i]
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') continue
    const blocks = Array.isArray(item.content) ? item.content : []
    let text = ''
    for (const c of blocks) {
      if (typeof c === 'string') text += c
      else if (c && typeof c === 'object' && typeof c.text === 'string') text += c.text
    }
    body.input[i] = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    }
    converted += 1
  }
  return converted
}

/**
 * 请求侧：子代理聚合兜底。
 *
 * 背景：codex multi-agent v2 下，子代理执行完毕后结果以 function_call_output 回到
 * 主线程 input 历史。OpenAI 官方流程模型会主动 wait 并聚合；DeepSeek/MiniMax
 * 等自定义提供方模型不主动聚合 → 主线程直接旁白收尾，子代理结论丢失。
 *
 * 本函数检测「input 尾部存在 collab 工具（spawn_agent/send_message/followup_task）
 * 的 function_call_output」这一信号——说明主线程即将在子代理结果之上生成下一轮
 * 回复。此时追加一条 user 消息，明确指示模型读取并聚合子代理结果。
 *
 * 幂等：用标记短语 SUBAGENT_AGG_HINT 防止 resume/重试时重复注入。
 * 安全：纯请求侧文本注入，不改响应流、不依赖线程标识；非 collab 工具输出不触发。
 * 返回注入的提示条数（0 或 1）。
 */
const SUBAGENT_AGG_HINT = '[cyberslots:subagent-agg]'

function injectSubagentAggregationHint(body) {
  if (!body || !Array.isArray(body.input) || body.input.length === 0) return 0
  const items = body.input

  // 收集 collab 工具的 call_id（function_call 项）
  const collabCallIds = new Set()
  for (const item of items) {
    if (item && typeof item === 'object' && item.type === 'function_call' &&
        COLLAB_PLAINTEXT_TOOLS.has(item.name)) {
      const cid = item.call_id || item.id
      if (cid) collabCallIds.add(cid)
    }
  }
  if (collabCallIds.size === 0) return 0

  // 从尾部向前找：最后一条非 reasoning 项是否是 collab 工具的 function_call_output
  // （可能紧跟 reasoning 项，跳过它们看实质最后一项）
  let lastSubstantiveIdx = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (!it || typeof it !== 'object') continue
    if (it.type === 'reasoning') continue
    lastSubstantiveIdx = i
    break
  }
  if (lastSubstantiveIdx < 0) return 0

  const lastItem = items[lastSubstantiveIdx]
  if (lastItem.type !== 'function_call_output') return 0
  const lastCallId = lastItem.call_id || lastItem.id
  if (!lastCallId || !collabCallIds.has(lastCallId)) return 0

  // 幂等：检查是否已注入过（最后几项里含标记短语）
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (!it || typeof it !== 'object') continue
    const text = typeof it.content === 'string'
      ? it.content
      : (Array.isArray(it.content)
          ? it.content.map(c => (c && typeof c.text === 'string') ? c.text : '').join('')
          : '')
    if (typeof it.output === 'string' && it.output.includes(SUBAGENT_AGG_HINT)) return 0
    if (text.includes(SUBAGENT_AGG_HINT)) return 0
    // 只看最后 3 项（hint 通常紧贴尾部注入）
    if (items.length - i > 3) break
  }

  // 追加聚合提示 user 消息
  const hint =
    SUBAGENT_AGG_HINT + '\n' +
    '上面的 function_call_output 包含子代理（subagent）返回的执行结果。' +
    '请在你的回复中读取并整合这些子代理结果的核心结论，不要忽略或跳过它们。' +
    '如果子代理结果包含代码改动、文件路径、错误诊断等关键信息，务必在你的最终回复中体现。'
  items.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: hint }],
  })
  return 1
}
module.exports = {
  markFunctionCallArgsPlaintext,
  patchJsonText,
  SsePlaintextArgsInjector,
  sanitizeEncryptedContentInInput,
  downgradeAgentMessageItems,
  injectSubagentAggregationHint,
}
