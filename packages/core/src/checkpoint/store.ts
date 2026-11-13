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
export function toPayload(edit: FileEdit, sessionDir: string | null): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    path: edit.path,
    binary: edit.binary,
    too_large: edit.tooLarge,
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
