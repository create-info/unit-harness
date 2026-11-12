/**
 * `~/.uh/config.json` —— provider 凭据与默认选择。
 *
 * 安全约束：
 *  - 文件权限 0600，只在必要时重写；
 *  - 任何展示路径都过 maskKey；
 *  - 不进事件日志、不进 git（~/.uh 不在仓库里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { uhHome } from '../paths.ts'
import type { ProviderDef } from './providers.ts'

export interface ProviderConfigEntry {
  apiKey?: string
  model?: string
  /** 覆盖注册表里的 baseUrl（自建网关、代理） */
  baseUrl?: string
}

export interface UhConfig {
  defaultProvider?: string
  providers: Record<string, ProviderConfigEntry>
}

const CONFIG_PATH = () => path.join(uhHome(), 'config.json')

export function configPath(): string {
  return CONFIG_PATH()
}

export function readConfig(): UhConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<UhConfig>
    return { providers: parsed.providers ?? {}, ...(parsed.defaultProvider ? { defaultProvider: parsed.defaultProvider } : {}) }
  } catch {
    return { providers: {} }
  }
}

export function writeConfig(cfg: UhConfig): void {
  const p = CONFIG_PATH()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
  try {
    fs.chmodSync(p, 0o600)
  } catch {
    /* windows: mode 不生效，忽略 */
  }
}

export function setProviderEntry(id: string, entry: ProviderConfigEntry): void {
  const cfg = readConfig()
  cfg.providers[id] = { ...cfg.providers[id], ...entry }
  writeConfig(cfg)
}

export function unsetProvider(id: string): boolean {
  const cfg = readConfig()
  if (!cfg.providers[id]) return false
  delete cfg.providers[id]
  if (cfg.defaultProvider === id) delete cfg.defaultProvider
  writeConfig(cfg)
  return true
}

export function setDefaultProvider(id: string): void {
  const cfg = readConfig()
  cfg.defaultProvider = id
  writeConfig(cfg)
}

/** 解析某个 provider 实际使用的 key（config 优先，其次环境变量） */
export function apiKeyFor(def: ProviderDef): string | undefined {
  const cfg = readConfig()
  const fromConfig = cfg.providers[def.id]?.apiKey
  if (fromConfig) return fromConfig
  if (def.envKey) {
    const v = process.env[def.envKey]
    if (v) return v
  }
  // 兜底：通用变量（CI / 容器里常见）
  return process.env.UH_API_KEY
}
