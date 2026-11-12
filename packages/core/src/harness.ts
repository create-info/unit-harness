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
import { EventStore } from './evidence/store.ts'
import type { SessionEvent, SessionMeta } from './evidence/store.ts'
import type { EventSource, SessionKind } from './evidence/kinds.ts'
import { createHash } from 'node:crypto'
import { buildLandlockArgv, findLandlockHelper } from './sandbox/landlock.ts'
import type { LandlockHelper } from './sandbox/landlock.ts'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
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
  /** 可写工作区；默认 ~/.uh/work */
  workspace?: string
  /** 允许沙箱内读 home（默认 false：home 里有 .ssh/.aws 等） */
  allowHome?: boolean
  /** 禁止沙箱内 TCP 连接（landlock ABI >= 4） */
  denyNetwork?: boolean
  /** 是否把事实写进会话日志（doctor 之类的只读命令设为 false） */
  record?: boolean
  /** 会话标签，便于 `uh session list` 辨认 */
  label?: string
  /** CLI 注入的版本号，写进 session/start */
  harnessVersion?: string
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
  private readonly helper: LandlockHelper | null
  private readonly workspace: string
  private readonly store: EventStore
  private session: SessionMeta | null = null

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts
    this.level = opts.logLevel ?? 'info'
    this.ctx = new Context()
    this.isolation = probeIsolation()
    this.helper = findLandlockHelper()
    this.workspace = opts.workspace ?? os.homedir() + '/.uh/work'
    try { mkdirSync(this.workspace, { recursive: true }) } catch { /* best effort */ }
    this.store = new EventStore()
  }

  /** 当前会话 id（未开启记录时为 null） */
  get sessionId(): string | null {
    return this.session?.id ?? null
  }

  /** 供 CLI 读取历史会话 */
  get events(): EventStore {
    return this.store
  }

  private ev(
    kind: SessionKind,
    payload: Record<string, unknown>,
    source: EventSource = 'agent',
    parentId: string | null = null,
  ): SessionEvent | null {
    if (!this.session) return null
    try {
      return this.store.append(this.session.id, kind, payload, { source, parentId })
    } catch (err) {
      this.log('warn', `event append failed (${kind}): ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /** 记录一条验证断言结果（“验证即断言”，见 docs/event-model.md §4.2） */
  recordVerification(
    assertion: Record<string, unknown>,
    result: 'pass' | 'fail' | 'error' | 'skipped',
    detail?: unknown,
  ): void {
    this.ev('verification/asserted', { assertion, result, detail: detail ?? null }, 'environment')
  }

  /** 当前生效的隔离方式说明，供 UI/日志展示 */
  describeEnforcement(): string {
    if (this.helper) {
      return `landlock-v${this.helper.abi} via ${this.helper.path}; writes limited to ${this.workspace}` +
        (this.opts.allowHome ? ' (+home readable)' : '; home unreadable') +
        (this.opts.denyNetwork ? '; tcp blocked' : '')
    }
    return this.isolation.enforced
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

  /** 扫描插件目录并 apply；record=true 时开启会话日志 */
  async start(): Promise<LoadedPlugin[]> {
    if (this.opts.record !== false) {
      this.session = this.store.create({
        workspace: this.workspace,
        harnessVersion: this.opts.harnessVersion ?? '0.0.0',
        ...(this.opts.label ? { label: this.opts.label } : {}),
      })
      this.ev('session/start', {
        workspace: this.workspace,
        harness_version: this.opts.harnessVersion ?? '0.0.0',
        isolation: this.isolation.enforced,
        available: this.isolation.available,
        platform: process.platform,
        arch: process.arch,
      }, 'environment')
    }

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
    const callEv = this.ev('tool/call', {
      tool: 'exec',
      argv: spec.argv,
      cwd: spec.cwd ?? this.workspace,
      timeout_ms: timeoutMs,
    }, 'agent')

    // 默认在工作区执行：工作区是唯一可写区域，cwd 必须与之一致
    const workdir = spec.cwd ?? this.workspace

    // 有 helper 就整条命令经 landlock 施加后再 exec
    const useLandlock = this.helper !== null && spec.isolation !== 'none'
    const cmd = useLandlock ? this.helper!.path : (spec.argv[0] as string)
    const args = useLandlock
      ? buildLandlockArgv(this.helper!, {
          argv: [...spec.argv],
          workspace: workdir,
          allowHome: this.opts.allowHome,
          denyNetwork: this.opts.denyNetwork,
        })
      : spec.argv.slice(1)

    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: workdir,
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
        const digest = createHash('sha256').update(stdout + stderr).digest('hex').slice(0, 16)
        this.ev('tool/result', {
          tool: 'exec',
          status: code === 0 ? 'ok' : 'error',
          exit_code: code ?? -1,
          isolation: this.helper ? `landlock-v${this.helper.abi}` : level,
          duration_ms: Date.now() - started,
          output_digest: digest,
          truncated,
        }, 'environment', callEv?.id ?? null)
        resolve({
          exitCode: code ?? -1,
          stdout, stderr, truncated,
          durationMs: Date.now() - started,
          isolation: this.helper ? (`landlock-v${this.helper.abi}` as IsolationLevel) : level,
        })
      })
    })
  }

  /** 调用已注册的工具（供 CLI / 后续 agent loop 使用） */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }> {
    const tool = this.toolRegistry.get(name)
    if (!tool) throw new Error(`tool not found: ${name}`)

    const callEv = this.ev('tool/call', { tool: name, args }, 'agent')
    const started = Date.now()
    try {
      const res = await tool.handler(args)
      const digest = createHash('sha256').update(res.content).digest('hex').slice(0, 16)
      this.ev('tool/result', {
        tool: name,
        status: 'ok',
        duration_ms: Date.now() - started,
        output_digest: digest,
        isolation: this.isolation.enforced,
      }, 'environment', callEv?.id ?? null)
      return res
    } catch (err) {
      this.ev('tool/result', {
        tool: name,
        status: 'error',
        duration_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        isolation: this.isolation.enforced,
      }, 'environment', callEv?.id ?? null)
      throw err
    }
  }

  /** 逆序释放所有注册（D3：可逆注册） */
  dispose(reason = 'disposed'): void {
    if (this.session) {
      try { this.store.end(this.session.id, reason) } catch { /* already closed */ }
      this.session = null
    }
    for (const d of [...this.disposers].reverse()) {
      try { d() } catch { /* keep disposing */ }
    }
    this.disposers.length = 0
  }
}
