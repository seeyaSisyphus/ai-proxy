// providers.js — 提供方解析与请求归一化。
//
// 三个代理共用这一个模块，服务代码里不再出现任何厂商名硬编码。
// 配置结构见 config.js 头部注释。
//
// ══ 模型寻址 ══════════════════════════════════════════════════════════
// 客户端模型名 `provider:modelId` 按**第一个**冒号切分：
//
//     wb:global:deepseek-v4.1-flash  ->  provider=wb, modelId=global:deepseek-v4.1-flash
//     deepseek:haiku                 ->  provider=deepseek, modelId=haiku
//
// 解析顺序（前者优先）：
//   1. `provider:` 前缀且该 provider 存在  -> 用它，modelId 原样（可按 models 表改别名）
//   2. 裸模型名在某个 provider 的 models 表里精确命中 -> 用它
//   3. 裸模型名命中某个 provider 的 modelPrefixes   -> 用它
//   4. 都没有 -> unsupported（明确报错）
//
// 刻意不做「兜底到某个默认 provider」：模型名写错时静默改投别家上游，会让配置错误
// 看起来像跑通了 —— 实际是另一个模型（甚至另一个计费档）在答，比直接报错难发现得多。
//
// 客户端协议（clientProtocol）取值与 baseUrls 的键一致：
//   'anthropic'        Anthropic Messages（Claude Code → 3718）
//   'openai_chat'      OpenAI Chat Completions（→ 3719）
//   'openai_responses' OpenAI Responses（Codex → 3722）
//
// 直连 / 转换的判定：
//   有与客户端同协议的端点 -> mode='direct'       字节透传
//   只有 openai_chat      -> mode='chat_bridge'  走协议桥转换
//   两者都没有             -> mode='unsupported'

'use strict'

const config = require('./config')

const PROVIDERS = config.providers || {}
const DEFAULT_TRANSPORT = 'http2'
const PROTOCOLS = ['anthropic', 'openai_chat', 'openai_responses']

// ========== 模型名解析 ==========
// 支持两种分隔符：`provider:modelId` 与 `provider/modelId`。
//
// **provider 段忽略大小写**，modelId 段严格保留原样。这条分界很重要：
//   - provider key 是本代理自定义的标识符（wb / deepseek / …），与上游无关，
//     放宽大小写只是让人少踩坑，不影响正确性。
//   - modelId 要原样发给上游，而各上游对大小写的容忍度完全不同：
//       MiniMax  不敏感（MINIMAX-M3 也能用）
//       DeepSeek 严格敏感（DeepSeek-Flash -> 400）
//       WorkBuddy 网关严格敏感（GLM-5.3 -> 模型不存在）
//     在这里折叠大小写会让「代理放行、上游报错」变成延迟失败，比直接拒绝更难查。
//
// 分隔符前的那段必须是**已声明的 provider key**（忽略大小写后比对），否则不拆。这条规则
// 同时解决了两件事：
//   - `minimax/minimax-m3`  -> provider=minimax, modelId=minimax-m3
//   - `stealth/union-alpha` -> 不拆，整体当 modelId（stealth 不是 provider key）
// 所以上游模型名自带斜线（OpenRouter 的 org/model）不会被误拆。
//
// 冒号优先于斜线：`wb:stealth/union-alpha` 里冒号定 provider、斜线属于 modelId。

// 按 key 忽略大小写查 provider，返回 [标准key, provider] 或 null。
function findProviderKeyIgnoreCase(head) {
  const lower = head.toLowerCase()
  for (const key of Object.keys(PROVIDERS)) {
    if (key.toLowerCase() === lower) return key
  }
  return null
}

function splitAtSeparator(raw, separator) {
  const idx = raw.indexOf(separator)
  if (idx <= 0 || idx === raw.length - 1) return null
  const head = raw.slice(0, idx)
  const canonical = findProviderKeyIgnoreCase(head)
  if (!canonical) return null
  // modelId 原样返回，不做任何大小写处理
  return { providerKey: canonical, modelId: raw.slice(idx + 1) }
}

function splitModelRef(modelName) {
  const raw = String(modelName || '')
  return splitAtSeparator(raw, ':') || splitAtSeparator(raw, '/') || { providerKey: null, modelId: raw }
}

// 在某个 provider 的 models 表里查 modelId。
// 精确命中优先；只有显式声明了 '*' 才走兜底（避免 '*' 抢掉别的 provider 的精确匹配）。
//
// **忽略大小写比对，但返回声明里的规范形式**（canonicalId）。这一点是关键：
// 用户写 `minimax-m3` 而声明里是 `MiniMax-M3` 时，转发的是**声明里的那个字符串**，
// 不是用户输入的字符串。所以既好写又不会出现「代理放行、上游报错」的延迟失败。
// 返回 { spec, canonicalId } 或 null。
function lookupModel(provider, modelId) {
  const models = provider.models
  if (!models) return null
  if (Object.prototype.hasOwnProperty.call(models, modelId)) {
    return { spec: models[modelId] || {}, canonicalId: modelId }
  }
  const lower = String(modelId).toLowerCase()
  for (const declared of Object.keys(models)) {
    if (declared !== '*' && declared.toLowerCase() === lower) {
      return { spec: models[declared] || {}, canonicalId: declared }
    }
  }
  if (Object.prototype.hasOwnProperty.call(models, '*')) {
    return { spec: models['*'] || {}, canonicalId: modelId }
  }
  return null
}

// 剥掉 `[1M]` 这类后缀。
//
// 这是**客户端标记**，不是上游模型名的一部分：Claude Code 用 `[1M]` 声明「该模型支持 1M
// 上下文」，它自己会在发送前剥掉，但其它客户端/手写请求可能原样发过来。
//
// 各上游一律不接受这个后缀（实测 MiniMax 400 `unknown model`、DeepSeek 400
// `supported API model names are ...`），所以**无条件剥离**，不再按 provider 声明开关 ——
// 之前只在部分 provider 上开启，导致 `minimax:MiniMax-M3[1M]` 匹配不到声明表、
// 带着后缀直发上游而 400。
function stripModelSuffix(modelId) {
  if (typeof modelId !== 'string' || !modelId.includes('[')) return modelId
  const cleaned = modelId.replace(/\[[^\]]*\]/g, '').trim()
  return cleaned || modelId
}

// 裸模型名反查：哪个 provider 的 models 表声明了它。
// 只认声明过的名字，不看 '*'（否则第一个声明了 '*' 的 provider 会吞掉所有名字）。
//
// 两处归一化后再比对，都是为了让人少踩坑：
//   - 后缀：Claude Code 会发 `k3[1M]`，表里写的是 `k3`（后缀无条件剥离）
//   - 大小写：MiniMax 官方模型名是 `MiniMax-M3`，习惯写成 `minimax-m3`
// 返回 canonicalId（声明里的规范写法），由 resolveRoute 采用 —— 转发的是声明里的字符串，
// 所以不会出现「代理放行、上游报错」。
function findByBareModel(modelId) {
  const lower = String(modelId).toLowerCase()
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    const models = provider.models
    if (!models) continue
    for (const declared of Object.keys(models)) {
      if (declared === '*') continue
      if (declared === modelId) {
        return { providerKey: key, provider, canonicalId: declared }
      }
      const stripped = stripModelSuffix(modelId)
      if (declared === stripped) {
        return { providerKey: key, provider, canonicalId: declared }
      }
      if (declared.toLowerCase() === lower) {
        return { providerKey: key, provider, canonicalId: declared }
      }
      const strippedLower = String(stripped).toLowerCase()
      if (declared.toLowerCase() === strippedLower) {
        return { providerKey: key, provider, canonicalId: declared }
      }
    }
  }
  return null
}

// 裸模型名按 modelPrefixes 归属。上游模型名自带厂商前缀（如 `global:`）时用它，
// 这样 `global:deepseek-v4.1-flash` 不必写成 `wb:global:deepseek-v4.1-flash`。
//
// 前缀是「归属标记」，不从 modelId 里剥掉 —— 它是上游模型名的一部分。
//
// **比对忽略大小写，但返回声明里的规范前缀**（canonicalPrefix）：网关严格敏感
// （实测 `GLOBAL:deepseek-v4.1-flash` -> 模型不存在），所以命中后必须把用户输入的前缀
// 换回声明形式再转发。取最长匹配，避免 `global:` 被更短的 `g` 之类抢走。
function findByModelPrefix(modelId) {
  const lower = String(modelId).toLowerCase()
  let best = null
  let bestLen = -1
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    const prefixes = provider.modelPrefixes
    if (!Array.isArray(prefixes)) continue
    for (const prefix of prefixes) {
      if (!prefix) continue
      if (lower.startsWith(prefix.toLowerCase()) && prefix.length > bestLen) {
        best = { providerKey: key, provider, canonicalPrefix: prefix }
        bestLen = prefix.length
      }
    }
  }
  return best
}

// ========== 端点解析 ==========
// 上游可以为不同协议配不同 baseUrl / apiKey / transport。
function endpointFor(provider, providerKey, clientProtocol) {
  const baseUrl = (provider.baseUrls || {})[clientProtocol]
  if (!baseUrl) return null
  const apiKeys = provider.apiKeys || {}
  const transports = provider.transport || {}
  return {
    providerKey,
    baseUrl,
    apiKey: apiKeys[clientProtocol] || provider.apiKey || '',
    transport: transports[clientProtocol] || DEFAULT_TRANSPORT,
  }
}

function transportSupported(endpoint, serverTransports) {
  if (!serverTransports) return true
  return serverTransports.includes(endpoint.transport)
}

// ========== 路由解析 ==========
// 返回 { provider, providerKey, endpoint, mode, modelId, reason }
function resolveRoute(modelName, clientProtocol, serverTransports) {
  const { providerKey: explicitKey, modelId: rawModelId } = splitModelRef(modelName)

  let providerKey = explicitKey
  let provider = providerKey ? PROVIDERS[providerKey] : null
  let modelId = rawModelId
  let reason = ''

  if (provider) {
    reason = '显式 provider 前缀'
  } else {
    const bare = findByBareModel(modelId)
    if (bare) {
      providerKey = bare.providerKey
      provider = bare.provider
      // 采用声明里的规范写法（如 minimax-m3 -> MiniMax-M3），避免大小写不匹配传到上游才报错
      if (bare.canonicalId) modelId = bare.canonicalId
      reason = '裸模型名匹配'
    } else {
      const byPrefix = findByModelPrefix(modelId)
      if (byPrefix) {
        providerKey = byPrefix.providerKey
        provider = byPrefix.provider
        // 前缀换回声明形式：网关严格敏感，`GLOBAL:` 会被判模型不存在
        if (byPrefix.canonicalPrefix) {
          modelId = byPrefix.canonicalPrefix + modelId.slice(byPrefix.canonicalPrefix.length)
        }
        // 整个模型名再按 models 表反查一次，命中则用声明形式（大小写也归一化）。
        // 网关对模型名严格敏感（`global:Deepseek-V4.1-Flash` -> 503），
        // 这一步把用户的大小写变体收敛到声明写法。未声明则保持原样透传（'*' 兜底）。
        const prefixHit = lookupModel(provider, modelId)
        if (prefixHit && prefixHit.canonicalId && prefixHit.canonicalId !== modelId) {
          modelId = prefixHit.canonicalId
        }
        reason = `裸模型名前缀归属 ${provider.name}`
      } else {
        // 不兜底：模型名既没有 provider 前缀、也匹配不到任何 models 表 / modelPrefixes 时
        // 直接报错。静默改投别家上游会让「配置写错」看起来像「跑通了」—— 实际是另一个
        // 模型在答（甚至另一个计费档），比报错难发现得多。
        const known = Object.keys(PROVIDERS).join(', ')
        return {
          provider: null,
          providerKey: null,
          endpoint: null,
          mode: 'unsupported',
          modelId,
          reason: `模型名 "${modelName}" 无法匹配任何提供方。请写成 <provider>:<modelId>（可用 provider: ${known}），或使用某个 provider 已声明的模型名`,
        }
      }
    }
  }

  // 后缀剥离要在「匹配 models 表」和「转发」两处都生效，所以解析出 provider 后立刻归一化。
  // 否则 `k3-256k[1M]` 既匹配不到别名，也可能带着后缀发给上游被判「模型不存在」。
  modelId = stripModelSuffix(modelId)

  // models 表命中：采用声明里的规范写法，并按需改别名（如 haiku -> deepseek-flash）
  const hit = lookupModel(provider, modelId)
  if (hit) {
    modelId = hit.canonicalId
    if (hit.spec && hit.spec.upstreamId) modelId = hit.spec.upstreamId
  }

  const baseUrls = provider.baseUrls || {}

  // 1) 同协议端点 -> 直连
  const same = endpointFor(provider, providerKey, clientProtocol)
  if (same) {
    if (transportSupported(same, serverTransports)) {
      return { provider, providerKey, endpoint: same, mode: 'direct', modelId, reason: `${reason}，协议直连` }
    }
    return {
      provider,
      providerKey,
      endpoint: null,
      mode: 'unsupported',
      modelId,
      reason: `${provider.name} 的 ${clientProtocol} 端点需要 ${same.transport} 传输，本代理不支持`,
    }
  }

  // 2) 只有 Chat 端点 -> 协议桥
  const chat = endpointFor(provider, providerKey, 'openai_chat')
  if (chat && transportSupported(chat, serverTransports)) {
    return {
      provider,
      providerKey,
      endpoint: chat,
      mode: 'chat_bridge',
      modelId,
      reason: `${reason}，${provider.name} 无 ${clientProtocol} 端点，走 Chat 协议桥`,
    }
  }

  // 3) 都没有 -> 明确报错
  const available = Object.keys(baseUrls).join('/') || '无'
  return {
    provider,
    providerKey,
    endpoint: null,
    mode: 'unsupported',
    modelId,
    reason: `${provider.name} 不提供 ${clientProtocol} 端点（可用: ${available}）`,
  }
}

// ========== 请求归一化 ==========
// 模型名已由 resolveRoute 解析成最终 modelId，这里只处理后缀剥离。
function normalizeRequest(provider, body, modelId) {
  if (!provider || !body) return modelId
  let model = modelId
  model = stripModelSuffix(model)
  body.model = model
  return model
}

// ========== 思考深度映射 ==========
// 返回 [{ from, to }] 形式的改写记录（供调用方打日志，并作为「body 已改动、需重新序列化」的判据；
// 恒等映射的字段搬移同样记录，见 moveToTop 分支）。
//
//   map    字面映射表 { 客户端档位: 上游档位 }，未列出的档位原样保留
//   force  无条件写入该档位
//   field  'reasoning_effort' = 提到顶层并删掉 output_config.effort
//
// 客户端可能用 Responses 结构（body.reasoning.effort）、Anthropic 结构
// （body.output_config.effort）或顶层 reasoning_effort，三种都要覆盖。
// 按模型覆盖 effort 映射表。
//
// 同一个上游里的模型档位集合并不统一，而 effort 只能声明到 provider 级：
//   Qwen3.8 系（qfmodel / qmodel_38max）：low / medium / xhigh   —— 没有 max
//   Kimi、GLM、DeepSeek 系：             low / high   / max      —— 没有 xhigh
// 若在 provider 级把 max 一律映射成 xhigh，Kimi/GLM/DeepSeek 就被降到了非声明档位；
// 反之 Qwen 系会收到不存在的 max。用 modelsEffort 逐模型覆盖，两边都保真。
//
// 形状：{ [模型名]: { [客户端协议]: 与 provider.effort 同构的 policy } }
// 模型名匹配走 body.model（已被 normalizeRequest 归一化成上游 id），大小写不敏感。
function modelEffortPolicy(provider, clientProtocol, body) {
  const byModel = provider && provider.modelsEffort
  if (!byModel || !body) return null
  const name = String(body.model || '').trim().toLowerCase()
  if (!name) return null
  const entry = byModel[name]
  if (!entry) return null
  return entry[clientProtocol] || null
}

function normalizeEffort(provider, clientProtocol, body) {
  const changes = []
  if (!provider || !body) return changes
  // 模型级覆盖优先于 provider 级：前者能精确表达「这个模型支持哪些档位」。
  const policy = modelEffortPolicy(provider, clientProtocol, body)
    || (provider.effort || {})[clientProtocol]
  if (!policy) return changes

  const table = policy.map || {}
  const forced = policy.force
  const moveToTop = policy.field === 'reasoning_effort'
  if (!forced && Object.keys(table).length === 0 && !moveToTop) return changes

  const slots = []
  if (body.reasoning && typeof body.reasoning === 'object') slots.push({ obj: body.reasoning, field: 'effort' })
  if (body.output_config && typeof body.output_config === 'object') slots.push({ obj: body.output_config, field: 'effort' })
  slots.push({ obj: body, field: 'reasoning_effort' })

  let clientEffort
  for (const slot of slots) {
    const raw = slot.obj[slot.field]
    if (raw !== undefined && raw !== null && raw !== '') {
      clientEffort = raw
      break
    }
  }

  if (moveToTop) {
    // 客户端没给档位就不注入（严格上游对未知档位直接 400，宁缺勿错）。
    if (clientEffort === undefined) return changes
    const lower = String(clientEffort).trim().toLowerCase()
    const mapped = table[lower] !== undefined ? table[lower] : clientEffort
    // 跨层级搬移本身也是改写：调用方（anthropic-server）用 changes.length 判断是否重新
    // 序列化，恒等映射（如 max -> max）若不记录，搬移会被静默丢弃。
    const moved = slots.some(slot => slot.obj !== body && slot.obj[slot.field] !== undefined)
    for (const slot of slots) delete slot.obj[slot.field]
    body.reasoning_effort = mapped
    if (moved || mapped !== clientEffort) changes.push({ from: lower, to: mapped })
    return changes
  }

  for (const slot of slots) {
    const raw = slot.obj[slot.field]
    if (forced) {
      if (raw !== forced) {
        // 客户端没给档位时 raw 为 undefined，日志里显示 (未设置) 而不是 undefined
        changes.push({ from: raw === undefined ? '(未设置)' : raw, to: forced })
        slot.obj[slot.field] = forced
      }
      continue
    }
    if (raw === undefined || raw === null || raw === '') continue
    const lower = String(raw).trim().toLowerCase()
    if (table[lower] !== undefined) {
      slot.obj[slot.field] = table[lower]
      changes.push({ from: lower, to: table[lower] })
    }
  }
  return changes
}

// Chat 协议端点专属的请求体补充字段（如 MiniMax 的 reasoning_split）。
function applyChatExtras(provider, body) {
  if (!provider || !provider.chatExtras || !body) return false
  let changed = false
  for (const [key, value] of Object.entries(provider.chatExtras)) {
    if (body[key] !== value) {
      body[key] = value
      changed = true
    }
  }
  return changed
}

// 会话粘性键的声明式映射：客户端只发 HTTP 头、而上游只从**请求体**取会话键时用它。
// 规则来自 provider.sessionSticky（config.js 声明），未声明的 provider 完全不受影响。
// 本函数不认识任何具体客户端：头名与目标字段都来自配置。
// 只收 headers 而非整个 req，与 normalizeEffort / applyChatExtras 保持同一依赖粒度。
// 仅对「出站是 Chat 请求体」的调用点生效（与 applyChatExtras 相同）。
function applySessionSticky(provider, body, headers) {
  const rule = provider && provider.sessionSticky
  if (!rule || !body || !headers) return false
  const { header, field } = rule
  if (typeof header !== 'string' || header === '') return false
  if (typeof field !== 'string' || field === '') return false
  // 上游把 snake_case 与 camelCase 视为同一语义键（ExtractKey 两种拼写都认，snake 优先），
  // 只检查配置里那一种拼写会顶掉客户端自带的另一种。
  for (const name of equivalentKeySpellings(field)) {
    if (body[name] !== undefined) return false
  }
  // Node 把入站头名小写化，配置里的大小写不敏感。
  const raw = headers[header.toLowerCase()]
  if (typeof raw !== 'string' || raw === '') return false
  body[field] = raw
  return true
}

// 同一语义键的等价拼写：conversation_id <-> conversationId。无法互转的名字只返回自身。
function equivalentKeySpellings(field) {
  const camel = field.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
  const snake = field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return new Set([field, camel, snake])
}

// ========== Key 池（429 轮换） ==========
function keyPoolFor(provider, clientProtocol) {
  if (!provider || !provider.keyPools) return null
  const pool = provider.keyPools[clientProtocol]
  return Array.isArray(pool) && pool.length > 0 ? pool : null
}

// ========== 单并发排队 ==========
function serializeCooldown(provider, clientProtocol) {
  if (!provider || !provider.serialize) return 0
  const cooldown = provider.serialize[clientProtocol]
  return Number.isFinite(cooldown) ? cooldown : 0
}

class SerialQueue {
  constructor() {
    this.active = 0
    this.queue = []
  }

  // 单并发执行 fn(done)；完成后冷却 cooldownMs 再放行下一个。
  run(cooldownMs, fn, onQueued) {
    if (this.active < 1) {
      this.active++
      fn(() => this._release(cooldownMs))
      return
    }
    if (onQueued) onQueued(this.queue.length + 1)
    this.queue.push(() => {
      this.active++
      fn(() => this._release(cooldownMs))
    })
  }

  _release(cooldownMs) {
    const next = () => {
      this.active--
      if (this.queue.length > 0) this.queue.shift()()
    }
    if (cooldownMs > 0) setTimeout(next, cooldownMs)
    else next()
  }
}

// ========== 目标 URL ==========
// 各客户端协议对应的上游路径（服务端固定，不看客户端原始路径）。
const UPSTREAM_PATH = {
  anthropic: '/v1/messages',
  openai_chat: '/v1/chat/completions',
  openai_responses: '/responses',
}

function buildTargetUrl(endpoint, clientProtocol, queryStr) {
  const base = String((endpoint && endpoint.baseUrl) || '').replace(/\/+$/, '')
  const url = base + (UPSTREAM_PATH[clientProtocol] || '')
  return queryStr ? url + '?' + queryStr : url
}

// ========== 模型清单（GET /v1/models）==========
// 从注册表派生，不硬编码：列出所有**在该客户端协议下可路由**的声明模型名。
// 客户端（Codex / Claude Code 的模型选择器）探测这个端点，所以清单必须与真实
// 可路由集合一致 —— 写死的清单会随时间腐化（列了已下线的名字、漏了新加的名字）。
//
// 只列声明名，不列 '*' 兜底产生的名字：兜底是「任意名字都接受」，穷举不出来，
// 列出来只会误导。
//
// 同一个名字可能被多个 provider 声明（如 `deepseek-flash`），此时按 resolveRoute
// 的实际结果归属 —— 也就是「这个裸名真的会路由到谁」，而不是声明顺序。
function listModels(clientProtocol, serverTransports) {
  const seen = new Map()
  for (const providerKey of Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[providerKey]
    for (const declared of Object.keys(provider.models || {})) {
      if (declared === '*') continue
      if (seen.has(declared)) continue
      const route = resolveRoute(declared, clientProtocol, serverTransports)
      if (route.mode === 'unsupported') continue
      seen.set(declared, {
        id: declared,
        object: 'model',
        owned_by: provider.name,
        created: MODEL_LIST_CREATED,
      })
    }
  }
  return [...seen.values()]
}

// OpenAI /v1/models 的 created 字段：静态占位（各上游无统一的模型上线时间）。
const MODEL_LIST_CREATED = 1720000000

// 展示用标签：区分直连与转换，方便日志/排查。
function modeLabel(mode) {
  if (mode === 'direct') return '直连'
  if (mode === 'chat_bridge') return 'chat桥'
  return '不支持'
}

// 日志用的提供方名。
function providerLabel(route) {
  return (route && route.provider && route.provider.name) || 'Unknown'
}

module.exports = {
  PROVIDERS,
  PROTOCOLS,
  splitModelRef,
  lookupModel,
  resolveRoute,
  normalizeRequest,
  normalizeEffort,
  applyChatExtras,
  applySessionSticky,
  keyPoolFor,
  serializeCooldown,
  SerialQueue,
  buildTargetUrl,
  modeLabel,
  providerLabel,
  listModels,
  UPSTREAM_PATH,
}
