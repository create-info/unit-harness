/**
 * Anthropic Messages API 适配器。
 *
 * 与 OpenAI 的差异（都在这里吸收，内核只认自己的 CompletionResult）：
 *  1. system 不是消息，是顶层参数；
 *  2. tool 结果不是 role:"tool"，而是 user 消息里的 tool_result block，
 *     且多个 tool_result 必须合并进同一条 user 消息；
 *  3. 认证头是 x-api-key + anthropic-version，不是 Bearer；
 *  4. max_tokens 必填。
 */
import type { CompletionResult, Message, ToolCall, ToolSpec } from './types.ts'

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string
}

interface AnthropicResponse {
  model?: string
  content?: AnthropicBlock[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string; type?: string }
}

export interface AnthropicConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
}

/** 把内部消息格式翻译成 Anthropic 的 (system, messages) */
export function toAnthropicMessages(messages: Message[]): {
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
} {
  const systemParts: string[] = []
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = []

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }

    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(tc.function.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : m.content })
      continue
    }

    if (m.role === 'tool') {
      // 连续的工具结果必须并进同一条 user 消息
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id ?? '',
        content: m.content,
      }
      const last = out[out.length - 1]
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        (last.content as AnthropicBlock[]).push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    // 带图的 user 消息：Anthropic 要求 image block 放在 text 之前或并列，content 必须是数组
    if (m.images?.length) {
      const blocks: AnthropicBlock[] = m.images.map((img) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: img.mediaType, data: img.data },
      }))
      if (m.content) blocks.push({ type: 'text', text: m.content })
      out.push({ role: 'user', content: blocks })
      continue
    }

    out.push({ role: 'user', content: m.content })
  }

  return { system: systemParts.join('\n\n'), messages: out }
}

export function toAnthropicTools(tools: ToolSpec[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }))
}

export async function anthropicComplete(
  cfg: AnthropicConfig,
  body: { messages: Message[]; tools?: ToolSpec[]; temperature?: number; maxTokens?: number },
  /** 外部取消信号（用户点了 Stop）；不接的话停止只能等到请求自己返回 */
  external?: AbortSignal,
): Promise<CompletionResult> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/v1/messages'
  const { system, messages } = toAnthropicMessages(body.messages)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 180_000)
  const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal

  const payload: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: body.maxTokens ?? 8192,
    messages,
  }
  if (system) payload.system = system
  const tools = toAnthropicTools(body.tools)
  if (tools) payload.tools = tools
  if (body.temperature !== undefined) payload.temperature = body.temperature

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`E_LLM_HTTP ${res.status}: ${text.slice(0, 400)}`)

    const data = JSON.parse(text) as AnthropicResponse
    if (data.error) throw new Error(`E_LLM: ${data.error.message ?? 'unknown error'}`)

    const blocks = data.content ?? []
    const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => ({
        id: b.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function' as const,
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      }))

    const inTok = data.usage?.input_tokens ?? 0
    const outTok = data.usage?.output_tokens ?? 0

    return {
      content: textOut,
      toolCalls,
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
      finishReason: data.stop_reason ?? 'stop',
      model: data.model ?? cfg.model,
    }
  } finally {
    clearTimeout(timer)
  }
}
