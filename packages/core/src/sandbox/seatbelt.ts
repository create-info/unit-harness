/**
 * macOS seatbelt（`sandbox-exec`）封装。
 *
 * 策略取舍：用 `(allow default)` + 显式 `deny`，而不是 `(deny default)` 白名单。
 * 原因：macOS 上进程需要读大量系统资源（dyld cache、TCC、Metal…），白名单模式
 * 会让普通命令也起不来；deny 模式更小、更可预测，且覆盖面足够——
 * 我们要挡的是「写工作区外」和「读 $HOME」，不是做一个完整 jail。
 *
 * 已知局限（写进 docs）：seatbelt 已被 Apple 标记 deprecated，但仍是
 * 第三方本地工具唯一可用的内核级机制。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface SeatbeltInfo {
  path: string
  available: boolean
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec'

export function findSeatbelt(): SeatbeltInfo {
  if (process.platform !== 'darwin') return { path: SANDBOX_EXEC, available: false }
  const ok = fs.existsSync(SANDBOX_EXEC)
  return { path: SANDBOX_EXEC, available: ok }
}

/** sbpl 字符串字面量转义 */
function q(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export interface SeatbeltOptions {
  workspace: string
  /** 允许读 $HOME（默认否） */
  allowHome?: boolean
  /** 禁止网络 */
  denyNetwork?: boolean
  /** 额外只读放行（工具链目录；放在 deny $HOME 之后，sbpl 是最后匹配优先） */
  extraReadOnly?: string[]
}

/** 生成 sbpl profile */
export function buildSeatbeltProfile(o: SeatbeltOptions): string {
  const home = os.homedir()
  const uhHome = path.join(home, '.uh')
  // 只放行工作区、~/.uh 与 /tmp 这类明确的临时目录。
  // 曾经把 /private/var/folders 整棵放进来，而 macOS 的 os.tmpdir() 就在那里，
  // 于是「写工作区之外」其实是被允许的 —— escalation 测试在 macOS 上因此长期失败，
  // 文档却写着「写入被限制在工作区」。宁可让临时目录写失败，也不能让承诺变成假话。
  const writable = [o.workspace, uhHome, '/tmp', '/private/tmp']
  const rules: string[] = ['(version 1)', '(allow default)']

  // 读：挡住 $HOME（.ssh/.aws 等），但放行 workspace 与 ~/.uh
  if (!o.allowHome) {
    rules.push(`(deny file-read* (subpath ${q(home)}))`)
    rules.push(`(allow file-read* (subpath ${q(o.workspace)}) (subpath ${q(uhHome)}))`)
    if (o.extraReadOnly?.length) {
      // 在后面 allow 才能覆盖前面的 deny（解释器、包缓存）
      rules.push(`(allow file-read* ${o.extraReadOnly.map((p) => `(subpath ${q(p)})`).join(' ')})`)
    }
  }

  // 写：默认全禁，只放行工作区 / ~/.uh / 临时目录 / 必要的设备
  rules.push('(deny file-write*)')
  rules.push(`(allow file-write* ${writable.map((p) => `(subpath ${q(p)})`).join(' ')})`)
  rules.push('(allow file-write* (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr"))')

  if (o.denyNetwork) {
    rules.push('(deny network*)')
    rules.push('(allow network* (literal "/private/var/run/mDNSResponder"))')
  }

  return rules.join('\n') + '\n'
}

/** 构造 `sandbox-exec -p <profile> -- cmd args` */
export function buildSeatbeltArgv(info: SeatbeltInfo, profile: string, argv: string[]): string[] {
  return ['-p', profile, '--', ...argv]
}

/** 把 profile 落到 ~/.uh/tmp 下，避免超长命令行参数 */
export function writeSeatbeltProfile(profile: string): string {
  const dir = path.join(os.homedir(), '.uh', 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'seatbelt.sb')
  fs.writeFileSync(p, profile)
  return p
}
