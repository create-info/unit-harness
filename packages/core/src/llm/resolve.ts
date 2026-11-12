/**
 * Provider 解析：决定"这次用哪个模型"。
 *
 * 优先级（高 → 低）：
 *   1. 显式 --base-url（自建网关 / 代理），协议按 openai 处理
 *   2. 显式 --provider
 *   3. 环境变量 UH_PROVIDER
 *   4. ~/.uh/config.json 的 defaultProvider
 *   5. 唯一可用的 provider（配了 key 或本地可探测的）
 *   6. 多个可用但没指定 → 报错并列出，绝不猜
 */
import { PROVIDERS, findProvider, localProviders, maskKey } from './providers.ts'
import type { ProviderDef } from './providers.ts'
import { apiKeyFor, readConfig } from './config.ts'

export interface ResolvedProvider {
  def: ProviderDef
  baseUrl: string
  apiKey?: string
  model: string
  /** 人类可读的来源说明，进日志与 doctor */
  source: string
}

export interface ResolveOptions {
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
}

interface ModelListResponse {
  data?: Array<{ id?: string; name?: string }>
  models?: Array<{ name?: string; id?: string }>
}

/** 从服务端拉真实模型列表（永远比硬编码准确） */
export async function listModels(def: ProviderDef, apiKey: string | undefined, baseUrl?: string): Promise<string[]> {
  const root = (baseUrl ?? def.baseUrl).replace(/\/$/, '')
  const url = def.protocol === 'anthropic' ? `${root}/v1/models` : `${root}/models`
  try {
    const res = await fetch(url, {
      headers: {
        ...(apiKey
          ? def.protocol === 'anthropic'
            ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
            : { authorization: `Bearer ${apiKey}` }
          : {}),
      },
      signal: AbortSignal.timeout(def.local ? 2500 : 8000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as ModelListResponse
    const ids = [
      ...(data.data ?? []).map((m) => m.id ?? m.name ?? ''),
      ...(data.models ?? []).map((m) => m.name ?? m.id ?? ''),
    ]
    return ids.filter((s): s is string => !!s)
  } catch {
    return []
  }
}

function pickModel(list: string[]): string {
  // 优先挑看起来像主力对话模型的，避开 embedding / rerank / 语音
  const chat = list.filter((m) => !/embed|rerank|whisper|tts|vision-only|bge|gte/i.test(m))
  return (chat.length > 0 ? chat : list)[0] as string
}

export async function resolveProvider(o: ResolveOptions = {}): Promise<ResolvedProvider> {
  const envProvider = process.env.UH_PROVIDER
  const cfg = readConfig()
  const explicitBase = o.baseUrl ?? process.env.UH_BASE_URL
  const explicitModel = o.model ?? process.env.UH_MODEL

  // 1) 自定义 endpoint：没有 provider 定义，按 OpenAI 兼容处理
  if (explicitBase) {
    const apiKey = o.apiKey ?? process.env.UH_API_KEY
    const pseudo: ProviderDef = {
      id: 'custom',
      label: 'custom endpoint',
      protocol: 'openai',
      baseUrl: explicitBase,
      ...(apiKey ? { envKey: 'UH_API_KEY' } : {}),
    }
    const models = await listModels(pseudo, apiKey, explicitBase)
    const model = explicitModel ?? (models.length ? pickModel(models) : '')
    if (!model) {
      throw new Error(`E_LLM: no model at ${explicitBase} and none given. Pass --model.`)
    }
    return { def: pseudo, baseUrl: explicitBase, ...(apiKey ? { apiKey } : {}), model, source: 'custom endpoint' }
  }

  // 2-4) 指定的 provider
  const wantedId = o.provider ?? envProvider ?? cfg.defaultProvider
  if (wantedId) {
    const def = findProvider(wantedId)
    if (!def) {
      throw new Error(`E_PROVIDER: unknown provider "${wantedId}".\nKnown: ${PROVIDERS.map((p) => p.id).join(', ')}`)
    }
    const apiKey = o.apiKey ?? apiKeyFor(def)
    if (!def.local && !apiKey) {
      throw new Error(
        `E_LLM_NO_KEY: ${def.label} needs an API key.\n` +
        `  uh config set ${def.id}        # paste the key when prompted\n` +
        (def.keysUrl ? `  get one: ${def.keysUrl}` : ''),
      )
    }
    const baseUrl = cfg.providers[def.id]?.baseUrl ?? def.baseUrl
    const models = await listModels(def, apiKey, baseUrl)
    const model = explicitModel ?? cfg.providers[def.id]?.model ?? (models.length ? pickModel(models) : def.modelHint ?? '')
    if (!model) {
      throw new Error(
        `E_LLM_NO_MODEL: could not list models for ${def.label}.\n` +
        `  models seen: ${models.length ? models.slice(0, 8).join(', ') : '(none)'}\n` +
        `  pass --model <id> or: uh config set ${def.id}.model <id>`,
      )
    }
    return {
      def,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      model,
      source: `provider:${def.id} key=${maskKey(apiKey)}`,
    }
  }

  // 5) 自动发现
  // 本地服务只是"顺手探测到的"，同时跑着 Ollama 和 LM Studio 很常见，
  // 不该因此报错；只有云端 —— 那是要花钱、且用户明确配过 key 的 —— 才需要人决策。
  const locals: ProviderDef[] = []
  for (const p of localProviders()) {
    const models = await listModels(p, undefined)
    if (models.length > 0) locals.push(p)
  }
  const clouds: ProviderDef[] = PROVIDERS.filter((p) => !p.local && apiKeyFor(p))

  if (clouds.length === 0 && locals.length === 0) {
    throw new Error(
      'E_NO_PROVIDER: no model provider configured.\n\n' +
      '  uh provider list        # see what is supported\n' +
      '  uh config set deepseek  # paste an API key (stored in ~/.uh/config.json, 0600)\n\n' +
      '  or start a local server: LM Studio (:1234) / Ollama (:11434) / vLLM (:8080)',
    )
  }

  if (clouds.length > 1) {
    throw new Error(
      `E_PROVIDER_AMBIGUOUS: several API keys are configured (${clouds.map((p) => p.id).join(', ')}).\n` +
      '  pick one:  uh config use <id>\n' +
      '  or per run: --provider <id>',
    )
  }

  // 配了云端 key 就用云端（那是用户的明确意图），否则落到本地第一个
  const def = (clouds[0] ?? locals[0]) as ProviderDef
  const apiKey = apiKeyFor(def)
  const models = await listModels(def, apiKey)
  const model = explicitModel ?? cfg.providers[def.id]?.model ?? (models.length ? pickModel(models) : def.modelHint ?? '')
  if (!model) throw new Error(`E_LLM_NO_MODEL: ${def.label} is reachable but lists no models.`)

  const others = [...clouds, ...locals].filter((p) => p.id !== def.id).map((p) => p.id)
  return {
    def,
    baseUrl: cfg.providers[def.id]?.baseUrl ?? def.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    model,
    source: def.local
      ? `discovered:${def.label}${others.length ? ` (also available: ${others.join(', ')})` : ''}`
      : `configured key${others.length ? ` (also available: ${others.join(', ')})` : ''}`,
  }
}
