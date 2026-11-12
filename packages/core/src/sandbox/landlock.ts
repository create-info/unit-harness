/**
 * landlock helper 的封装。
 *
 * 为什么用外部二进制而不是 native addon：
 *  - Node 没有 landlock 的 syscall 绑定；
 *  - landlock 必须在 exec 前于同一进程内施加，无法"事后检查"；
 *  - 一个静态 C 小程序编译一次即可跨发行版使用（见 native/landlock-helper）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export interface LandlockHelper {
  path: string
  abi: number
}

/** 默认只读的系统路径（各发行版布局不同，不存在的会被 helper 跳过） */
export const SYSTEM_RO = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/proc', '/sys', '/opt', '/run']

/** SEA 单文件发行版：首次运行时把内嵌的 helper 释放到 ~/.uh/bin */
function ensureEmbeddedHelper(): string | null {
  const embedded = typeof __UH_LANDLOCK_B64__ === 'undefined' ? '' : __UH_LANDLOCK_B64__
  if (!embedded) return null
  if (process.platform !== 'linux') return null

  const target = path.join(os.homedir(), '.uh', 'bin', 'landlock-helper')
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, Buffer.from(embedded, 'base64'))
    fs.chmodSync(target, 0o755)
    return target
  } catch {
    return null
  }
}

function candidates(): string[] {
  // 显式指定时只认它：`UH_LANDLOCK_HELPER=/nonexistent` 可用来模拟「没有沙箱」，
  // 也避免测试时静默回落到仓库内的构建产物。
  const explicit = process.env.UH_LANDLOCK_HELPER
  if (explicit !== undefined && explicit !== '') return [explicit]

  const home = os.homedir()
  const installed = path.join(home, '.uh', 'bin', 'landlock-helper')
  if (!fs.existsSync(installed)) ensureEmbeddedHelper()

  return [
    installed,
    path.join(process.cwd(), 'build', 'landlock-helper'),
    path.join(process.cwd(), 'native', 'landlock-helper', 'build', 'landlock-helper'),
  ]
}

function probeAbi(bin: string): number {
  try {
    const out = execFileSync(bin, ['--probe'], { timeout: 3000, encoding: 'utf8' }).trim()
    const n = Number(out)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/** 找到可用的 helper；返回 null 表示 landlock 路径不可用 */
export function findLandlockHelper(): LandlockHelper | null {
  if (process.platform !== 'linux') return null
  for (const bin of candidates()) {
    try {
      fs.accessSync(bin, fs.constants.X_OK)
    } catch {
      continue
    }
    const abi = probeAbi(bin)
    if (abi > 0) return { path: bin, abi }
  }
  return null
}

export interface WrapOptions {
  argv: string[]
  workspace: string
  /** 允许读 home（默认否：home 里有 .ssh/.aws 等凭据） */
  allowHome?: boolean
  /** 禁止 TCP（landlock ABI >= 4 才有；UDP 不受控） */
  denyNetwork?: boolean
  /** 额外路径 */
  extraReadOnly?: string[]
  extraReadWrite?: string[]
}

/** 构造 `helper ... -- cmd` 的完整参数 */
export function buildLandlockArgv(helper: LandlockHelper, o: WrapOptions): string[] {
  const args: string[] = []
  const ro = [...SYSTEM_RO, ...(o.extraReadOnly ?? [])]
  if (o.allowHome) ro.push(os.homedir())

  for (const p of ro) args.push('--ro', p)
  for (const p of o.extraReadWrite ?? []) args.push('--rw', p)

  // workspace 永远可写；~/.uh 需要可写（配置、插件缓存）
  args.push('--rw', o.workspace)
  args.push('--rw', path.join(os.homedir(), '.uh'))

  args.push('--net', o.denyNetwork ? 'none' : 'any')
  args.push('--', ...o.argv)
  return args
}
