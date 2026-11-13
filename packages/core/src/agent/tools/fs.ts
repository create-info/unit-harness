/**
 * 基础文件工具：read_file / list_dir / grep。
 *
 * 在这之前，模型想看一个文件只能 `run_command: ["cat", "x.ts"]`。后果有两个：
 * 一个是它拿不到行号，改代码时对不上位置；另一个是 `cat` 一个大文件会把上下文
 * 直接冲掉。Codex 和 DSH 都把这三件事做成了一等公民，这里跟上。
 *
 * 它们跑在**进程内**，不经沙箱——但只读，而且路径一律过 safeJoin，
 * 逃不出工作区。比让模型自己 `cat` 更安全，因为它根本没有执行任何东西的机会。
 */

export interface ReadResult {
  text: string
  totalLines: number
  shownFrom: number
  shownTo: number
  truncated: boolean
}

/** 按行切片，行号从 1 开始（和编辑器一致，模型改代码时对得上） */
export function sliceLines(content: string, offset = 1, limit = 2000): ReadResult {
  const all = content.split('\n')
  const totalLines = all.length
  const from = Math.max(1, Math.floor(offset))
  const count = Math.max(1, Math.floor(limit))
  const slice = all.slice(from - 1, from - 1 + count)
  const numbered = slice.map((line, i) => `${String(from + i).padStart(6)}|${line}`).join('\n')
  const shownTo = from - 1 + slice.length
  const truncated = shownTo < totalLines

  const tail = truncated
    ? `\n\n[showing lines ${from}-${shownTo} of ${totalLines}. Read the rest with offset=${shownTo + 1}]`
    : ''

  return { text: numbered + tail, totalLines, shownFrom: from, shownTo, truncated }
}

/** 二进制/超大文件不该被当成文本读进来 */
export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

export interface GrepHit {
  path: string
  line: number
  text: string
}

export function formatHits(hits: GrepHit[], opts: { pattern: string; max: number; filesScanned: number }): string {
  if (hits.length === 0) return `no matches for /${opts.pattern}/ (scanned ${opts.filesScanned} files)`
  const body = hits.map((h) => `${h.path}:${h.line}: ${h.text.slice(0, 240)}`).join('\n')
  const more = hits.length >= opts.max ? `\n\n[stopped at ${opts.max} matches — narrow the pattern or path]` : ''
  return `${hits.length} match(es) in ${opts.filesScanned} files\n${body}${more}`
}

/** 目录树的一行：目录带尾斜杠，文件给字节数 */
export function formatEntry(name: string, isDir: boolean, bytes: number, depth: number): string {
  const indent = '  '.repeat(depth)
  return isDir ? `${indent}${name}/` : `${indent}${name}  (${bytes} B)`
}
