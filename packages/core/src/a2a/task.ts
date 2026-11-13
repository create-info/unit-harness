/**
 * 会话日志 → A2A Task。这是整个 A2A 服务里唯一有判断力的部分，
 * 其余都是协议包装。
 *
 * 一个映射特别顺：我们的审批门天然对应 TASK_STATE_INPUT_REQUIRED。
 * 有 `approval/requested` 却没有对应的 `approval/resolved`，就说明这个任务
 * 卡在等人确认——对别的 agent 来说这正是"需要输入才能继续"。
 * 不用另造一套状态机，事件日志本来就是状态。
 */
import type { Task, TaskState, TaskStatus, Message, Part, Artifact } from './types.ts'

export interface SessionEvent {
  kind: string
  timestamp?: string
  payload?: Record<string, unknown>
}

/** 会话目录里读到的原始信息 */
export interface SessionView {
  id: string
  contextId: string
  events: SessionEvent[]
  workspace?: string
  label?: string
}

const iso = (e: SessionEvent): string => {
  if (typeof e.timestamp === 'string') return e.timestamp
  return new Date().toISOString()
}

/**
 * 从事件推导状态。顺序即优先级：末尾的终态优先于中间态。
 *
 * 为什么不用"最后一条事件是什么"来判断：一次失败的 run 最后写的是 turn/end，
 * 和成功的 run 一模一样，只有事件里带的 stop_reason 不同。
 */
export function stateOf(events: SessionEvent[]): { state: TaskState; detail?: string } {
  if (!events.length) return { state: 'TASK_STATE_SUBMITTED' }

  // 还在等的审批：requested 里有、resolved 里没有
  const asked = new Map<string, string>()
  const answered = new Set<string>()
  for (const e of events) {
    const p = e.payload ?? {}
    if (e.kind === 'approval/requested') {
      const key = String(p.id ?? p.tool_call_id ?? p.ref ?? asked.size)
      asked.set(key, String(p.reason ?? p.command ?? 'approval needed'))
    }
    if (e.kind === 'approval/resolved') {
      const key = String(p.id ?? p.tool_call_id ?? p.ref ?? '')
      if (key) answered.add(key)
      // 事件里没带 id 的时候，按顺序认领最早那个未决请求
      else if (asked.size > answered.size) {
        const first = [...asked.keys()].find((k) => !answered.has(k))
        if (first) answered.add(first)
      }
    }
  }
  const pending = [...asked.keys()].filter((k) => !answered.has(k))
  if (pending.length) {
    return { state: 'TASK_STATE_INPUT_REQUIRED', detail: asked.get(pending[0] as string) }
  }

  const interrupted = events.some((e) => e.kind === 'session/interrupted')
  const failed = events.find((e) => e.kind === 'error')
  const turnEnd = [...events].reverse().find((e) => e.kind === 'turn/end')
  const ended = events.some((e) => e.kind === 'session/end' || e.kind === 'session/completed')
  const rejected = events.find((e) => e.kind === 'policy/denied' || (e.kind === 'tool/result' && e.payload?.refused === true))

  if (interrupted) return { state: 'TASK_STATE_CANCELED', detail: 'interrupted' }
  if (failed) return { state: 'TASK_STATE_FAILED', detail: String(failed.payload?.message ?? 'error') }
  if (rejected && !turnEnd) return { state: 'TASK_STATE_REJECTED', detail: 'denied by policy' }

  if (turnEnd) {
    const stop = String(turnEnd.payload?.stop_reason ?? '')
    if (stop === 'interrupted') return { state: 'TASK_STATE_CANCELED', detail: stop }
    if (stop === 'error') return { state: 'TASK_STATE_FAILED', detail: stop }
    // turn 结束了但会话没结束：多半是还在同一轮里继续，或者进程已经退出
    return { state: ended ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING', detail: stop || undefined }
  }

  // 有事件但没有 turn/end：正在跑
  return { state: 'TASK_STATE_WORKING' }
}

const textPart = (text: string): Part => ({ text })

/** 事件里的用户输入和模型回答 → A2A history */
export function historyOf(events: SessionEvent[], limit?: number): Message[] {
  const out: Message[] = []
  let n = 0
  for (const e of events) {
    const p = e.payload ?? {}
    // turn/start 里的 task 是这次任务的原始指令（老会话没有这个字段，
    // 那时 session/start 也没记，只能从 steering/message 里补）
    if (e.kind === 'turn/start' && typeof p.task === 'string' && p.task.trim()) {
      out.push({ messageId: `m${++n}`, role: 'ROLE_USER', parts: [textPart(String(p.task))] })
    }
    if (e.kind === 'session/start' && typeof p.task === 'string' && p.task.trim()) {
      out.push({ messageId: `m${++n}`, role: 'ROLE_USER', parts: [textPart(String(p.task))] })
    }
    if (e.kind === 'steering/message' && typeof p.text === 'string' && p.text.trim()) {
      out.push({ messageId: `m${++n}`, role: 'ROLE_USER', parts: [textPart(String(p.text))] })
    }
    if (e.kind === 'assistant/message' && typeof p.text === 'string' && p.text.trim()) {
      out.push({ messageId: `m${++n}`, role: 'ROLE_AGENT', parts: [textPart(String(p.text))] })
    }
  }
  // historyLength 语义是"最近 N 条"
  return limit && limit > 0 ? out.slice(-limit) : out
}

/** 交付物 → artifacts。verification 结果塞进 metadata，别的 agent 能看见"验过没有" */
export function artifactsOf(events: SessionEvent[]): Artifact[] {
  const out: Artifact[] = []
  // assertion 是个对象（{kind:'artifact-exists', path} / {kind:'command-exit', argv}），
  // 不是字符串——按 path 归到文件上，按 argv 归到"跑过的检查"上
  const verified = new Map<string, { result: string; detail?: unknown; checks: string[] }>()
  for (const e of events) {
    if (e.kind !== 'verification/asserted') continue
    const p = e.payload ?? {}
    const a = p.assertion as Record<string, unknown> | string | undefined
    const key = typeof a === 'string'
      ? a
      : String((a?.path as string) ?? (Array.isArray(a?.argv) ? (a.argv as string[]).join(' ') : '') ?? '')
    if (!key) continue
    const prev = verified.get(key)
    verified.set(key, {
      result: String(p.result ?? ''),
      detail: p.detail,
      checks: [...(prev?.checks ?? []), String((a as Record<string, unknown>)?.kind ?? 'assert')],
    })
  }

  let n = 0
  for (const e of events) {
    if (e.kind !== 'artifact/emitted') continue
    const p = e.payload ?? {}
    const path = String(p.path ?? p.name ?? '')
    if (!path) continue
    const v = verified.get(path)
    out.push({
      artifactId: `a${++n}`,
      name: path.split('/').pop() || path,
      description: v ? `verified: ${v.result}` : undefined,
      parts: [{ text: path, metadata: { path } }],
      metadata: {
        path,
        ...(typeof p.bytes === 'number' ? { bytes: p.bytes } : {}),
        ...(v ? { verification: v.result, verificationDetail: v.detail, checks: v.checks } : {}),
      },
    })
  }

  // 跑过的检查本身也是产出：调用方据此判断"它到底验了什么"
  for (const [key, v] of verified) {
    if (out.some((a) => a.metadata?.path === key)) continue
    out.push({
      artifactId: `a${++n}`,
      name: key.length > 60 ? key.slice(0, 57) + '...' : key,
      description: `check: ${v.checks.join(', ')} -> ${v.result}`,
      parts: [{ text: key, metadata: { check: true } }],
      metadata: { check: true, verification: v.result, detail: v.detail },
    })
  }
  return out
}

/** 一条事件流 → Task */
export function taskOf(view: SessionView, opts: { historyLength?: number } = {}): Task {
  const { state, detail } = stateOf(view.events)
  const last = view.events[view.events.length - 1]
  const status: TaskStatus = {
    state,
    ...(last ? { timestamp: iso(last) } : {}),
    ...(detail
      ? {
          message: {
            messageId: `s-${view.id}`,
            contextId: view.contextId,
            taskId: view.id,
            role: 'ROLE_AGENT' as const,
            parts: [textPart(detail)],
          },
        }
      : {}),
  }

  const history = historyOf(view.events, opts.historyLength)
  const artifacts = artifactsOf(view.events)

  return {
    id: view.id,
    contextId: view.contextId,
    status,
    ...(artifacts.length ? { artifacts } : {}),
    ...(history.length ? { history } : {}),
    metadata: {
      ...(view.workspace ? { workspace: view.workspace } : {}),
      ...(view.label ? { label: view.label } : {}),
      events: view.events.length,
      // 让调用方知道这是"我们的事件日志"，而不是凭空编的状态
      source: 'unit-harness/events.jsonl',
    },
  }
}

/** 终态不能再取消，也不能再变 */
export function isTerminal(state: TaskState): boolean {
  return state === 'TASK_STATE_COMPLETED'
    || state === 'TASK_STATE_FAILED'
    || state === 'TASK_STATE_CANCELED'
    || state === 'TASK_STATE_REJECTED'
}
