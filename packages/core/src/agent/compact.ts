/**
 * 上下文压缩。
 *
 * 借鉴 Codex 第 14 讲的结论：压缩是一条生命周期，不是"摘要一下扔掉旧历史"。
 * 我们实现其中最朴素但够用的一条路径 —— 本地摘要（Codex 的 Unsupported 分支）：
 * 把历史交给模型，取回一段结构化摘要，替换掉旧消息。
 *
 * 三条不可让步的约束：
 *  1. 用户的原始请求必须逐字保留 —— 那是"授权事实"，摘要不能改写它；
 *  2. 失败过的尝试要进摘要 —— 否则模型会兴致勃勃地再踩一次同样的坑；
 *  3. 保留的消息必须从 assistant 边界开始 —— 否则 tool 消息失去配对，Anthropic 直接 400。
 */
import type { Message } from '../llm/types.ts'
import type { LlmGateway } from '../llm/gateway.ts'

export const SUMMARY_PROMPT = `You are compacting the working memory of a coding agent that must continue working WITHOUT seeing the original conversation.

Produce a dense summary with these sections, in this order:

## Task
The user's request, verbatim if it fits in two lines.

## Done so far
What was actually executed and what it produced. Include exact file paths, commands that mattered, and concrete values. Drop anything that was already applied.

## Failed attempts
What was tried and did NOT work, and why. This exists so the agent does not repeat it.

## Remaining
What is still open, if anything.

Rules: terse bullets, no preamble, no praise, no plan narration. If a fact is uncertain, say so instead of guessing.`

export interface CompactionOptions {
  /** 保留最近多少条消息（不含 system） */
  keepRecent?: number
  /** 摘要调用用的额外说明，比如"这是一个部署脚本任务" */
  hint?: string
}

export interface CompactionResult {
  messages: Message[]
  beforeChars: number
  afterChars: number
  dropped: number
  summary: string
}

/**
 * 找安全的切割点：从末尾往前保留 keep 条，然后向前对齐到 assistant 边界，
 * 保证不会留下"孤立的 tool 消息"（有 tool 结果但没有对应的 tool_calls）。
 */
export function safeCutIndex(messages: Message[], keep: number): number {
  let idx = Math.max(0, messages.length - keep)
  // 跳过开头的 tool 消息：它们属于更早的 assistant
  while (idx < messages.length && messages[idx]?.role === 'tool') idx++
  // 如果第一条不是 user/assistant，继续往后挪
  while (idx < messages.length && messages[idx]?.role !== 'user' && messages[idx]?.role !== 'assistant') idx++
  return idx
}

/** 纯函数：把旧消息拼成摘要请求的输入文本 */
export function renderTranscript(messages: Message[], limitChars = 40_000): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      parts.push(`[tool result] ${m.content.slice(0, 1200)}`)
      continue
    }
    if (m.role === 'assistant') {
      const calls = (m.tool_calls ?? []).map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`)
      if (m.content) parts.push(`[assistant] ${m.content.slice(0, 1200)}`)
      if (calls.length) parts.push(`[assistant → tool] ${calls.join('; ')}`)
      continue
    }
    parts.push(`[user] ${m.content.slice(0, 2000)}`)
  }
  // 只保留最近的 limitChars，压缩请求本身不能爆
  let text = parts.join('\n')
  if (text.length > limitChars) text = `…(earlier turns elided)…\n${text.slice(text.length - limitChars)}`
  return text
}

export async function compactMessages(
  gateway: LlmGateway,
  messages: Message[],
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  const keep = opts.keepRecent ?? 6
  const system = messages.filter((m) => m.role === 'system')
  const body = messages.filter((m) => m.role !== 'system')

  const cut = safeCutIndex(body, keep)
  const old = body.slice(0, cut)
  const tail = body.slice(cut)

  if (old.length === 0) {
    return { messages, beforeChars: 0, afterChars: 0, dropped: 0, summary: '' }
  }

  const transcript = renderTranscript(old)
  const res = await gateway.complete({
    role: 'cheap',
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: (opts.hint ? `${opts.hint}\n\n` : '') + transcript },
    ],
    temperature: 0,
  })

  const summary = res.content.trim() || '(summary unavailable)'
  const compactionMessage: Message = {
    role: 'user',
    content:
      '[Compacted context — earlier turns were summarised to free space]\n' +
      summary +
      '\n[End of compacted context. Continue the work from here.]',
  }

  const next = [...system, compactionMessage, ...tail]
  return {
    messages: next,
    beforeChars: old.reduce((n, m) => n + m.content.length, 0),
    afterChars: summary.length,
    dropped: old.length,
    summary,
  }
}

/** 估算当前窗口是否该压缩：prompt_tokens 来自上一次真实响应 */
export function shouldCompact(promptTokens: number, maxContextTokens: number, ratio = 0.7): boolean {
  if (!Number.isFinite(promptTokens) || promptTokens <= 0) return false
  return promptTokens >= Math.floor(maxContextTokens * ratio)
}
