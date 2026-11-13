/**
 * 事件 kind 白名单与最小 payload 校验。
 *
 * 只登记 `session/*`（持久事实）。`agent/*` 是实时拦截面，**不落日志**
 * （见 docs/event-model.md §1）。
 */

export const SESSION_KINDS = [
  'session/start', 'session/resumed', 'session/compacted', 'session/end',
  'session/interrupted',
  'checkpoint/created', 'checkpoint/restored',
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'steering/message',
  'assistant/chunk', 'assistant/message',
  'llm/request', 'llm/response',
  'tool/call', 'tool/result',
  'artifact/emitted',
  'plan/updated',
  'verification/asserted',
  'approval/requested', 'approval/resolved',
  'hook/execution',
  'scope/forked', 'scope/disposed',
  'agent/spawned', 'agent/finished',
  'protocol/received', 'protocol/sent',
  'error',
] as const

export type SessionKind = (typeof SESSION_KINDS)[number]

export type EventSource = 'agent' | 'user' | 'environment' | 'hook'

const REQUIRED: Partial<Record<SessionKind, string[]>> = {
  'session/start': ['workspace', 'harness_version'],
  'session/end': ['reason'],
  'session/interrupted': ['steps'],
  'checkpoint/created': ['commit'],
  'tool/call': ['tool'],
  'tool/result': ['tool', 'status', 'isolation'],
  'verification/asserted': ['assertion', 'result'],
  'hook/execution': ['hook_name', 'event', 'decision'],
  'artifact/emitted': ['path', 'sha256'],
  'plan/updated': ['steps'],
  'error': ['message'],
  'llm/request': ['model'],
  'llm/response': ['model', 'usage'],
}

export function isSessionKind(k: string): k is SessionKind {
  return (SESSION_KINDS as readonly string[]).includes(k)
}

/** 校验失败抛错；未知 kind 由调用方决定（P1 一律拒绝写入） */
export function validatePayload(kind: SessionKind, payload: Record<string, unknown>): void {
  const need = REQUIRED[kind]
  if (!need) return
  const missing = need.filter((f) => !(f in payload))
  if (missing.length) {
    throw new Error(`E_EVENT_PAYLOAD: ${kind} missing fields: ${missing.join(', ')}`)
  }
}
