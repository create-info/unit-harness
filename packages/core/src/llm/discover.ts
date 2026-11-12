/**
 * 零配置探测本地模型服务。
 *
 * 首启体验的关键：用户装完 `uh` 不该先去找 API key。LM Studio（1234）与
 * Ollama（11434，带 /v1 兼容层）默认端口探一遍，能跑就直接跑。
 */
import type { ProviderConfig } from './types.ts'

async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/models', {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
    if (data.data) return data.data.map((m) => m.id ?? '').filter(Boolean)
    if (data.models) return data.models.map((m) => m.name ?? '').filter(Boolean)
    return []
  } catch {
    return []
  }
}

const CANDIDATES = [
  { baseUrl: 'http://127.0.0.1:1234/v1', label: 'LM Studio' },
  { baseUrl: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
  { baseUrl: 'http://127.0.0.1:8080/v1', label: 'llama.cpp / vLLM' },
]

export interface ResolveOptions {
  model?: string
  baseUrl?: string
  apiKey?: string
}

/** 解析 provider：显式参数 > 环境变量 > 本地探测 */
export async function resolveProvider(o: ResolveOptions = {}): Promise<ProviderConfig & { source: string }> {
  const envBase = process.env.UH_BASE_URL
  const envKey = process.env.UH_API_KEY
  const envModel = process.env.UH_MODEL

  const baseUrl = o.baseUrl ?? envBase
  const apiKey = o.apiKey ?? envKey
  const model = o.model ?? envModel

  if (baseUrl && model) {
    return { baseUrl, model, ...(apiKey ? { apiKey } : {}), source: 'explicit' }
  }

  if (baseUrl && !model) {
    const found = await listModels(baseUrl, apiKey)
    if (found.length > 0) {
      return { baseUrl, model: found[0] as string, ...(apiKey ? { apiKey } : {}), source: 'explicit+discovered' }
    }
    throw new Error(`E_LLM: no models at ${baseUrl}. Pass --model, or start a server there.`)
  }

  for (const c of CANDIDATES) {
    const found = await listModels(c.baseUrl)
    if (found.length > 0) {
      return {
        baseUrl: c.baseUrl,
        model: model ?? (found[0] as string),
        source: `discovered:${c.label}`,
      }
    }
  }

  throw new Error(
    'E_LLM: no model provider found.\n' +
    '  - start LM Studio / Ollama locally, or\n' +
    '  - set UH_BASE_URL + UH_MODEL (+ UH_API_KEY), e.g.\n' +
    '      UH_BASE_URL=https://api.deepseek.com/v1 UH_MODEL=deepseek-chat UH_API_KEY=sk-... uh run "..."',
  )
}
