/**
 * bubblewrap：唯一能同时做到「读得动工具链」和「读不到凭据」的机制。
 *
 * 为什么需要它：landlock 是白名单——放行 $HOME 就等于放行 $HOME/.ssh，
 * 而不放行 $HOME 又让 git（~/.gitconfig）、npm（~/.npmrc）、pip、编辑器配置
 * 全部失效。实测就是这样：`git commit` 直接 `fatal: 读取配置文件时遇到未知错误`。
 *
 * bwrap 用挂载层解决：整个 / 只读挂进来，再用空的 tmpfs 盖住凭据目录。
 * 于是「读」是完全正常的用户环境，「凭据」是一个空目录。
 *
 * 代价：需要非特权 user namespace。Ubuntu 23.10 起 AppArmor 默认限制它
 * （apparmor_restrict_unprivileged_userns=1），所以这里必须能失败得体面。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export interface BwrapInfo {
  path: string
}

/** 用空 tmpfs 盖掉的目录：凭据就在这里 */
const MASKED = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.config/gcloud',
]

function findInPath(bin: string): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, bin)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

/**
 * 真的跑一次才算可用。
 * 装了这个二进制但 userns 被禁，是最常见的状态——只看文件存在会得出
 * 「有 bwrap」然后每条命令都 `setting up uid map: Permission denied`。
 */
export function findBwrap(): BwrapInfo | null {
  const bin = findInPath('bwrap')
  if (!bin) return null
  try {
    const r = spawnSync(bin, ['--ro-bind', '/', '/', '--dev', '/dev', '--', 'true'], {
      timeout: 4000,
      stdio: 'ignore',
    })
    return r.status === 0 ? { path: bin } : null
  } catch {
    return null
  }
}

export interface BwrapOptions {
  argv: string[]
  workspace: string
  denyNetwork?: boolean
  /** 额外只读放行的路径（工具链目录等） */
  extraReadOnly?: string[]
  /** 关闭凭据屏蔽（调试用；正常不该开） */
  unmasked?: boolean
}

/** 构造 `bwrap ... -- cmd` 的参数 */
export function buildBwrapArgv(info: BwrapInfo, o: BwrapOptions): string[] {
  const home = os.homedir()
  const args: string[] = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
  ]

  if (!o.unmasked) {
    for (const rel of MASKED) {
      const p = path.join(home, rel)
      // 只有存在的路径才盖：给一个不存在的路径 --tmpfs 会让 bwrap 直接失败
      try {
        fs.statSync(p)
        args.push('--tmpfs', p)
      } catch { /* 不存在就不管 */ }
    }
  }

  for (const p of o.extraReadOnly ?? []) args.push('--ro-bind-try', p, p)

  // 工作区可写。~/.uh 也要可写：配置与缓存都在那儿
  args.push('--bind', o.workspace, o.workspace)
  const uh = path.join(home, '.uh')
  try {
    fs.statSync(uh)
    args.push('--bind', uh, uh)
  } catch { /* 没有就不绑 */ }

  args.push('--chdir', o.workspace)
  if (o.denyNetwork) args.push('--unshare-net')
  args.push('--', ...o.argv)
  return args
}
