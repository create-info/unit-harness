/**
 * 工作区快照与差异：用来回答"这次运行到底改了什么"。
 *
 * 为什么不依赖模型自己上报交付物：模型会说"我完成了"，但它可能改了别的文件、
 * 或根本没写。快照对比是**不依赖模型配合**的事实来源（D9 的"唯一可变状态"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export interface FileMeta {
  size: number
  mtimeMs: number
  sha256: string
}

export type Snapshot = Record<string, FileMeta>

const SKIP_DIRS = new Set(['node_modules', '.git', '.uh', 'build', 'dist', '.cache', '__pycache__'])
const MAX_FILES = 2000
const MAX_HASH_BYTES = 8 * 1024 * 1024

export function sha256File(abs: string): string | null {
  try {
    const st = fs.statSync(abs)
    return hashFile(abs, st.size)
  } catch {
    return null
  }
}

function hashFile(abs: string, size: number): string {
  const h = createHash('sha256')
  if (size > MAX_HASH_BYTES) {
    // 超大文件只哈希首尾各 1MB，避免拖慢每次运行
    const fd = fs.openSync(abs, 'r')
    try {
      const head = Buffer.alloc(1024 * 1024)
      fs.readSync(fd, head, 0, head.length, 0)
      h.update(head)
      const tail = Buffer.alloc(1024 * 1024)
      fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length))
      h.update(tail)
    } finally {
      fs.closeSync(fd)
    }
  } else {
    h.update(fs.readFileSync(abs))
  }
  return h.digest('hex')
}

/** 递归快照；跳过依赖/构建目录，限制文件数 */
export function snapshotDir(root: string): Snapshot {
  const out: Snapshot = {}
  let count = 0

  const walk = (dir: string, rel: string): void => {
    if (count >= MAX_FILES) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (count >= MAX_FILES) return
      const abs = path.join(dir, String(e.name))
      const relPath = rel ? `${rel}/${String(e.name)}` : String(e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(String(e.name))) continue
        walk(abs, relPath)
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs)
          out[relPath] = { size: st.size, mtimeMs: st.mtimeMs, sha256: hashFile(abs, st.size) }
          count++
        } catch {
          /* unreadable file: skip */
        }
      }
    }
  }

  walk(root, '')
  return out
}

export interface ChangeSet {
  added: string[]
  modified: string[]
  removed: string[]
}

export function diffSnapshots(before: Snapshot, after: Snapshot): ChangeSet {
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []

  for (const [p, meta] of Object.entries(after)) {
    const prev = before[p]
    if (!prev) added.push(p)
    else if (prev.sha256 !== meta.sha256 || prev.size !== meta.size) modified.push(p)
  }
  for (const p of Object.keys(before)) {
    if (!after[p]) removed.push(p)
  }

  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() }
}

export interface Artifact {
  path: string
  sha256: string
  bytes: number
}

/** 把变更转成交付物清单（删除不算交付物，但会记进 events） */
export function collectArtifacts(root: string, changes: ChangeSet, after: Snapshot): Artifact[] {
  const out: Artifact[] = []
  for (const p of [...changes.added, ...changes.modified]) {
    const meta = after[p]
    if (!meta) continue
    out.push({ path: p, sha256: meta.sha256, bytes: meta.size })
  }
  return out
}
