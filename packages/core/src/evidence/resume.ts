/**
 * 续跑：从上一个会话恢复对话。
 *
 * 依据是 `sessions/<id>/state.json`——每次 run 结束时把完整 messages 落盘。
 * 为什么不从 events.jsonl 重建：事件里记的是「发了多少条消息」，不是消息本身；
 * 想重建就得把整段对话塞进 llm/request 事件，日志会膨胀到没法看。
 *
 * 状态文件只对**最近一次**有意义的会话写，所以这里取最新的那个。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import type { Message } from '../llm/types.ts'

export interface ResumeState {
  sessionId: string
  updatedAt: string
  stoppedBy: string
  plan: Array<{ step: string; status: string }>
  messages: Message[]
}

export function sessionsDir(): string {
  return path.join(uhHome(), 'sessions')
}

export function readState(sessionId: string): ResumeState | null {
  try {
    const p = path.join(sessionsDir(), sessionId, 'state.json')
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      session_id?: string
      updated_at?: string
      stopped_by?: string
      plan?: ResumeState['plan']
      messages?: Message[]
    }
    if (!Array.isArray(raw.messages)) return null
    // 落盘用 snake_case（与事件字段一致），对外用 camelCase
    return {
      sessionId: raw.session_id ?? sessionId,
      updatedAt: raw.updated_at ?? '',
      stoppedBy: raw.stopped_by ?? 'unknown',
      plan: raw.plan ?? [],
      messages: raw.messages,
    }
  } catch {
    return null
  }
}

/** 最近一个可续跑的会话（按 meta 的 created_at 倒序，跳过没有 state 的） */
export function latestResumable(): ResumeState | null {
  let ids: string[]
  try {
    ids = fs.readdirSync(sessionsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name))
      .sort()
      .reverse()
  } catch {
    return null
  }
  for (const id of ids) {
    const st = readState(id)
    if (st && st.messages.length > 0) return st
  }
  return null
}
