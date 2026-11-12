/**
 * Provider 注册表。
 *
 * 刻意**不硬编码模型名**：模型名半年就会退役（deepseek-chat / deepseek-reasoner
 * 已在 2026-07 下线）。真实模型列表在配置了 key 之后从 `{baseUrl}/models` 拉，
 * 这里只描述"怎么连"。
 */
export type WireProtocol = 'openai' | 'anthropic'

export interface ProviderDef {
  id: string
  label: string
  protocol: WireProtocol
  baseUrl: string
  /** 环境变量名；本地服务为空 */
  envKey?: string
  /** 是否本地服务（不需要 key，走自动探测） */
  local?: boolean
  /** 申请 key 的地方，出现在 `uh provider list` 里 */
  keysUrl?: string
  /** 默认模型提示：仅在服务端拒绝列出模型时用于提示，不作为调用参数 */
  modelHint?: string
}

export const PROVIDERS: ProviderDef[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', keysUrl: 'https://platform.deepseek.com/api_keys', modelHint: 'deepseek-v4-flash' },
  { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', keysUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', keysUrl: 'https://platform.openai.com/api-keys' },
  { id: 'moonshot', label: 'Moonshot (Kimi)', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', envKey: 'MOONSHOT_API_KEY', keysUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'zhipu', label: 'Zhipu (GLM)', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'ZHIPU_API_KEY', keysUrl: 'https://bigmodel.cn/usercenter/apikeys' },
  { id: 'qwen', label: 'Qwen (DashScope)', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', keysUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'siliconflow', label: 'SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', envKey: 'SILICONFLOW_API_KEY', keysUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', keysUrl: 'https://console.groq.com/keys' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', keysUrl: 'https://openrouter.ai/keys' },
  { id: 'ollama', label: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM Studio (local)', protocol: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', local: true },
  { id: 'vllm', label: 'vLLM / llama.cpp (local)', protocol: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', local: true },
]

export function findProvider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

/** 探测顺序：LM Studio 默认携带完整模型库，优先；Ollama 次之 */
const LOCAL_ORDER = ['lmstudio', 'ollama', 'vllm']

export function localProviders(): ProviderDef[] {
  return PROVIDERS.filter((p) => p.local).sort(
    (a, b) => LOCAL_ORDER.indexOf(a.id) - LOCAL_ORDER.indexOf(b.id),
  )
}

/** 打完码的 key，用于展示与日志；任何输出都不得出现完整 key */
export function maskKey(key: string | undefined): string {
  if (!key) return '(none)'
  if (key.length <= 10) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}
