/**
 * A2A v1.0 数据模型（子集）。
 *
 * 只放我们用得到的字段，但字段名和枚举值严格照规范写——协议对象上自作聪明
 * 改名字，对方客户端就认不出来了。
 *
 * 规范来源：https://a2a-protocol.org/latest/specification/ 第 4 章。
 * 注意 v1.0 和 v0.x 差别很大：方法名从 `message/send` 变成 `SendMessage`，
 * 枚举带 `TASK_STATE_` 前缀，Task 多了 contextId。照旧文档写会连不上新客户端。
 */

export type TaskState =
  | 'TASK_STATE_UNSPECIFIED'
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED'

export type Role = 'ROLE_UNSPECIFIED' | 'ROLE_USER' | 'ROLE_AGENT'

/** Part 必须且只能含 text / raw / url / data 之一 */
export interface Part {
  text?: string
  raw?: string
  url?: string
  data?: unknown
  metadata?: Record<string, unknown>
  filename?: string
  mediaType?: string
}

export interface Artifact {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
}

export interface Message {
  messageId: string
  contextId?: string
  taskId?: string
  role: Role
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
  referenceTaskIds?: string[]
}

export interface TaskStatus {
  state: TaskState
  message?: Message
  timestamp?: string
}

export interface Task {
  id: string
  contextId?: string
  status: TaskStatus
  artifacts?: Artifact[]
  history?: Message[]
  metadata?: Record<string, unknown>
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  tags: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

export interface AgentCapabilities {
  streaming?: boolean
  pushNotifications?: boolean
  stateTransitionHistory?: boolean
  extendedAgentCard?: boolean
}

export interface AgentInterface {
  url: string
  /** JSONRPC | GRPC | HTTP+JSON */
  protocolBinding: string
  tenant?: string
}

export interface AgentCard {
  name: string
  description: string
  supportedInterfaces: AgentInterface[]
  provider?: { organization: string; url?: string }
  version: string
  documentationUrl?: string
  capabilities: AgentCapabilities
  securitySchemes?: Record<string, unknown>
  securityRequirements?: unknown[]
  defaultInputModes: string[]
  defaultOutputModes: string[]
  skills: AgentSkill[]
}

export interface SendMessageRequest {
  tenant?: string
  message: Message
  configuration?: {
    acceptedOutputModes?: string[]
    historyLength?: number
    taskPushNotificationConfig?: unknown
  }
  metadata?: Record<string, unknown>
}

export interface SendMessageResponse {
  task?: Task
  message?: Message
}

/** JSON-RPC 2.0 错误码里 A2A 用到的几个 */
export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  /** A2A 扩展码 */
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
} as const
