// 开发期冒烟测试：codex-chat-bridge 的双向转换。
// 运行：node tmp-bridge-test.js
'use strict'

const assert = require('assert')
const { responsesToChatCompletions, chatCompletionToResponse, ChatToResponsesStream, buildToolContext } = require('./codex-chat-bridge')

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

function drive(stream, chunks) {
  let out = ''
  for (const raw of chunks) {
    const parsed = JSON.parse(raw)
    for (const event of stream.handleChatChunk(parsed)) out += event
  }
  for (const event of stream.finish()) out += event
  return out
}

console.log('\n== 请求方向 ==')

check('instructions -> system，input 数组 -> messages', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    instructions: 'be terse',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'dev' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
  })
  assert.deepStrictEqual(body.messages, [
    { role: 'system', content: 'be terse\n\ndev' },
    { role: 'user', content: 'hi' },
  ])
})

check('namespace 工具折叠 + 回程还原 namespace/name', () => {
  const request = {
    model: 'm',
    tools: [
      {
        type: 'namespace',
        name: 'collaboration',
        description: 'collab',
        tools: [
          {
            type: 'function',
            name: 'spawn_agent',
            description: 'spawn',
            strict: false,
            parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
          },
        ],
      },
    ],
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] }],
  }
  const { body, toolContext } = responsesToChatCompletions(request)
  assert.strictEqual(body.tools[0].function.name, 'collaboration__spawn_agent')
  assert.deepStrictEqual(body.tools[0].function.parameters.required, ['message'])

  const stream = new ChatToResponsesStream(toolContext)
  const out = drive(stream, [
    JSON.stringify({ id: 'c1', model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'collaboration__spawn_agent', arguments: '' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"message":"go"}' } }] }, finish_reason: 'tool_calls' }] }),
  ])
  const events = eventsOf(out)
  const done = events.find(e => e.type === 'response.output_item.done')
  assert.strictEqual(done.item.type, 'function_call')
  assert.strictEqual(done.item.name, 'spawn_agent')
  assert.strictEqual(done.item.namespace, 'collaboration')
  assert.deepStrictEqual(done.item.encrypted_function_args, [])
  assert.strictEqual(done.item.arguments, '{"message":"go"}')
  assert.ok(events.some(e => e.type === 'response.function_call_arguments.delta'))
  assert.ok(events.some(e => e.type === 'response.function_call_arguments.done'))
})

check('custom (freeform) 工具 -> custom_tool_call + input 事件', () => {
  const request = { model: 'm', tools: [{ type: 'custom', name: 'apply_patch', description: 'patch' }] }
  const { body, toolContext } = responsesToChatCompletions(request)
  assert.strictEqual(body.tools[0].function.name, 'apply_patch')
  assert.strictEqual(body.tools[0].function.parameters.required[0], 'input')

  const stream = new ChatToResponsesStream(toolContext)
  const out = drive(stream, [
    JSON.stringify({ id: 'c2', model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'apply_patch' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"input":"*** Begin Patch"}' } }] }, finish_reason: 'tool_calls' }] }),
  ])
  const events = eventsOf(out)
  const done = events.find(e => e.type === 'response.output_item.done')
  assert.strictEqual(done.item.type, 'custom_tool_call')
  assert.strictEqual(done.item.id, 'ctc_call_2')
  assert.strictEqual(done.item.input, '*** Begin Patch')
  assert.ok(events.some(e => e.type === 'response.custom_tool_call_input.delta'))
  assert.ok(!events.some(e => e.type === 'response.function_call_arguments.delta'))
})

check('reasoning_content -> reasoning 项，顺序在 message 之前', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c3', model: 'm', choices: [{ delta: { reasoning_content: 'Need context. ' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10, completion_tokens_details: { reasoning_tokens: 3 } } }),
  ])
  const events = eventsOf(out)
  assert.ok(out.includes('response.reasoning_summary_text.delta'))
  assert.ok(out.includes('response.reasoning_summary_text.done'))
  const reasoningPos = out.indexOf('"type":"reasoning"')
  const messagePos = out.indexOf('"type":"message"')
  assert.ok(reasoningPos > 0 && reasoningPos < messagePos, 'reasoning 必须排在 message 之前')
  const completed = events.find(e => e.type === 'response.completed')
  assert.strictEqual(completed.response.output[0].type, 'reasoning')
  assert.strictEqual(completed.response.output[0].summary[0].text, 'Need context. ')
  assert.strictEqual(completed.response.output[1].content[0].text, 'Done')
  assert.strictEqual(completed.response.usage.output_tokens_details.reasoning_tokens, 3)
})

check('内联 <think> 拆成 reasoning，标签不泄漏', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c4', model: 'm', choices: [{ delta: { content: '<think>\nNeed' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' context.</think>\n\npong' }, finish_reason: 'stop' }] }),
  ])
  assert.ok(out.includes('Need context.'))
  assert.ok(out.includes('"text":"pong"'))
  assert.ok(!out.includes('<think>'))
  assert.ok(!out.includes('</think>'))
  assert.ok(out.includes('response.completed'))
})

check('并行工具调用：name 后到时仍按 index 顺序产出', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c5', model: 'm', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: '', arguments: '{' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'second_tool', arguments: '{"value":2}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'first_tool', arguments: '"value":1}' } }] }, finish_reason: 'tool_calls' }] }),
  ])
  const events = eventsOf(out)
  const added = events.filter(e => e.type === 'response.output_item.added')
  assert.strictEqual(added.length, 2)
  assert.strictEqual(added[0].item.name, 'first_tool')
  assert.strictEqual(added[1].item.name, 'second_tool')
  const completed = events.find(e => e.type === 'response.completed')
  assert.strictEqual(completed.response.output[0].arguments, '{"value":1}')
  assert.strictEqual(completed.response.output[1].arguments, '{"value":2}')
})

check('缺失 index 时 arguments 续帧不炸成多个 item', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c6', model: 'm', choices: [{ delta: { tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ type: 'function', function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] }),
  ])
  const completed = eventsOf(out).find(e => e.type === 'response.completed')
  assert.strictEqual(completed.response.output.length, 1)
  assert.strictEqual(completed.response.output[0].arguments, '{"path":"a.txt"}')
})

check('无 name 的工具调用只报 failed，不报 completed', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c7', model: 'm', choices: [{ delta: { content: '让我继续处理' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
  ])
  assert.ok(out.includes('response.failed'))
  assert.ok(out.includes('upstream_tool_call_dropped'))
  assert.ok(!out.includes('response.completed'))
  assert.ok(out.includes('让我继续处理'))
})

check('finish_reason=length 保持 incomplete 而非 failed', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [
    JSON.stringify({ id: 'c8', model: 'm', choices: [{ delta: { content: '来看' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { arguments: '{"pa' } }] }, finish_reason: 'length' }] }),
  ])
  assert.ok(out.includes('response.completed'))
  assert.ok(out.includes('"status":"incomplete"'))
  assert.ok(!out.includes('response.failed'))
})

check('流无 finish_reason 但有输出 -> incomplete', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [JSON.stringify({ id: 'c9', model: 'm', choices: [{ delta: { content: 'partial' } }] })])
  assert.ok(out.includes('"status":"incomplete"'))
  assert.ok(out.includes('"reason":"max_output_tokens"'))
})

check('流无任何输出 -> stream_truncated', () => {
  const stream = new ChatToResponsesStream()
  const out = drive(stream, [JSON.stringify({ id: 'c10', model: 'm', choices: [{ delta: {} }] })])
  assert.ok(out.includes('response.failed'))
  assert.ok(out.includes('stream_truncated'))
})

check('非流式：Chat -> Responses 输出项与 usage', () => {
  const request = { model: 'm', tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }] }
  const { toolContext } = responsesToChatCompletions(request)
  const response = chatCompletionToResponse(
    {
      id: 'abc',
      model: 'm',
      created: 123,
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            reasoning_content: 'think',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city": "Paris"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } },
    },
    toolContext
  )
  assert.strictEqual(response.id, 'resp_abc')
  assert.strictEqual(response.status, 'completed')
  assert.strictEqual(response.output[0].type, 'reasoning')
  assert.strictEqual(response.output[1].type, 'function_call')
  assert.strictEqual(response.output[1].arguments, '{"city":"Paris"}')
  assert.strictEqual(response.output[1].reasoning_content, 'think')
  assert.strictEqual(response.usage.input_tokens_details.cached_tokens, 4)
})

check('非流式：工具调用全无 name 时抛错', () => {
  assert.throws(() => {
    chatCompletionToResponse(
      { id: 'x', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', type: 'function', function: { arguments: '{}' } }] } }] },
      buildToolContext({})
    )
  }, /without a function name/)
})

check('请求：历史 function_call + function_call_output -> assistant tool_calls + tool 消息', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }],
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should call it.' }] },
      { type: 'function_call', name: 'get_weather', arguments: '{"city":"Paris"}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temp":18}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ],
  })
  assert.deepStrictEqual(body.messages[1], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
    reasoning_content: 'I should call it.',
  })
  assert.deepStrictEqual(body.messages[2], { role: 'tool', tool_call_id: 'call_1', content: '{"temp":18}' })
  assert.strictEqual(body.messages[3].role, 'user')
})

check('请求：agent_message 降级为 user 消息', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    input: [{ type: 'agent_message', author: 'root', recipient: 'sub', content: [{ type: 'input_text', text: 'do the thing' }] }],
  })
  const message = body.messages[0]
  assert.strictEqual(message.role, 'user')
  assert.strictEqual(message.content, 'do the thing')
})

check('请求：tool_calls assistant 缺 reasoning_content 时补占位', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    tools: [{ type: 'function', name: 'f', parameters: { type: 'object', properties: {} } }],
    input: [
      { type: 'function_call', name: 'f', arguments: '{}', call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ],
  })
  assert.strictEqual(body.messages[0].reasoning_content, 'tool call')
})

check('请求：流式注入 stream_options.include_usage', () => {
  const { body } = responsesToChatCompletions({ model: 'm', stream: true, input: 'hi' })
  assert.deepStrictEqual(body.stream_options, { include_usage: true })
})

check('请求：无工具时丢弃 tool_choice / parallel_tool_calls', () => {
  const { body } = responsesToChatCompletions({ model: 'm', tool_choice: 'auto', parallel_tool_calls: true, input: 'hi' })
  assert.strictEqual(body.tool_choice, undefined)
  assert.strictEqual(body.parallel_tool_calls, undefined)
})

check('请求：reasoning.effort -> reasoning_effort', () => {
  const { body } = responsesToChatCompletions({ model: 'm', reasoning: { effort: 'high' }, input: 'hi' })
  assert.strictEqual(body.reasoning_effort, 'high')
})

check('请求：超长 namespace 工具名折叠到 64 字节内', () => {
  const longNamespace = 'mcp__codex_apps__' + 'x'.repeat(60)
  const { body } = responsesToChatCompletions({
    model: 'm',
    tools: [{ type: 'namespace', name: longNamespace, tools: [{ type: 'function', name: 'do_thing', parameters: { type: 'object' } }] }],
    input: 'hi',
  })
  assert.ok(body.tools[0].function.name.length <= 64, '工具名必须 <= 64 字节')
})

check('请求：prompt_cache_key 透传并补 conversation_id（上游粘性选号用）', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    input: 'hi',
    prompt_cache_key: 'thread-uuid-1',
  })
  assert.strictEqual(body.prompt_cache_key, 'thread-uuid-1')
  assert.strictEqual(body.conversation_id, 'thread-uuid-1')
})

check('请求：客户端自带 conversation_id 时不覆盖', () => {
  const { body } = responsesToChatCompletions({
    model: 'm',
    input: 'hi',
    prompt_cache_key: 'thread-uuid-1',
    conversation_id: 'explicit-conv',
  })
  assert.strictEqual(body.conversation_id, 'explicit-conv')
})

check('请求：无 prompt_cache_key 时不注入 conversation_id', () => {
  const { body } = responsesToChatCompletions({ model: 'm', input: 'hi' })
  assert.strictEqual('conversation_id' in body, false)
})

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过') + '\n')
process.exit(failures ? 1 : 0)
