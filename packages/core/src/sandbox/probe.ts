/**
 * 沙箱能力探测（D7）。
 *
 * 原则：
 *  1. 每个机制单独报告，不合并成布尔；
 *  2. 探测不出来就说 "unverified"，不假装可用；
 *  3. 全部不可用时 fail-closed（effective 之外的兜底由调用方拒绝执行）。
 *
 * 已知撞墙点见 docs/unit-harness-opensource-v1.md D7。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IsolationLevel, IsolationReport } from '../types.ts'

/** P0 的诚实声明：能探测到能力，但还没有施加隔离的代码 */
const SANDBOX_ENFORCED_IN_P0: IsolationLevel = 'none'

function readText(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

/** 解析 major.minor，用于内核能力判断 */
function kernelVersion(release: string): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(release)
  if (!m) return null
  return [Number(m[1]), Number(m[2])]
}

function findInPath(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const d of dirs) {
    const p = path.join(d, bin)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

interface LandlockProbe { available: boolean; abi: number | null; reason?: string }

function probeLandlock(notes: string[]): LandlockProbe {
  if (process.platform !== 'linux') return { available: false, abi: null, reason: 'not linux' }

  const ver = kernelVersion(os.release())
  if (!ver) return { available: false, abi: null, reason: 'unparsable kernel release' }
  const [major, minor] = ver
  const newEnough = major > 5 || (major === 5 && minor >= 13)

  // 最可靠的用户态信号：内核启用了哪些 LSM
  const lsm = readText('/sys/kernel/security/lsm')
  if (lsm !== null) {
    const enabled = lsm.trim().split(',').map((s) => s.trim())
    notes.push(`lsm: ${enabled.join(',') || '(empty)'}`)
    if (enabled.includes('landlock')) {
      // ABI 版本需要 syscall 探测；此处保守报 1，并在 notes 说明
      notes.push('landlock ABI reported as 1 (conservative; not syscall-probed)')
      return { available: true, abi: 1 }
    }
    return { available: false, abi: null, reason: 'landlock not in lsm list' }
  }

  if (!newEnough) return { available: false, abi: null, reason: `kernel ${os.release()} < 5.13` }

  notes.push('lsm list unreadable; falling back to kernel version only (unverified)')
  return { available: false, abi: null, reason: 'lsm list unreadable (unverified)' }
}

function probeBwrap(notes: string[]): { available: boolean; path: string | null; reason?: string } {
  if (process.platform !== 'linux') return { available: false, path: null, reason: 'not linux' }
  const bundled = path.join(os.homedir(), '.uh', 'bin', 'bwrap')
  try { fs.accessSync(bundled, fs.constants.X_OK); notes.push(`bwrap: bundled at ${bundled}`); return { available: true, path: bundled } } catch { /* next */ }
  const sys = findInPath('bwrap')
  if (sys) { notes.push(`bwrap: system at ${sys}`); return { available: true, path: sys } }
  return { available: false, path: null, reason: 'bwrap not found' }
}

function probeSeatbelt(notes: string[]): { available: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { available: false, reason: 'not darwin' }
  const p = '/usr/bin/sandbox-exec'
  const ok = fs.existsSync(p)
  notes.push(`seatbelt: ${ok ? 'sandbox-exec present' : 'sandbox-exec missing'}`)
  return ok ? { available: true } : { available: false, reason: 'sandbox-exec missing' }
}

/** 探测当前机器真实可用的隔离能力 */
export function probeIsolation(): IsolationReport {
  const notes: string[] = []
  const landlock = probeLandlock(notes)
  const bwrap = probeBwrap(notes)
  const seatbelt = probeSeatbelt(notes)

  let available: IsolationLevel
  if (process.platform === 'linux') {
    if (landlock.available) available = `landlock-v${landlock.abi ?? 1}` as IsolationLevel
    else if (bwrap.available) available = 'bwrap'
    else available = 'path-guard'
  } else if (process.platform === 'darwin') {
    available = seatbelt.available ? 'seatbelt' : 'path-guard'
  } else if (process.platform === 'win32') {
    notes.push('windows: restricted-token not implemented yet')
    available = 'path-guard'
  } else {
    available = 'path-guard'
  }

  if (available === 'path-guard') {
    notes.push('path-guard: no kernel isolation available; exec will require --allow-unconfined')
  }

  // P0：尚未实现 landlock/bwrap/seatbelt 的封装，因此实际施加的隔离为 none。
  // P1 实现后，enforced 应改为实测值（不要在这里写死成 available）。
  const enforced: IsolationLevel = SANDBOX_ENFORCED_IN_P0

  return {
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    landlock,
    bwrap,
    seatbelt,
    available,
    enforced,
    notes,
  }
}

/** 人类可读的一行摘要，用于 `uh doctor` 与 session/start 事件 */
export function describeIsolation(r: IsolationReport): string {
  const gap = r.available !== r.enforced ? `  [available ${r.available}, NOT enforced]` : ''
  return `${r.enforced} (platform=${r.platform}/${r.arch}, kernel=${r.release})${gap}`
}
