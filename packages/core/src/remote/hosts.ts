/**
 * 远端主机配置。
 *
 * 这里**只存路径，不存私钥内容**：`~/.uh/hosts.json` 里写 `key: ~/.ssh/id_ed25519`，
 * 私钥本身留在原地、权限仍由系统管。harness 读到的是"用哪把钥匙"，不是钥匙。
 *
 * 为什么远端执行要绕开本地沙箱：SSH 必须读私钥，而沙箱故意让 ~/.ssh 不可读
 * （那是防模型偷凭据的主要一道墙）。所以 ssh 是一个**独立工具**，凭据只在工具内部
 * 流转，模型看到的是主机别名 + 命令，看不到 key。工具边界就是信任边界。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'

export interface RemoteHost {
  host: string
  user?: string
  port?: number
  /** 私钥路径（可含 ~）；缺省用 ssh 的默认身份 */
  key?: string
  /** 人读备注 */
  label?: string
  /** 默认 shell，缺省 sh -lc */
  shell?: string
}

interface HostsFile {
  hosts?: Record<string, RemoteHost>
}

export function hostsConfigPath(): string {
  return path.join(uhHome(), 'hosts.json')
}

export function loadHosts(): { hosts: Record<string, RemoteHost>; path: string } {
  const p = hostsConfigPath()
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as HostsFile
    return { hosts: parsed.hosts ?? {}, path: p }
  } catch {
    return { hosts: {}, path: p }
  }
}

export function upsertHost(name: string, host: RemoteHost): string {
  const p = hostsConfigPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  let current: HostsFile = {}
  try { current = JSON.parse(fs.readFileSync(p, 'utf8')) as HostsFile } catch { /* new file */ }
  const hosts = { ...(current.hosts ?? {}) }
  hosts[name] = host
  fs.writeFileSync(p, JSON.stringify({ ...current, hosts }, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* 平台不支持则忽略 */ }
  return p
}

export function removeHost(name: string): boolean {
  const p = hostsConfigPath()
  let current: HostsFile
  try { current = JSON.parse(fs.readFileSync(p, 'utf8')) as HostsFile } catch { return false }
  const hosts = { ...(current.hosts ?? {}) }
  if (!(name in hosts)) return false
  delete hosts[name]
  fs.writeFileSync(p, JSON.stringify({ ...current, hosts }, null, 2) + '\n', { mode: 0o600 })
  return true
}

export function targetOf(name: string, host: RemoteHost): string {
  return host.user ? `${host.user}@${host.host}` : host.host
}
