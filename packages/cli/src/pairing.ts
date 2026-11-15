/**
 * 配对：让一台手机长期被这台电脑认。
 *
 * 之前只有一把 `serve-token`——那是「口令」，不是「设备」。手机上要背一串
 * 25 位的随机字符，背完还没法单独撤销：手机丢了只能换口令，所有设备一起失联。
 *
 * 这里做的事很简单：每台设备一把自己的令牌，只存哈希；删一台不影响其他。
 * 令牌形如 `uhp_xxxx`（uh phone），前缀让人一眼看出这是给设备用的，
 * 而不是我们内部某个密钥。
 *
 * 关于存储：`devices.json` 权限 0600，里面只有 sha256 摘要，没有令牌原文——
 * 备份、截图、误贴进 issue 都拿不到能用的凭据。
 */
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { uhHome } from '../../core/src/paths.ts'

export interface Device {
  id: string
  name: string
  /** sha256(token)，没有原文 */
  hash: string
  created: string
  lastSeen?: string
}

interface DeviceFile {
  devices: Device[]
}

function file(): string {
  return join(uhHome(), 'devices.json')
}

export function loadDevices(): Device[] {
  try {
    const j = JSON.parse(readFileSync(file(), 'utf8')) as DeviceFile
    return Array.isArray(j.devices) ? j.devices : []
  } catch {
    return []
  }
}

function save(devices: Device[]): void {
  mkdirSync(uhHome(), { recursive: true })
  writeFileSync(file(), JSON.stringify({ devices }, null, 2), { mode: 0o600 })
  try { chmodSync(file(), 0o600) } catch { /* 有些文件系统不支持，不影响功能 */ }
}

function sha(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * 造一台设备。
 *
 * 名字不是装饰：手机丢了的时候，你要在一串 id 里找出「哪台是丢的那台」，
 * `dev_a1b2c3` 做不到，`iPhone 15` 可以。
 */
export function createDevice(name: string): { device: Device; token: string } {
  const devices = loadDevices()
  const token = 'uhp_' + randomBytes(18).toString('base64url')
  const device: Device = {
    id: 'dev_' + randomBytes(4).toString('hex'),
    name: name.trim() || 'device',
    hash: sha(token),
    created: new Date().toISOString(),
  }
  devices.push(device)
  save(devices)
  return { device, token }
}

/** 令牌 → 设备。命中就顺手记一次 lastSeen（节流：一分钟内不重复写盘） */
export function deviceForToken(token: string): Device | null {
  if (!token) return null
  const h = sha(token)
  const devices = loadDevices()
  const hit = devices.find((d) => d.hash === h)
  if (!hit) return null
  const now = Date.now()
  const last = hit.lastSeen ? Date.parse(hit.lastSeen) : 0
  if (!Number.isFinite(last) || now - last > 60_000) {
    hit.lastSeen = new Date(now).toISOString()
    save(devices)
  }
  return hit
}

/** 撤销一台：按 id 或名字都认（`uh unpair iPhone` 比背 id 现实） */
export function revokeDevice(idOrName: string): Device | null {
  const devices = loadDevices()
  const key = idOrName.trim()
  const idx = devices.findIndex((d) => d.id === key || d.name === key)
  if (idx < 0) return null
  const [gone] = devices.splice(idx, 1)
  save(devices)
  return gone ?? null
}

/**
 * 手机上要打开的那个地址。
 *
 * 令牌放在 `?t=` 里是有意的：这样**用相机扫一下就配对完成**，不需要在手机上
 * 手敲任何东西。服务端收到 `?t=` 会换成 cookie 并把令牌从地址栏抹掉，
 * 所以它不会留在历史记录里。
 */
export function pairUrl(baseUrl: string, token: string): string {
  const u = baseUrl.replace(/\/+$/, '')
  return `${u}/?t=${encodeURIComponent(token)}`
}
