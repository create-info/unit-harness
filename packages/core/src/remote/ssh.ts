/**
 * 远端执行：spawn 系统的 ssh 客户端。
 *
 * 不用 npm 的 ssh 库：ssh 自己的配置（~/.ssh/config、ProxyJump、agent）是用户已经
 * 调好的，另起一套实现只会让"在我机器上能连"变成"在 uh 里连不上"。
 *
 * 安全上的三条：
 *  - BatchMode=yes —— 绝不弹密码提示（否则会挂到超时，看起来像网络问题）
 *  - StrictHostKeyChecking=accept-new —— 首次信任并记录，之后变动就拒（不静默接受 MITM）
 *  - ConnectTimeout —— 连不上要快速失败，不要拖着整轮对话
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { targetOf } from './hosts.ts'
import type { RemoteHost } from './hosts.ts'

export interface RemoteSpec {
  host: RemoteHost
  command: string
  timeoutMs?: number
}

export interface RemoteResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

function expandKey(key: string): string {
  return key.startsWith('~') ? path.join(os.homedir(), key.slice(1)) : key
}

export function sshArgv(spec: RemoteSpec): string[] {
  const { host } = spec
  const argv = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
    '-o', 'LogLevel=ERROR',
  ]
  if (host.key) argv.push('-i', expandKey(host.key))
  if (host.port) argv.push('-p', String(host.port))
  argv.push('--', targetOf('', host))
  // 整条命令作为**单个参数**交给远端 shell 解析：管道、重定向、变量展开
  // 都应该在远端发生，而不是在本地先被拆开
  argv.push(spec.command)
  return argv
}

export async function runRemote(spec: RemoteSpec): Promise<RemoteResult> {
  const timeoutMs = spec.timeoutMs ?? 60_000
  const started = Date.now()

  return await new Promise<RemoteResult>((resolve) => {
    const child = spawn('ssh', sshArgv(spec), { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000)
    }, timeoutMs)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    child.stderr?.on('data', (d: string) => { stderr += d })

    const done = (code: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: timedOut ? 124 : code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      })
    }

    child.on('error', (err) => {
      stderr += `\nE_SSH_SPAWN: ${err.message}`
      done(125)
    })
    child.on('close', (code) => done(code ?? 1))
  })
}
