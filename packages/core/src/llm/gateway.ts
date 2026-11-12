/**
 * LLM 网关：全系统唯一的模型出口。
 *
 * 负责四件事（docs/design-decisions.md 的 llmgw 设计）：
 *  ① 路由（role → 模型） ② 预算/用量记录 ③ 事件留痕 ④ 失败重试
 * P1 只做 ①③④ 的最小实现；② 记录 usage 但不做配额拒绝。
 */
import { chatComplete } from './openai.ts'
import type { CompletionResult, LlmRole, Message, ProviderConfig, ToolSpec } from './types.ts'

export type EventSink = (
  kind: 'llm/request' | 'llm/response',
  payload: Record<string, unknown>,
  parentId?: string | null,
) => string | null

export interface GatewayOptions {
  primary: ProviderConfig
  /** 便宜模型（可选），role=cheap 时使用 */
  cheap?: ProviderConfig
  emit: EventSink
  maxRetries?: number
}

/** 粗略估算：4 字符 ≈ 1 token，只用于日志与预算提示 */
export function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4)
}

export class LlmGateway {
  constructor(private readonly opts: GatewayOptions) {}

  private cfgFor(role: LlmRole): ProviderConfig {
    if (role === 'cheap' && this.opts.cheap) return this.opts.cheap
    return this.opts.primary
  }

  async complete(req: {
    messages: Message[]
    tools?: ToolSpec[]
    role?: LlmRole
    temperature?: number
    maxTokens?: number
  }): Promise<CompletionResult> {
    const cfg = this.cfgFor(req.role ?? 'plan')
    const requestEv = this.opts.emit('llm/request', {
      model: cfg.model,
      role: req.role ?? 'plan',
      messages: req.messages.length,
      tools: req.tools?.length ?? 0,
      est_tokens: estimateTokens(req.messages),
    })

    const attempts = (this.opts.maxRetries ?? 2) + 1
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await chatComplete(cfg, req)
        this.opts.emit('llm/response', {
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
        // 认证/请求错误不重试
        if (/E_LLM_HTTP 4\d\d/.test(msg)) break
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)))
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }
}
