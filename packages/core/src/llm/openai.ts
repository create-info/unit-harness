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

/**
 * 把 fetch 的失败翻译成能查的话。
 *
 * Node 的 fetch 在几乎所有网络层失败上都只抛 TypeError: fetch failed,
 * 具体原因藏在 err.cause.code 里。不把它带出来，用户看到的就是一句
 * "fetch failed"——既不知道是服务没开、还是地址错了、还是 key 里有脏字符。
 *
 * UND_ERR_INVALID_ARG 特别值得一提：它不是网络问题，是**请求本身非法**。
 * 最常见的原因是 API key 里混进了换行或 ESC（终端 raw mode 下按方向键就会
 * 把 ESC 序列插进去）。这种情况重启服务、重试都没用。
 */
function explainFetchError(err: unknown, url: string, cfg: { model: string; apiKey?: string }): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause
  const code = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))
  const host = (() => { try { return new URL(url).host } catch { return url } })()

  if (code === 'UND_ERR_INVALID_ARG') {
    const dirty = cfg.apiKey
      ? [...cfg.apiKey].some((c) => c.charCodeAt(0) < 0x21 || c.charCodeAt(0) > 0x7e)
      : false
    return dirty
      ? 'E_LLM_KEY: 这个 provider 的 apiKey 里有控制字符（换行 / ESC 等），请求根本发不出去。' +
        ' 重新设置一次：uh config set <provider>'
      : 'E_LLM_REQUEST: 请求参数非法（' + code + '），检查 baseUrl 与 apiKey'
  }
  if (code === 'ECONNREFUSED') {
    return 'E_LLM_CONNECT: ' + host + ' 上没有服务在监听。本地模型要先启动（LM Studio / Ollama），' +
      '或者 uh provider list 看有哪些可用'
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'E_LLM_DNS: 解析不了 ' + host + '——检查 baseUrl 的拼写和网络'
  }
  if (code === 'ABORT_ERR' || code === 'UND_ERR_ABORTED') {
    return 'E_LLM_TIMEOUT: 等 ' + host + ' 响应超时（模型可能正在加载，或提示词太长）'
  }
  return 'E_LLM_FETCH: 连不上 ' + host + '（' + code + '）'
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
  /**
   * 外部取消信号（用户点了 Stop）。
   *
   * 不接这个信号的话，停止标志只能在 step 边界生效——而一个 27B 模型的
   * 单次请求就是几十秒。用户点了 Stop、界面上转着 "stopping…"、
   * 实际上请求还在跑，看起来就是"停不下来"。
   */
  external?: AbortSignal,
): Promise<CompletionResult> {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 120_000)
  // 谁先到算谁：超时或用户点停
  const signal = external ? AbortSignal.any([controller.signal, external]) : controller.signal
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
      signal,
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
  } catch (err) {
    // 裸的 fetch failed 什么也说明不了：连不上、DNS、header 非法、超时
    // 都是这一句。真实原因在 err.cause 里，必须带出来。
    // 用户主动停的，不要报成"连不上"——那不是故障，是他自己的操作
    if ((err as { name?: string }).name === 'AbortError' || external?.aborted) {
      throw new Error('E_LLM_ABORTED: stopped by the user')
    }
    throw new Error(explainFetchError(err, url, cfg), { cause: err })
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
