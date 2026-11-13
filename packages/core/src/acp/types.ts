/**
 * ACP v1（Agent Client Protocol）数据模型子集。
 *
 * 来源：https://agentclientprotocol.com/protocol/v1/ 的 .md 版本（比抓渲染页干净）。
 * ACP 是 stdio JSON-RPC 2.0，一行一条消息，所以 stdout 只能有协议帧——
 * 任何 console.log 都会把客户端搞崩，日志一律走 stderr。
 */

/** 一个会话里的一条用户输入。text 最常见，resource 是文件引用。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'image'; mimeType: string; data: string }

export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean }
  terminal?: boolean
  auth?: { terminal?: boolean }
}

export interface AgentCapabilities {
  loadSession?: boolean
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean }
  mcpCapabilities?: { http?: boolean; sse?: boolean }
}

export interface Implementation {
  name: string
  title?: string
  version: string
}

export interface InitializeParams {
  protocolVersion: number
  clientCapabilities?: ClientCapabilities
  clientInfo?: Implementation
}

export interface InitializeResult {
  protocolVersion: number
  agentCapabilities: AgentCapabilities
  agentInfo: Implementation
  authMethods: unknown[]
}

export interface SessionNewParams {
  cwd: string
  mcpServers?: unknown[]
}

export interface SessionNewResult {
  sessionId: string
}

export interface PromptParams {
  sessionId: string
  prompt: ContentBlock[]
}

/**
 * 回合为什么结束。取消必须用 `cancelled`，不要用错误——
 * 客户端把未识别的错误显示给用户，而用户按的是"停止"，不是"出错了"。
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'

export interface PromptResult {
  stopReason: StopReason
}

/** session/update 的 update 载荷，只用我们真能产出的几种 */
export type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; messageId?: string; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; messageId?: string; content: ContentBlock }
  | {
      sessionUpdate: 'tool_call'
      toolCallId: string
      title: string
      kind?: 'read' | 'edit' | 'execute' | 'search' | 'other'
      status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      rawInput?: unknown
    }
  | {
      sessionUpdate: 'tool_call_update'
      toolCallId: string
      status?: 'pending' | 'in_progress' | 'completed' | 'failed'
      content?: Array<{ type: 'content'; content: ContentBlock }>
      rawOutput?: unknown
    }
  | {
      sessionUpdate: 'plan'
      entries: Array<{ content: string; status?: 'pending' | 'in_progress' | 'completed'; priority?: string }>
    }

export interface SessionUpdateParams {
  sessionId: string
  update: SessionUpdate
}

/**
 * 审批请求。我们的审批门天然就是这个——和 A2A 的 INPUT_REQUIRED 是同一件事的两种说法。
 */
export interface RequestPermissionParams {
  sessionId: string
  toolCall: { toolCallId: string; title: string; kind?: string; status?: string; rawInput?: unknown }
  options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>
}

export interface RequestPermissionResult {
  outcome:
    | { outcome: 'selected'; optionId: string }
    | { outcome: 'cancelled' }
}

export const ACP_ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** ACP 扩展：需要先认证 */
  AUTH_REQUIRED: -32000,
  SESSION_NOT_FOUND: -32001,
} as const
