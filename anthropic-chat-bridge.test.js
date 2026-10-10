// Anthropic→Chat 桥的**历史思考回传口径**回归（node --test）。
//
// 判据来自 DeepSeek Thinking Mode 文档（2026-10-01 核对原文）：
//   · 带 tools：`the reasoning_content must be fully passed back to the API in all
//     subsequent requests — even for turns where the model did not perform a tool call.
//     If your code does not correctly pass back reasoning_content, the API will return
//     a 400 error`，且会被拼进上下文；
//   · 不带 tools：`even if passed to the API, it will be ignored` → 丢弃。
// 实测（本机路由）：WorkBuddy 桥上游忽略 reasoning_content（差 0 tokens 且不 400），
// DeepSeek 直连全额计入（635 vs 314）。故本改动在该上游零成本、在严格上游免 400。
const test = require('node:test')
const assert = require('node:assert/strict')

const { anthropicToChatCompletions, resolveReasoningEffort } = require('./anthropic-chat-bridge')

const TOOLS = [
  { name: 'get_time', description: 'Get the current time.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
]

const withTools = body => anthropicToChatCompletions({ ...body, tools: TOOLS }, {})
const noTools = body => anthropicToChatCompletions(body, {})

const assistantMsgs = out => out.messages.filter(m => m.role === 'assistant')

const HISTORY = {
  model: 'probe-model',
  max_tokens: 8,
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'THINK-FINAL' }, { type: 'text', text: 'done' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'THINK-TOOL' }, { type: 'tool_use', id: 't1', name: 'get_time', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '12:00' }] },
    { role: 'user', content: 'again' },
  ],
}

test('带 tools：非工具调用的 assistant 也必须回传历史思考（规范要求，此前被丢弃）', () => {
  const [final, toolCall] = assistantMsgs(withTools(HISTORY))
  assert.equal(final.reasoning_content, 'THINK-FINAL')
  assert.equal(toolCall.reasoning_content, 'THINK-TOOL')
})

test('不带 tools：思考被丢弃（规范：传了也会被忽略），工具调用消息仍带（兼容要求）', () => {
  const [final, toolCall] = assistantMsgs(noTools(HISTORY))
  assert.equal(final.reasoning_content, undefined)
  assert.equal(toolCall.reasoning_content, 'THINK-TOOL')
})

test('带 tools 的工具调用消息无思考：给非空占位（思考型上游硬要求）', () => {
  const out = withTools({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] }] })
  assert.equal(assistantMsgs(out)[0].reasoning_content, 'tool call')
})

test('带 tools：redacted_thinking 走占位文本（拿不到明文时的唯一代表）', () => {
  const out = withTools({ model: 'm', messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'xx' }, { type: 'text', text: 'ok' }] }] })
  assert.equal(assistantMsgs(out)[0].reasoning_content, '[redacted thinking]')
})

test('preserveReasoningContent:false（provider 显式关档）→ 一律不带', () => {
  const out = anthropicToChatCompletions({ ...HISTORY, tools: TOOLS }, { preserveReasoningContent: false })
  assert.equal(assistantMsgs(out).filter(m => m.reasoning_content !== undefined).length, 0)
})

test('回归：tools 清理与键序不变（BatchTool 过滤、缺 description 不发 null、schema 补 object）', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'BatchTool', name: 'drop_me' },
      { name: 'no_desc', input_schema: {} },
      { name: 'has_desc', description: 'd', input_schema: { properties: { a: { type: 'string', format: 'uri' } } } },
    ],
  }
  const out = anthropicToChatCompletions(body, {})
  assert.deepEqual(out.tools.map(t => t.function.name), ['no_desc', 'has_desc'])
  assert.equal('description' in out.tools[0].function, false)
  assert.deepEqual(out.tools[0].function.parameters, { type: 'object', properties: {} })
  // root schema 必须显式 object；format:'uri' 被剥掉
  assert.deepEqual(out.tools[1].function.parameters, { type: 'object', properties: { a: { type: 'string' } } })
  // 键序：model → messages → max_tokens(若有) → tools（与改动前一致，前缀缓存不受影响）
  assert.deepEqual(Object.keys(out), ['model', 'messages', 'tools'])
})


test('effort：opts.reasoningEffort 优先于白名单解析（顶层化后 max 不再降档）', () => {
  const out = anthropicToChatCompletions(
    { model: 'g:deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
    { reasoningEffort: 'max' },
  )
  assert.equal(out.reasoning_effort, 'max')
})

test('effort：无 opts 时 deepseek 的 max 仍按白名单降为 xhigh（现状锁定，防误改）', () => {
  assert.equal(resolveReasoningEffort({ model: 'g:deepseek-flash', output_config: { effort: 'max' } }), 'xhigh')
})

test('effort：白名单与 cc-switch 对齐（含 gpt-6-sol / gpt-6-luna）', () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']) {
    assert.equal(resolveReasoningEffort({ model, output_config: { effort: 'max' } }), 'max', model)
  }
})
test('回归：tools 为空数组/非数组时不视为「带 tools」，思考照旧丢弃', () => {
  for (const tools of [[], undefined, null, 'nope']) {
    const body = { ...HISTORY, tools }
    if (tools === undefined) delete body.tools
    const [final] = assistantMsgs(anthropicToChatCompletions(body, {}))
    assert.equal(final.reasoning_content, undefined, `tools=${JSON.stringify(tools)}`)
  }
})
