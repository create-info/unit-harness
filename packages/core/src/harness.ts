/**
 * Harness：Cordis 之上的薄封装（D3）。
 *
 * 职责边界：
 *  - 插件只见到 UnitHarnessContext，见不到 Cordis 类型；
 *  - 所有副作用经 exec/fs 封装，以便后续统一记录证据（D13）；
 *  - 插件加载失败不影响宿主（docs D4/D5）。
 */
import { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { probeIsolation } from './sandbox/probe.ts'
import { API_VERSION } from './types.ts'
import type {
  Disposer, ExecResult, ExecSpec, HookPoint, HookRegistration, HookSpec,
  IsolationLevel, IsolationReport, Plugin, ToolDefinition, UnitHarnessContext,
} from './types.ts'

/** SEA 产物是 CJS main，动态 import 需要用运行时求值，避免被打包器改写 */
const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export interface HarnessOptions {
  pluginDirs?: string[]
  configs?: Record<string, unknown>
  /** path-guard 级别下是否允许执行（fail-closed 默认 false） */
  unconfined?: boolean
  logLevel?: LogLevel
  workspace?: string
}

export interface LoadedPlugin {
  name: string
  dir: string
  file: string
  status: 'loaded' | 'failed'
  error?: string
}

export class Harness {
  readonly ctx: Context
  readonly isolation: IsolationReport
  readonly plugins: LoadedPlugin[] = []

  private readonly opts: HarnessOptions
  private readonly level: LogLevel
  private readonly disposers: Disposer[] = []
  private readonly toolRegistry = new Map<string, ToolDefinition>()
  private readonly hookRegistry: HookRegistration[] = []
  private readonly services = new Map<string, unknown>()

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts
    this.level = opts.logLevel ?? 'info'
    this.ctx = new Context()
    this.isolation = probeIsolation()
  }

  /** 当前实际隔离级别 */
  get isolationLevel(): IsolationLevel {
    return this.isolation.enforced
  }

  private log(level: LogLevel, msg: string, ...rest: unknown[]): void {
    if (LEVELS[level] < LEVELS[this.level]) return
    const line = `[uh:${level}] ${msg}`
    if (level === 'error') console.error(line, ...rest)
    else if (level === 'warn') console.warn(line, ...rest)
    else console.log(line, ...rest)
  }

  /** 扫描插件目录并 apply */
  async start(): Promise<LoadedPlugin[]> {
    const dirs = this.opts.pluginDirs ?? []
    for (const dir of dirs) {
      let entries: Awaited<ReturnType<typeof readdir>> = [] as unknown as Awaited<ReturnType<typeof readdir>>
      try {
        entries = (await readdir(dir, { withFileTypes: true })) as unknown as typeof entries
      } catch {
        this.log('debug', `plugin dir not found: ${dir}`)
        continue
      }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue
        await this.loadOne(join(dir, String(ent.name)))
      }
    }
    return this.plugins
  }

  private async resolveEntry(pdir: string): Promise<string | null> {
    try {
      const pkg = JSON.parse(await readFile(join(pdir, 'package.json'), 'utf8')) as { main?: string }
      if (typeof pkg.main === 'string') {
        const p = join(pdir, pkg.main)
        await stat(p)
        return p
      }
    } catch { /* fall through to conventional names */ }

    for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
      const p = join(pdir, name)
      try { await stat(p); return p } catch { /* next */ }
    }
    return null
  }

  private async loadOne(pdir: string): Promise<void> {
    const file = await this.resolveEntry(pdir)
    if (!file) {
      this.log('debug', `no entry in ${pdir}`)
      return
    }
    const record: LoadedPlugin = { name: pdir.split('/').pop() ?? pdir, dir: pdir, file, status: 'failed' }

    try {
      const mod = await dynamicImport(pathToFileURL(file).href)
      const plugin = (mod.default ?? mod) as Plugin
      const name = plugin?.name ?? record.name
      record.name = name

      if (plugin.apiVersion !== API_VERSION) {
        record.error = `E_API_VERSION: plugin requires apiVersion ${String(plugin.apiVersion)}, host provides ${API_VERSION}. ` +
          `Run: uh plugin migrate ${name} --to ${API_VERSION}`
        this.plugins.push(record)
        this.log('error', record.error)
        return
      }

      const config = (this.opts.configs?.[name] ?? this.opts.configs?.[name.replace(/\./g, '_')] ?? {}) as Record<string, unknown>
      const pctx = this.makePluginContext(name, config)
      await plugin.apply(pctx, config)
      record.status = 'loaded'
      this.plugins.push(record)
      this.log('info', `plugin loaded: ${name}`)
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err)
      this.plugins.push(record)
      this.log('error', `plugin failed: ${record.name} -> ${record.error}`)
    }
  }

  private makePluginContext(id: string, config: Readonly<Record<string, unknown>>): UnitHarnessContext {
    const self = this
    const scoped = (level: LogLevel) => (msg: string, ...rest: unknown[]) =>
      self.log(level, `[${id}] ${msg}`, ...rest)

    return {
      apiVersion: 1,
      id,
      config,

      log: {
        debug: scoped('debug'),
        info: scoped('info'),
        warn: scoped('warn'),
        error: scoped('error'),
      },

      tools: {
        register(tool: ToolDefinition) {
          if (self.toolRegistry.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`)
          self.toolRegistry.set(tool.name, tool)
          const dispose = () => { self.toolRegistry.delete(tool.name) }
          self.disposers.push(dispose)
          return dispose
        },
        list: () => [...self.toolRegistry.values()].map((t) => ({ name: t.name, description: t.description })),
      },

      hooks: {
        on(point: HookPoint, spec: HookSpec) {
          const reg: HookRegistration = { point, spec }
          self.hookRegistry.push(reg)
          const dispose = () => {
            const i = self.hookRegistry.indexOf(reg)
            if (i >= 0) self.hookRegistry.splice(i, 1)
          }
          self.disposers.push(dispose)
          return dispose
        },
        list: () => [...self.hookRegistry],
      },

      exec: {
        run: (argv, opts) => self.exec({ ...opts, argv }),
      },

      sandbox: {
        probe: () => self.isolation,
        isolation: self.isolation.enforced,
      },

      provide<T>(name: string, impl: T): Disposer {
        self.services.set(name, impl)
        // 同时注册到 Cordis 上下文，让其他插件能用 ctx.<name> 取到
        try { (self.ctx as unknown as { provide?: (n: string, v: unknown) => void }).provide?.(name, impl) } catch { /* ignore */ }
        const dispose = () => { self.services.delete(name) }
        self.disposers.push(dispose)
        return dispose
      },

      inject<T>(name: string): T | undefined {
        return (self.services.get(name) as T | undefined)
      },

      effect(setup: () => Disposer | void): Disposer {
        const d = setup()
        const dispose = typeof d === 'function' ? d : () => {}
        self.disposers.push(dispose)
        return dispose
      },
    }
  }

  /** 唯一的命令执行入口；path-guard 下默认拒绝（fail-closed） */
  async exec(spec: ExecSpec): Promise<ExecResult> {
    const level = this.isolation.enforced
    if ((level === 'path-guard' || level === 'none') && this.opts.unconfined !== true) {
      throw new Error(
        `E_SANDBOX_UNAVAILABLE: current isolation is "${level}". ` +
        `Refusing to execute (fail-closed). Re-run with --allow-unconfined if you accept the risk.`,
      )
    }

    const started = Date.now()
    const timeoutMs = spec.timeoutMs ?? 60_000
    const [cmd, ...args] = spec.argv

    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd as string, args, {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let truncated = false
      const LIMIT = 256 * 1024
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)

      child.stdout.on('data', (b: Buffer) => {
        if (stdout.length > LIMIT) { truncated = true; return }
        stdout += b.toString('utf8')
      })
      child.stderr.on('data', (b: Buffer) => {
        if (stderr.length > LIMIT) { truncated = true; return }
        stderr += b.toString('utf8')
      })
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({
          exitCode: code ?? -1,
          stdout, stderr, truncated,
          durationMs: Date.now() - started,
          isolation: level,
        })
      })
    })
  }

  /** 调用已注册的工具（供 CLI / 后续 agent loop 使用） */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }> {
    const tool = this.toolRegistry.get(name)
    if (!tool) throw new Error(`tool not found: ${name}`)
    return await tool.handler(args)
  }

  /** 逆序释放所有注册（D3：可逆注册） */
  dispose(): void {
    for (const d of [...this.disposers].reverse()) {
      try { d() } catch { /* keep disposing */ }
    }
    this.disposers.length = 0
  }
}
