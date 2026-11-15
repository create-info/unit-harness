/**
 * Checkpoint / undo —— 日志式，不碰 git。
 *
 * 上一版给每个工作区开了个影子 git 仓库，能跑，但重：必须装 git、每次 run 前后
 * 各来一次 `add -A`（大仓库要扫全树）、状态还是两套（GIT_DIR + 工作区）。
 *
 * 这一版照 Codex 的路子：**可回滚的东西就是日志本身**。
 * 每次写盘把「改之前 + 改之后」记成一条事件，写进 session 的 events.jsonl 里——
 * 和 tool/call、approval/requested 是同一条链。回滚 = 读日志、按倒序把 before 写回去。
 *
 * 换来的是：
 *   - 没有 git 也能 undo
 *   - `uh replay` 天然看得到每一次改写（它就是事件）
 *   - 粒度是文件，不是「整棵树 reset 到某个 commit」
 *
 * 代价写清楚，不假装没有：
 *   - 二进制和超大文件不记正文，undo 时明说还原不了，而不是悄悄跳过
 *   - 只有**经我们手**的写入（apply_patch / 内建写文件）有记录。shell 里的
 *     `sed -i`、重定向不经过这里，日志里没有，undo 也就还原不了
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 超过这个大小就不内联正文了（事件日志是给人读的，不是备份仓） */
export const MAX_INLINE_BYTES = 256_000

/**
 * 内联进事件行的上限。再大就挪到 `blobs/`，事件里只留引用。
 *
 * 事件日志的价值在于「能一眼看完一条记录」。把 200KB 的文件原文塞进一行 JSON，
 * `cat` 一次就把终端糊住了，grep 也基本失效——日志就不像日志了。
 */
export const INLINE_LIMIT_BYTES = 4_096

export interface FileEdit {
  /** 相对工作区 */
  path: string
  /** 改之前的内容；null = 这个文件原本不存在，或正文在 blob 里（见 beforeRef） */
  before: string | null
  /** 改之后的内容；null = 被删掉了，或正文在 blob 里（见 afterRef） */
  after: string | null
  /** 正文外置时的 blob 名 */
  beforeRef?: string
  afterRef?: string
  /** 原始大小，blob 外置时唯一还留在事件里的尺寸信息 */
  beforeSize?: number
  afterSize?: number
  /** 二进制：没法当文本还原 */
  binary: boolean
  /** 太大没存正文 */
  tooLarge: boolean
}

/** 正文写进 blobs/，返回文件名（内容哈希，天然去重） */
export function spillToBlob(sessionDir: string, content: string): string {
  const hash = createHash('sha256').update(content, 'utf8').digest('hex')
  const dir = path.join(sessionDir, 'blobs')
  fs.mkdirSync(dir, { recursive: true })
  const abs = path.join(dir, hash)
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, content, 'utf8')
  return hash
}

/** 把一条记录变成事件 payload：小就内联，大就外置 */
/**
 * 这个文件加了几行、删了几行。
 *
 * 用多重集差而不是真 diff：汇总行只要「大概动了多少」，而 LCS 在几千行的文件上
 * 会把事件记录拖慢。同一个文件里增减一样多的行会互相抵消——但那本来也就叫「改动不大」，
 * 想看清楚的人点开卡片看逐行对比。
 */
function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
  const split = (v: string | null): string[] | null => (v === null ? null : v.split('\n'))
  const a = split(before)
  const b = split(after)
  if (a === null) return { added: b?.length ?? 0, removed: 0 }
  if (b === null) return { added: 0, removed: a.length }
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of b) {
    const n = counts.get(line) ?? 0
    if (n > 0) counts.set(line, n - 1)
    else added++
  }
  let removed = 0
  for (const n of counts.values()) removed += n
  return { added, removed }
}

export function toPayload(edit: FileEdit, sessionDir: string | null): Record<string, unknown> {
  const delta = lineStats(edit.before, edit.after)
  const payload: Record<string, unknown> = {
    path: edit.path,
    binary: edit.binary,
    too_large: edit.tooLarge,
    // 前端要靠这个画「+123 −45」和文件汇总，不能每次都去算 diff
    added: delta.added,
    removed: delta.removed,
  }

  const put = (side: 'before' | 'after', value: string | null): void => {
    if (value === null) { payload[side] = null; return }
    const size = Buffer.byteLength(value, 'utf8')
    payload[`${side}_size`] = size
    if (sessionDir && size > INLINE_LIMIT_BYTES) {
      payload[`${side}_ref`] = spillToBlob(sessionDir, value)
      payload[side] = null
    } else {
      payload[side] = value
    }
  }
  put('before', edit.before)
  put('after', edit.after)
  return payload
}

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

/** 把一次写入的「前后」整理成一条可回滚的记录 */
export function makeEdit(rel: string, before: Buffer | null, after: Buffer | null): FileEdit {
  const binary = (before !== null && looksBinary(before)) || (after !== null && looksBinary(after))
  const tooLarge =
    (before !== null && before.length > MAX_INLINE_BYTES) ||
    (after !== null && after.length > MAX_INLINE_BYTES)

  const asText = (b: Buffer | null): string | null => {
    if (b === null) return null
    if (binary || tooLarge) return null
    return b.toString('utf8')
  }

  return { path: rel, before: asText(before), after: asText(after), binary, tooLarge }
}

/** 这条记录能不能被还原 */
export function isRestorable(edit: FileEdit): boolean {
  return !edit.binary && !edit.tooLarge
}

interface AnyEvent {
  kind: string
  payload: Record<string, unknown>
}

/**
 * 从事件流里取出「最近一次 turn 的改写」，按路径合并成净变化。
 *
 * 同一个文件在一次 turn 里被改三次，只需要回到**第一次之前**的样子：
 * 中间的版本对人没有意义，写回去反而会把文件停在一个半成品状态。
 */
export function editsForLastTurn(events: AnyEvent[]): { turn: number; edits: FileEdit[] } {
  const collected = new Map<string, FileEdit>()
  let turn = 0

  const reset = (): void => { collected.clear() }

  for (const ev of events) {
    if (ev.kind === 'turn/start') { turn += 1; reset(); continue }
    if (ev.kind === 'checkpoint/restored') { reset(); continue }
    if (ev.kind !== 'checkpoint/file') continue

    const p = String(ev.payload.path ?? '')
    if (!p) continue
    const edit: FileEdit = {
      path: p,
      before: (ev.payload.before as string | null) ?? null,
      after: (ev.payload.after as string | null) ?? null,
      binary: ev.payload.binary === true,
      tooLarge: ev.payload.too_large === true,
    }
    const beforeRef = ev.payload.before_ref
    const afterRef = ev.payload.after_ref
    if (typeof beforeRef === 'string') edit.beforeRef = beforeRef
    if (typeof afterRef === 'string') edit.afterRef = afterRef
    if (typeof ev.payload.before_size === 'number') edit.beforeSize = ev.payload.before_size
    if (typeof ev.payload.after_size === 'number') edit.afterSize = ev.payload.after_size
    const seen = collected.get(p)
    // 只保留第一次的 before，after 始终取最新
    collected.set(p, seen ? { ...edit, before: seen.before } : edit)
  }

  return { turn, edits: [...collected.values()] }
}

export interface CheckpointSummary {
  /** checkpoint/created 那条事件的 seq —— 回退的锚点 */
  seq: number
  /** 第几轮（turn/start 计数） */
  turn: number
  label: string
  files: string[]
  at: string | null
}

/**
 * 会话里所有的检查点，按时间顺序。
 *
 * 「检查点」不是另存的一份快照：它就是一轮结束时封的那条 checkpoint/created，
 * 真正的可回滚内容在它前面那些 checkpoint/file 事件里。所以这里只要列出坐标，
 * 回退时再按 seq 去捞正文。
 */
export function listCheckpoints(events: Array<AnyEvent & { seq?: number; timestamp?: string }>): CheckpointSummary[] {
  const out: CheckpointSummary[] = []
  let turn = 0
  for (const ev of events) {
    if (ev.kind === 'turn/start') { turn += 1; continue }
    if (ev.kind !== 'checkpoint/created') continue
    const files = Array.isArray(ev.payload.files) ? (ev.payload.files as string[]) : []
    out.push({
      seq: typeof ev.seq === 'number' ? ev.seq : 0,
      turn,
      label: String(ev.payload.label ?? ''),
      files,
      at: ev.timestamp ?? null,
    })
  }
  return out
}

/**
 * 某个检查点之后发生的所有文件改写，**按时间正序**，一条不合并。
 *
 * 和 editsForLastTurn 的区别是要点：那个按路径合并成净变化，因为「回到一轮之前」
 * 只关心起点。这里要重放到任意一个检查点，重复写的文件必须逐次回退，
 * 否则中间那些版本会被跳过，最后落在一个谁都没见过的状态。
 */
export function editsAfterSeq(
  events: Array<AnyEvent & { seq?: number }>,
  cutoffSeq: number,
): FileEdit[] {
  const out: FileEdit[] = []
  for (const ev of events) {
    if (ev.kind !== 'checkpoint/file') continue
    if (typeof ev.seq === 'number' && ev.seq <= cutoffSeq) continue
    const p = String(ev.payload.path ?? '')
    if (!p) continue
    const edit: FileEdit = {
      path: p,
      before: (ev.payload.before as string | null) ?? null,
      after: (ev.payload.after as string | null) ?? null,
      binary: ev.payload.binary === true,
      tooLarge: ev.payload.too_large === true,
    }
    if (typeof ev.payload.before_ref === 'string') edit.beforeRef = ev.payload.before_ref
    if (typeof ev.payload.after_ref === 'string') edit.afterRef = ev.payload.after_ref
    if (typeof ev.payload.before_size === 'number') edit.beforeSize = ev.payload.before_size
    if (typeof ev.payload.after_size === 'number') edit.afterSize = ev.payload.after_size
    out.push(edit)
  }
  return out
}

/**
 * 回退到某个检查点。
 *
 * 逐条倒着应用（后发生的先撤），最后整个工作区就停在那个检查点上——
 * 而不是「每个文件回到它在那之后第一次被改之前」。两者的差别只在
 * 被改过两次以上的文件上，但正是那种文件最容易留下半成品。
 */
export function undoToCheckpoint(workspace: string, editsChronological: FileEdit[]): UndoResult {
  const total: UndoResult = { restored: [], removed: [], skipped: [] }
  for (const edit of [...editsChronological].reverse()) {
    const one = applyUndo(workspace, [edit])
    total.restored.push(...one.restored)
    total.removed.push(...one.removed)
    total.skipped.push(...one.skipped)
  }
  // 倒着撤的时候同一个文件可能先「还原」再「删除」，报表里只留最后一次的结果
  const seen = new Set<string>()
  total.restored = total.restored.reverse().filter((p) => (seen.has(p) ? false : (seen.add(p), true))).reverse()
  return total
}

/**
 * 最近一次「回退到某个检查点」发生在哪条事件之后。
 *
 * 回退会改工作区，但事件日志只增不改——所以日志里那些被撤掉的 checkpoint/file
 * 还留在原处。如果允许跨过一条 checkpoint/restored 往前回退，重放出来的就是
 * 「把这些已经撤过的改动再撤一次」，落地的内容没人见过。
 * 所以更早的检查点直接不可用，宁可少做也不做错。
 */
export function lastRestoreSeq(events: Array<AnyEvent & { seq?: number }>): number {
  let last = 0
  for (const ev of events) {
    if (ev.kind === 'checkpoint/restored' && typeof ev.seq === 'number' && ev.seq > last) last = ev.seq
  }
  return last
}

/** 已撤销的轮次记在这里。事件日志是 append-only，撤销状态不能反过来往里写 */
export function undoneMarkerPath(sessionDir: string): string {
  return path.join(sessionDir, 'undone.json')
}

export function isTurnUndone(sessionDir: string, turn: number): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(undoneMarkerPath(sessionDir), 'utf8')) as { turns?: number[] }
    return Array.isArray(raw.turns) && raw.turns.includes(turn)
  } catch {
    return false
  }
}

export function markTurnUndone(sessionDir: string, turn: number): void {
  let turns: number[] = []
  try {
    const raw = JSON.parse(fs.readFileSync(undoneMarkerPath(sessionDir), 'utf8')) as { turns?: number[] }
    if (Array.isArray(raw.turns)) turns = raw.turns
  } catch { /* first undo */ }
  if (!turns.includes(turn)) turns.push(turn)
  fs.writeFileSync(undoneMarkerPath(sessionDir), JSON.stringify({ turns, at: new Date().toISOString() }, null, 2), 'utf8')
}

/** 把外置的正文读回来，供 undo 使用 */
export function hydrateEdits(edits: FileEdit[], sessionDir: string): FileEdit[] {
  const read = (ref: string): string | null => {
    try { return fs.readFileSync(path.join(sessionDir, 'blobs', ref), 'utf8') } catch { return null }
  }
  return edits.map((e) => {
    const out = { ...e }
    if (e.beforeRef) {
      const v = read(e.beforeRef)
      if (v !== null) out.before = v
    }
    if (e.afterRef) {
      const v = read(e.afterRef)
      if (v !== null) out.after = v
    }
    return out
  })
}

export interface UndoResult {
  restored: string[]
  removed: string[]
  skipped: Array<{ path: string; why: string }>
}

/**
 * 把一批改写反向应用。
 *
 * 顺序无所谓（每个文件独立），但**先写真、后删文件**：万一中途失败，
 * 留下的是多余的文件，而不是把原来的文件弄丢。
 */
export function applyUndo(workspace: string, edits: FileEdit[]): UndoResult {
  const out: UndoResult = { restored: [], removed: [], skipped: [] }
  const root = path.resolve(workspace)
  const inWorkspace = (rel: string): string | null => {
    const abs = path.resolve(root, rel)
    return abs === root || abs.startsWith(root + path.sep) ? abs : null
  }

  for (const edit of edits) {
    const abs = inWorkspace(edit.path)
    if (!abs) { out.skipped.push({ path: edit.path, why: 'outside the workspace' }); continue }
    if (!isRestorable(edit)) {
      out.skipped.push({
        path: edit.path,
        why: edit.binary ? 'binary file — content was not recorded' : 'too large — content was not recorded',
      })
      continue
    }
    try {
      if (edit.before === null) {
        // 原本不存在：删掉它
        if (fs.existsSync(abs)) { fs.unlinkSync(abs); out.removed.push(edit.path) }
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, edit.before, 'utf8')
        out.restored.push(edit.path)
      }
    } catch (err) {
      out.skipped.push({ path: edit.path, why: err instanceof Error ? err.message : String(err) })
    }
  }

  return out
}

/** 读文件；不存在或读不了就是 null（「原本没有这个文件」也是有效信息） */
export function readMaybeFile(abs: string): Buffer | null {
  try { return fs.readFileSync(abs) } catch { return null }
}

/** 读某个 session 的事件（undo 用；事件少，一次读完即可） */
export function readSessionEvents(sessionDir: string): AnyEvent[] {
  try {
    return fs.readFileSync(path.join(sessionDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AnyEvent)
  } catch {
    return []
  }
}
