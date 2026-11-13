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
import { normalizeBudget, type BudgetConfig } from './agent/budget.ts'
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
import { findBwrap, buildBwrapArgv } from './sandbox/bwrap.ts'
import { buildSeatbeltProfile, findSeatbelt } from './sandbox/seatbelt.ts'
import { toolchainPaths, executableRoots, shellInnerPrograms } from './sandbox/toolchains.ts'
import { McpRegistry } from './mcp/bridge.ts'
import { loadMcpServers } from './mcp/config.ts'
import { isPluginEnabled } from './llm/config.ts'
import { makeEdit, toPayload, readMaybeFile as readMaybe } from './checkpoint/store.ts'
import { loadHooks, matches, hookName } from './hook/hooks.ts'
import type { HookConfig, HookDef, HookEvent, HookOutcome } from './hook/hooks.ts'
import { allowAll, denyAll, needsApproval } from './approval/gate.ts'
import { addRule, loadRules, matchesRule, suggestPrefix, type ApprovalRule } from './approval/rules.ts'
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

/**
 * 这条 stderr 是不是沙箱拒绝，而不是命令自己失败。
 *
 * 分不清的代价很大：把普通报错当沙箱拒绝，模型会一遍遍申请放宽；
 * 把沙箱拒绝当普通报错，模型只会换个写法重试然后放弃。所以只认
 * 各后端自己的固定方言（bwrap / landlock / seatbelt 各有各的说法）。
 */
export function isSandboxDenial(stderr: string): boolean {
  if (!stderr) return false
  const s = stderr.toLowerCase()
  return s.includes('read-only file system')
    || s.includes('permission denied')
    || s.includes('operation not permitted')
    || s.includes('权限不够')
    || s.includes('operation not allowed')
    || s.includes('eacces')
}

/** 查持久规则。只读不写——命中计数在 addRule 里做，查询不该有副作用 */
function findRule(argv: string[], cwd: string): ApprovalRule | null {
  try {
    return loadRules().find((r) => matchesRule(argv, cwd, r)) ?? null
  } catch {
    // 规则文件坏了不能挡住审批流程，退化成"每次都问"
    return null
  }
}

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
  /** 日志写 stderr 而不是 stdout。stdio 协议（ACP）必须打开这个 */
  logToStderr?: boolean
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
  /**
   * 成本预算（token）。到线就停，stoppedBy 会是 'budget'。
   * 与上下文预算（maxContextTokens）不是一回事：那个负责压缩历史，这个负责叫停。
   */
  budget?: { perRun?: number; perDay?: number; dayUsed?: number }
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
  /** 这一轮写过的文件，等轮末封成一条 checkpoint/created */
  private pendingEdits: string[] = []
  private readonly helper: LandlockHelper | null
  private readonly bwrap: { path: string } | null
  /** 本会话已批准的命令指纹（cwd + argv）。进程退出即失效，不落盘。 */
  private readonly approvedCommands = new Set<string>()
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
    // 攒着，等这一轮结束时发一条边界事件。
    // 一堆散落的 checkpoint/file 让人只能靠 turn 号去猜"哪些是同一批"；
    // 有明确的 created，回滚和审计都有边界可依
    if (!this.pendingEdits.includes(edit.path)) this.pendingEdits.push(edit.path)
  }

  /**
   * 一轮结束时把这一批改动封成一个 checkpoint。
   *
   * 没有改动就不发——空跑一轮不该在日志里留一个空 checkpoint，
   * 那会让 `uh undo` 以为"这一轮改过东西"。
   */
  private sealCheckpoint(label: string): void {
    if (!this.pendingEdits.length) return
    const files = this.pendingEdits.slice()
    this.pendingEdits.length = 0
    this.ev('checkpoint/created', { label, files, file_count: files.length }, 'agent')
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
  /**
   * 给上层（CLI / 剧本 / 宿主）记一条会话事实。
   *
   * `ev` 是私有的：内部的 step 事件顺序由 loop 决定，放开会让人乱插。
   * 但「这一次跑的是哪个剧本」这种事实只有上层知道，所以留一个窄口。
   */
  /**
   * 沙箱里能不能干活，一半取决于环境变量。
   *
   * 沙箱只让写工作区，但 npm 想写 ~/.npm、pip 想写 ~/.cache/pip、go 想写 ~/go-build、
   * cargo 想写 ~/.cargo——每一个都把「能装依赖」变成 EACCES。放宽沙箱去迁就它们
   * 是错的方向：真正该改的是「缓存放哪」。把这些位置指到工作区里的 .uh/，
   * 沙箱的边界不用动，工具就能正常跑。
   *
   * .uh 本来就被交付物快照跳过，所以这些缓存不会混进产物里。
   */
  private sandboxEnv(workdir: string): Record<string, string> {
    // 不生效的沙箱（path-guard/unconfined）也用同一套：换机器时行为一致，
    // 而且缓存留在项目里，清掉工作区就等于清掉缓存。
    const root = nodePath.join(workdir, '.uh')
    const dirs: Record<string, string> = {
      TMPDIR: nodePath.join(root, 'tmp'),
      TMP: nodePath.join(root, 'tmp'),
      TEMP: nodePath.join(root, 'tmp'),
      // XDG_CACHE_HOME / XDG_DATA_HOME 故意**不覆盖**。
      //
      // 这两个变量影响面太广：Playwright、Electron、各种桌面工具都用它找
      // 已安装的东西。指到工作区里，等于告诉 Playwright「浏览器在
      // <工作区>/.uh/cache/ms-playwright」——那里是空的，而真正的浏览器在
      // ~/.cache/ms-playwright。结果就是每个工作区都要重下几百兆，
      // 或者干脆报「浏览器没装」。
      //
      // 工具链缓存和工作区缓存不是一回事：npm/pip 的缓存按项目隔离是对的，
      // 浏览器这种「一次装好、到处复用」的资产必须留在 HOME。
      NPM_CONFIG_CACHE: nodePath.join(root, 'cache', 'npm'),
      npm_config_cache: nodePath.join(root, 'cache', 'npm'),
      YARN_CACHE_FOLDER: nodePath.join(root, 'cache', 'yarn'),
      PNPM_HOME: nodePath.join(root, 'cache', 'pnpm'),
      PIP_CACHE_DIR: nodePath.join(root, 'cache', 'pip'),
      GOCACHE: nodePath.join(root, 'cache', 'go-build'),
      GOMODCACHE: nodePath.join(root, 'cache', 'go-mod'),
      CARGO_HOME: nodePath.join(root, 'cache', 'cargo'),
      GRADLE_USER_HOME: nodePath.join(root, 'cache', 'gradle'),
    }
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(dirs)) {
      try {
        fsSync.mkdirSync(v, { recursive: true })
        out[k] = v
      } catch {
        // 目录建不出来就别设了：设一个不存在的路径，工具会报一个更难懂的错误
      }
    }
    // 显式指回真实的浏览器缓存：即使将来有人又把 XDG_CACHE_HOME 改回工作区，
    // Playwright 也还找得到。存在才设，没装过就别造一个空目录骗它。
    const pw = nodePath.join(os.homedir(), '.cache', 'ms-playwright')
    try {
      if (fsSync.existsSync(pw)) out.PLAYWRIGHT_BROWSERS_PATH = pw
    } catch { /* 读不到就算了 */ }

    // 告诉程序它在被沙箱包着——很多工具会因此跳过不必要的家目录写入
    out.UH_SANDBOXED = '1'
    return out
  }

  note(kind: SessionKind, payload: Record<string, unknown>): void {
    this.ev(kind, payload)
  }

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
    this.bwrap = findBwrap()
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
    if (this.bwrap) {
      return `bwrap via ${this.bwrap.path}; writes limited to ${this.workspace}; ` +
        'credential dirs (.ssh/.aws/.gnupg/.npmrc/...) masked with empty tmpfs'
    }
    if (this.helper) {
      return `landlock-v${this.helper.abi} via ${this.helper.path}; writes limited to ${this.workspace}; ` +
        'read is NOT restricted — landlock has no way to allow $HOME except .ssh, and ' +
        'blocking all of $HOME breaks git/npm/pip config' +
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

  /** 预算配置。每次现读文件——改了设置不用重启 */
  budget(): BudgetConfig {
    try {
      const raw = JSON.parse(fsSync.readFileSync(nodePath.join(uhHome(), 'config.json'), 'utf8')) as Record<string, unknown>
      return normalizeBudget(raw.budget)
    } catch {
      return { perRun: 0, perDay: 0 }
    }
  }

  /**
   * 今天已经花掉的 token。
   *
   * 现扫日志而不是记在内存：内存里那个数字只代表「这个进程见过多少」，
   * 而 ACP / Web / CLI 可能是三个进程，用户一天完全可能用其中两个。
   */
  todayUsage(): number {
    try {
      const store = new EventStore()
      const today = new Date().toISOString().slice(0, 10)
      let total = 0
      for (const meta of store.list({ limit: 200 })) {
        const dir = store.sessionDir(meta.id)
        if (!dir) continue
        let text = ''
        try { text = fsSync.readFileSync(nodePath.join(dir, 'events.jsonl'), 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          if (!line.includes('llm/response')) continue
          let ev: { kind?: string; timestamp?: string; payload?: { usage?: { total_tokens?: number } } }
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.kind !== 'llm/response') continue
          // 只算今天：昨天的额度不该吃掉今天的
          if (!String(ev.timestamp ?? '').startsWith(today)) continue
          total += ev.payload?.usage?.total_tokens ?? 0
        }
      }
      return total
    } catch {
      return 0
    }
  }

  /** 当前实际隔离级别 */
  get isolationLevel(): IsolationLevel {
    return this.isolation.enforced
  }

  private log(level: LogLevel, msg: string, ...rest: unknown[]): void {
    if (LEVELS[level] < LEVELS[this.level]) return
    const line = `[uh:${level}] ${msg}`
    // 走 stdio 协议时（ACP）stdout 是数据通道，混进一个日志行客户端就解析失败。
    // 这不是可以「记得别 log」的事，得让默认行为本身分得清。
    if (this.opts.logToStderr) console.error(line, ...rest)
    else if (level === 'error') console.error(line, ...rest)
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
    let level = this.isolation.enforced
    let escalated = false
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

      // 越权申请：沙箱挡不住它想要的事，它明确要求这一次跑在外面。
      // 这种请求一律要问，而且不问"要不要"，问的是"同不同意这个理由"。
      if (spec.escalate) {
        const why = spec.escalate.trim().slice(0, 300) || '(no reason given)'
        const req: ApprovalRequest = {
          kind: 'exec',
          risk: risk === 'read' ? 'write' : risk,
          reason: `needs to run this outside the sandbox — ${why}`,
          summary: cmdline.length > 160 ? `${cmdline.slice(0, 157)}...` : cmdline,
          detail: `${cmdline}\n\nwhy: ${why}\n\nsandbox: ${level}`,
        }
        let decision: ApprovalDecision = 'allow'
        if (this.opts.approval === 'allow') {
          this.ev('approval/resolved', { kind: 'exec', risk, decision: 'allow', auto: true, escalation: true }, 'user')
        } else {
          const requested = this.ev('approval/requested', { ...req }, 'agent')
          decision = await this.approvalGate().request(req)
          this.ev('approval/resolved', { kind: 'exec', risk, decision, escalation: true }, 'user', requested?.id ?? null)
        }
        if (decision === 'deny') {
          this.ev('tool/result', {
            tool: 'exec', status: 'refused', isolation: level, refused: true, denied_by: 'approval',
          }, 'user', attempted?.id ?? null)
          throw new Error(
            'E_APPROVAL_DENIED: the user refused to run this outside the sandbox. ' +
            'Do not retry it and do not try to reach the same result through another command. ' +
            'Say what you could not do and why it needed to leave the sandbox.',
          )
        }
        escalated = true
        level = 'none'
      }
    }

    if (spec.source === 'model' && !spec.escalate) {
      const cmdline = spec.argv.join(' ')
      const risk = classify(cmdline)
      const verdict = needsApproval(risk, {
        // path-guard / none 时沙箱其实没在管写入
        isolationEnforced: level !== 'path-guard' && level !== 'none',
        kind: 'exec',
      })
      // 本会话内批准过的同一条命令（同参数、同目录）不再问第二遍。
      // Codex 的 ApprovedForSession 就是这个粒度：精确到 argv + cwd，
      // 因为它记住的是"这一条"，不是"这一类"——`rm -rf node_modules` 批一次，
      // 不代表下次 `rm -rf ~` 也该放行。
      const cmdKey = workdir0 + '\u0000' + spec.argv.join('\u0000')
      if (verdict.needed && this.approvedCommands.has(cmdKey)) {
        this.ev('approval/resolved', { kind: 'exec', risk, decision: 'allow', cached: true }, 'user')
        verdict.needed = false
      }

      // 持久规则：上次会话里点过「一直都行」，这里直接放行。
      // 规则带 cwd，所以换到别的项目会重新问。
      if (verdict.needed) {
        const hit = findRule(spec.argv, workdir0)
        if (hit) {
          this.ev('approval/resolved', {
            kind: 'exec', risk, decision: 'allow', cached: true, rule: hit.prefix.join(' '),
          }, 'user')
          verdict.needed = false
          // 会话缓存也记上，后面同一条命令不必再查盘
          this.approvedCommands.add(cmdKey)
        }
      }

      if (verdict.needed) {
        // 能被记住的前缀要先算出来给界面：null 时界面就不该显示「一直都行」
        const persistPrefix = suggestPrefix(spec.argv, risk)
        const req: ApprovalRequest = {
          kind: 'exec',
          risk,
          reason: verdict.reason,
          summary: cmdline.length > 160 ? `${cmdline.slice(0, 157)}...` : cmdline,
          detail: cmdline,
          persistPrefix,
          // 破坏性命中时记的是完整 argv，界面上不能画成通配
          persistExact: persistPrefix !== null && persistPrefix.length === spec.argv.length,
        }
        // approval/requested 的含义是「问过人了」。--yes 并不问人，只是自动批准，
        // 记一条 requested 会让审计日志撒谎
        let decision: ApprovalDecision = 'allow'
        if (this.opts.approval === 'allow') {
          this.ev('approval/resolved', { kind: 'exec', risk, decision: 'allow', auto: true }, 'user')
        } else {
          const requested = this.ev('approval/requested', { ...req }, 'agent')
          decision = await this.approvalGate().request(req)
          const resolved: Record<string, unknown> = { kind: 'exec', risk, decision: decision === 'deny' ? 'deny' : 'allow' }
          if (decision === 'allow-always' && persistPrefix) {
            const rule = addRule(persistPrefix, workdir0)
            resolved.rule = rule.prefix.join(' ')
            resolved.remembered = true
          }
          this.ev('approval/resolved', resolved, 'user', requested?.id ?? null)
        }
        if (decision !== 'deny') this.approvedCommands.add(cmdKey)
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

    // 越权批准过的那一次是**有意**跑在沙箱外的，人已经点过头；
    // 再拿 fail-closed 拦一次，等于让刚批准的许可当场失效。
    if ((level === 'path-guard' || level === 'none') && this.opts.unconfined !== true && !escalated) {
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
    // bwrap 排最前：它是唯一能既让工具链读得动、又挡住 ~/.ssh 的机制。
    // 用不了（userns 被禁）才退到 landlock —— 那条路读是放开的，见 bwrap.ts。
    // 判据是解析后的 level，不是请求里的 spec.isolation：
    // 越权批准后 level 会被改成 'none'，那一刻就真的不能套沙箱。
    const useBwrap = this.bwrap !== null && level !== 'none'
    const useLandlock = !useBwrap && this.helper !== null && level !== 'none'
    const useSeatbelt = !useBwrap && !useLandlock && this.seatbelt.available && level !== 'none'

    let cmd: string
    let args: string[]
    if (useBwrap) {
      cmd = this.bwrap!.path
      args = buildBwrapArgv(this.bwrap!, {
        argv: [...spec.argv],
        workspace: workdir,
        denyNetwork: this.opts.denyNetwork,
        extraReadOnly: [...toolchainPaths().readOnly, ...this.sandboxRoots(spec.argv, workdir)],
      })
    } else if (useLandlock) {
      cmd = this.helper!.path
      args = buildLandlockArgv(this.helper!, {
        argv: [...spec.argv],
        workspace: workdir,
        // 默认让 home 可读。关掉它看起来更"安全"，实际是让 git、npm、pip、
        // 编辑器配置全部失效——沙箱于是保护了一个什么都干不了的环境。
        // 真正的凭据屏蔽交给 bwrap（能精确盖目录）；landlock 做不到，状态里如实写。
        allowHome: this.opts.allowHome !== false,
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
        env: { ...process.env, ...this.sandboxEnv(workdir), ...(spec.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // 自成进程组。照 Codex 的 process_group(0)：一条命令往往是棵进程树
        // （node 拉起 playwright，playwright 拉起 chromium），只杀直接子进程
        // 会让孙子进程变成孤儿继续跑——用户按了停止，浏览器还在后台开着。
        detached: process.platform !== 'win32',
      })

      /**
       * 杀整棵进程树，不只是直接子进程。
       *
       * Unix 上子进程是新的进程组组长，`kill(-pid)` 打的是整个组。
       * Windows 没有进程组，用 taskkill /T。
       */
      const killTree = (): void => {
        if (child.pid === undefined) return
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch {
          // 组已经没了就退回到直接杀；两者都可能失败（进程已退出）
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
      }

      // 中断要能打断正在跑的命令，否则用户按了 Ctrl+C 还得等它跑完
      const onAbort = (): void => { killTree() }
      if (spec.signal) {
        if (spec.signal.aborted) onAbort()
        else spec.signal.addEventListener('abort', onAbort, { once: true })
      }

      let truncated = false
      const LIMIT = 256 * 1024
      const timer = setTimeout(() => { killTree() }, timeoutMs)

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
        // 记**实际**用的机制。越权批准过的那一次没有沙箱——
        // 这里如果照抄"我们有 landlock"，审计链就会给一次不受限的执行贴上受限的标签，
        // 那比没有日志更糟：它让你以为查过了。
        const actualIsolation: IsolationLevel = escalated
          ? 'none'
          : useBwrap ? 'bwrap'
          : useLandlock ? (`landlock-v${this.helper!.abi}` as IsolationLevel)
          : useSeatbelt ? 'seatbelt'
          : level
        this.ev('tool/result', {
          tool: 'exec',
          status: code === 0 ? 'ok' : 'error',
          exit_code: code ?? -1,
          isolation: actualIsolation,
          ...(escalated ? { escalated: true } : {}),
          duration_ms: Date.now() - started,
          output_digest: digest,
          truncated,
        }, 'environment', callEv?.id ?? null)
        resolve({
          exitCode: code ?? -1,
          stdout, stderr, truncated,
          durationMs: Date.now() - started,
          isolation: actualIsolation,
          ...(escalated ? { escalated: true } : {}),
        })
      })
    })
  }

  /** 当前工作目录下可用的 skills（只读，供 CLI/UI 展示） */
  get skills(): Skill[] {
    return discoverSkills(process.cwd()).filter((k) => isPluginEnabled('skill:' + k.name))
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

    // 关掉的技能不进工具表：它不该出现在模型的候选里，也不该被 use_skill 唤起
    const skills: Skill[] = o.skills === false
      ? []
      : discoverSkills(process.cwd()).filter((k) => isPluginEnabled('skill:' + k.name))
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
      // 在设置里关掉的 server 不启动。连上了才算"能用"，所以过滤必须在这一步之前。
      const keep = new Set(Object.keys(loaded.servers))
      for (const name of keep) if (!isPluginEnabled('mcp:' + name)) keep.delete(name)
      if (Object.keys(loaded.servers).length > 0) {
        await this.mcp.start(Object.fromEntries([...keep].map((n) => [n, loaded.servers[n]!])))
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
            ...(a.escalate ? { escalate: a.escalate } : {}),
            signal: this.abortCtl.signal,
            source: 'model',
          })
          const body = r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')

          // 撞了沙箱墙的人（模型）需要知道两件事：这不是命令写错了，以及有正规的
          // 申请通道。否则它只会换个写法再撞一次，或者干脆报告"做不到"。
          const hint = r.exitCode !== 0 && !r.escalated && isSandboxDenial(r.stderr)
            ? `\n\n[sandbox: refused by ${r.isolation} — this is the boundary, not a bug in your command. `
              + `Writes are only allowed inside ${this.workspace}.]\n`
              + `[sandbox: if this genuinely has to happen, call run_command again with `
              + `escalate:"<one line saying why>". The user is asked first, and only that one command runs outside.]`
            : ''
          return { content: `exit=${r.exitCode} isolation=${r.isolation}\n${body}${hint}`.trim() }
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
        // 预算从配置读，今天已用的量现场算——不能信内存里的计数器，
        // 那是"这个进程见过多少"，不是"今天花了多少"
        ...(this.budget().perRun || this.budget().perDay
          ? { budget: { ...this.budget(), dayUsed: this.todayUsage() } }
          : {}),
      },
    )

    // 封这一轮的 checkpoint。放在这里而不是 recordEdit 里：
    // 一次改动属于哪一轮由外层决定，编辑器自己不知道 turn 的边界。
    // 中断和预算停下也要封——已经写下去的文件必须能回滚。
    this.sealCheckpoint(`turn ${result.steps} steps, ${result.stoppedBy}`)

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
