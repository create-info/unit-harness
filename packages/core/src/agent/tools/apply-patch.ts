/**
 * apply_patch —— 让模型"写补丁"而不是"写文件"。
 *
 * 借鉴 Codex（第 18 讲）的核心结论：一次可校验的变更单元，比一串散落的写操作安全。
 * 我们保留了它最关键的三条语义：
 *   1. 原子性：先在内存里把整个补丁跑一遍，任一 hunk 失败就一个字节都不落盘；
 *   2. 宽容匹配：模型给的上下文行常常不精确（缩进/空行），精确匹配失败后退到
 *      去空白匹配，仍失败才报错；
 *   3. 结构化：Add / Delete / Update(+Move) 三种意图分开表达，而不是让模型拼 shell。
 *
 * 与 Codex 的差异：不做流式解析（我们是非流式 CLI），不做 shell 拦截（我们只有一个
 * exec 入口，模型直接调工具）。
 */

export interface UpdateChunk {
  /** @@ 后面的定位文本，通常是函数/类定义 */
  context: string | null
  oldLines: string[]
  newLines: string[]
}

export type Hunk =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: UpdateChunk[] }

export interface ParsedPatch {
  hunks: Hunk[]
  warnings: string[]
}

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'

/** 去掉模型常见的 heredoc 包裹（GPT 系列会把补丁塞进 <<'EOF' ... EOF） */
function unwrapHeredoc(text: string): string {
  const t = text.trim()
  const m = /^<<\s*'?([A-Za-z_]+)'?\s*\n([\s\S]*)\n?\1\s*$/.exec(t)
  return m ? (m[2] as string) : t
}

export function parsePatch(input: string): ParsedPatch {
  const text = unwrapHeredoc(input).replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  let i = 0
  // 容忍开头空行
  while (i < lines.length && lines[i]?.trim() === '') i++
  if (lines[i]?.trim() !== BEGIN) {
    throw new Error(`E_PATCH_FORMAT: patch must start with "${BEGIN}", got: ${JSON.stringify(lines[i] ?? '')}`)
  }
  i++

  const hunks: Hunk[] = []
  const warnings: string[] = []

  const readBlocks = (stopAt: (l: string) => boolean): string[] => {
    const out: string[] = []
    while (i < lines.length && !stopAt(lines[i] as string)) {
      const line = lines[i] as string
      out.push(line.startsWith('+') ? line.slice(1) : line)
      i++
    }
    return out
  }

  while (i < lines.length) {
    const line = lines[i] as string
    if (line.trim() === END) { i++; break }
    if (line.trim() === '') { i++; continue }

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim()
      i++
      const body = readBlocks((l) => l.startsWith('*** '))
      hunks.push({ kind: 'add', path, lines: body })
      continue
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim()
      i++
      hunks.push({ kind: 'delete', path })
      continue
    }

    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim()
      i++
      let moveTo: string | undefined
      if (lines[i]?.startsWith('*** Move to: ')) {
        moveTo = (lines[i] as string).slice('*** Move to: '.length).trim()
        i++
      }
      const chunks: UpdateChunk[] = []
      while (i < lines.length && !(lines[i] as string).startsWith('*** ')) {
        const l = lines[i] as string
        if (l.startsWith('@@')) {
          const ctx = l.slice(2).trim()
          i++
          const oldLines: string[] = []
          const newLines: string[] = []
          while (i < lines.length) {
            const cur = lines[i] as string
            if (cur.startsWith('@@') || cur.startsWith('*** ')) break
            if (cur.startsWith('-')) { oldLines.push(cur.slice(1)); i++; continue }
            if (cur.startsWith('+')) { newLines.push(cur.slice(1)); i++; continue }
            if (cur.startsWith(' ')) {
              oldLines.push(cur.slice(1)); newLines.push(cur.slice(1)); i++; continue
            }
            // 空行 = 上下文空行
            oldLines.push(''); newLines.push(''); i++
          }
          if (oldLines.length === 0 && newLines.length === 0) {
            warnings.push(`empty chunk after "${l}" in ${path} — ignored`)
            continue
          }
          chunks.push({ context: ctx || null, oldLines, newLines })
          continue
        }
        i++
      }
      if (chunks.length === 0 && !moveTo) {
        throw new Error(`E_PATCH_FORMAT: Update File ${path} has no chunks and no move target`)
      }
      hunks.push({ kind: 'update', path, ...(moveTo ? { moveTo } : {}), chunks })
      continue
    }

    throw new Error(`E_PATCH_FORMAT: unexpected line: ${JSON.stringify(line)}`)
  }

  if (hunks.length === 0) throw new Error('E_PATCH_EMPTY: no hunks in patch')
  return { hunks, warnings }
}

// ---------- 匹配与应用（纯函数，便于测试） ----------

const norm = (s: string) => s.replace(/[ \t]+$/g, '')

/** 精确匹配优先，失败后退到"去空白"匹配；返回起始行号或 -1 */
export function findBlock(fileLines: string[], block: string[], from: number): number {
  if (block.length === 0) return from

  for (let start = from; start + block.length <= fileLines.length; start++) {
    let ok = true
    for (let k = 0; k < block.length; k++) {
      if (norm(fileLines[start + k] as string) !== norm(block[k] as string)) { ok = false; break }
    }
    if (ok) return start
  }

  // 宽容：忽略所有内部空白
  const squash = (s: string) => s.replace(/\s+/g, '')
  for (let start = from; start + block.length <= fileLines.length; start++) {
    let ok = true
    for (let k = 0; k < block.length; k++) {
      if (squash(fileLines[start + k] as string) !== squash(block[k] as string)) { ok = false; break }
    }
    if (ok) return start
  }
  return -1
}

export interface ApplyResult {
  file: string
  action: 'add' | 'update' | 'delete' | 'move'
  addedLines: number
  removedLines: number
}

/**
 * 干跑：在内存里算出所有文件的新内容。任何失败都抛错，调用方因此不会写盘。
 * 返回 [绝对路径, 新内容|null(删除)] 与结果摘要。
 */
export interface PlannedWrite {
  path: string
  content: string | null
}

export function planPatch(
  hunks: Hunk[],
  read: (rel: string) => string | null,
): { writes: PlannedWrite[]; results: ApplyResult[] } {
  const writes: PlannedWrite[] = []
  const results: ApplyResult[] = []
  // 同一个文件在补丁里出现多次时，后续 hunk 要基于前面算出的内容
  const virtual = new Map<string, string | null>()

  const current = (rel: string): string | null => {
    if (virtual.has(rel)) return virtual.get(rel) as string | null
    return read(rel)
  }

  for (const h of hunks) {
    if (h.kind === 'add') {
      const body = h.lines.join('\n') + (h.lines.length ? '\n' : '')
      if (current(h.path) !== null) {
        throw new Error(`E_PATCH_CONFLICT: Add File ${h.path} but it already exists`)
      }
      virtual.set(h.path, body)
      results.push({ file: h.path, action: 'add', addedLines: h.lines.length, removedLines: 0 })
      continue
    }

    if (h.kind === 'delete') {
      if (current(h.path) === null) throw new Error(`E_PATCH_MISSING: Delete File ${h.path} but it does not exist`)
      virtual.set(h.path, null)
      results.push({ file: h.path, action: 'delete', addedLines: 0, removedLines: 0 })
      continue
    }

    // update
    const original = current(h.path)
    if (original === null) throw new Error(`E_PATCH_MISSING: Update File ${h.path} but it does not exist`)

    const lines = original.split('\n')
    let cursor = 0
    let added = 0
    let removed = 0

    for (const [idx, chunk] of h.chunks.entries()) {
      if (chunk.context) {
        // @@ 定位：上下文文本本身所在的块也要被替换掉，所以先找位置，找不到就用 cursor
        const anchor = lines.findIndex((l, n) => n >= cursor && l.includes(chunk.context as string))
        if (anchor >= 0) cursor = anchor
      }
      const at = findBlock(lines, chunk.oldLines, cursor)
      if (at < 0) {
        throw new Error(
          `E_PATCH_NOMATCH: chunk #${idx + 1} of ${h.path} did not match ` +
          `(context ${JSON.stringify(chunk.context ?? '(none)')}). ` +
          `Old block was:\n${chunk.oldLines.slice(0, 6).join('\n')}`,
        )
      }
      lines.splice(at, chunk.oldLines.length, ...chunk.newLines)
      cursor = at + chunk.newLines.length
      added += chunk.newLines.length
      removed += chunk.oldLines.length
    }

    const next = lines.join('\n')
    virtual.set(h.path, next)
    const action = h.moveTo ? 'move' : 'update'
    if (h.moveTo) {
      virtual.set(h.moveTo, next)
      virtual.set(h.path, null)
    }
    results.push({ file: h.moveTo ?? h.path, action, addedLines: added, removedLines: removed })
  }

  for (const [p, content] of virtual) writes.push({ path: p, content })
  return { writes, results }
}
