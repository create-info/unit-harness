/**
 * LLM 网关：全系统唯一的模型出口。
 *
 * 负责：路由（provider/role）· 用量记录 · 事件留痕 · 失败重试。
 * 协议差异交给 complete() 分发，这里不认识任何具体厂商。
 */
import { complete as dispatch } from './complete.ts'
import type { CompletionResult, LlmRole, Message, ToolSpec } from './types.ts'
import type { ResolvedProvider } from './resolve.ts'

export type EventSink = (
  kind: 'llm/request' | 'llm/response',
  payload: Record<string, unknown>,
  parentId?: string | null,
) => string | null

export interface GatewayOptions {
  primary: ResolvedProvider
  cheap?: ResolvedProvider
  emit: EventSink
  maxRetries?: number
}

/** 粗略估算：4 字符 ≈ 1 token，只用于日志与预算提示 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
}

export class LlmGateway {
  constructor(private readonly opts: GatewayOptions) {}

  private pick(role: LlmRole): ResolvedProvider {
    if (role === 'cheap' && this.opts.cheap) return this.opts.cheap
    return this.opts.primary
  }

  async complete(req: {
    messages: Message[]
    tools?: ToolSpec[]
    role?: LlmRole
    temperature?: number
    maxTokens?: number
    /** 流式回调：给了就开流，不给就一次性返回 */
    onText?: (delta: string) => void
    onReasoning?: (delta: string) => void
  }): Promise<CompletionResult> {
    const target = this.pick(req.role ?? 'plan')
    const requestEv = this.opts.emit('llm/request', {
      provider: target.def.id,
      protocol: target.def.protocol,
      model: target.model,
      role: req.role ?? 'plan',
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
      est_tokens: estimateTokens(req.messages),
    })

    const attempts = (this.opts.maxRetries ?? 2) + 1
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await dispatch(
          target.def,
          {
            baseUrl: target.baseUrl,
            ...(target.apiKey ? { apiKey: target.apiKey } : {}),
            model: target.model,
          },
          req,
          (req.onText || req.onReasoning)
            ? {
                ...(req.onText ? { onText: req.onText } : {}),
                ...(req.onReasoning ? { onReasoning: req.onReasoning } : {}),
              }
            : undefined,
        )
        this.opts.emit('llm/response', {
          provider: target.def.id,
          model: res.model,
          usage: res.usage,
          finish_reason: res.finishReason,
          tool_calls: res.toolCalls.length,
          content_len: res.content.length,
        }, requestEv)
        return res
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        // 认证/参数错误重试没用
        if (/E_LLM_HTTP 4\d\d|E_LLM_NO_KEY/.test(msg)) break
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}
