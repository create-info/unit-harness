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

/** 会话按 YYYY/MM/DD 分层：列「最近 N 个」时不用扫全库 */
function dateParts(d = new Date()): [string, string, string] {
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')]
}

/** 从新到旧的日期目录 */
function dateDirsDesc(rootDir: string): string[] {
  const out: string[] = []
  let years: string[] = []
  try { years = fs.readdirSync(rootDir).filter((n) => /^\d{4}$/.test(n)) } catch { return out }
  for (const y of years.sort().reverse()) {
    let months: string[] = []
    try { months = fs.readdirSync(path.join(rootDir, y)).filter((n) => /^\d{2}$/.test(n)) } catch { continue }
    for (const m of months.sort().reverse()) {
      let days: string[] = []
      try { days = fs.readdirSync(path.join(rootDir, y, m)).filter((n) => /^\d{2}$/.test(n)) } catch { continue }
      for (const d of days.sort().reverse()) out.push(path.join(rootDir, y, m, d))
    }
  }
  return out
}

export class EventStore {
  private readonly root: string
  private readonly archiveRoot: string
  private readonly metas = new Map<string, SessionMeta>()
  /** 会话 id → 目录。有了它，append 不用每次都去磁盘上找 */
  private readonly dirs = new Map<string, string>()

  constructor(root?: string) {
    this.root = root ?? path.join(uhHome(), 'sessions')
    this.archiveRoot = path.join(path.dirname(this.root), 'archived_sessions')
    fs.mkdirSync(this.root, { recursive: true })
  }

  /**
   * 找到会话目录。先查缓存，再从新到旧扫日期目录。
   *
   * 也认老的平铺布局（`sessions/<id>`）——升级不该让已有的会话变成孤儿。
   */
  private locate(id: string): string | null {
    const cached = this.dirs.get(id)
    if (cached) return cached

    const legacy = path.join(this.root, id)
    if (fs.existsSync(path.join(legacy, 'meta.json'))) {
      this.dirs.set(id, legacy)
      return legacy
    }

    for (const base of [this.root, this.archiveRoot]) {
      for (const dayDir of dateDirsDesc(base)) {
        const candidate = path.join(dayDir, id)
        if (fs.existsSync(path.join(candidate, 'meta.json'))) {
          this.dirs.set(id, candidate)
          return candidate
        }
      }
    }
    return null
  }

  private dir(id: string): string {
    const found = this.locate(id)
    if (found) return found
    // 新会话：落在今天的目录里
    const [y, m, d] = dateParts()
    return path.join(this.root, y, m, d, id)
  }

  /** 会话目录（checkpoint 的 blob 要写在这里） */
  sessionDir(id: string): string | null {
    return this.locate(id)
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
    const target = this.dir(id)
    fs.mkdirSync(target, { recursive: true })
    this.dirs.set(id, target)
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

  /**
   * 列会话，新的在前。`limit` 给了就按日期倒序边扫边停——
   * 这正是分层的意义：要 20 条就不必读一年的量。
   */
  list(opts: { limit?: number; archived?: boolean } = {}): SessionMeta[] {
    const out: SessionMeta[] = []
    const limit = opts.limit ?? Infinity
    const roots = opts.archived ? [this.archiveRoot] : [this.root]

    for (const base of roots) {
      // 老的平铺会话（sessions/<id>/meta.json）
      let legacy: string[] = []
      try { legacy = fs.readdirSync(base).filter((n) => !/^\d{4}$/.test(n)) } catch { /* fine */ }
      for (const id of legacy) {
        if (out.length >= limit) break
        const m = this.get(id)
        if (m) out.push(m)
      }
      for (const dayDir of dateDirsDesc(base)) {
        if (out.length >= limit) break
        let ids: string[] = []
        try { ids = fs.readdirSync(dayDir) } catch { continue }
        for (const id of ids) {
          if (out.length >= limit) break
          const m = this.get(id)
          if (m) out.push(m)
        }
      }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
  }

  /**
   * 把早于 N 天的会话挪进 archived_sessions/。
   *
   * 「归档」而不是「删除」：事件日志是证据，删了就没得查了。
   * 归档之后 list 默认看不到，但按 id 仍然能读出来。
   */
  prune(opts: { olderThanDays: number; dryRun?: boolean }): { moved: string[]; kept: number } {
    const cutoff = Date.now() - opts.olderThanDays * 86_400_000
    const moved: string[] = []
    let kept = 0

    const consider = (src: string): void => {
      let meta: SessionMeta | null = null
      try { meta = JSON.parse(fs.readFileSync(path.join(src, 'meta.json'), 'utf8')) as SessionMeta } catch { return }
      // 还在写的不动：归档一个 active 会话等于让它半路失联
      if (meta.status === 'active') { kept++; return }
      const when = Date.parse(meta.updated_at || meta.created_at)
      if (!Number.isFinite(when) || when > cutoff) { kept++; return }

      if (!opts.dryRun) {
        const dst = path.join(this.archiveRoot, path.relative(this.root, src))
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.renameSync(src, dst)
        this.dirs.set(meta.id, dst)
      }
      moved.push(meta.id)
    }

    // 老的平铺布局（sessions/<id>）也要认，否则升级之后它们永远不会被归档
    let legacy: string[] = []
    try { legacy = fs.readdirSync(this.root).filter((n) => !/^\d{4}$/.test(n)) } catch { /* none */ }
    for (const id of legacy) consider(path.join(this.root, id))

    for (const dayDir of dateDirsDesc(this.root)) {
      let ids: string[] = []
      try { ids = fs.readdirSync(dayDir) } catch { continue }
      for (const id of ids) consider(path.join(dayDir, id))
    }
    return { moved, kept }
  }

  /**
   * 重新打开一条已结束的会话（多轮对话的下一轮）。
   *
   * dispose() 每轮都会 end() 一次，所以一轮跑完会话就是 ended。下一句要往同一条
   * 会话里追加事件，就必须先改回 active —— 否则 append 会以 E_SESSION_ENDED
   * 失败，而这个失败只会出现在「第二轮」以后，第一轮永远测不出来。
   */
  reopen(sessionId: string): SessionMeta | null {
    const meta = this.get(sessionId)
    if (!meta) return null
    if (meta.status === 'active') return meta
    const next: SessionMeta = { ...meta, status: 'active', updated_at: now() }
    this.writeMeta(next)
    return next
  }

  end(sessionId: string, reason: string): void {
    const meta = this.get(sessionId)
    if (!meta || meta.status === 'ended') return
    this.append(sessionId, 'session/end', { reason }, { source: 'agent' })
    this.writeMeta({ ...this.get(sessionId)!, status: 'ended', updated_at: now() })
  }
}
