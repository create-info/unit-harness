/**
 * Checkpoint / undo。
 *
 * apply_patch 是原子的（干跑全过才落盘），但**改完没有退路**：模型把一个文件改崩，
 * 只能指望它自己再改回来。Codex 有 rewind，我们之前连原内容都没留。
 *
 * 实现用 git，但**不看工作区自己的 .git**：我们给每个会话开一个独立的 GIT_DIR，
 * 以工作区为 work-tree。这样
 *   - 用户在 git 仓库里跑 agent，不会污染他的 index/HEAD
 *   - 工作区不是 git 仓库，也照样能建点
 *   - 命令行改的文件（`sed -i`、`npm install` 写出的产物）也能被覆盖到——
 *     只盯着 apply_patch 是不够的，agent 改文件的路子有一半在 shell 里
 *
 * 只在 turn 边界建点。一个 turn 里的五次 patch 应该是一起回退的，
 * 否则 undo 会停在「改了一半」的中间态，那比不改更糟。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface CheckpointEntry {
  hash: string
  label: string
  at: string
  /** 这个点相对上一个点改了几个文件 */
  files: number
}

/**
 * 每个工作区一个独立的 GIT_DIR —— 不按会话分。
 * 会话是「谁在干活」，工作区是「哪块文件被改了」；undo 关心的是后者。
 */
export function checkpointDirFor(uhHome: string, workspace: string): string {
  const key = createHash('sha256').update(workspace).digest('hex').slice(0, 12)
  return path.join(uhHome, 'checkpoints', key)
}

/** 工作区里默认不值得进快照的东西 */
const DEFAULT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  '.uh/',
  '.venv/',
  '__pycache__/',
  '*.log',
]

export class Checkpoints {
  private ready = false

  constructor(
    private readonly workTree: string,
    private readonly gitDir: string,
  ) {}

  /** git 不在会静默降级成「没有 checkpoint」，而不是让整个 run 失败 */
  available(): boolean {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  private git(args: string[], opts: { allowFail?: boolean } = {}): string {
    try {
      return execFileSync('git', args, {
        cwd: this.workTree,
        env: {
          ...process.env,
          GIT_DIR: this.gitDir,
          GIT_WORK_TREE: this.workTree,
          // 别让用户的全局配置（签名、hooks、模板）干扰我们
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }).trim()
    } catch (err) {
      if (opts.allowFail) return ''
      throw err
    }
  }

  init(): void {
    if (this.ready) return
    fs.mkdirSync(this.gitDir, { recursive: true })
    this.git(['init', '--quiet'], { allowFail: true })
    const exclude = path.join(this.gitDir, 'info', 'exclude')
    fs.mkdirSync(path.dirname(exclude), { recursive: true })
    fs.writeFileSync(exclude, DEFAULT_EXCLUDES.join('\n') + '\n', 'utf8')
    this.git(['config', 'user.email', 'agent@unit-harness.local'], { allowFail: true })
    this.git(['config', 'user.name', 'UnitHarness'], { allowFail: true })
    this.git(['config', 'commit.gpgsign', 'false'], { allowFail: true })
    this.ready = true
  }

  /** 建一个点。返回 commit hash；没变化也留一个空点，保证 turn 与点一一对应 */
  snapshot(label: string): string | null {
    if (!this.available()) return null
    try {
      this.init()
      this.git(['add', '-A'], { allowFail: true })
      this.git(['commit', '--allow-empty', '--quiet', '-m', label], { allowFail: true })
      return this.git(['rev-parse', 'HEAD'], { allowFail: true }) || null
    } catch {
      return null
    }
  }

  list(limit = 20): CheckpointEntry[] {
    if (!this.available()) return []
    try {
      this.init()
      const raw = this.git(['log', `-${limit}`, '--pretty=format:%H\x1f%s\x1f%cI'], { allowFail: true })
      if (!raw) return []
      return raw.split('\n').map((line) => {
        const [hash, label, at] = line.split('\x1f')
        const stat = this.git(['show', '--stat', '--oneline', '--format=', hash as string], { allowFail: true })
        const files = (stat.match(/\|\s+\d+\s+[+-]*/g) ?? []).length
        return { hash: hash as string, label: label ?? '', at: at ?? '', files }
      })
    } catch {
      return []
    }
  }

  /** 回退 n 个点。n=1 表示回到最近一次 run 之前 */
  undo(n = 1): { commit: string; label: string } | null {
    if (!this.available()) return null
    try {
      this.init()
      const count = Math.max(1, Math.floor(n))
      const target = this.git(['rev-parse', `HEAD~${count}`], { allowFail: true })
      if (!target) return null
      const label = this.git(['log', '-1', '--pretty=%s', target], { allowFail: true })
      // --hard 会连新增的文件一起清掉，这正是「还原」该有的样子
      this.git(['reset', '--hard', target])
      return { commit: target, label }
    } catch {
      return null
    }
  }

  /** 某个点上改了什么（给 `uh checkpoints --diff` 用） */
  summary(hash: string): string {
    return this.git(['show', '--stat', '--format=%s', hash], { allowFail: true })
  }
}
