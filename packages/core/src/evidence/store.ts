/**
 * 事件存储：每个会话一个目录，事件以 **JSONL** 追加写入。
 *
 * 为什么不用 SQLite（P1）：
 *  - 事件日志天然是追加流，JSONL 与语义一致，且可 `cat`/`grep` 直接审计；
 *  - 无需 native 依赖，SEA 单文件友好；
 *  - `node:sqlite` 在 Node 22 仍需实验 flag，会污染所有入口。
 * 需要复杂查询时再迁移（事件格式不变，只是换个索引层）。
 */
import fs from 'node:fs'
import path from 'node:path'

import { uhHome } from '../paths.ts'
import { newEventId, newSessionId } from './ids.ts'
import { isSessionKind, validatePayload } from './kinds.ts'
import type { EventSource, SessionKind } from './kinds.ts'

export interface SessionMeta {
  id: string
  created_at: string
  updated_at: string
  workspace: string
  harness_version: string
  status: 'active' | 'ended' | 'failed'
  last_seq: number
  label?: string
}

export interface SessionEvent {
  id: string
  session_id: string
  seq: number
  timestamp: string
  kind: SessionKind
  source: EventSource
  parent_id: string | null
  payload: Record<string, unknown>
}

export interface AppendOptions {
  source?: EventSource
  parentId?: string | null
}

const now = (): string => new Date().toISOString()

export class EventStore {
  private readonly root: string
  private readonly metas = new Map<string, SessionMeta>()

  constructor(root?: string) {
    this.root = root ?? path.join(uhHome(), 'sessions')
    fs.mkdirSync(this.root, { recursive: true })
  }

  private dir(id: string): string {
    return path.join(this.root, id)
  }

  private metaPath(id: string): string {
    return path.join(this.dir(id), 'meta.json')
  }

  private eventsPath(id: string): string {
    return path.join(this.dir(id), 'events.jsonl')
  }

  /** 原子写 meta（写临时文件再 rename） */
  private writeMeta(meta: SessionMeta): void {
    const p = this.metaPath(meta.id)
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2))
    fs.renameSync(tmp, p)
    this.metas.set(meta.id, meta)
  }

  create(opts: { workspace: string; harnessVersion: string; label?: string }): SessionMeta {
    const id = newSessionId()
    const t = now()
    const meta: SessionMeta = {
      id,
      created_at: t,
      updated_at: t,
      workspace: opts.workspace,
      harness_version: opts.harnessVersion,
      status: 'active',
      last_seq: 0,
      ...(opts.label ? { label: opts.label } : {}),
    }
    fs.mkdirSync(this.dir(id), { recursive: true })
    this.writeMeta(meta)
    return meta
  }

  get(id: string): SessionMeta | null {
    const cached = this.metas.get(id)
    if (cached) return cached
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaPath(id), 'utf8')) as SessionMeta
      this.metas.set(id, meta)
      return meta
    } catch {
      return null
    }
  }

  /** 追加一条事件；seq 由 meta.last_seq 递增，写入后 fsync（证据要落盘） */
  append(sessionId: string, kind: string, payload: Record<string, unknown>, opts: AppendOptions = {}): SessionEvent {
    if (!isSessionKind(kind)) throw new Error(`E_EVENT_KIND: unknown session kind "${kind}"`)
    validatePayload(kind, payload)

    const meta = this.get(sessionId)
    if (!meta) throw new Error(`E_SESSION_NOT_FOUND: ${sessionId}`)
    if (meta.status === 'ended') throw new Error(`E_SESSION_ENDED: ${sessionId}`)

    const seq = meta.last_seq + 1
    const ev: SessionEvent = {
      id: newEventId(),
      session_id: sessionId,
      seq,
      timestamp: now(),
      kind,
      source: opts.source ?? 'agent',
      parent_id: opts.parentId ?? null,
      payload,
    }

    const line = JSON.stringify(ev) + '\n'
    const fd = fs.openSync(this.eventsPath(sessionId), 'a')
    try {
      fs.writeSync(fd, line)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    this.writeMeta({ ...meta, last_seq: seq, updated_at: ev.timestamp })
    return ev
  }

  /** 读事件；损坏的行跳过（崩溃时最后一行可能截断） */
  read(sessionId: string, opts: { fromSeq?: number; kinds?: SessionKind[] } = {}): SessionEvent[] {
    const p = this.eventsPath(sessionId)
    let raw: string
    try {
      raw = fs.readFileSync(p, 'utf8')
    } catch {
      return []
    }
    const out: SessionEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let ev: SessionEvent
      try {
        ev = JSON.parse(line) as SessionEvent
      } catch {
        continue
      }
      if (opts.fromSeq !== undefined && ev.seq < opts.fromSeq) continue
      if (opts.kinds && !opts.kinds.includes(ev.kind)) continue
      out.push(ev)
    }
    return out
  }

  list(): SessionMeta[] {
    let ids: string[] = []
    try {
      ids = fs.readdirSync(this.root)
    } catch {
      return []
    }
    const out: SessionMeta[] = []
    for (const id of ids) {
      const m = this.get(id)
      if (m) out.push(m)
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  end(sessionId: string, reason: string): void {
    const meta = this.get(sessionId)
    if (!meta || meta.status === 'ended') return
    this.append(sessionId, 'session/end', { reason }, { source: 'agent' })
    this.writeMeta({ ...this.get(sessionId)!, status: 'ended', updated_at: now() })
  }
}
