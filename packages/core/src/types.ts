/**
 * UnitHarness 公开类型。
 *
 * 设计约束（见 docs/unit-harness-core-api-v1.md）：
 *  - 插件只 import 本文件导出的类型，不 import Cordis；
 *  - 所有副作用必须经 ctx.exec / ctx.fs；绕过执行层 = 不受支持的用法；
 *  - 能力清单不是安全边界（D5）。
 */

/** 插件 API 版本。不匹配时加载失败并给出迁移指引（D4）。 */
export const API_VERSION = 1

/**
 * 构建期注入的 landlock helper（base64）。
 * 单文件发行版靠它在首次运行时自举出 ~/.uh/bin/landlock-helper；
 * 普通构建里是空串，此时回落到仓库内的构建产物。
 */
declare global {
  // eslint-disable-next-line no-var
  var __UH_LANDLOCK_B64__: string | undefined
}

export type Disposer = () => void

/** 沙箱实际生效的隔离级别。必须如实上报，绝不静默降级（D7）。 */
export type IsolationLevel =
  | `landlock-v${number}`
  | 'bwrap'
  | 'seatbelt'
  | 'win-restricted-token'
  | 'path-guard'
  | 'none'

/** landlock 施加的范围说明（写进报告与事件，避免用户误判） */
export interface SandboxScope {
  /** 只读挂载/规则覆盖的路径 */
  readonlyRead: string[]
  /** 可写路径 */
  readWrite: string[]
  /** 网络是否被禁止（landlock 只能管 TCP） */
  network: 'blocked-tcp' | 'allowed'
}

/** 探测结果：每个机制单独报告，不合并成一个是/否。 */
export interface IsolationReport {
  platform: NodeJS.Platform
  arch: string
  release: string
  landlock: { available: boolean; abi: number | null; reason?: string }
  bwrap: { available: boolean; path: string | null; reason?: string }
  seatbelt: { available: boolean; reason?: string }
  /** 本机**最高可用**的隔离级别（能力探测结果） */
  available: IsolationLevel
  /** 本构建**实际施加**的隔离级别。P0 尚未实现封装，故为 'none'。 */
  enforced: IsolationLevel
  /** 探测方式的说明，避免用户误以为是实测 */
  notes: string[]
}

export interface ExecSpec {
  argv: [string, ...string[]]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  /** 期望的隔离级别；auto 表示按探测结果取当前可用最高档 */
  isolation?: 'auto' | IsolationLevel
  /** 中断信号：abort 时杀掉子进程（Ctrl+C 不该让用户等到命令自己结束） */
  signal?: AbortSignal
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /** 实际生效级别，必填（D7：不得省略） */
  isolation: IsolationLevel
  truncated: boolean
}

export interface ToolSchema {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  schema: ToolSchema
  handler: (args: Record<string, unknown>) => Promise<{ content: string }>
}

export type HookPoint =
  | 'session-start' | 'prompt-submit' | 'pre-step'
  | 'pre-tool' | 'post-tool' | 'post-tool-failure' | 'stop' | 'session-end'

export interface HookSpec {
  name: string
  mode: 'command' | 'prompt' | 'agent'
  command?: [string, ...string[]]
  timeoutMs?: number
  match?: { tools?: string[] }
  prompt?: string
}

export interface HookRegistration {
  point: HookPoint
  spec: HookSpec
}

/** 插件作者看到的全部上下文。 */
export interface UnitHarnessContext {
  readonly apiVersion: 1
  readonly id: string
  readonly config: Readonly<Record<string, unknown>>

  readonly log: {
    info(msg: string, ...rest: unknown[]): void
    warn(msg: string, ...rest: unknown[]): void
    error(msg: string, ...rest: unknown[]): void
    debug(msg: string, ...rest: unknown[]): void
  }

  readonly tools: {
    register(tool: ToolDefinition): Disposer
    list(): ReadonlyArray<Pick<ToolDefinition, 'name' | 'description'>>
  }

  readonly hooks: {
    on(point: HookPoint, spec: HookSpec): Disposer
    list(): ReadonlyArray<HookRegistration>
  }

  readonly exec: {
    run(argv: [string, ...string[]], opts?: Omit<ExecSpec, 'argv'>): Promise<ExecResult>
  }

  readonly sandbox: {
    probe(): IsolationReport
    readonly isolation: IsolationLevel
  }

  /** 注册一个可被其他插件 inject 的能力 */
  provide<T>(name: string, impl: T): Disposer
  /** 取用其他插件提供的能力 */
  inject<T>(name: string): T | undefined
  /** 注册可逆副作用；插件卸载时自动撤销 */
  effect(setup: () => Disposer | void): Disposer
}

/** 插件定义。v1 只支持函数式插件（apply），不支持 Service 子类。 */
export interface Plugin {
  name: string
  apiVersion: 1
  apply(ctx: UnitHarnessContext, config: unknown): void | Promise<void>
}
