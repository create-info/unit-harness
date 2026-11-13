/** 协议分发：内核只认 CompletionResult，协议差异在适配器里吸收 */
import { chatComplete } from './openai.ts'
import type { StreamHandlers } from './openai.ts'
import { anthropicComplete } from './anthropic.ts'
import type { CompletionResult, Message, ToolSpec } from './types.ts'
import type { ProviderDef } from './providers.ts'

export interface CallConfig {
  baseUrl: string
  apiKey?: string
  model: string
  timeoutMs?: number
}

export async function complete(
  def: ProviderDef,
  cfg: CallConfig,
  body: { messages: Message[]; tools?: ToolSpec[]; temperature?: number; maxTokens?: number },
  handlers?: StreamHandlers,
  /** 用户点了 Stop：必须一路传到 fetch，否则只能等这一轮自己跑完 */
  signal?: AbortSignal,
): Promise<CompletionResult> {
  if (def.protocol === 'anthropic') {
    if (!cfg.apiKey) {
      throw new Error(`E_LLM_NO_KEY: ${def.id} needs an API key. Run: uh config set ${def.id}`)
    }
    return anthropicComplete({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs }, body, signal)
  }
  return chatComplete(cfg, body, handlers, signal)
}
