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

export interface StreamHandlers {
  /** 文本增量 */
  onText?: (delta: string) => void
  /** 推理模型（reasoner / o 系列）的思考增量 */
  onReasoning?: (delta: string) => void
}

export async function chatComplete(
  cfg: ProviderConfig,
  body: { messages: Message[]; tools?: ToolSpec[]; temperature?: number; maxTokens?: number },
  handlers?: StreamHandlers,
): Promise<CompletionResult> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 120_000)
  const streaming = Boolean(handlers?.onText || handlers?.onReasoning)

  const payload: Record<string, unknown> = {
    model: cfg.model,
    messages: body.messages.map((m) => {
      const out: Record<string, unknown> = { role: m.role, content: m.content }
      // 有图时 content 必须变成 parts 数组，纯字符串 + 图片在 OpenAI 协议里不接受
      if (m.images?.length) {
        out.content = [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.data}` },
          })),
        ]
      }
      if (m.tool_calls) out.tool_calls = m.tool_calls
      if (m.tool_call_id) out.tool_call_id = m.tool_call_id
      if (m.name) out.name = m.name
      return out
    }),
    stream: streaming,
  }
  if (streaming) payload.stream_options = { include_usage: true }
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
    // 先分流再读 body：res.text() 会把 ReadableStream 锁住，
    // 之后再交给 readStream 就是 "ReadableStream is locked"
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`E_LLM_HTTP ${res.status}: ${errText.slice(0, 400)}`)
    }
    if (streaming) {
      const ct = res.headers.get('content-type') ?? ''
      // 有些服务（老版本 Ollama、某些代理）会忽略 stream 参数直接回整包 JSON。
      // 请求了流却拿到 JSON 不是错误，按非流式解析即可——否则表现为「对面不听话就报错」。
      if (ct.includes('text/event-stream')) {
        return await readStream(res, cfg, handlers as StreamHandlers)
      }
    }

    const text = await res.text()
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

/**
 * 解析 SSE 流。
 *
 * 三件事必须做对，否则流式就是"看起来能用但结果是错的"：
 *  - tool_calls 是**分片**到达的：id/name 通常一次给全，arguments 一片片拼，
 *    漏一片就是非法 JSON；按 index 累积，不能按到达顺序覆盖。
 *  - 推理模型的思考走 `reasoning_content`（DeepSeek）或 `reasoning`（其他），
 *    和正文分开，否则会把思考内容塞进回答里。
 *  - usage 常常只在最后一个 chunk 里（要靠 stream_options.include_usage），
 *    没有就如实记 0 —— 本地服务经常干脆不给。
 */
async function readStream(
  res: Response,
  cfg: ProviderConfig,
  handlers: StreamHandlers,
): Promise<CompletionResult> {
  if (!res.body) throw new Error('E_LLM_STREAM: response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let content = ''
  let reasoning = ''
  let finishReason = 'stop'
  let model = cfg.model
  let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const calls = new Map<number, { id: string; name: string; args: string }>()

  const handleFrame = (frame: string): boolean => {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      if (payload === '[DONE]') return true

      let j: Record<string, unknown>
      try { j = JSON.parse(payload) as Record<string, unknown> } catch { continue }

      const err = j.error as { message?: string } | undefined
      if (err) throw new Error(`E_LLM: ${err.message ?? 'stream error'}`)
      if (typeof j.model === 'string') model = j.model

      const u = j.usage as Partial<Usage> | null | undefined
      if (u) {
        usage = {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? 0,
        }
      }

      const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0]
      if (!choice) continue
      const delta = (choice.delta ?? {}) as Record<string, unknown>

      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content
        handlers.onText?.(delta.content)
      }
      const r = delta.reasoning_content ?? delta.reasoning
      if (typeof r === 'string' && r) {
        reasoning += r
        handlers.onReasoning?.(r)
      }

      const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const idx = typeof tc.index === 'number' ? tc.index : 0
          const cur = calls.get(idx) ?? { id: '', name: '', args: '' }
          if (typeof tc.id === 'string' && tc.id) cur.id = tc.id
          const fn = tc.function as { name?: string; arguments?: string } | undefined
          if (fn?.name) cur.name = fn.name
          if (fn?.arguments) cur.args += fn.arguments
          calls.set(idx, cur)
        }
      }

      if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }
    return false
  }

  let done = false
  while (!done) {
    const { done: eof, value } = await reader.read()
    if (eof) break
    buf += decoder.decode(value, { stream: true })

    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (handleFrame(frame)) { done = true; break }
    }
  }
  if (!done && buf.trim()) handleFrame(buf)

  return {
    content,
    toolCalls: [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => ({
        id: c.id || `call_${i}_${content.length}`,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    usage,
    finishReason,
    model,
    ...(reasoning ? { reasoning } : {}),
  }
}
