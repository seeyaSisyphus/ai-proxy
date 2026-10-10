// 开发期冒烟测试：anthropic-chat-bridge 的双向转换。
// 运行：node tmp-anthropic-bridge-test.js
'use strict'

const assert = require('assert')
const {
  anthropicToChatCompletions,
  openaiToAnthropic,
  ChatToAnthropicStream,
  cleanSchema,
  mapToolChoiceToChat,
  mapStopReason,
  resolveReasoningEffort,
  stripLeadingAnthropicBillingHeader,
} = require('./anthropic-chat-bridge')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (err) {
    failures++
    console.log('  FAIL ' + name + '\n       ' + err.message)
  }
}

function eventsOf(text) {
  return text
    .split('\n\n')
    .filter(block => block.trim())
    .map(block => {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      return line ? JSON.parse(line.slice(6)) : null
    })
    .filter(Boolean)
}

// 把 Chat SSE chunk 数组喂给转换器，返回全部 Anthropic SSE 事件。
function drive(chunks) {
  const stream = new ChatToAnthropicStream()
  let out = ''
  for (const raw of chunks) {
    const chunk = typeof raw === 'string' ? JSON.parse(raw) : raw
    for (const event of stream.handleChunk(chunk)) out += event
  }
  for (const event of stream.finish()) out += event
  return out
}

// 前缀分片拼接：避免工具链对整串字面量的显示折叠造成误读。
const HDR = 'x-anthropic-billing-' + 'header:'

console.log('\n== 请求方向 ==')

check('system 合并到首部 + 计费头剥离（LF）', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    system: HDR + ' cch=a7754;\n\nYou are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepStrictEqual(messages, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hi' },
  ])
})

check('计费头 CRLF 形态同样剥离干净（不留裸换行）', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    system: HDR + ' cch=a7754;\r\n\r\nYou are helpful.',
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.strictEqual(messages[0].content, 'You are helpful.')
})

check('system 数组分片：计费头片清空后不产生空 system', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    system: [
      { type: 'text', text: HDR + ' cch=a7754;\n' },
      { type: 'text', text: 'Stable prompt' },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  })
  assert.deepStrictEqual(messages[0], { role: 'system', content: 'Stable prompt' })
})

check('计费头出现在正文中间时原样保留（不误删用户内容）', () => {
  const body = 'Keep this literal:\n' + HDR + ' cch=a7754;\n\nBody'
  assert.strictEqual(stripLeadingAnthropicBillingHeader(body), body)
})

check('tool_result -> 独立 tool 消息，且排在所属 assistant 之前', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: '{"temp":18}' },
          { type: 'text', text: 'thanks' },
        ],
      },
    ],
  })
  assert.strictEqual(messages[1].role, 'tool')
  assert.strictEqual(messages[1].tool_call_id, 'tu_1')
  assert.strictEqual(messages[1].content, '{"temp":18}')
  assert.strictEqual(messages[2].role, 'user')
  assert.strictEqual(messages[2].content, 'thanks')
})

check('tool_use -> assistant.tool_calls（arguments 规范化）', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'w', input: { b: 1, a: 2 } }],
      },
    ],
  })
  const call = messages[0].tool_calls[0]
  assert.strictEqual(call.id, 'tu_1')
  assert.strictEqual(call.function.name, 'w')
  assert.strictEqual(call.function.arguments, '{"a":2,"b":1}') // 键排序，跨轮字节稳定
})

check('thinking 块 -> assistant.reasoning_content（带 tool_calls 时必须非空）', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should call the tool.' },
          { type: 'tool_use', id: 'tu_1', name: 'w', input: {} },
        ],
      },
    ],
  })
  assert.strictEqual(messages[0].reasoning_content, 'I should call the tool.')
})

check('redacted_thinking -> 占位 reasoning_content', () => {
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'redacted_thinking', data: 'xxx' },
          { type: 'tool_use', id: 'tu_1', name: 'w', input: {} },
        ],
      },
    ],
  })
  assert.strictEqual(messages[0].reasoning_content, '[redacted thinking]')
})

check('工具 schema：根补 type=object、丢弃 format=uri、null description 省略', () => {
  const { tools } = anthropicToChatCompletions({
    model: 'm',
    messages: [],
    tools: [
      { name: 'a', input_schema: { properties: { x: { type: 'string', format: 'uri' } } } },
      { name: 'b', description: null, input_schema: { type: 'object' } },
    ],
  })
  assert.strictEqual(tools[0].function.parameters.type, 'object')
  assert.strictEqual(tools[0].function.parameters.properties.x.format, undefined)
  assert.strictEqual('description' in tools[1].function, false)
})

check('BatchTool 不下发', () => {
  const { tools } = anthropicToChatCompletions({
    model: 'm',
    messages: [],
    tools: [{ type: 'BatchTool', name: 'batch' }, { name: 'keep', input_schema: { type: 'object' } }],
  })
  assert.strictEqual(tools.length, 1)
  assert.strictEqual(tools[0].function.name, 'keep')
})

check('tool_choice: any -> required，tool -> function 对象', () => {
  assert.strictEqual(mapToolChoiceToChat('any'), 'required')
  assert.deepStrictEqual(mapToolChoiceToChat({ type: 'tool', name: 'w' }), {
    type: 'function',
    function: { name: 'w' },
  })
})

check('流式请求自动带 stream_options.include_usage', () => {
  const { stream_options } = anthropicToChatCompletions({
    model: 'm',
    messages: [],
    stream: true,
  })
  assert.deepStrictEqual(stream_options, { include_usage: true })
})

check('o 系模型用 max_completion_tokens', () => {
  const { max_completion_tokens, max_tokens } = anthropicToChatCompletions({
    model: 'o3-mini',
    max_tokens: 128,
    messages: [],
  })
  assert.strictEqual(max_completion_tokens, 128)
  assert.strictEqual(max_tokens, undefined)
})

check('工具输出中的图片摘到合成 user 消息（tool 消息保持文本）', () => {
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(9000)
  const { messages } = anthropicToChatCompletions({
    model: 'm',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(9000) } }],
          },
        ],
      },
    ],
  })
  const toolMsg = messages.find(m => m.role === 'tool')
  const mediaMsg = messages.find(m => m.role === 'user')
  assert.ok(toolMsg, 'tool 消息存在')
  assert.strictEqual(typeof toolMsg.content, 'string')
  assert.ok(!toolMsg.content.includes(dataUrl), 'tool 消息不含 base64')
  assert.ok(mediaMsg && Array.isArray(mediaMsg.content), '媒体挂到合成 user 消息')
  assert.strictEqual(mediaMsg.content[1].type, 'image_url')
})

console.log('\n== 思考深度（effort）解析 ==')

check('output_config.effort: low/medium/high/xhigh 一一对应', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh']) {
    assert.strictEqual(resolveReasoningEffort({ output_config: { effort: e } }), e)
  }
})

check('effort=max：支持独立 max 档的模型保留，其余退到 xhigh', () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) {
    assert.strictEqual(resolveReasoningEffort({ model, output_config: { effort: 'max' } }), 'max', model)
  }
  assert.strictEqual(resolveReasoningEffort({ model: 'gpt-5.4', output_config: { effort: 'max' } }), 'xhigh')
})

check('显式 effort 优先于 thinking', () => {
  assert.strictEqual(
    resolveReasoningEffort({ output_config: { effort: 'low' }, thinking: { type: 'adaptive' } }),
    'low'
  )
})

check('未知 effort 值不注入', () => {
  assert.strictEqual(resolveReasoningEffort({ output_config: { effort: 'turbo' } }), null)
})

check('thinking 预算分档：<4000 low / <16000 medium / 否则 high', () => {
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 1024 } }), 'low')
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 8000 } }), 'medium')
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'enabled', budget_tokens: 32000 } }), 'high')
})

check('thinking.adaptive -> xhigh；enabled 无预算 -> high；disabled -> 不注入', () => {
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'adaptive' } }), 'xhigh')
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'enabled' } }), 'high')
  assert.strictEqual(resolveReasoningEffort({ thinking: { type: 'disabled' } }), null)
})

check('解析结果落到请求体 reasoning_effort', () => {
  const { reasoning_effort } = anthropicToChatCompletions({
    model: 'm',
    messages: [],
    output_config: { effort: 'high' },
  })
  assert.strictEqual(reasoning_effort, 'high')
})

check('无任何 effort 信号时不注入 reasoning_effort', () => {
  const { reasoning_effort } = anthropicToChatCompletions({ model: 'm', messages: [] })
  assert.strictEqual(reasoning_effort, undefined)
})

check('metadata 透传（上游靠 user_id.session_id 做会话粘性）', () => {
  const metadata = { user_id: '{"session_id":"sess-1","device_id":"dev-1"}' }
  const { metadata: forwarded } = anthropicToChatCompletions({ model: 'm', messages: [], metadata })
  assert.deepStrictEqual(forwarded, metadata)
})

check('无 metadata 时不注入该字段', () => {
  const out = anthropicToChatCompletions({ model: 'm', messages: [] })
  assert.strictEqual('metadata' in out, false)
})

console.log('\n== 响应方向（非流式） ==')

check('正文 + 思考 -> text/thinking 块，stop_reason 映射', () => {
  const out = openaiToAnthropic({
    id: 'chatcmpl-1',
    model: 'm',
    choices: [
      {
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'hello', reasoning_content: 'thinking...' },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  })
  assert.deepStrictEqual(out.content, [
    { type: 'thinking', thinking: 'thinking...' },
    { type: 'text', text: 'hello' },
  ])
  assert.strictEqual(out.stop_reason, 'end_turn')
})

check('tool_calls -> tool_use 块，finish_reason=tool_calls -> tool_use', () => {
  const out = openaiToAnthropic({
    id: 'x',
    model: 'm',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: '{"a":1}' } }],
        },
      },
    ],
  })
  assert.strictEqual(out.stop_reason, 'tool_use')
  assert.deepStrictEqual(out.content, [{ type: 'tool_use', id: 'c1', name: 'w', input: { a: 1 } }])
})

check('usage：input = prompt - cache_read - cache_creation（三桶互斥）', () => {
  const out = openaiToAnthropic({
    id: 'x',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 },
    },
  })
  assert.strictEqual(out.usage.input_tokens, 100)
  assert.strictEqual(out.usage.cache_read_input_tokens, 800)
  assert.strictEqual(out.usage.cache_creation_input_tokens, 100)
  assert.strictEqual(out.usage.output_tokens, 50)
  assert.strictEqual(
    out.usage.input_tokens + out.usage.cache_read_input_tokens + out.usage.cache_creation_input_tokens,
    1000
  )
})

check('finish_reason 映射表', () => {
  assert.strictEqual(mapStopReason('stop'), 'end_turn')
  assert.strictEqual(mapStopReason('length'), 'max_tokens')
  assert.strictEqual(mapStopReason('tool_calls'), 'tool_use')
  assert.strictEqual(mapStopReason('function_call'), 'tool_use')
  assert.strictEqual(mapStopReason(null), null)
})

check('usage：direct 字段为 0 占位时回落到 details（上游实测形态）', () => {
  const out = openaiToAnthropic({
    id: 'x',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    usage: {
      prompt_tokens: 838,
      completion_tokens: 16,
      cache_read_input_tokens: 0, // 占位 0，真实命中在 details 里
      cache_creation_input_tokens: 0,
      cached_tokens: 0,
      prompt_cache_hit_tokens: 640,
      prompt_tokens_details: { cached_tokens: 640, cache_write_tokens: 0 },
    },
  })
  assert.strictEqual(out.usage.cache_read_input_tokens, 640)
  assert.strictEqual(out.usage.input_tokens, 198)
  assert.strictEqual(
    out.usage.input_tokens + out.usage.cache_read_input_tokens,
    838,
    '三桶恒等：input + cache_read == prompt_tokens'
  )
})

check('usage：direct 字段有真值时优先于 details', () => {
  const out = openaiToAnthropic({
    id: 'x',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 10,
      cache_read_input_tokens: 900,
      prompt_tokens_details: { cached_tokens: 100 },
    },
  })
  assert.strictEqual(out.usage.cache_read_input_tokens, 900)
  assert.strictEqual(out.usage.input_tokens, 100)
})

check('usage：无缓存时不下发 cache_read/cache_creation 字段', () => {
  const out = openaiToAnthropic({
    id: 'x',
    model: 'm',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
  })
  assert.strictEqual('cache_read_input_tokens' in out.usage, false)
  assert.strictEqual('cache_creation_input_tokens' in out.usage, false)
  assert.strictEqual(out.usage.input_tokens, 20)
})

console.log('\n== 响应方向（流式） ==')

check('流式：message_start 恰一次，text_delta 拼接', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}',
    '{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}',
  ])
  const events = eventsOf(out)
  const starts = events.filter(e => e.type === 'message_start')
  assert.strictEqual(starts.length, 1)
  const text = events
    .filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
    .map(e => e.delta.text)
    .join('')
  assert.strictEqual(text, 'Hello')
})

check('流式：thinking 与 text 各自成块且交替时正确关闭', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"think"}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
  ])
  const events = eventsOf(out)
  const blockTypes = events
    .filter(e => e.type === 'content_block_start')
    .map(e => e.content_block.type)
  assert.deepStrictEqual(blockTypes, ['thinking', 'text'])
  const stops = events.filter(e => e.type === 'content_block_stop').length
  assert.strictEqual(stops, 2, '两个块都要关闭')
})

check('流式：空字符串思考不产生碎片块', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"","content":"a"}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"","content":"b"},"finish_reason":"stop"}]}',
  ])
  const events = eventsOf(out)
  const blockTypes = events
    .filter(e => e.type === 'content_block_start')
    .map(e => e.content_block.type)
  assert.deepStrictEqual(blockTypes, ['text'], '只应有一个 text 块')
  const text = events
    .filter(e => e.type === 'content_block_delta' && e.delta.type === 'text_delta')
    .map(e => e.delta.text)
    .join('')
  assert.strictEqual(text, 'ab')
})

check('流式：工具调用 name 后到时先攒参数再补发，不丢参', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"arguments":"{\\"a\\""}}]}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"w","arguments":":1}"}}]},"finish_reason":"tool_calls"}]}',
  ])
  const events = eventsOf(out)
  const start = events.find(e => e.type === 'content_block_start')
  assert.strictEqual(start.content_block.type, 'tool_use')
  assert.strictEqual(start.content_block.name, 'w')
  const args = events
    .filter(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
    .map(e => e.delta.partial_json)
    .join('')
  assert.strictEqual(args, '{"a":1}')
})

check('流式：并行工具调用按 index 各自开块', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t0","arguments":"{}"}},{"index":1,"id":"b","function":{"name":"t1","arguments":"{}"}}]}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  ])
  const events = eventsOf(out)
  const blocks = events.filter(e => e.type === 'content_block_start').map(e => e.content_block.name)
  assert.deepStrictEqual(blocks, ['t0', 't1'])
  const stops = events.filter(e => e.type === 'content_block_stop').length
  assert.strictEqual(stops, 2)
})

check('流式：无限空白中止该工具调用（防上下文撑爆）', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"t0"}}]}}]}',
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"' + ' '.repeat(600) + '"}}]},"finish_reason":"tool_calls"}]}',
  ])
  const events = eventsOf(out)
  const args = events
    .filter(e => e.type === 'content_block_delta' && e.delta.type === 'input_json_delta')
    .map(e => e.delta.partial_json)
    .join('')
  assert.ok(args.length < 500, '空白不应被转发（实际 ' + args.length + '）')
})

check('流式：message_delta 恰一条，且 usage 用最后一个 chunk 的完整值', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}',
    '{"id":"c1","model":"m","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7}}',
  ])
  const events = eventsOf(out)
  const deltas = events.filter(e => e.type === 'message_delta')
  assert.strictEqual(deltas.length, 1, 'Anthropic 只允许一条 message_delta')
  assert.strictEqual(deltas[0].usage.input_tokens, 100)
  assert.strictEqual(deltas[0].usage.output_tokens, 7)
  const stops = events.filter(e => e.type === 'message_stop')
  assert.strictEqual(stops.length, 1)
  // message_delta 必须在 message_stop 之前
  assert.ok(events.findIndex(e => e.type === 'message_delta') < events.findIndex(e => e.type === 'message_stop'))
})

check('流式：无 [DONE] 直接收尾也补齐 delta/stop', () => {
  const stream = new ChatToAnthropicStream()
  let out = ''
  for (const event of stream.handleChunk(JSON.parse('{"id":"c1","model":"m","choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}'))) out += event
  for (const event of stream.finish()) out += event
  const events = eventsOf(out)
  assert.strictEqual(events.filter(e => e.type === 'message_delta').length, 1)
  assert.strictEqual(events.filter(e => e.type === 'message_stop').length, 1)
})

check('流式：工具调用缺 name 时用兜底名，不产生无名块', () => {
  const out = drive([
    '{"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}',
  ])
  const events = eventsOf(out)
  const start = events.find(e => e.type === 'content_block_start')
  assert.ok(start, '仍要开块')
  assert.strictEqual(start.content_block.name, 'unknown_tool')
})

check('流式：上游 error 事件 -> Anthropic error 且不再补 stop', () => {
  const stream = new ChatToAnthropicStream()
  let out = ''
  for (const event of stream.handleChunk(JSON.parse('{"id":"c1","model":"m","choices":[{"delta":{"content":"x"}}]}'))) out += event
  for (const event of stream.handleError('boom', 'upstream_error')) out += event
  for (const event of stream.finish()) out += event
  const events = eventsOf(out)
  assert.strictEqual(events.filter(e => e.type === 'error').length, 1)
  assert.strictEqual(events.filter(e => e.type === 'message_stop').length, 0)
})

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过') + '\n')
process.exit(failures ? 1 : 0)
