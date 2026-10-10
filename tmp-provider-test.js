// 开发期冒烟测试：providers.js 的路由与归一化。
// 运行：node tmp-provider-test.js
'use strict'

const assert = require('assert')
const providers = require('./providers')
const config = require('./config')

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

const ALL = ['http2', 'http1']
const H2_ONLY = ['http2']

console.log('\n== 模型寻址：provider:modelId ==')

check('显式前缀：wb:global:deepseek-v4.1-flash', () => {
  const r = providers.splitModelRef('wb:global:deepseek-v4.1-flash')
  assert.strictEqual(r.providerKey, 'wb')
  assert.strictEqual(r.modelId, 'global:deepseek-v4.1-flash', '按第一个冒号切，modelId 可含冒号')
})

check('provider 段忽略大小写（WB:/Wb:/wb: 等价）', () => {
  const ref = providers.splitModelRef('wb:glm-5.3')
  for (const variant of ['WB:glm-5.3', 'Wb:glm-5.3', 'wB:glm-5.3']) {
    const r = providers.splitModelRef(variant)
    assert.strictEqual(r.providerKey, ref.providerKey, variant + ' 应归一到 wb')
    assert.strictEqual(r.modelId, 'glm-5.3', 'modelId 原样保留')
  }
})

check('modelId 段不折叠大小写（原样透传）', () => {
  // 各上游容忍度不同（MiniMax 不敏感 / DeepSeek 严格），代理不擅自改写用户输入
  const r = providers.splitModelRef('wb:GLM-5.3')
  assert.strictEqual(r.modelId, 'GLM-5.3', 'modelId 不该被折叠')
})

check('裸模型名忽略大小写，且归一化到声明形式', () => {
  // 关键：转发的是声明里的字符串，不是用户输入 —— 否则大小写不匹配要到上游才报错
  for (const written of ['minimax-m3', 'MINIMAX-M3', 'MiniMax-M3', 'Minimax-m3']) {
    const r = providers.resolveRoute(written, 'anthropic', ALL)
    assert.strictEqual(r.provider.name, 'MiniMax', written + ' 应路由到 MiniMax')
    assert.strictEqual(r.modelId, 'MiniMax-M3', written + ' 应归一化为声明形式')
  }
  for (const written of ['DeepSeek-Flash', 'DEEPSEEK-FLASH']) {
    const r = providers.resolveRoute(written, 'anthropic', ALL)
    assert.strictEqual(r.provider.name, 'DeepSeek')
    assert.strictEqual(r.modelId, 'deepseek-flash', written + ' 应归一化为声明形式')
  }
})

check('大小写归一化不跨 provider 串味', () => {
  // k3 属于 kimi，Kimi:k3 必须解析到 kimi 而不是别家
  const r = providers.resolveRoute('Kimi:k3', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'Kimi')
  assert.strictEqual(r.modelId, 'k3')
})

check('后缀无条件剥离（各上游都不接受 [1M]）', () => {
  // 实测 MiniMax 400 unknown model / DeepSeek 400 supported names are ...
  // 之前只在部分 provider 上开启，导致 minimax:MiniMax-M3[1M] 匹配不到声明表
  for (const [written, expectProvider, expectModel] of [
    ['minimax:MINIMAX-M3[1M]', 'MiniMax', 'MiniMax-M3'],
    ['MINIMAX-M3[1M]', 'MiniMax', 'MiniMax-M3'],
    ['minimax:minimax-m3[1m]', 'MiniMax', 'MiniMax-M3'],
    ['deepseek:DEEPSEEK-FLASH[1M]', 'DeepSeek', 'deepseek-flash'],
    ['DEEPSEEK-FLASH[1M]', 'DeepSeek', 'deepseek-flash'],
    ['kimi:K3[1M]', 'Kimi', 'k3'],
    ['wb:GLM-5.3[1M]', 'WorkBuddy', 'glm-5.3'],
  ]) {
    const r = providers.resolveRoute(written, 'anthropic', ALL)
    assert.strictEqual(r.provider.name, expectProvider, written)
    const body = { model: written }
    const final = providers.normalizeRequest(r.provider, body, r.modelId)
    assert.strictEqual(final, expectModel, written + ' 剥后缀+归一化后应为 ' + expectModel)
  }
})

check('modelPrefixes 忽略大小写，且归一化到声明前缀', () => {
  // 网关严格敏感：GLOBAL: 会被判模型不存在，必须换回声明形式
  for (const written of ['GLOBAL:deepseek-v4.1-flash', 'Global:Deepseek-V4.1-Flash']) {
    const r = providers.resolveRoute(written, 'openai_responses', ALL)
    assert.strictEqual(r.provider.name, 'WorkBuddy', written)
    assert.strictEqual(r.modelId, 'global:deepseek-v4.1-flash', written + ' 应归一化')
  }
})

check('带前缀的显式 provider 也归一化：WB:GLOBAL:... -> global:...', () => {
  const r = providers.resolveRoute('WB:GLOBAL:DEEPSEEK-V4.1-FLASH', 'openai_responses', ALL)
  assert.strictEqual(r.provider.name, 'WorkBuddy')
  assert.strictEqual(r.modelId, 'global:deepseek-v4.1-flash', '大小写与模型名都归一化')
})

check('未声明的 modelId 保持原样（不擅自折叠大小写）', () => {
  // wb 有 '*' 兜底，但没声明过的名字不该被改写 —— 用户可能知道上游的确切写法
  const r = providers.resolveRoute('wb:Some-Undeclared-Model', 'openai_responses', ALL)
  assert.strictEqual(r.provider.name, 'WorkBuddy')
  assert.strictEqual(r.modelId, 'Some-Undeclared-Model', '原样透传')
})

check('斜线分隔符：minimax/minimax-m3', () => {
  const r = providers.splitModelRef('minimax/minimax-m3')
  assert.strictEqual(r.providerKey, 'minimax')
  assert.strictEqual(r.modelId, 'minimax-m3')
})

check('斜线分隔符：冒号优先于斜线', () => {
  const r = providers.splitModelRef('openrouter:stealth/union-alpha')
  assert.strictEqual(r.providerKey, 'openrouter', '冒号定 provider')
  assert.strictEqual(r.modelId, 'stealth/union-alpha', '斜线属于 modelId')
})

check('上游模型名自带斜线不被误拆（stealth 不是 provider key）', () => {
  const r = providers.splitModelRef('stealth/union-alpha')
  assert.strictEqual(r.providerKey, null, 'stealth 不是 provider，不该拆')
  assert.strictEqual(r.modelId, 'stealth/union-alpha')

  const routed = providers.resolveRoute('stealth/union-alpha', 'openai_responses', ALL)
  assert.strictEqual(routed.provider.name, 'OpenRouter', '仍能按 models 表精确命中')
  assert.strictEqual(routed.modelId, 'stealth/union-alpha')
})

check('未知 org/model 形式 -> 报错（不静默兜底）', () => {
  for (const m of ['anthropic/claude-sonnet-4-6', 'google/gemini-2.5-pro']) {
    const r = providers.resolveRoute(m, 'anthropic', ALL)
    assert.strictEqual(r.mode, 'unsupported', m + ' 应报错')
  }
})

check('斜线分隔符走完整路由：kimi/k3 与 k3 等价', () => {
  const a = providers.resolveRoute('kimi/k3', 'anthropic', ALL)
  const b = providers.resolveRoute('k3', 'anthropic', ALL)
  assert.strictEqual(a.provider.name, b.provider.name)
  assert.strictEqual(a.modelId, b.modelId)
})

check('裸模型名不会被误拆（global: 不是 provider 名）', () => {
  const r = providers.splitModelRef('global:deepseek-v4.1-flash')
  assert.strictEqual(r.providerKey, null, 'global 不是 provider，整体当裸名')
  assert.strictEqual(r.modelId, 'global:deepseek-v4.1-flash')
})

check('deepseek:deepseek-flash 显式前缀', () => {
  const r = providers.splitModelRef('deepseek:deepseek-flash')
  assert.strictEqual(r.providerKey, 'deepseek')
  assert.strictEqual(r.modelId, 'deepseek-flash')
})

console.log('\n== 路由决策 ==')

check('裸名前缀归属：global:... -> wb（modelPrefixes）', () => {
  const r = providers.resolveRoute('global:deepseek-v4.1-flash', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'WorkBuddy')
  assert.strictEqual(r.mode, 'chat_bridge', 'wb 只有 Chat 端点')
  assert.strictEqual(r.modelId, 'global:deepseek-v4.1-flash', '前缀不参与剥离')
})

check('裸名前缀归属：cn:... -> wb', () => {
  const r = providers.resolveRoute('cn:kimi-k2.7', 'openai_responses', ALL)
  assert.strictEqual(r.provider.name, 'WorkBuddy')
})

check('显式前缀与裸名结果一致', () => {
  const a = providers.resolveRoute('wb:global:deepseek-v4.1-flash', 'anthropic', ALL)
  const b = providers.resolveRoute('global:deepseek-v4.1-flash', 'anthropic', ALL)
  assert.strictEqual(a.provider.name, b.provider.name)
  assert.strictEqual(a.modelId, b.modelId)
})

check('wb 裸模型名：deepseek-v4.1-flash / glm-5.3 / kimi-k3-1 都能路由', () => {
  // 网关本身也接受裸名；这三条在 models 表里显式列出以便裸名命中
  for (const m of ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3-1']) {
    const r = providers.resolveRoute(m, 'openai_responses', ALL)
    assert.strictEqual(r.provider.name, 'WorkBuddy', m + ' 应路由到 WorkBuddy')
    assert.strictEqual(r.mode, 'chat_bridge')
    assert.strictEqual(r.modelId, m, '原样透传，不做改写')
  }
})

check('wb 裸名与带前缀名互不干扰', () => {
  const bare = providers.resolveRoute('deepseek-v4.1-flash', 'openai_responses', ALL)
  const prefixed = providers.resolveRoute('global:deepseek-v4.1-flash', 'openai_responses', ALL)
  assert.strictEqual(bare.provider.name, prefixed.provider.name, '同一 provider')
  assert.strictEqual(bare.modelId, 'deepseek-v4.1-flash')
  assert.strictEqual(prefixed.modelId, 'global:deepseek-v4.1-flash', '前缀保留')
})

check('裸模型名精确匹配：deepseek-flash -> deepseek 直连', () => {
  for (const proto of ['anthropic', 'openai_chat', 'openai_responses']) {
    const r = providers.resolveRoute('deepseek-flash', proto, ALL)
    assert.strictEqual(r.provider.name, 'DeepSeek', proto)
    assert.strictEqual(r.mode, 'direct', proto + ' 应直连')
  }
})

check('裸模型名精确匹配：k3 -> kimi 直连（不是 k3-256k）', () => {
  const r = providers.resolveRoute('k3', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'Kimi')
  assert.strictEqual(r.modelId, 'k3', 'k3 就是 k3，不该被改写成 k3-256k')
})

check('Kimi 只有 anthropic 端点：其余协议明确报不支持', () => {
  for (const proto of ['openai_chat', 'openai_responses']) {
    const r = providers.resolveRoute('k3', proto, ALL)
    assert.strictEqual(r.mode, 'unsupported', proto)
    assert.ok(r.reason.includes('Kimi'))
  }
})

check('Kimi：k3 就发 k3，k3-256k 就发 k3-256k（后者便宜一半，不能调错）', () => {
  const a = providers.resolveRoute('k3', 'anthropic', ALL)
  assert.strictEqual(a.provider.name, 'Kimi')
  assert.strictEqual(a.modelId, 'k3', 'k3 不该被改写成 k3-256k')

  const b = providers.resolveRoute('k3-256k', 'anthropic', ALL)
  assert.strictEqual(b.provider.name, 'Kimi')
  assert.strictEqual(b.modelId, 'k3-256k', 'k3-256k 不该被改写成 k3')
})

check('后缀剥离在「匹配」与「转发」两处都生效（k3[1M] -> k3）', () => {
  // Claude Code 的 ANTHROPIC_DEFAULT_*_MODEL 会带 [1M]，不归一化会匹配不到 models 表
  for (const sent of ['k3[1M]', 'k3[1m]', 'kimi:k3[1M]', 'k3-256k[1M]', 'k3-256k[1m]']) {
    const r = providers.resolveRoute(sent, 'anthropic', ALL)
    assert.strictEqual(r.provider.name, 'Kimi', sent + ' 应路由到 Kimi')
    const body = { model: sent }
    const final = providers.normalizeRequest(r.provider, body, r.modelId)
    assert.strictEqual(final, sent.replace(/^[a-z]+:/, '').replace(/\[[^\]]*\]/g, ''), sent + ' 剥后缀后应等于原名')
  }
})

check('别名改写：haiku -> deepseek-flash', () => {
  const r = providers.resolveRoute('deepseek:haiku', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'DeepSeek')
  assert.strictEqual(r.modelId, 'deepseek-flash', 'haiku 档指向 deepseek-flash')
})

check('别名改写：openrouter:opus -> stealth/union-alpha', () => {
  const r = providers.resolveRoute('openrouter:opus', 'openai_responses', ALL)
  assert.strictEqual(r.modelId, 'stealth/union-alpha')
})

check('MiniMax：未列出的 modelId 原样透传（不再静默改写成 M3）', () => {
  // 显式 provider 前缀下 modelId 原样交给上游；写错由上游报错，不在代理里悄悄换模型
  const r = providers.resolveRoute('minimax:whatever', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'MiniMax')
  assert.strictEqual(r.modelId, 'whatever', '不该被改写成 MiniMax-M3')
})

check('MiniMax：裸名未列出 -> 报错（不兜底）', () => {
  const r = providers.resolveRoute('minimax-unknown', 'anthropic', ALL)
  assert.strictEqual(r.mode, 'unsupported')
})

check('不兜底：完全匹配不上的模型名在三个端口都报错', () => {
  // 静默改投别家上游会让配置错误看起来像跑通了（实际是别的模型在答），所以一律报错
  for (const proto of ['anthropic', 'openai_chat', 'openai_responses']) {
    const r = providers.resolveRoute('gpt-5.5', proto, ALL)
    assert.strictEqual(r.mode, 'unsupported', proto + ' 不该乱投别家')
    assert.strictEqual(r.provider, null)
    assert.ok(r.reason.includes('gpt-5.5'), 'reason 应点名模型名: ' + r.reason)
    assert.ok(r.reason.includes('provider'), 'reason 应提示正确写法: ' + r.reason)
  }
})

check('不兜底：拼错 provider 名 -> 报错，不静默换模型', () => {
  const r = providers.resolveRoute('workbuddy:global:deepseek-v4.1-flash', 'anthropic', ALL)
  assert.strictEqual(r.mode, 'unsupported')
  assert.strictEqual(r.provider, null)
})

check('显式前缀优先：deepseek:k3 归 DeepSeek（modelId 原样，由上游报错）', () => {
  const r = providers.resolveRoute('deepseek:k3', 'anthropic', ALL)
  assert.strictEqual(r.provider.name, 'DeepSeek')
  assert.strictEqual(r.modelId, 'k3', '显式前缀下 modelId 原样透传')
})

check('传输层不匹配：只支持 http2 的服务够不着 wb', () => {
  const r = providers.resolveRoute('global:x', 'openai_chat', H2_ONLY)
  assert.strictEqual(r.mode, 'unsupported')
  assert.ok(r.reason.includes('http1'), 'reason 应说明传输层: ' + r.reason)
})

check('wb 在 openai 端口走直连（协议同，靠 http1 中继）', () => {
  const r = providers.resolveRoute('global:deepseek-v4.1-flash', 'openai_chat', ALL)
  assert.strictEqual(r.mode, 'direct')
  assert.strictEqual(r.endpoint.transport, 'http1')
})

console.log('\n== 端点解析 ==')

check('apiKeys 按协议覆盖 apiKey', () => {
  const r = providers.resolveRoute('openrouter:stealth/union-alpha', 'openai_responses', ALL)
  const viaClaude = providers.resolveRoute('openrouter:stealth/union-alpha', 'anthropic', ALL)
  assert.notStrictEqual(r.endpoint.apiKey, viaClaude.endpoint.apiKey, '两个协议的 key 应不同')
})

check('keyPoolFor / serializeCooldown 按协议取', () => {
  const p = providers.PROVIDERS.openrouter
  assert.ok(providers.keyPoolFor(p, 'anthropic').length > 0)
  assert.ok(providers.keyPoolFor(p, 'openai_responses').length > 0)
  assert.strictEqual(providers.keyPoolFor(p, 'openai_chat'), null)
  assert.strictEqual(providers.serializeCooldown(p, 'openai_responses'), 1500)
  assert.strictEqual(providers.serializeCooldown(p, 'anthropic'), 0)
})

console.log('\n== 请求归一化 ==')

check('未声明的 modelId 也剥后缀（无条件，各上游都不接受）', () => {
  // DeepSeek 以前没声明 stripModelSuffix，带后缀会直发上游 400
  const ds = providers.resolveRoute('deepseek:deepseek-flash', 'anthropic', ALL)
  const b = { model: 'deepseek-flash[1M]' }
  assert.strictEqual(providers.normalizeRequest(ds.provider, b, 'deepseek-flash[1M]'), 'deepseek-flash')
})

check('wb：codex 的 ultra -> max', () => {
  const p = providers.PROVIDERS.wb
  const body = { reasoning: { effort: 'ultra' } }
  const ch = providers.normalizeEffort(p, 'openai_responses', body)
  assert.deepStrictEqual(body.reasoning, { effort: 'max' })
  assert.strictEqual(ch.length, 1)
})

check('wb：xhigh 不做映射（网关的 xhigh 比 max 低，那是升档）', () => {
  const p = providers.PROVIDERS.wb
  const body = { reasoning: { effort: 'xhigh' } }
  const ch = providers.normalizeEffort(p, 'openai_responses', body)
  assert.deepStrictEqual(body.reasoning, { effort: 'xhigh' })
  assert.strictEqual(ch.length, 0)
})

check('wb anthropic：只把 output_config.effort 提到顶层，不改档位（降档交给网关）', () => {
  const p = providers.PROVIDERS.wb
  const body = { output_config: { effort: 'xhigh' } }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(body.reasoning_effort, 'xhigh', '提到顶层，桥的 opts.reasoningEffort 才能拿到')
  assert.strictEqual(body.output_config.effort, undefined)
  assert.strictEqual(ch.length, 1, '搬移必须记录 change，否则 anthropic-server 不重序列化')
})

check('deepseek anthropic：output_config.effort 提到顶层并降档', () => {
  const p = providers.PROVIDERS.deepseek
  const body = { output_config: { effort: 'ultra' } }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(body.reasoning_effort, 'max')
  assert.strictEqual(body.output_config.effort, undefined, '顶层化后删掉原字段')
  assert.strictEqual(ch.length, 1)
})

check('moveToTop：恒等映射也记录 change（否则 anthropic-server 丢弃字段搬移）', () => {
  const p = providers.PROVIDERS.deepseek
  const body = { model: 'deepseek-flash', output_config: { effort: 'low' } }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(ch.length, 1, '恒等搬移必须产生 change，否则 bodyBuffer 不会重序列化')
  assert.strictEqual(body.reasoning_effort, 'low')
  assert.strictEqual(body.output_config.effort, undefined)
})

check('moveToTop：值本来就在顶层且未变时不重写（避免无谓字节差异）', () => {
  const p = providers.PROVIDERS.deepseek
  const body = { reasoning_effort: 'max' }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(ch.length, 0)
  assert.deepStrictEqual(body, { reasoning_effort: 'max' })
})

check('wb anthropic：只声明 field 即可把 max 提到顶层（空 map 不再早退）', () => {
  const p = providers.PROVIDERS.wb
  const body = { model: 'g:deepseek-flash', output_config: { effort: 'max' } }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(ch.length, 1)
  assert.strictEqual(body.reasoning_effort, 'max')
  assert.strictEqual(body.output_config.effort, undefined)
})
check('deepseek anthropic：客户端没给 effort 就不注入', () => {
  const p = providers.PROVIDERS.deepseek
  const body = { messages: [] }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(body.reasoning_effort, undefined)
  assert.strictEqual(ch.length, 0)
})

check('deepseek chat：force 无条件写 max', () => {
  const p = providers.PROVIDERS.deepseek
  const body = { reasoning_effort: 'low' }
  const ch = providers.normalizeEffort(p, 'openai_chat', body)
  assert.strictEqual(body.reasoning_effort, 'max')
  assert.strictEqual(ch.length, 1)
})

check('minimax：只就地降档，字段位置不动', () => {
  const p = providers.PROVIDERS.minimax
  const body = { output_config: { effort: 'ultra' } }
  const ch = providers.normalizeEffort(p, 'anthropic', body)
  assert.strictEqual(body.output_config.effort, 'high')
  assert.strictEqual(body.reasoning_effort, undefined)
  assert.strictEqual(ch.length, 1)
})

check('未声明 effort 的协议：完全不碰 body', () => {
  const p = providers.PROVIDERS.minimax
  const body = { reasoning_effort: 'ultra' }
  const ch = providers.normalizeEffort(p, 'openai_chat', body)
  assert.deepStrictEqual(body, { reasoning_effort: 'ultra' })
  assert.strictEqual(ch.length, 0)
})

console.log('\n== 其他 ==')

check('applyChatExtras：MiniMax 注入 reasoning_split', () => {
  const p = providers.PROVIDERS.minimax
  const body = {}
  assert.strictEqual(providers.applyChatExtras(p, body), true)
  assert.strictEqual(body.reasoning_split, true)
  assert.strictEqual(providers.applyChatExtras(p, body), false)
})

check('buildTargetUrl：按客户端协议选上游路径', () => {
  const ep = { baseUrl: 'https://api.example.com/v1/' }
  assert.strictEqual(providers.buildTargetUrl(ep, 'anthropic', ''), 'https://api.example.com/v1/v1/messages')
  assert.strictEqual(providers.buildTargetUrl(ep, 'openai_chat', ''), 'https://api.example.com/v1/v1/chat/completions')
  assert.strictEqual(providers.buildTargetUrl(ep, 'openai_responses', ''), 'https://api.example.com/v1/responses')
  assert.strictEqual(providers.buildTargetUrl(ep, 'openai_responses', 'x=1'), 'https://api.example.com/v1/responses?x=1')
})

// 会话粘性：客户端只发 HTTP 头、上游只从请求体取会话键时的声明式映射。
// 回归点：不能覆盖客户端自带的值（Claude Code 自带 metadata）、未声明的 provider 不受影响。
const DSH_HEADER = { 'x-deepseek-harness-session-id': 'sess-1' }

check('applySessionSticky：按 provider 声明把头发进请求体', () => {
  const p = providers.PROVIDERS.wb
  const body = {}
  assert.strictEqual(providers.applySessionSticky(p, body, DSH_HEADER), true)
  assert.strictEqual(body[p.sessionSticky.field], 'sess-1')
})

check('applySessionSticky：头缺失 / 空串 / 非字符串时不写入', () => {
  const p = providers.PROVIDERS.wb
  for (const headers of [{}, { 'x-deepseek-harness-session-id': '' }, { 'x-deepseek-harness-session-id': ['a', 'b'] }]) {
    const body = {}
    assert.strictEqual(providers.applySessionSticky(p, body, headers), false, JSON.stringify(headers))
    assert.strictEqual(p.sessionSticky.field in body, false)
  }
})

check('applySessionSticky：客户端已带同义键时不覆盖（snake 与 camel 两种拼写都算）', () => {
  const p = providers.PROVIDERS.wb
  // 网关 ExtractKey 两种拼写都认，只查配置那一种会顶掉客户端自带的另一种。
  for (const own of [{ conversation_id: 'client-snake' }, { conversationId: 'client-camel' }]) {
    const body = { ...own }
    assert.strictEqual(providers.applySessionSticky(p, body, DSH_HEADER), false, JSON.stringify(own))
    assert.deepStrictEqual(body, own, JSON.stringify(own))
  }
})

check('applySessionSticky：未声明该规则的 provider 完全不受影响', () => {
  const body = {}
  const declared = Object.entries(config.providers).filter(([, p]) => p.sessionSticky).map(([k]) => k)
  const undeclared = Object.keys(config.providers).filter(k => !declared.includes(k))
  assert.ok(undeclared.length > 0, '应有未声明 sessionSticky 的 provider 参与本检查')
  for (const key of undeclared) {
    assert.strictEqual(providers.applySessionSticky(providers.PROVIDERS[key], body, DSH_HEADER), false, key)
  }
  assert.deepStrictEqual(body, {})
})

check('applySessionSticky：畸形声明一律静默不生效，不抛异常', () => {
  const bodies = []
  for (const rule of [null, undefined, 'a-string', 42, true, [], {}, { header: 123 }, { header: 'x-hdr' },
    { field: 'conversation_id' }, { header: '' }, { header: 'x-hdr', field: '' }]) {
    const body = { model: 'm' }
    bodies.push(body)
    assert.strictEqual(providers.applySessionSticky({ sessionSticky: rule }, body, DSH_HEADER), false, JSON.stringify(rule))
    assert.deepStrictEqual(body, { model: 'm' }, JSON.stringify(rule))
  }
})

check('SerialQueue：单并发', () => {
  const q = new providers.SerialQueue()
  let concurrent = 0, max = 0
  const run = () => q.run(0, done => {
    concurrent++; max = Math.max(max, concurrent)
    setTimeout(() => { concurrent--; done() }, 5)
  })
  run(); run(); run()
  assert.strictEqual(max, 1)
})

check('配置完整性：每个 provider 有 name/baseUrls，端点是字符串', () => {
  for (const [key, p] of Object.entries(config.providers)) {
    assert.ok(p.name, key + ' 缺 name')
    assert.ok(p.baseUrls && Object.keys(p.baseUrls).length > 0, key + ' 缺 baseUrls')
    for (const [proto, url] of Object.entries(p.baseUrls)) {
      assert.strictEqual(typeof url, 'string', `${key}.baseUrls.${proto} 必须是字符串`)
      assert.ok(providers.PROTOCOLS.includes(proto), `${key}.baseUrls.${proto} 协议名非法`)
    }
    if (p.effort) {
      for (const proto of Object.keys(p.effort)) {
        assert.ok(providers.PROTOCOLS.includes(proto), `${key}.effort.${proto} 协议名非法`)
      }
    }
  }
})

console.log('\n' + (failures ? failures + ' 项失败' : '全部通过') + '\n')
process.exit(failures ? 1 : 0)
