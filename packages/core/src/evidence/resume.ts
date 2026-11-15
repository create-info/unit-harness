/**
 * 续跑：从上一个会话恢复对话。
 *
 * 依据是会话目录里的 `state.json`——每次 run 结束时把完整 messages 落盘。
 * 为什么不从 events.jsonl 重建：事件里记的是「发了多少条消息」，不是消息本身；
 * 想重建就得把整段对话塞进 llm/request 事件，日志会膨胀到没法看。
 *
 * 会话按 YYYY/MM/DD 分层之后，找「最近一个」不能再用 readdir 平铺，
 * 交给 EventStore.list —— 它按日期倒序扫，要几条读几条。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import { EventStore } from './store.ts'
import { replayRollout } from './rollout.ts'
import type { Message, ImageInput } from '../llm/types.ts'

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

/**
 * 续跑时把图片按路径重新读回来。
 *
 * state.json 里刻意不存 base64（一份带截图的会话能把文件撑到几十 MB），只留 path。
 * 但 provider 转请求时拼的是 `data:<type>;base64,<data>`——空 data 发出去就是
 * 一个畸形请求，整轮 400。所以续跑前必须补，补不到的那张直接丢掉：
 * 少一张图和整轮失败，前者能用。
 */
function hydrateImages(msgs: Message[]): Message[] {
  return msgs.map((m) => {
    if (!m.images?.length) return m
    const kept: ImageInput[] = []
    for (const im of m.images) {
      if (im.data) { kept.push(im); continue }
      try {
        kept.push({ ...im, data: fs.readFileSync(im.path).toString('base64') })
      } catch { /* 图没了（用户清了 .uh/uploads）：丢掉这张，别拖着整轮一起失败 */ }
    }
    return { ...m, images: kept }
  })
}

/** 按目录读（调用方已经知道会话在哪） */
export function readStateAt(dir: string, fallbackId: string): ResumeState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')) as {
      session_id?: string
      updated_at?: string
      stopped_by?: string
      plan?: ResumeState['plan']
      messages?: Message[]
    }
    if (!Array.isArray(raw.messages)) return null
    // 落盘用 snake_case（与事件字段一致），对外用 camelCase
    return {
      sessionId: raw.session_id ?? fallbackId,
      updatedAt: raw.updated_at ?? '',
      stoppedBy: raw.stopped_by ?? 'unknown',
      plan: raw.plan ?? [],
      messages: hydrateImages(raw.messages),
    }
  } catch {
    return null
  }
}

export function readState(sessionId: string): ResumeState | null {
  const dir = new EventStore().sessionDir(sessionId)
  return dir ? readStateAt(dir, sessionId) : null
}

/**
 * 续跑该用哪份历史。
 *
 * 优先 rollout：它是边跑边追加的，被打断的那一轮也留得下已经发生的事。
 * state.json 只是整轮结束时的快照——一轮没有"结束"（被 Stop、被 --force、
 * 浏览器关了），它就是上一轮的旧样子，拿它续跑等于让模型忘掉刚做的事。
 *
 * 老会话没有 rollout，退回 state.json；两样都没有就返回 null（新开一轮）。
 */
export function resumeMessages(sessionId: string): Message[] | null {
  const dir = new EventStore().sessionDir(sessionId)
  if (!dir) return null
  const rolled = replayRollout(dir)
  if (rolled && rolled.length) return hydrateImages(rolled)
  const st = readStateAt(dir, sessionId)
  return st && st.messages.length ? st.messages : null
}

/**
 * 最近一个可续跑的会话。
 *
 * 判据是"有没有历史"，不是"有没有 state.json"。被打断的会话恰恰没有 state.json
 * ——它没有"整轮结束"——但它的 rollout 里全是刚才做过的事，那正是最该被续上的
 * 一条。以前这里只看 state.json，于是 `--continue` 会跳过刚被打断的那一轮，
 * 接上更早的、已经做完的会话：用户以为在接着刚才，其实跳回了几步之前。
 */
export function latestResumable(): ResumeState | null {
  const store = new EventStore()
  for (const meta of store.list({ limit: 50 })) {
    const dir = store.sessionDir(meta.id)
    if (!dir) continue
    const st = readStateAt(dir, meta.id)
    const rolled = replayRollout(dir)
    const hasRollout = Boolean(rolled && rolled.length)
    if (!hasRollout && !(st && st.messages.length > 0)) continue
    // state.json 在就用它补齐 plan / stoppedBy；消息以 rollout 为准
    return {
      sessionId: meta.id,
      updatedAt: st?.updatedAt ?? new Date(meta.updated_at).toISOString(),
      stoppedBy: st?.stoppedBy ?? 'unknown',
      plan: st?.plan ?? [],
      messages: (hasRollout ? rolled! : st!.messages),
    }
  }
  return null
}
