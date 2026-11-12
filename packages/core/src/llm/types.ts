/** LLM 层的最小类型集。只实现 OpenAI 兼容的 chat completions。 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface Message {
  role: Role
  content: string
  /** assistant 发起工具调用时存在 */
  tool_calls?: ToolCall[]
  /** role=tool 时指向被回应的调用 */
  tool_call_id?: string
  name?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** OpenAI tools 格式 */
export interface ToolSpec {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface CompletionResult {
  content: string
  toolCalls: ToolCall[]
  usage: Usage
  finishReason: string
  model: string
}

export interface ProviderConfig {
  baseUrl: string
  apiKey?: string
  model: string
  /** 毫秒，默认 120s */
  timeoutMs?: number
}

/** 成本角色：决定路由与预算检查（见 docs 的 llmgw 设计） */
export type LlmRole = 'plan' | 'exec' | 'cheap'
