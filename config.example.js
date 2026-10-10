// config.example.js — ai-proxy 示例配置文件
// 使用时请复制为 config.js 并填入您自己的 API Key。
//
// 结构参考 omp / opencode：每个上游一个 provider 对象，声明自己的模型、各协议端点、
// 密钥、思考深度映射。三个代理服务（anthropic 3718 / openai 3719 / codex 3722）共用
// 这一份，服务代码里不再出现任何厂商名硬编码。
//
// ══ 模型寻址 ══════════════════════════════════════════════════════════
// 客户端模型名写成 `provider:modelId`：
//
//     wb:global:deepseek-v4.1-flash
//     └┬┘└────────────┬──────────┘
//   provider       modelId（原样发给上游）
//
// 按第一个冒号切分，所以 modelId 里可以再带冒号。
// 解析不出来就报错，不兜底到任何默认上游 —— 静默改投别家会让写错的模型名看起来像跑通了。
//
// ══ provider 字段 ═════════════════════════════════════════════════════
//   name              展示名（日志用）
//   apiKey            上游密钥，所有协议共用
//   apiKeys           可选，按协议覆盖 apiKey（如 OpenRouter 的 Claude/Codex 分池）
//   baseUrls          各协议端点。声明了哪个协议就等于「该协议可用」：
//                       有与客户端同协议的端点 -> 直连（字节透传）
//                       只有 openai_chat      -> 走协议桥转换
//                       都没有                -> 明确报错，不静默改投别家上游
//   transport         可选，按协议指定传输层 'http1' | 'http2'（缺省 http2）
//   models            可选，模型表。键是客户端可用的 modelId，值可为：
//                       {}                        仅声明（原样透传）
//                       { upstreamId: 'x' }       别名：上游实际收到 x
//                       '*'                       兜底：未列出的 modelId 也接受
//   modelPrefixes     可选，裸模型名的归属前缀（如 ['global:', 'cn:']）
//   effort            可选，思考深度映射表，按客户端协议分档
//   keyPools          可选，按协议分池的轮换密钥（429 时切下一把）
//   serialize         可选，按协议单并发排队 + 冷却毫秒
//   chatExtras        可选，走 Chat 协议时追加的请求体字段
//   sessionSticky     可选，会话粘性键映射

module.exports = {
  // ==================== 服务端口 ====================
  ports: {
    anthropic: 3718, // Claude Code 等 Anthropic 协议客户端接入
    codex: 3722,     // Codex CLI 等 Responses 协议客户端接入
    openai: 3719,    // OpenAI 兼容（Chat Completions）客户端接入
  },

  // ==================== 上游提供方 ====================
  providers: {
    // ---- WorkBuddy 网关示例 ----
    wb: {
      name: 'WorkBuddy',
      apiKey: 'your-workbuddy-key-here',
      baseUrls: {
        openai_chat: 'http://127.0.0.1:7863',
      },
      transport: { openai_chat: 'http1' },
      models: {
        '*': {},
        'deepseek-v4.1-flash': {},
        'glm-5.3': {},
        'kimi-k3-1': {},
        'global:deepseek-v4.1-flash': {},
        'global:glm-5.3': {},
        'global:kimi-k3': {},
      },
      modelPrefixes: ['global:', 'cn:'],
      effort: {
        openai_responses: { map: { ultra: 'max' } },
        anthropic: { field: 'reasoning_effort' },
      },
      sessionSticky: { header: 'x-deepseek-harness-session-id', field: 'conversation_id' },
    },

    // ---- DeepSeek ----
    deepseek: {
      name: 'DeepSeek',
      apiKey: 'your-deepseek-api-key-here',
      baseUrls: {
        anthropic: 'https://api.deepseek.com/anthropic',
        openai_chat: 'https://api.deepseek.com/v1',
        openai_responses: 'https://api.deepseek.com/v1',
      },
      models: {
        'deepseek-flash': {},
        'deepseek-v4-pro': {},
        'haiku': { upstreamId: 'deepseek-flash' },
      },
      effort: {
        anthropic: { map: { ultra: 'max', xhigh: 'max' }, field: 'reasoning_effort' },
        openai_chat: { force: 'max' },
        openai_responses: { map: { ultra: 'max' } },
      },
    },

    // ---- MiniMax ----
    minimax: {
      name: 'MiniMax',
      apiKey: 'your-minimax-api-key-here',
      baseUrls: {
        anthropic: 'https://api.minimaxi.com/anthropic',
        openai_chat: 'https://api.minimaxi.com/v1',
        openai_responses: 'https://api.minimaxi.com/v1',
      },
      models: {
        'MiniMax-M3': {},
        'MiniMax-M2.7': {},
        'MiniMax-M2.7-highspeed': {},
        'MiniMax-M2.5': {},
        'MiniMax-M2.5-highspeed': {},
        'MiniMax-M2.1': {},
        'MiniMax-M2.1-highspeed': {},
        'MiniMax-M2': {},
      },
      effort: {
        anthropic: { map: { ultra: 'high', xhigh: 'high' } },
        openai_responses: { map: { ultra: 'high', xhigh: 'high' } },
      },
      chatExtras: { reasoning_split: true },
    },

    // ---- Kimi ----
    kimi: {
      name: 'Kimi',
      apiKey: 'your-kimi-api-key-here',
      baseUrls: {
        anthropic: 'https://api.kimi.com/coding',
      },
      models: {
        'k3': {},
        'k3-256k': {},
        'kimi-for-coding': {},
        'kimi-for-coding-highspeed': {},
      },
      effort: {
        anthropic: { map: { ultra: 'max', xhigh: 'max' }, field: 'reasoning_effort' },
      },
    },

    // ---- OpenRouter ----
    openrouter: {
      name: 'OpenRouter',
      apiKey: 'your-openrouter-api-key-here',
      apiKeys: {
        anthropic: 'your-openrouter-anthropic-key-here',
        openai_responses: 'your-openrouter-responses-key-here',
      },
      baseUrls: {
        anthropic: 'https://openrouter.ai/api',
        openai_chat: 'https://openrouter.ai/api/v1',
        openai_responses: 'https://openrouter.ai/api/v1',
      },
      models: {
        'stealth/union-alpha': {},
        'union-alpha': { upstreamId: 'stealth/union-alpha' },
        'opus': { upstreamId: 'stealth/union-alpha' },
      },
      keyPools: {
        anthropic: [
          'your-openrouter-anthropic-key-1',
          'your-openrouter-anthropic-key-2',
        ],
        openai_responses: [
          'your-openrouter-responses-key-1',
          'your-openrouter-responses-key-2',
        ],
      },
      serialize: { openai_responses: 1500 },
    },

    // ---- Qoder Hub ----
    qoder: {
      name: 'Qoder',
      apiKey: '',
      baseUrls: {
        openai_chat: 'http://127.0.0.1:8790',
      },
      transport: { openai_chat: 'http1', openai_responses: 'http1' },
      models: {
        '*': {},
        'qfmodel': {},
        'Qwen3.8-Flash': { upstreamId: 'qfmodel' },
        'qwen3.8-flash': { upstreamId: 'qfmodel' },
        'qmodel_38max': {},
        'Qwen3.8-Max': { upstreamId: 'qmodel_38max' },
        'qwen3.8-max': { upstreamId: 'qmodel_38max' },
        'dfmodel': {},
        'DeepSeek-Flash': { upstreamId: 'dfmodel' },
        'deepseek-flash-q': { upstreamId: 'dfmodel' },
        'gmodel': {},
        'GLM-5.3': { upstreamId: 'gmodel' },
        'glm-5.3-q': { upstreamId: 'gmodel' },
        'glm-5.3': { upstreamId: 'gmodel' },
        'gfmodel': {},
        'GLM-5.3-Flash': { upstreamId: 'gfmodel' },
        'glm-5.3-flash': { upstreamId: 'gfmodel' },
        'kmodel_latest': {},
        'Kimi-K3': { upstreamId: 'kmodel_latest' },
        'kimi-k3-q': { upstreamId: 'kmodel_latest' },
        'ultimate': {},
        'Ultimate': { upstreamId: 'ultimate' },
        'opus 5.5': { upstreamId: 'ultimate' },
        'opus-5.5': { upstreamId: 'ultimate' },
        'opus5.5': { upstreamId: 'ultimate' },
        'performance': {},
        'Performance': { upstreamId: 'performance' },
        'gpt 6': { upstreamId: 'performance' },
        'gpt-6': { upstreamId: 'performance' },
        'gpt6': { upstreamId: 'performance' },
      },
      effort: {
        openai_responses: { map: { ultra: 'xhigh' } },
        anthropic: { map: { ultra: 'xhigh' }, field: 'reasoning_effort' },
        openai_chat: { map: { ultra: 'xhigh' } },
      },
      modelsEffort: {
        'qfmodel': {
          openai_responses: { map: { ultra: 'xhigh', max: 'xhigh' } },
          anthropic: { map: { ultra: 'xhigh', max: 'xhigh' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'xhigh', max: 'xhigh' } },
        },
        'qmodel_38max': {
          openai_responses: { map: { ultra: 'xhigh', max: 'xhigh' } },
          anthropic: { map: { ultra: 'xhigh', max: 'xhigh' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'xhigh', max: 'xhigh' } },
        },
        'kmodel_latest': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
        'gmodel': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
        'gfmodel': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
        'dfmodel': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
        'ultimate': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
        'performance': {
          openai_responses: { map: { ultra: 'max' } },
          anthropic: { map: { ultra: 'max' }, field: 'reasoning_effort' },
          openai_chat: { map: { ultra: 'max' } },
        },
      },
    },
  },
}
