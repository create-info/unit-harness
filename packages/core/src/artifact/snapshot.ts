/**
 * 工作区快照与差异：用来回答"这次运行到底改了什么"。
 *
 * 为什么不依赖模型自己上报交付物：模型会说"我完成了"，但它可能改了别的文件、
 * 或根本没写。快照对比是**不依赖模型配合**的事实来源（D9 的"唯一可变状态"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { JUNK_DIRS, isJunkPath, isVenvDir } from '../fs/junk.ts'

export interface FileMeta {
  size: number
  mtimeMs: number
  sha256: string
}

export type Snapshot = Record<string, FileMeta>

/**
 * 不进快照的目录：依赖、构建产物、各种工具缓存。
 *
 * `.gocache` 是踩出来的：某个项目把 Go 的构建缓存放在工程里，一次跑下来
 * 快照里塞了两千个哈希文件名——它们变成两千条「交付物」刷满屏幕，跑完还要
 * 因为其中一些被清理而报「文件被移除了」。构建缓存的增减不是用户的工作成果。
 */
// 清单搬到 fs/junk.ts 了：这里少写 `.uvcache` 就够让一条会话烧掉三千步，
// 所以它只能有一份，各处引用同一份。
const SKIP_DIRS = JUNK_DIRS
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
        // 名字枚举盖不住 `pptvenv` 这类自命名的 venv：整棵跳过，见 fs/junk.ts
        if (isVenvDir(abs)) continue
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

/**
 * 一个产物是怎么来的——这决定了我们敢不敢说"这是这次做的"。
 *
 *   tool     : 我们自己看见它被写进去的（write_file / apply_patch 走的都是同一条
 *              记账路径），确凿。
 *   snapshot : 只是"跑的时候它出现在了工作区里"。两条会话共用一个目录时，
 *              隔壁那条写的东西也算在你头上——这不是归属，这是巧合。
 *
 * Codex 干脆不拍快照（`turn_diff_tracker.rs`：只累加自己打过的补丁）。我们做
 * 课件这类产出是脚本写的、拿不到补丁，所以快照还得留着看，但**不能拿它当归属**。
 */
export type ArtifactSource = 'tool' | 'exec' | 'snapshot'

export interface Artifact {
  path: string
  sha256: string
  bytes: number
  source: ArtifactSource
}

/**
 * 把变更转成交付物清单（删除不算交付物，但会记进 events）。
 *
 * `attested` 是这一轮里被工具**真正写过**的相对路径集合。不在里面的，
 * 按"只是出现了"记，界面上就不能算作这次会话的产出。
 */
export function collectArtifacts(
  root: string,
  changes: ChangeSet,
  after: Snapshot,
  attested?: ReadonlySet<string>,
  execWindows?: ReadonlyArray<readonly [number, number]>,
): Artifact[] {
  // 路径写法在两边的来历不同（工具传的是 `a.txt`，快照可能是 `./a.txt`），
  // 先统一成一种再比。不清洗就直接比，会把自己写的文件判成"只是出现了"。
  const ours = attested ? new Set([...attested].map((x) => x.replace(/^\.\//, ''))) : null
  /**
   * 落在某条命令的执行窗口里 = 这条命令写的。
   *
   * 工具写的有账本（tool），其余只能靠时间：脚本生成 pptx/svg 这类拿不到补丁，
   * 却正是办公场景的主要产出。用**单条命令**的窗口而不是整次 run 的区间——
   * 窗口通常几秒，隔壁会话的文件几乎不可能正好落进来；而"整个 run 期间出现过"
   * 是二十分钟，那才会把别人的东西算到自己头上。
   *
   * 这不是精确证明，是排除法：不在任何窗口里、也不是工具写的，就不能认领。
   */
  const inWindow = (t: number): boolean => {
    if (!execWindows || !execWindows.length || !Number.isFinite(t)) return false
    // 只给 100ms 余量（落盘、日志刷新）。放 1 秒就会把"命令刚跑完 0.4 秒后
    // 别人写进来的文件"也算进来——那正是要排除的东西。
    for (const [a, b] of execWindows) if (t >= a && t <= b + 100) return true
    return false
  }
  const out: Artifact[] = []
  for (const p of [...changes.added, ...changes.modified]) {
    // 老快照是按旧清单拍的，里面还带着 `.uvcache`、`.venv` 这类目录。
    // 只在拍快照那一层过滤，等于"新会话干净、老会话照旧"——用户点开的那条
    // 恰恰是老会话。所以读出来的时候也按同一份清单滤一遍。
    if (isJunkPath(p)) continue
    const meta = after[p]
    if (!meta) continue
    // 快照里的 key 带不带 `./` 取决于拍摄时的路径写法，比对前统一一下，
    // 否则「明明是自己写的」会被判成 snapshot——宁可漏认，不可错认，
    // 但让这种纯格式差异造成漏认同样是 bug。
    const key = p.replace(/^\.\//, '')
    out.push({
      path: p,
      sha256: meta.sha256,
      bytes: meta.size,
      source: ours?.has(key) ? 'tool' : (inWindow(meta.mtimeMs) ? 'exec' : 'snapshot'),
    })
  }
  return out
}
