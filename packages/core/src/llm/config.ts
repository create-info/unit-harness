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
  /** 审批档位：ask（逐次问）/ auto（只问不可逆的）/ allow（不问） */
  approval?: 'ask' | 'auto' | 'allow'
  /** 沙箱开关。默认全关：默认值要能兜住，不能靠人记得去打开 */
  sandbox?: SandboxPrefs
  /** 界面外观。默认浅色（白底 #FFFFFF / 正文 #1A1C1F），和桌面端一致 */
  ui?: UiPrefs
  /** 被关掉的插件，形如 "mcp:github" / "skill:deploy-check"，跨会话生效 */
  disabledPlugins?: string[]
  /** 钩子：事件名 → 命令 */
  hooks?: Record<string, string>
}

export interface UiPrefs {
  /** light（默认）/ dark / system */
  mode?: 'light' | 'dark' | 'system'
  /** 背景色，不填用主题默认的 #ffffff */
  bg?: string
  /** 正文/边框色，不填用 #1a1c1f */
  fg?: string
  /** 强调色 */
  accent?: string
  font?: 'system' | 'mono'
}

export interface SandboxPrefs {
  /** 允许沙箱内读 home（.ssh/.aws 也在里面，所以默认 false） */
  allowHome?: boolean
  /** 禁止沙箱内建 TCP 连接（landlock ABI >= 4 才有） */
  denyNetwork?: boolean
  /** 沙箱只做到 path-guard 时仍然执行：那是真正的降级，默认拒绝 */
  unconfined?: boolean
}

const CONFIG_PATH = () => path.join(uhHome(), 'config.json')

export function configPath(): string {
  return CONFIG_PATH()
}

export function readConfig(): UhConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<UhConfig>
    // 先把文件里有的全带上，再补默认值。
    // 之前是白名单式地一个一个抄字段，于是每加一个设置都要记得改这里，
    // 忘了就是"存得进去、读不回来"——approval 和 ui 各栽过一次。
    return {
      ...parsed,
      providers: parsed.providers ?? {},
      ...(parsed.defaultProvider ? { defaultProvider: parsed.defaultProvider } : {}),
      // 不带上这个字段，写进去的档位下次读就没了：writeConfig(approval:'allow')
      // 之后 readConfig().approval === undefined，于是静默退回 'ask'
      ...(parsed.approval ? { approval: parsed.approval } : {}),
      ...(parsed.sandbox && typeof parsed.sandbox === 'object' ? { sandbox: parsed.sandbox } : {}),
      // 同一个坑踩过第二次：这里不显式带上的字段，写进文件的下一秒就被读没了。
      // 与其每加一个设置就记得改这行，不如把"未知字段"原样留着——
      // 老版本读新文件时不该把它不认识的东西删掉。
      ...(parsed.ui && typeof parsed.ui === 'object' ? { ui: parsed.ui } : {}),
    }
  } catch {
    return { providers: {} }
  }
}

/**
 * 某个插件是不是被关掉了。
 *
 * 开关写在配置里，就必须在读的地方真的被读到——否则它只是界面上的一个装饰，
 * 而"我明明关了它"是最难排查的一类问题。
 */
export function isPluginEnabled(id: string): boolean {
  return !(readConfig().disabledPlugins ?? []).includes(id)
}

export function enabledMcpServers(servers: Record<string, unknown>): Record<string, unknown> {
  const off = new Set(readConfig().disabledPlugins ?? [])
  const out: Record<string, unknown> = {}
  for (const [name, cfg] of Object.entries(servers)) {
    if (!off.has('mcp:' + name)) out[name] = cfg
  }
  return out
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
