# UnitHarness 核心 API 与模块边界 v1

> 状态：**草案已评审**（2026-11-12）。本文定义 `@unit-harness/core` 的公开面与六层依赖边界，插件作者只看这一份。
> 上位：`unit-harness-opensource-v1.md`（D3/D4/D13）· 关联：`unit-harness-event-model-v1.md`（事件与钩子语义）

---

## 1. 六层 → 包映射

| 层 | 包 | 职责 | 对外 |
|---|---|---|---|
| L1 运行时 | `@unit-harness/runtime` | Agent 循环、turn/step 状态机、上下文装配、LLM 调度 | 内部 |
| L2 执行 | `@unit-harness/exec` | `exec` / `fs` / `net` / `sandbox` 的封装实现，**所有副作用唯一出口** | 内部（经 core） |
| L3 验证 | `@unit-harness/verify` | 断言执行器、内置断言（exit / schema / hash / http） | 内部（经 core） |
| L4 证据 | `@unit-harness/evidence` | 事件写入、blob 内容寻址、哈希链、回放引擎 | 内部（经 core） |
| L5 插件 | 用户与官方插件 | 工具、钩子、剧本、验证器 | — |
| L6 分发 | `@unit-harness/cli` / `@unit-harness/desktop` | 打包、签名、更新、壳 | 用户入口 |

**唯一对外包**：`@unit-harness/core`。它 re-export 类型与 `UnitHarnessContext`，其余五个包**不发布 public 入口**（`exports` 里只有 `.` → `internal.js`，靠 `private: true` 或 npm scope 限制）。

插件写 `import type { UnitHarnessContext } from '@unit-harness/core'`，**永远不 import 其他五个包**。

---

## 2. 依赖方向（CI 强制）

```
       ┌──────────────┐
       │  @uh/core    │  ← 插件唯一入口
       └──────┬───────┘
      ┌───────┼────────┬──────────┬──────────┐
      ▼       ▼        ▼          ▼          ▼
  runtime  verify    exec     evidence   (types)
      │       │        │          │
      └───────┴────────┴──────────┘
                全部 → evidence（单向）
```

规则（`pnpm lint:deps` 检查 `package.json` 的 dependencies + AST import）：

| 规则 | 违反示例 |
|---|---|
| R1：`evidence` 不依赖任何同层包 | `evidence` import `exec` → 失败 |
| R2：`L1/L2/L3` 不得 import `L5` 的任何东西 | `runtime` import 某 plugin → 失败 |
| R3：插件只能 import `@unit-harness/core` | 插件 import `@unit-harness/exec` → 失败 |
| R4：`core` 不 import 具体插件 | — |
| R5：协议适配器（MCP/ACP/A2A）不得被 `core` import | `core` import `@unit-harness/protocol-acp` → 失败 |

R3 是"薄封装不被绕过"的机械保证：一旦某个插件直连 `exec`，D4 的 API 承诺和 D5 的未来 RPC 隔离就同时失效。

---

## 3. `UnitHarnessContext`：插件看到的全部

```ts
// @unit-harness/core
export interface UnitHarnessContext {
  /** 插件 API 版本。不匹配时加载失败并给出迁移指引（D4） */
  readonly apiVersion: 1
  /** 本插件的稳定标识（来自 package.json name） */
  readonly id: string
  /** 已通过 schema 校验的配置（只读） */
  readonly config: Readonly<Record<string, unknown>>

  readonly agent: AgentApi
  readonly session: SessionApi
  readonly llm: LlmApi
  readonly tools: ToolsApi
  readonly hooks: HooksApi
  readonly sandbox: SandboxApi
  readonly exec: ExecApi
  readonly fs: FsApi
  readonly net: NetApi
  readonly verify: VerifyApi
  readonly evidence: EvidenceApi
  readonly scope: ScopeApi
  readonly log: LogApi

  /** 注册一个可被其他插件 inject 的能力（内部走 ctx.effect，卸载自动撤销） */
  provide<T>(name: string, impl: T): Disposer
  /** 取用其他插件提供的能力；不存在时抛 ServiceNotFoundError（不要用 try/catch 当探测） */
  inject<T>(name: string): T
  /** 注册可逆副作用；返回的 disposer 在插件卸载时自动调用 */
  effect(setup: () => Disposer | void): Disposer
}
```

### 3.1 `AgentApi`

```ts
export interface AgentApi {
  /** 启动一个新会话并跑一次输入；返回句柄，可用 await handle.done() 等待 */
  run(input: { prompt: string; cwd?: string; model?: string; label?: string }): Promise<RunHandle>
  /** 从会话日志尾部继续（崩溃恢复 / 用户点"继续"） */
  resume(sessionId: SessionId): Promise<RunHandle>
  /** 协作式取消：写 turn/end{aborted}，正在跑的沙箱进程被终止 */
  cancel(sessionId: SessionId, reason?: string): Promise<void>
  /** 派生一个受作用域约束的子 Agent（D10） */
  spawn(spec: { role: string; prompt: string; tools?: string[]; scope?: ScopeId }): Promise<RunHandle>
}

export interface RunHandle {
  readonly sessionId: SessionId
  done(): Promise<RunOutcome>              // { status, artifacts, verifications }
  events(opts?: { fromSeq?: number }): AsyncIterable<SessionEvent>
}
```

### 3.2 `SessionApi` / `EvidenceApi`（分工：**生命周期 vs 内容**）

```ts
export interface SessionApi {
  create(opts?: { workspace?: string; label?: string }): Promise<SessionId>
  get(id: SessionId): Promise<SessionMeta | null>
  list(opts?: { limit?: number; status?: SessionStatus }): Promise<SessionMeta[]>
  end(id: SessionId, reason: string): Promise<void>
  /** 读事件流（分页 + 按 kind 过滤），回放与 UI 都走这里 */
  events(id: SessionId, opts?: { fromSeq?: number; kinds?: EventKind[]; limit?: number }):
    Promise<SessionEvent[]>
  /** 订阅尾部事件（SSE / UI 用），不落额外状态 */
  tail(id: SessionId, fromSeq: number): AsyncIterable<SessionEvent>
}

export interface EvidenceApi {
  /** 唯一写入入口。校验 kind 白名单 + payload schema 后追加，返回冻结事件 */
  append(kind: EventKind, payload: Record<string, unknown>,
         opts?: { source?: EventSource; parentId?: EventId }): Promise<SessionEvent>
  /** 登记交付物：计算 sha256、写 blob、发 artifact/emitted */
  emitArtifact(input: { path: string; kind: ArtifactKind; title: string }): Promise<ArtifactRecord>
  /** 对整个会话状态做快照，返回内容哈希（用于"两次回放结果一致"的证据） */
  snapshot(label?: string): Promise<string>
}
```

**为什么拆开**：`session` 是"哪个会话、什么状态"；`evidence` 是"往里写什么、留下什么证据"。混在一起会让插件以为可以随便写事件，而写入的唯一目的应该是**留证**。

### 3.3 `HooksApi`

```ts
export type HookPoint =
  | 'session-start' | 'prompt-submit' | 'pre-step'
  | 'pre-tool' | 'post-tool' | 'post-tool-failure' | 'stop' | 'session-end'

export interface HookSpec {
  name: string                      // 唯一名，出现在 hook/execution 日志里
  mode: 'command' | 'prompt' | 'agent'
  /** mode=command */
  command?: [string, ...string[]]
  timeoutMs?: number                // 默认 5000
  /** 仅在匹配时触发；空 = 全部 */
  match?: { tools?: string[]; pathPrefix?: string[] }
  /** mode=prompt */
  prompt?: string
  /** mode=agent */
  agent?: { role: string; tools?: string[] }
}

export interface HooksApi {
  on(point: HookPoint, hook: HookSpec): Disposer
  list(): ReadonlyArray<{ point: HookPoint; name: string; mode: HookSpec['mode'] }>
}
```

语义严格遵循 `unit-harness-event-model-v1.md` §5：串行 waterfall、任一 `deny` 即终止、`exit 2` 阻断 / `exit 1` 非阻断、每次执行写 `hook/execution`。

### 3.4 `SandboxApi` / `ExecApi` / `FsApi` / `NetApi`

```ts
export interface SandboxApi {
  /** 探测当前平台真实可用的隔离级别（D7）；结果进 session/start */
  probe(): Promise<IsolationReport>
  /** 在沙箱里跑一次命令；自动写 tool/result{isolation}；fail-closed */
  run(spec: ExecSpec): Promise<ExecResult>
}

export interface ExecSpec {
  argv: [string, ...string[]]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number                // 默认 60000
  net?: 'none' | { allow: string[] }  // 域名白名单，不支持 IP
  isolation?: 'auto' | IsolationLevel  // auto = 按 D7 降级链探测
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  isolation: IsolationLevel         // 实际生效级别，必填
  truncated: boolean
}

export interface ExecApi {
  run(argv: [string, ...string[]], opts?: Omit<ExecSpec, 'argv'>): Promise<ExecResult>
}

export interface FsApi {
  read(path: string): Promise<string>
  write(path: string, data: string | Uint8Array): Promise<void>
  list(path: string): Promise<Entry[]>
  /** 所有路径先 realpath 再校验前缀，防符号链接逃逸 */
  stat(path: string): Promise<Stat>
  readonly root: string             // 工作区根，只读
}

export interface NetApi {
  fetch(url: string, init?: RequestInit): Promise<Response>  // 域名白名单 + 禁 IP/内网/非标端口
}
```

**四个 API 都自动记录证据**：每次 `exec.run` 写 `tool/result`，每次 `fs.write` 在 `tool/result.output_digest` 中体现，每次 `net.fetch` 记 `protocol/*`。插件不需要、也不允许自己写这些事件。

### 3.5 `VerifyApi`

```ts
export type Assertion =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-sha256'; path: string; sha256: string }
  | { kind: 'schema'; schema: Record<string, unknown>; target: 'artifact' | 'payload'; path?: string }
  | { kind: 'command-exit'; argv: string[]; expectExit: 0 | number; timeoutMs?: number }
  | { kind: 'http-status'; url: string; expect: number }
  | { kind: 'json-path'; path: string; pointer: string; equals: unknown }
  | { kind: 'custom'; name: string; params: Record<string, unknown> }

export interface VerifyApi {
  /** 执行一条断言并写 verification/asserted */
  assert(a: Assertion, opts?: { targetRef?: ArtifactRecord; stopOnFail?: boolean }):
    Promise<AssertionResult>
  /** 注册自定义断言类型（插件扩展点，D13 允许"加验证器"） */
  define(name: string, fn: (params: Record<string, unknown>, ctx: UnitHarnessContext) =>
    Promise<{ result: 'pass' | 'fail' | 'error'; detail?: unknown }>): Disposer
}
```

**关键**：`assert` 内部强制走 `sandbox.run`——**验证也必须在沙箱里执行**，不允许"在宿主直接跑个 shell 检查"（那会让验证本身成为逃逸点）。

### 3.6 `ScopeApi`（D10）

```ts
export interface ScopeApi {
  current(): ScopeId
  /** 派生作用域：在其中注册的工具/钩子/技能默认不可见于父作用域 */
  fork(label: string): Scope
  dispose(scope: ScopeId): void
}

export interface Scope {
  readonly id: ScopeId
  readonly label: string
  /** 把本作用域的能力显式导出给父作用域（唯一跨域方式） */
  export(names: string[]): void
}
```

语义：
- 插件在 `apply()` 时注册的一切，默认归属于**当前作用域**；
- 子 Agent（`agent.spawn`）自动运行在新作用域；
- 外部 Agent（ACP/A2A 接入）同样受作用域约束，等价于一个受限的 `spawn`。

### 3.7 `LlmApi`

```ts
export interface LlmApi {
  /** 一次补全；内部写 llm/request 与 llm/response（含 usage 与成本） */
  complete(req: {
    messages: ChatMessage[]
    tools?: ToolSchema[]
    model?: string               // 缺省用会话模型
    maxTokens?: number
    temperature?: number
    /** 成本角色：决定路由与预算检查 */
    role?: 'plan' | 'exec' | 'cheap'
  }): Promise<{ content: string; toolCalls?: ToolCall[]; usage: Usage }>
  stream(req: ...): AsyncIterable<Chunk>
  /** 注册 provider（换模型、接本地 LM Studio 都走这里） */
  registerProvider(id: string, p: LlmProvider): Disposer
}
```

---

## 4. 插件定义

```ts
// @unit-harness/core
export interface Plugin {
  /** 与 package.json name 一致 */
  name: string
  /** 必须显式声明，否则加载失败（D4） */
  apiVersion: 1
  /** 依赖的其他插件提供的服务名（不是包名） */
  inject?: string[]
  /** 只有这些都可用时才会被加载 */
  start?(): void | Promise<void>
  apply(ctx: UnitHarnessContext, config: unknown): void | Promise<void>
  /** 可选：显式清理；通常用 ctx.effect 即可 */
  stop?(): void | Promise<void>
}

export type Disposer = () => void
```

加载顺序由 `inject` 推导（服务何时可用），**不写启动序列**。

### 4.1 `examples/plugin-hello`（≤50 行，生态入口）

```ts
// examples/plugin-hello/src/index.ts
import type { Plugin, UnitHarnessContext } from '@unit-harness/core'

// 最小插件：注册一个工具 + 一个 pre-tool 钩子
const plugin: Plugin = {
  name: '@unit-harness-example/hello',
  apiVersion: 1,

  apply(ctx: UnitHarnessContext, config: unknown) {
    const who = (config as { who?: string })?.who ?? 'world'

    // ① 注册工具：所有副作用必须走 ctx.exec / ctx.fs，自动留证据
    ctx.tools.register({
      name: 'hello',
      description: 'Say hello and report the sandbox isolation in use',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        // 走封装接口 → 自动写 tool/result{isolation}
        const r = await ctx.exec.run(['sh', '-c', 'echo hello && true'], { timeoutMs: 3000 })
        return { content: `hello ${who} (isolation=${r.isolation})` }
      },
    })

    // ② 注册钩子：命令式，最确定的一档（默认 command 模式）
    ctx.hooks.on('pre-tool', {
      name: 'hello-guard',
      mode: 'command',
      command: ['sh', '-c', 'exit 0'], // 想阻断就 exit 2，注意 exit 1 是非阻断的
    })

    // ③ 一切注册已由框架包装为可逆 effect，无需手写清理
  },
}

export default plugin
```

`cordis.patch.yml` 里加一行即可生效：

```yaml
- insert:
    - id: hello
      name: '@unit-harness-example/hello'
      config:
        who: unit-harness
```

---

## 5. 生命周期

```
discover → validate(apiVersion + config schema)
        → resolve(inject 依赖)
        → apply(ctx, config)        ← 只能在这里注册
        → [运行期]
        → dispose（逆序撤销所有 effect）
```

硬规则：
1. **注册只允许发生在 `apply` / `start` 内**。运行期再动态注册必须显式走 `scope.fork()` 后的 `apply`，否则拒绝（防止事件监听泄漏）；
2. dispose 逆序执行，任何一个 disposer 抛错不影响其余（记录并继续）；
3. 插件崩溃不影响宿主：`apply` 抛错 → 该插件标记 `failed`，宿主照跑，UI 显示"某插件加载失败"。

---

## 6. 错误模型

```ts
export class UnitHarnessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'E_API_VERSION'      // 插件 apiVersion 不匹配
      | 'E_CONFIG'           // 配置 schema 校验失败
      | 'E_SERVICE_NOT_FOUND'
      | 'E_SANDBOX_UNAVAILABLE'  // fail-closed 触发
      | 'E_ASSERTION_FAILED'
      | 'E_TOOL_FAILED'
      | 'E_CANCELLED'
      | 'E_PROTOCOL',        // 协议适配器错误
    readonly detail?: unknown,
  ) { super(message) }
}
```

`E_API_VERSION` 必须携带**可执行的迁移指引**：

```
Plugin @foo/bar requires apiVersion 1, but this build provides 2.
Run:  uh plugin migrate @foo/bar --to 2
See:  https://github.com/create-info/unit-harness/blob/main/docs/migrations/v2.md
```

`E_SANDBOX_UNAVAILABLE` 是 fail-closed 的表现：**不降级执行**，直接失败并提示用户如何启用隔离（D7）。

---

## 7. 分级现状（v0.1 计划）

| API | 级别 | 理由 |
|---|---|---|
| `ctx.tools.register` | `@public` | 第一方插件全部依赖 |
| `ctx.hooks.on` | `@public` | 同上 |
| `ctx.exec.run` / `ctx.fs` | `@public` | 同上 |
| `ctx.evidence.append` | **`@experimental`** | 事件 kind 集合仍在长，暂不冻结 |
| `ctx.verify.assert` | `@experimental` | 断言类型还要扩展（等 `agent` 模式钩子落地） |
| `ctx.scope` | `@experimental` | 作用域语义需真实多 Agent 场景验证 |
| `ctx.agent.spawn` | `@experimental` | — |
| `ctx.llm.registerProvider` | `@public` | 第三方要接本地模型，必须稳定 |
| `Plugin.apiVersion` | `@public` | 整个生态的地基 |

**毕业条件**（D4）：`@public` 必须登记在 `docs/graduation.md`——"哪个第一方插件在生产里用着它"。没登记的一律回到 `@experimental`。

---

## 8. 插件禁止清单（CI 与 code review 双重检查）

1. 不得 `import '@deepseek-ai/cordis'`（D3）；
2. 不得 `import '@unit-harness/{runtime,exec,verify,evidence}'`（R3）；
3. 不得直接 `import 'node:child_process'` 执行命令——必须 `ctx.exec`（否则没有 `isolation` 记录，验证链断裂）；
4. 不得直接写 SQLite 或读写 `~/.uh/data/*.db`；
5. 不得在 `apply` 之外注册工具/钩子；
6. 不得声称能力清单具有安全约束力（D5）。

第 3 条是**唯一一条"技术上拦不住但必须审"的规则**：TS 同进程无法阻止 `node:child_process`，但 code review 与插件审核必须拒绝。这一点要在 `CONTRIBUTING.md` 里明写——与 D5 的诚实立场一致：我们承认无法阻止，但把"绕过执行层"定义为不受支持的用法。
