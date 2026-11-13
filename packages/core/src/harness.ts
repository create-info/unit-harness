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
import { LlmGateway } from './llm/gateway.ts'
import { resolveProvider } from './llm/resolve.ts'
import { runAgent } from './agent/loop.ts'
import type { AgentDeps } from './agent/loop.ts'
import { snapshotDir, diffSnapshots, collectArtifacts, sha256File } from './artifact/snapshot.ts'
import type { Artifact } from './artifact/snapshot.ts'
import { inferAssertions, runAssertion } from './verify/assertions.ts'
import type { AssertionOutcome } from './verify/assertions.ts'
import fsSync from 'node:fs'
import { workspaceDir } from './paths.ts'
import nodePath from 'node:path'
import { buildSystemPrompt } from './agent/prompt.ts'
import type { RunResult } from './agent/loop.ts'
import type { SessionEvent, SessionMeta } from './evidence/store.ts'
import type { EventSource, SessionKind } from './evidence/kinds.ts'
import { createHash } from 'node:crypto'
import { buildLandlockArgv, findLandlockHelper } from './sandbox/landlock.ts'
import type { LandlockHelper } from './sandbox/landlock.ts'
import { buildSeatbeltProfile, findSeatbelt } from './sandbox/seatbelt.ts'
import { toolchainPaths, executableRoots, shellInnerPrograms } from './sandbox/toolchains.ts'
import { McpRegistry } from './mcp/bridge.ts'
import { loadMcpServers } from './mcp/config.ts'
import { makeEdit, toPayload, readMaybeFile as readMaybe } from './checkpoint/store.ts'
import { loadHooks, matches, hookName } from './hook/hooks.ts'
import type { HookConfig, HookDef, HookEvent, HookOutcome } from './hook/hooks.ts'
import { allowAll, denyAll, needsApproval } from './approval/gate.ts'
import type { ApprovalDecision, ApprovalGate, ApprovalPolicy, ApprovalRequest } from './approval/gate.ts'
import { uhHome } from './paths.ts'
import type { Message, ImageInput } from './llm/types.ts'
import { discoverSkills, renderSkillIndex } from './skill/registry.ts'
import { sliceLines, formatEntry, formatHits, looksBinary } from './agent/tools/fs.ts'
import { loadHosts } from './remote/hosts.ts'
import { runRemote } from './remote/ssh.ts'
import { classify } from './remote/risk.ts'
import type { Skill } from './skill/registry.ts'
import type { SeatbeltInfo } from './sandbox/seatbelt.ts'
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
  /** 审批策略：ask 逐次问（默认），allow 全放行，deny 一律拒 */
  approval?: ApprovalPolicy
  /** 自定义审批门（覆盖 approval 策略，用于 UI / API 场景） */
  gate?: ApprovalGate
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
  /** 事件回调，CLI 用来实时打印进度 */
  onEvent?: (kind: string, payload: Record<string, unknown>) => void
  /** 允许远端写操作（默认 false：只读才放行） */
  allowRemoteWrite?: boolean
  /** 允许远端毁灭性命令（默认 false） */
  allowRemoteDestructive?: boolean
  /** 远端命令超时（默认 60s） */
  remoteTimeoutMs?: number
  /** 流式：模型正文增量 */
  onText?: (delta: string) => void
  /** 流式：推理模型思考增量 */
  onReasoning?: (delta: string) => void
}

export interface RunTaskOptions {
  task: string
  provider?: string
  model?: string
  baseUrl?: string
  apiKey?: string
  maxSteps?: number
  maxSeconds?: number
  /** 结束时对工作区变更做自动验证（默认 true） */
  verify?: boolean
  /** 是否给模型 update_plan 工具（默认 true） */
  plan?: boolean
  /** 上下文窗口预算（默认 32000；到 70% 自动压缩，0 关闭） */
  maxContextTokens?: number
  /** 是否启动 MCP server（默认 true） */
  mcp?: boolean
  /** 是否加载 skills（默认 true） */
  skills?: boolean
  /** 是否用流式（默认 true；管道/CI 里也无害，画面不抖只是更快） */
  stream?: boolean
  /** 续跑：上一次会话的消息 */
  resumeFrom?: Message[]
  /** 附在第一轮用户消息上的图片 */
  images?: ImageInput[]
}

export interface RunTaskOutcome extends RunResult {
  artifacts: Artifact[]
  verifications: Array<AssertionOutcome & { path: string }>
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
  private readonly seatbelt: SeatbeltInfo
  /** MCP server 桥接（外部进程，不在沙箱内） */
  readonly mcp = new McpRegistry()

  /** 子 agent 深度限制：再深只是把上下文切碎，没有收益 */
  private readonly maxSubAgentDepth = 2
  /** 一次 run 里最多起几个子 agent（深度不封口宽度，成本要封） */
  private readonly maxSubAgentTotal = 8
  private subAgentCount = 0

  /** 中断：Ctrl+C 走这里，而不是直接杀进程 */
  private readonly abortCtl = new AbortController()
  /** 用户在工作期间插的话，等下一个 step 边界交给模型 */
  private readonly steerQueue: string[] = []

  /** hooks 配置：每次 run 前重新读，改配置不用重启 */
  private hooks: HookConfig = {}

  /**
   * 执行某个挂点的 hook。返回**被挡下**的那些。
   *
   * hook 走 exec（沙箱内、有隔离记录），但它不是模型发起的，所以 source 是 internal：
   * 审批门不该因为一条用户自己配的检查脚本来问用户。
   */
  private async runHooks(event: HookEvent, ctx: { tool?: string; command?: string }): Promise<HookOutcome[]> {
    const defs = this.hooks[event] ?? []
    if (defs.length === 0) return []
    const shell = process.platform === 'win32' ? ['cmd', '/c'] : ['sh', '-c']
    const blocked: HookOutcome[] = []

    for (let i = 0; i < defs.length; i++) {
      const def = defs[i] as HookDef
      if (!matches(def, ctx.tool, ctx.command)) continue
      const name = hookName(event, def, i)
      let exitCode = 0
      let output = ''
      try {
        const r = await this.exec({
          argv: [shell[0] as string, ...shell.slice(1), def.run],
          timeoutMs: def.timeout_ms ?? 60_000,
          source: 'internal',
          env: {
            ...(ctx.tool ? { UH_TOOL: ctx.tool } : {}),
            UH_EVENT: event,
            ...(ctx.command ? { UH_COMMAND: ctx.command.slice(0, 2000) } : {}),
          },
        })
        exitCode = r.exitCode
        output = (r.stderr || r.stdout || '').trim()
      } catch (err) {
        exitCode = 1
        output = err instanceof Error ? err.message : String(err)
      }
      const decision = exitCode === 0 ? 'allow' : 'block'
      this.ev('hook/execution', { hook_name: name, event, decision, exit_code: exitCode }, 'hook')
      if (decision === 'block') blocked.push({ name, event, decision, exitCode, output })
    }
    return blocked
  }

  /**
   * 记一条可回滚的改写。
   *
   * 不落盘到别处——它本身就是事件。这既是 checkpoint（能反向应用），
   * 也是审计（能看到这一步改了哪个文件的哪一行）。
   */
  private recordEdit(rel: string, before: Buffer | null, after: Buffer | null): void {
    const edit = makeEdit(rel.replace(/^\.\//, ''), before, after)
    // 大正文外置：事件行要能一眼看完，日志不该被一个文件原文糊住
    const dir = this.session ? this.store.sessionDir(this.session.id) : null
    this.ev('checkpoint/file', toPayload(edit, dir), 'agent')
  }

  /** 审批门：显式 gate 优先，否则按策略挑 */
  private approvalGate(): ApprovalGate {
    if (this.opts.gate) return this.opts.gate
    return this.opts.approval === 'allow' ? allowAll : denyAll
  }

  /** 请求中断（可重入：已中断时无副作用） */
  /**
   * 运行中追加指令。
   *
   * 不打断正在跑的步骤：排队，到下一个 step 边界才交给模型。这样已经发出的
   * 工具调用能正常收尾（事件日志不会停在「调用了但没结果」），而人看到走偏时
   * 仍然能立刻说一句，不用等它跑完再重来。
   */
  steer(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    this.steerQueue.push(t)
    this.ev('steering/message', { text: t.slice(0, 200), status: 'queued' })
    return true
  }

  abort(): void {
    if (!this.abortCtl.signal.aborted) this.abortCtl.abort()
  }

  get aborted(): boolean {
    return this.abortCtl.signal.aborted
  }
  /** 工作区绝对路径（外部模块如剧本检查要读它） */
  readonly workspace: string
  private readonly store: EventStore
  private session: SessionMeta | null = null

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts
    this.level = opts.logLevel ?? 'info'
    this.ctx = new Context()
    this.isolation = probeIsolation()
    this.helper = findLandlockHelper()
    this.seatbelt = findSeatbelt()
    // 必须走 paths.ts，否则 UH_HOME 只影响事件存储、不影响工作区，测试隔离会失效
    this.workspace = opts.workspace ?? workspaceDir()
    try { mkdirSync(this.workspace, { recursive: true }) } catch { /* best effort */ }
    this.store = new EventStore()
  }

  /** 可写工作区根目录 */
  get workspaceDir(): string {
    return this.workspace
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
    this.opts.onEvent?.(kind, payload)
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
    if (this.seatbelt.available) {
      return `seatbelt via ${this.seatbelt.path}; writes limited to ${this.workspace}` +
        (this.opts.allowHome ? ' (+home readable)' : '; home unreadable') +
        (this.opts.denyNetwork ? '; network blocked' : '')
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
        run: (argv, opts) => self.exec({ ...opts, argv, signal: self.abortCtl.signal }),
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
    const workdir0 = spec.cwd ?? this.workspace

    // 先记 tool/call：即使随后被拒绝，"有人试图执行"也必须留痕（审计完整性）
    const attempted = this.ev('tool/call', {
      tool: 'exec',
      argv: spec.argv,
      cwd: workdir0,
    }, 'agent')

    // ---- 审批门：模型发起的危险动作在人点头之前不执行 ----
    if (spec.source === 'model') {
      const cmdline = spec.argv.join(' ')
      const risk = classify(cmdline)
      const verdict = needsApproval(risk, {
        // path-guard / none 时沙箱其实没在管写入
        isolationEnforced: level !== 'path-guard' && level !== 'none',
        kind: 'exec',
      })
      if (verdict.needed) {
        const req: ApprovalRequest = {
          kind: 'exec',
          risk,
          reason: verdict.reason,
          summary: cmdline.length > 160 ? `${cmdline.slice(0, 157)}...` : cmdline,
          detail: cmdline,
        }
        // approval/requested 的含义是「问过人了」。--yes 并不问人，只是自动批准，
        // 记一条 requested 会让审计日志撒谎
        let decision: ApprovalDecision = 'allow'
        if (this.opts.approval === 'allow') {
          this.ev('approval/resolved', { kind: 'exec', risk, decision: 'allow', auto: true }, 'user')
        } else {
          const requested = this.ev('approval/requested', { ...req }, 'agent')
          decision = await this.approvalGate().request(req)
          this.ev('approval/resolved', { kind: 'exec', risk, decision }, 'user', requested?.id ?? null)
        }
        if (decision === 'deny') {
          this.ev('tool/result', {
            tool: 'exec',
            status: 'refused',
            isolation: level,
            refused: true,
            denied_by: 'approval',
          }, 'user', attempted?.id ?? null)
          throw new Error(
            `E_APPROVAL_DENIED: ${verdict.reason}. The command was not run. ` +
            `Tell the user what it does and why it is needed; do not retry it silently.`,
          )
        }
      }
    }

    if ((level === 'path-guard' || level === 'none') && this.opts.unconfined !== true) {
      this.ev('tool/result', {
        tool: 'exec',
        status: 'error',
        isolation: level,
        error: 'E_SANDBOX_UNAVAILABLE',
        refused: true,
      }, 'environment', attempted?.id ?? null)
      throw new Error(
        `E_SANDBOX_UNAVAILABLE: current isolation is "${level}". ` +
        `Refusing to execute (fail-closed). Re-run with --allow-unconfined if you accept the risk.`,
      )
    }

    const started = Date.now()
    const timeoutMs = spec.timeoutMs ?? 60_000
    const callEv = attempted

    // 默认在工作区执行：工作区是唯一可写区域，cwd 必须与之一致
    const workdir = spec.cwd ?? this.workspace

    // 按平台选择施加方式：Linux = landlock helper，macOS = sandbox-exec
    const useLandlock = this.helper !== null && spec.isolation !== 'none'
    const useSeatbelt = !useLandlock && this.seatbelt.available && spec.isolation !== 'none'

    let cmd: string
    let args: string[]
    if (useLandlock) {
      cmd = this.helper!.path
      args = buildLandlockArgv(this.helper!, {
        argv: [...spec.argv],
        workspace: workdir,
        allowHome: this.opts.allowHome,
        denyNetwork: this.opts.denyNetwork,
        // 只读放行解释器/包管理器目录：否则 venv、nvm 在沙箱里全部失效
        extraReadOnly: [
          ...toolchainPaths().readOnly,
          ...this.sandboxRoots(spec.argv, workdir),
        ],
      })
    } else if (useSeatbelt) {
      const profile = buildSeatbeltProfile({
        workspace: workdir,
        allowHome: this.opts.allowHome,
        denyNetwork: this.opts.denyNetwork,
        extraReadOnly: [
          ...toolchainPaths().readOnly,
          ...this.sandboxRoots(spec.argv, workdir),
        ],
      })
      cmd = this.seatbelt.path
      args = ['-p', profile, '--', ...spec.argv]
    } else {
      cmd = spec.argv[0] as string
      args = spec.argv.slice(1)
    }

    return await new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: workdir,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // 中断要能打断正在跑的命令，否则用户按了 Ctrl+C 还得等它跑完
      const onAbort = (): void => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
      if (spec.signal) {
        if (spec.signal.aborted) onAbort()
        else spec.signal.addEventListener('abort', onAbort, { once: true })
      }

      let truncated = false
      const LIMIT = 256 * 1024
      const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)

      // 保留**头和尾**：超过上限后继续滑动保留最后一段。
      // 只留头会把错误信息（通常在结尾）丢掉，模型于是对着一堆进度日志发呆。
      const makeCollector = () => {
        let head = ''
        let tail = ''
        let over = false
        return {
          push(chunk: string): void {
            if (!over) {
              head += chunk
              if (head.length > LIMIT) {
                over = true
                tail = head.slice(-LIMIT)
                head = head.slice(0, LIMIT)
              }
            } else {
              tail = (tail + chunk).slice(-LIMIT)
            }
          },
          value(): string {
            if (!over) return head
            truncated = true
            return `${head}\n\n… [output too long; middle dropped] …\n\n${tail}`
          },
        }
      }
      const outC = makeCollector()
      const errC = makeCollector()

      child.stdout.on('data', (b: Buffer) => outC.push(b.toString('utf8')))
      child.stderr.on('data', (b: Buffer) => errC.push(b.toString('utf8')))
      child.on('error', (e) => { clearTimeout(timer); reject(e) })
      child.on('close', (code) => {
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        const stdout = outC.value()
        const stderr = errC.value()
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
          isolation: this.helper
            ? (`landlock-v${this.helper.abi}` as IsolationLevel)
            : (useSeatbelt ? 'seatbelt' : level),
        })
      })
    })
  }

  /** 当前工作目录下可用的 skills（只读，供 CLI/UI 展示） */
  get skills(): Skill[] {
    return discoverSkills(process.cwd())
  }

  /** 已注册工具列表（只读）：插件工具 + MCP 桥接工具 */
  get tools(): ReadonlyArray<ToolDefinition> {
    const base = [...this.toolRegistry.values()]
    const mcpTools = this.mcp.tools.map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.schema as unknown as ToolDefinition['schema'],
      handler: async (args: Record<string, unknown>) => this.callTool(t.name, args),
    }))
    const hosts = loadHosts().hosts
    const remoteTools: ToolDefinition[] = Object.keys(hosts).length === 0 ? [] : [{
      name: 'remote_exec',
      description:
        'Run a command on a configured remote host (e.g. a server you deploy to). ' +
        'Read-only commands run directly; anything that modifies the host is refused unless ' +
        'the user allowed it for this run. This does NOT run in the local sandbox — it runs ' +
        `on the remote machine. Hosts: ${Object.keys(hosts).join(', ')}`,
      schema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'host name from hosts.json' },
          command: { type: 'string', description: 'shell command to run on the remote host' },
        },
        required: ['host', 'command'],
      } as unknown as ToolDefinition['schema'],
      handler: async (args: Record<string, unknown>) =>
        this.callTool('remote_exec', args),
    }]

    return [...base, ...mcpTools, ...remoteTools]
  }

  /**
   * 跑一次 agent 任务：模型在沙箱护甲里自主决定步骤，每步落事件。
   * 这是 harness 唯一"对外的主入口"。
   */
  async runTask(o: RunTaskOptions): Promise<RunTaskOutcome> {
    const provider = await resolveProvider({
      ...(o.provider ? { provider: o.provider } : {}),
      ...(o.model ? { model: o.model } : {}),
      ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
      ...(o.apiKey ? { apiKey: o.apiKey } : {}),
    })

    const gateway = new LlmGateway({
      primary: provider,
      emit: (kind, payload, parentId) => this.ev(kind, payload, 'agent', parentId ?? null)?.id ?? null,
    })

    const skills: Skill[] = o.skills === false ? [] : discoverSkills(process.cwd())
    const sys = buildSystemPrompt({
      workspace: this.workspace,
      isolation: this.isolation.enforced,
      networkBlocked: this.opts.denyNetwork === true,
      planEnabled: o.plan !== false,
      skillIndex: renderSkillIndex(skills),
      tools: this.tools.map((t) => ({ name: t.name, description: t.description })),
    })

    // system 提示不写进事件（体积大且含环境细节），只记摘要
    this.log('info', `provider: ${provider.def.id} (${provider.def.protocol}) model=${provider.model} — ${provider.source}`)

    // MCP：外部 server，按配置启动；单个失败不影响本次运行
    if (o.mcp !== false && this.mcp.isEmpty) {
      const loaded = loadMcpServers()
      if (Object.keys(loaded.servers).length > 0) {
        await this.mcp.start(loaded.servers)
        for (const st of this.mcp.status) {
          this.log(st.error ? 'warn' : 'info',
            st.error ? `mcp ${st.name}: ${st.error}` : `mcp ${st.name}: ${st.tools} tool(s) via ${st.transport}`)
        }
        this.ev('tool/result', {
          tool: 'mcp/connect',
          status: this.mcp.status.some((x) => x.error) ? 'error' : 'ok',
          isolation: 'none',
          external: true,
          servers: this.mcp.status,
        }, 'environment')
      }
    }

    const before = o.verify === false ? null : snapshotDir(this.workspace)

    // 每次 run 重新读配置：改了 hooks.json 不用重启
    this.hooks = loadHooks(this.workspace)

    const makeSpawnerSelf = this
    function makeSpawner(level: number) {
        return async (subTask: string, subOpts: { maxSteps?: number }): Promise<string> => {
        if (level > makeSpawnerSelf.maxSubAgentDepth) {
          throw new Error(`E_AGENT_DEPTH: already ${level - 1} levels deep, refusing to go further`)
        }
        // 深度有界 ≠ 成本有界：每个子 agent 跑满 maxSteps、每步再派一个，
        // 深度 2 也能派出几十个。给整个 run 一个总数上限。
        if (makeSpawnerSelf.subAgentCount >= makeSpawnerSelf.maxSubAgentTotal) {
          throw new Error(
            `E_AGENT_BUDGET: this run already started ${makeSpawnerSelf.subAgentCount} sub-agents ` +
            `(limit ${makeSpawnerSelf.maxSubAgentTotal}). Do the remaining work yourself.`,
          )
        }
        const id = `sub${++makeSpawnerSelf.subAgentCount}`
        const startedAt = Date.now()
        const spawned = makeSpawnerSelf.ev('agent/spawned', { agent: id, task: subTask.slice(0, 200), level }, 'agent')
        const subDeps: AgentDeps = { ...depsRef, spawnSubAgent: makeSpawner(level + 1) }
        try {
          const sub = await runAgent(subDeps, {
            task: subTask,
            maxSteps: subOpts.maxSteps ?? 6,
            signal: makeSpawnerSelf.abortCtl.signal,
          })
          makeSpawnerSelf.ev('agent/finished', {
            agent: id,
            steps: sub.steps,
            tokens: sub.usage.total,
            duration_ms: Date.now() - startedAt,
            stopped_by: sub.stoppedBy,
          }, 'agent', spawned?.id ?? null)
          return `[sub-agent ${id} finished after ${sub.steps} steps]\n${sub.text || '(no text)'}`
        } catch (err) {
          makeSpawnerSelf.ev('agent/finished', {
            agent: id,
            error: err instanceof Error ? err.message.slice(0, 200) : String(err),
            duration_ms: Date.now() - startedAt,
          }, 'agent', spawned?.id ?? null)
          throw err
        }
          }
    }


    // 子 agent 的闭包要引用「同一个 deps 对象」，而它正在被构造
    let depsRef: AgentDeps
    const agentDeps: AgentDeps = {
        workspace: this.workspace,
        system: sys,
        // 每步边界取走积压的插话。放在 step 而不是工具执行中间：半路改消息
        // 会让正在进行的工具调用上下文对不上，日志也读不懂
        drainSteer: () => this.steerQueue.splice(0),
        gateway,
        tools: this.tools,
        runCommand: async (a) => {
          if (!Array.isArray(a.argv) || a.argv.length === 0 || a.argv.some((x) => typeof x !== 'string')) {
            throw new Error('run_command expects argv: string[] with at least one element')
          }
          const r = await this.exec({
            argv: [a.argv[0] as string, ...a.argv.slice(1)],
            ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}),
            signal: this.abortCtl.signal,
            source: 'model',
          })
          const body = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')
          return { content: `exit=${r.exitCode} isolation=${r.isolation}\n${body}`.trim() }
        },
        callTool: (name, args) => this.callTool(name, args),
        readFile: (rel) => {
          try {
            return fsSync.readFileSync(this.safeJoin(rel), 'utf8')
          } catch {
            return null
          }
        },
        readSlice: (rel, offset, limit) => {
          try {
            const buf = fsSync.readFileSync(this.safeJoin(rel))
            if (looksBinary(buf)) return null
            return sliceLines(buf.toString('utf8'), offset, limit)
          } catch { return null }
        },
        listTree: (rel, depth) => {
          try {
            const root = this.safeJoin(rel)
            if (!fsSync.statSync(root).isDirectory()) return null
            const lines: string[] = []
            const walk = (dir: string, level: number): void => {
              if (level > depth) return
              const entries = fsSync.readdirSync(dir, { withFileTypes: true })
                .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
                .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
              for (const e of entries) {
                const abs = nodePath.join(dir, e.name)
                if (e.isDirectory()) {
                  lines.push(formatEntry(e.name, true, 0, level - 1))
                  if (level < depth) walk(abs, level + 1)
                } else {
                  let bytes = 0
                  try { bytes = fsSync.statSync(abs).size } catch { /* raced with the agent's own write */ }
                  lines.push(formatEntry(e.name, false, bytes, level - 1))
                }
              }
            }
            walk(root, 1)
            return lines.length ? lines.join('\n') : '(empty directory)'
          } catch { return null }
        },
        grep: (rel, pattern, opts) => {
          try {
            const root = this.safeJoin(rel)
            let re: RegExp
            try { re = new RegExp(pattern, 'i') } catch { return null }
            const nameRe = opts.glob
              ? new RegExp('^' + opts.glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
              : undefined
            const hits: { path: string; line: number; text: string }[] = []
            let scanned = 0

            const walk = (abs: string): boolean => {
              let st: fsSync.Stats
              try { st = fsSync.statSync(abs) } catch { return false }
              if (st.isDirectory()) {
                const base = nodePath.basename(abs)
                if (base === 'node_modules' || base === '.git' || base === '.uh' || base === 'dist') return false
                for (const e of fsSync.readdirSync(abs)) {
                  if (walk(nodePath.join(abs, e))) return true
                }
                return false
              }
              if (st.size > 2_000_000) return false
              if (nameRe && !nameRe.test(nodePath.basename(abs))) return false
              let buf: Buffer
              try { buf = fsSync.readFileSync(abs) } catch { return false }
              if (looksBinary(buf)) return false
              scanned++
              const relPath = nodePath.relative(this.workspace, abs)
              const lines = buf.toString('utf8').split('\n')
              for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i] as string)) {
                  hits.push({ path: relPath, line: i + 1, text: lines[i] as string })
                  if (hits.length >= opts.max) return true
                }
              }
              return false
            }
            walk(root)
            return { text: formatHits(hits, { pattern, max: opts.max, filesScanned: scanned }), count: hits.length }
          } catch { return null }
        },
        writeFile: (rel, content) => {
          const abs = this.safeJoin(rel)
          const before = readMaybe(abs)
          fsSync.mkdirSync(nodePath.dirname(abs), { recursive: true })
          fsSync.writeFileSync(abs, content)
          this.recordEdit(rel, before, Buffer.from(content, 'utf8'))
        },
        deleteFile: (rel) => {
          const abs = this.safeJoin(rel)
          const before = readMaybe(abs)
          try { fsSync.unlinkSync(abs) } catch { /* already gone */ }
          if (before) this.recordEdit(rel, before, null)
        },
        /**
         * 子 agent：同一套执行环境，一段新对话。
         *
         * 深度用**闭包**带下去，不用共享计数器：计数器在多路并行时会互相覆盖，
         * 实测能把限制放穿到三层（1+6+36 次派活）。参数化闭包没有这个漏洞。
         */
        spawnSubAgent: makeSpawner(1),
        runHooks: (event, ctx) => this.runHooks(event, ctx),
        planEnabled: o.plan !== false,
        skills,
        ...(o.stream !== false ? {
          onText: (d: string) => { this.opts.onText?.(d) },
          onReasoning: (d: string) => { this.opts.onReasoning?.(d) },
        } : {}),
        maxContextTokens: o.maxContextTokens ?? Number(process.env.UH_MAX_CONTEXT ?? 32000),
        ev: (kind, payload) => this.ev(kind, payload, 'agent')?.id ?? null,
        log: (m) => this.log('info', m),
    }
    depsRef = agentDeps

    const result = await runAgent(
      agentDeps,
      {
        task: o.task,
        ...(o.maxSteps ? { maxSteps: o.maxSteps } : {}),
        ...(o.maxSeconds ? { maxSeconds: o.maxSeconds } : {}),
        signal: this.abortCtl.signal,
        ...(o.resumeFrom ? { initialMessages: o.resumeFrom } : {}),
        ...(o.images?.length ? { images: o.images } : {}),
      },
    )

    // 落盘对话状态：这是 --continue 的唯一依据。
    // 只写最后一个会话就够了，但每次覆盖写，保证「最后的状态」永远是最新的。
    if (this.session) {
      try {
        // 会话目录按 YYYY/MM/DD 分层了，让 store 告诉我们它在哪
        const sdir = this.store.sessionDir(this.session.id)
        const statePath = nodePath.join(sdir ?? nodePath.join(uhHome(), 'sessions', this.session.id), 'state.json')
        fsSync.writeFileSync(statePath, JSON.stringify({
          session_id: this.session.id,
          updated_at: new Date().toISOString(),
          stopped_by: result.stoppedBy,
          plan: result.plan ?? [],
          // base64 不落盘：一份带截图的会话能让 state.json 涨到几十 MB，
          // 续跑时按 path 重新读就行
          messages: result.messages.map((m) => (m.images?.length
            ? { ...m, images: m.images.map((i) => ({ path: i.path, mediaType: i.mediaType, data: '' })) }
            : m)),
        }), 'utf8')
      } catch { /* 状态落盘失败不该让整次运行失败 */ }
    }

    // 中断不是失败：把「被谁停下的」写清楚，下次 --continue 才知道从哪接
    if (result.stoppedBy === 'interrupted') {
      this.ev('session/interrupted', {
        steps: result.steps,
        had_plan: (result.plan ?? []).length > 0,
        workspace: this.workspace,
      }, 'agent')
      this.log('warn', 'run interrupted by signal')
    }

    // ---- 交付物闭环：改了什么 → 登记 → 断言 → 事件 ----
    const artifacts: Artifact[] = []
    const verifications: Array<AssertionOutcome & { path: string }> = []

    if (before) {
      const after = snapshotDir(this.workspace)
      const changes = diffSnapshots(before, after)
      artifacts.push(...collectArtifacts(this.workspace, changes, after))

      if (changes.removed.length > 0) {
        this.ev('error', { message: 'files were removed during the run', files: changes.removed })
      }

      for (const art of artifacts) {
        this.ev('artifact/emitted', {
          path: art.path,
          sha256: art.sha256,
          bytes: art.bytes,
          kind: nodePath.extname(art.path).replace('.', '') || 'file',
        })

        const deps = {
          workspace: this.workspace,
          exec: async (argv: [string, ...string[]]) => {
            const r = await this.exec({ argv })
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
          },
          exists: (rel: string) => fsSync.existsSync(this.safeJoin(rel)),
          size: (rel: string) => {
            try { return fsSync.statSync(this.safeJoin(rel)).size } catch { return -1 }
          },
          sha256: (rel: string) => sha256File(this.safeJoin(rel)),
        }

        for (const a of inferAssertions(art)) {
          const out = await runAssertion(a, deps)
          this.recordVerification(a as unknown as Record<string, unknown>, out.result, out.detail)
          verifications.push({ path: art.path, ...out })
        }
      }
    }

    return { ...result, artifacts, verifications }
  }

  /** 沙箱内需要只读放行的目录：静态工具链 + 本次实际执行的程序所在树 */
  private sandboxRoots(argv: string[], workdir: string): string[] {
    const progs = [String(argv[0] ?? ''), ...shellInnerPrograms(argv)]
    const out: string[] = []
    for (const p of progs) {
      if (!p) continue
      out.push(...executableRoots(p, workdir))
    }
    return [...new Set(out)]
  }

  /** 把相对路径限制在工作区内（挡住 ../ 逃逸） */
  private safeJoin(rel: string): string {
    const abs = nodePath.resolve(this.workspace, rel)
    if (!abs.startsWith(nodePath.resolve(this.workspace))) {
      throw new Error(`E_PATH_ESCAPE: ${rel}`)
    }
    return abs
  }

  /**
   * 远端执行。
   *
   * 三条硬约束：
   *  1. **不经过本地沙箱**（SSH 要读私钥，而沙箱故意禁读 ~/.ssh）——所以隔离如实记 'none'
   *     并加 scope:'remote'，绝不冒充成 landlock。
   *  2. **默认只读**：写操作要这次运行显式授权，destructive 永远先拦。
   *  3. **每一次都留痕**，包括被拒绝的那次。
   */
  private async remoteExec(args: Record<string, unknown>): Promise<{ content: string }> {
    const hostName = String(args.host ?? '')
    const command = String(args.command ?? '')
    const hosts = loadHosts().hosts
    const host = hosts[hostName]

    if (!host) {
      throw new Error(`unknown host "${hostName}". Configured: ${Object.keys(hosts).join(', ') || '(none)'} — add one with \`uh host add\``)
    }
    if (!command.trim()) throw new Error('remote_exec: empty command')

    const risk = classify(command)
    const callEv = this.ev('tool/call', {
      tool: 'remote_exec', host: hostName, command, risk, scope: 'remote',
    }, 'agent')

    const allowed =
      risk === 'read' ||
      (risk === 'write' && this.opts.allowRemoteWrite === true) ||
      (risk === 'destructive' && this.opts.allowRemoteDestructive === true)

    if (!allowed) {
      const reason = risk === 'destructive'
        ? 'E_REMOTE_DESTRUCTIVE: refused (needs --allow-remote-destructive)'
        : 'E_REMOTE_WRITE: refused (needs --allow-remote-write)'
      this.ev('tool/result', {
        tool: 'remote_exec', host: hostName, status: 'error', refused: true,
        reason, risk, isolation: 'none', external: true, scope: 'remote',
      }, 'environment', callEv?.id ?? null)
      throw new Error(`${reason} — ran on ${hostName}: ${command.slice(0, 120)}`)
    }

    const started = Date.now()
    const r = await runRemote({ host, command, timeoutMs: this.opts.remoteTimeoutMs ?? 60_000 })
    const digest = createHash('sha256').update(r.stdout + r.stderr).digest('hex').slice(0, 16)

    this.ev('tool/result', {
      tool: 'remote_exec', host: hostName, status: r.exitCode === 0 ? 'ok' : 'error',
      exit_code: r.exitCode, stdout_digest: digest, risk,
      duration_ms: Date.now() - started, timed_out: r.timedOut,
      isolation: 'none', external: true, scope: 'remote',
    }, 'environment', callEv?.id ?? null)

    if (r.timedOut) throw new Error(`E_REMOTE_TIMEOUT: ${hostName} did not finish within ${this.opts.remoteTimeoutMs ?? 60_000}ms`)
    return { content: `${r.stdout}${r.stderr ? (r.stdout ? '\n' : '') + r.stderr : ''}` }
  }

  /** 调用已注册的工具（含 MCP 桥接工具） */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ content: string }> {
    if (name === 'remote_exec') return await this.remoteExec(args)

    const isMcp = this.mcp.has(name)
    const tool = this.toolRegistry.get(name)
    if (!tool && !isMcp) throw new Error(`tool not found: ${name}`)

    // MCP 调用发生在守护进程之外，隔离强度报 'none' —— 不能继承本地沙箱的假象
    const isolation = isMcp ? 'none' : this.isolation.enforced

    const callEv = this.ev('tool/call', {
      tool: name,
      args,
      ...(isMcp ? { external: true, transport: 'mcp' } : {}),
    }, 'agent')
    const started = Date.now()
    try {
      const res = isMcp ? await this.mcp.call(name, args) : await tool!.handler(args)
      const digest = createHash('sha256').update(res.content).digest('hex').slice(0, 16)
      this.ev('tool/result', {
        tool: name,
        status: 'ok',
        duration_ms: Date.now() - started,
        output_digest: digest,
        isolation,
        ...(isMcp ? { external: true } : {}),
      }, 'environment', callEv?.id ?? null)
      return res
    } catch (err) {
      this.ev('tool/result', {
        tool: name,
        status: 'error',
        duration_ms: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
        isolation,
        ...(isMcp ? { external: true } : {}),
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
    void this.mcp.close()
    for (const d of [...this.disposers].reverse()) {
      try { d() } catch { /* keep disposing */ }
    }
    this.disposers.length = 0
  }
}
