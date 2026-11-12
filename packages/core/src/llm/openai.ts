/**
 * OpenAI 兼容的 chat completions 客户端。
 *
 * 覆盖 DeepSeek / OpenAI / LM Studio / Ollama / vLLM —— 它们都实现了
 * `POST {baseUrl}/chat/completions` 与 `tools` 字段，不需要每家一个适配器。
 */
import type { CompletionResult, Message, ProviderConfig, ToolSpec, Usage } from './types.ts'

interface RawResponse {
  model?: string
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> }
    finish_reason?: string
  }>
  usage?: Partial<Usage>
  error?: { message?: string }
}

export async function chatComplete(
  cfg: ProviderConfig,
  body: { messages: Message[]; tools?: ToolSpec[]; temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 120_000)

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: body.messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content }
      if (m.tool_calls) out.tool_calls = m.tool_calls
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id
      if (m.name) out.name = m.name
      return out
    }),
    stream: false,
  }
  if (body.tools?.length) payload.tools = body.tools
  if (body.temperature !== undefined) payload.temperature = body.temperature
  if (body.maxTokens !== undefined) payload.max_tokens = body.maxTokens

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`E_LLM_HTTP ${res.status}: ${text.slice(0, 400)}`)
    }
    const data = JSON.parse(text) as RawResponse
    if (data.error) throw new Error(`E_LLM: ${data.error.message ?? 'unknown error'}`)

    const choice = data.choices?.[0]
    const msg = choice?.message
    const toolCalls = (msg?.tool_calls ?? []).map((t) => ({
      id: t.id,
      type: 'function' as const,
      function: { name: t.function.name, arguments: t.function.arguments },
    }))

    return {
      content: msg?.content ?? '',
      toolCalls,
      usage: {
        prompt_tokens: data.usage?.prompt_tokens ?? 0,
        completion_tokens: data.usage?.completion_tokens ?? 0,
        total_tokens: data.usage?.total_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? 'stop',
      model: data.model ?? cfg.model,
    }
  } finally {
    clearTimeout(timer)
  }
}
