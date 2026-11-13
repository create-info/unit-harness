# UnitHarness 协议适配器契约 v1（MCP / ACP / A2A）

> 状态：**草案**（2026-11-12）。本文定义三种协议如何接到内核上。
> 上位：`unit-harness-opensource-v1.md` D11（协议边界）+ D14（传输层可插拔）
> 关联：`unit-harness-event-model-v1.md`（映射产物是 `session/*` 事件）

---

## 实现现状

本文是**设计契约**，与代码现状有差异，如实记下来：

- **A2A**：已实现，见 [`a2a.md`](a2a.md)。但实现方式比本文草案简单——没有抽
  `ProtocolAdapter` 接口，`packages/core/src/a2a/` 直接就是这一种协议的实现。
  等第二个协议落地时再抽接口，比先假定一个抽象、再为每个协议打补丁好。
- **ACP**：未实现。
- **MCP**：已实现，但是 client 侧（我们调别人的工具），形状和本文描述的方向相反。

---

## 1. 一条原则

> **内核只认自己的规范化事件模型。协议是边界翻译，不是内核分支。**

判断标准很简单：**删掉所有适配器包，内核必须还能完整跑完一个会话**。如果删掉 ACP 之后内核里还有 `if (protocol === 'acp')`，就说明翻译漏进了内核，必须搬出去。

三个必然推论：

1. 内核不 import 任何协议 SDK（CI 规则 R5）；
2. 协议差异只体现在适配器包的内部；
3. 新协议（未来还会有）只需新增一个包，**内核零改动**——这是 D1「验证闭环」能被长期维护的前提。

---

## 2. 统一适配器接口

```ts
// @unit-harness/core（类型定义放 core，实现在各协议包）
export interface ProtocolAdapter {
  readonly id: string                     // 'mcp' | 'acp' | 'a2a' | 自定义
  readonly transport: 'stdio-jsonrpc' | 'http-sse' | 'http-jsonrpc'
  /** 协议版本，写进 session/start 与 protocol/* 事件，便于审计 */
  readonly protocolVersion: string

  /** 启动监听；返回 disposer */
  start(ctx: UnitHarnessContext, opts: AdapterOptions): Promise<Disposer>

  /** 能力协商结果：本端支持什么 */
  capabilities(): ProtocolCapabilities

  /** 入站翻译：协议消息 → 内部事件（可能 0..n 条） */
  toEvents(msg: unknown): InternalEvent[]

  /** 出站翻译：内部事件 → 协议消息（不需要发就返回 null） */
  fromEvent(ev: SessionEvent): unknown | null
}

export interface AdapterOptions {
  /** 绑定到哪个作用域（D10）——外部 Agent 的能力边界 */
  scopeId: ScopeId
  /** 允许暴露的工具白名单；空 = 全部 */
  exposeTools?: string[]
  /** 是否能代替用户做审批（通常 false） */
  canApprove?: boolean
}

export interface ProtocolCapabilities {
  tools: boolean
  resources: boolean
  prompts: boolean
  streaming: boolean
  permissions: boolean
  subagents: boolean
}
```

**`toEvents` / `fromEvent` 是纯函数**（不碰 IO、不改状态），因此可以直接单测——这是三种协议能共用一套测试夹具的原因。

---

## 3. 三种协议的角色与方向

| 协议 | 我们是什么 | 传输 | 典型场景 | 包 |
|---|---|---|---|---|
| **MCP** | **双向**：client（消费外部 server 的工具/资源）+ server（把我们的工具暴露给别的 agent） | stdio / HTTP+SSE | 用户已有 Playwright/Filesystem MCP server；或 Claude Code 来调我们的选型工具 | `@unit-harness/protocol-mcp` |
| **ACP** | **agent server**：被编辑器拉起，按会话协议驱动 | stdio JSON-RPC（first-class） | Zed / 其他 ACP 客户端里直接使用 UnitHarness | `@unit-harness/protocol-acp` |
| **A2A** | **agent endpoint**：接受其他 agent 的委托任务 | HTTP + SSE / JSON-RPC | 别的编排器把"帮我选服务器"委托给我们 | `@unit-harness/protocol-a2a` |

**三者不是替代关系**：MCP 解决"工具接入"，ACP 解决"被编辑器驱动"，A2A 解决"被别的 agent 调用"。我们的产品里可能同时开着三个。

> 具体 method 名与字段以各自官方规范为准（MCP 2025-06-18 / ACP / A2A 当前版本）。适配器**必须锁定版本并在 `protocolVersion` 里声明**，跨版本差异在包内消化，不外溢成条件分支。

---

## 4. MCP 适配器

### 4.1 作为 client（把外部 server 的工具变成我们的工具）

```
外部 MCP server (stdio/http)
      ↓ tools/list
  适配器缓存工具描述
      ↓ 注册进 ctx.tools（scope 约束）
  agent 调用 → tools/call → 结果 → tool/result 事件
```

关键点：

| 项 | 决策 |
|---|---|
| 工具命名 | `mcp__<server>__<tool>`，避免与内置工具冲突（下划线双分隔，可解析） |
| 结果映射 | MCP 的 `content` 数组 → 我们的 `tool/result.output`；`isError` → `status: 'error'` |
| 隔离级别 | MCP server 是外部进程，**不受我们沙箱约束**，`tool/result.isolation` 记为 `'none'` 并在 UI 标黄（诚实报告，参见 D7 的同类原则） |
| 超时 | 默认 60s；MCP 无进度通知时视为不可中断（记录 warning） |
| 审批 | MCP 工具默认按 **B 级**（需确认）处理，除非用户显式在白名单里放行 |

最后两条很重要：**外部 MCP 工具是我们的验证闭环唯一的"逃逸口"**。一个 MCP filesystem server 可以绕过 `ctx.fs` 直接改文件。处理方式不是禁止（那会让生态不可用），而是：① 默认 B 级需确认；② `isolation: 'none'` 显式可见；③ `uh doctor` 里列出所有已连接的 MCP server 及其风险等级。

### 4.2 作为 server（把我们的工具暴露出去）

```
POST /mcp   (JSON-RPC 2.0, Bearer token)
  initialize → tools/list → tools/call
```

- 复用我们在 unitai.site 上已经验证过的 `/mcp` 实现经验（JSON-RPC over HTTP + Bearer + 会员校验）；
- **只暴露 `@public` 且标记 `exposable: true` 的工具**；`exec` / `fs.write` 默认不暴露；
- 每个 `tools/call` 都开一个**新的子会话**（`agent/spawned`），而不是挂在调用者的会话上——否则审计链会被外部调用污染；
- 会员/额度校验在这里做，但**不作为安全边界**（D5 同理：真正的边界是网络与用户授权）。

---

## 5. ACP 适配器

### 5.1 会话生命周期映射

| ACP 侧 | 我们内部 | 说明 |
|---|---|---|
| `initialize`（客户端能力） | `session/start`（`source: environment`） | 记录客户端名与版本 |
| `session/new` | `ctx.session.create()` | 一个 ACP 会话 = 一个我们的 session |
| `session/prompt` | `agent.run()` 或注入 `steering/message` | 首轮走 run，运行中走 steering |
| `session/update`（通知） | `assistant/chunk`、`tool/call`、`tool/result`、`verification/asserted` | 我们把内部事件**翻译成 ACP 通知**，不是反过来 |
| `session/request_permission` | `approval/requested` | **关键映射**：ACP 的权限请求 = 我们的审批门禁，语义天然对齐 |
| `session/cancel` | `ctx.agent.cancel()` | 协作式取消，写 `turn/end{aborted}` |
| `fs/read_text_file` / `fs/write_text_file` | `ctx.fs`（经沙箱校验） | 客户端提供的 fs 能力视为外部资源，读写在本地仍受路径校验 |

### 5.2 为什么 ACP 值得优先做

1. **得到编辑器的原生集成**（不需要我们做 IDE 插件）；
2. ACP 的 `request_permission` 与我们的 B 级审批**同构**，翻译成本极低；
3. ACP 是 stdio-first，天然适合本地单文件分发（D2/D15 的产物形态）。

### 5.3 出站方向（我们当 client 去驱动别的 ACP agent）

对应 D10 的"外部 Agent 作为特殊子 Agent 后端"：

```ts
ctx.agent.spawn({
  role: 'external',
  backend: { protocol: 'acp', command: ['other-agent', '--acp'] },
})
```

- 子 Agent 在**新作用域**里运行；
- 它的工具调用回执转成 `tool/result`，但 `isolation: 'external'`（新增枚举值，D7 的 `IsolationLevel` 需追加）；
- 它的审批请求**冒泡到我们的 UI**，不允许它自行批准。

---

## 6. A2A 适配器

### 6.1 概念映射

| A2A | 我们内部 | 说明 |
|---|---|---|
| Agent Card（`/.well-known/...`） | 静态能力声明 | 由 `@public` 工具 + 已启用的 playbook 生成，不从运行时反射 |
| `Task` | 一次 `agent.run()` 的 session | Task id ↔ session id 双向索引 |
| `Message` / `Part` | `user/message` / `assistant/message` | text part ↔ 文本；file part ↔ `artifact/emitted` |
| task 状态更新 / streaming | `session/*` 事件的出站翻译 | 与 ACP 类似的单向翻译 |
| `Artifact` | `artifacts` 表 + `artifact/emitted` | **A2A 的 Artifact 与我们的交付物语义完全一致**，这是最自然的对接 |
| cancel | `ctx.agent.cancel()` | |
| 认证 | 我们自己的 token（不是 A2A 规定的） | 明确写在 Agent Card 之外 |

### 6.2 边界

- A2A 请求**必须**在受限作用域运行：默认只给 `@public` 工具的子集，不给 `exec`；
- 跨组织调用时，`approval/requested` **不能**由调用方代批（`canApprove: false` 默认）；
- 长任务返回的是 `verification/asserted` 的摘要——这正是 A2A 场景下的差异化价值：**对方拿到的不只是"做完了"，而是"通过了哪些断言"**。

---

## 7. 取消与超时（三协议统一）

| 场景 | 行为 | 事件 |
|---|---|---|
| 调用方取消 | 协作式：设取消标志 → 正在跑的沙箱进程收到 SIGTERM → 工具返回 `E_CANCELLED` | `turn/end{aborted}` + `tool/result{status:'cancelled'}` |
| 适配器超时 | 默认：工具 60s、模型 300s、整体任务 30min | `error{code:'timeout'}` |
| 宿主崩溃 | 不主动取消（下次 `wake()` 恢复） | `session/resumed` |

**硬取消与软取消**：`exec` 类工具可硬杀（进程树），`llm` 类只能软取消（断开连接，token 仍计费——这要如实记进 `llm/response.usage`）。

---

## 8. 错误码映射

| 内部 `code` | MCP | ACP | A2A |
|---|---|---|---|
| `E_API_VERSION` | `-32602 Invalid params` | `-32602` | `invalid_request` |
| `E_CONFIG` | `-32602` | `-32602` | `invalid_request` |
| `E_SERVICE_NOT_FOUND` | `-32601 Method not found` | `-32601` | `not_found` |
| `E_SANDBOX_UNAVAILABLE` | `-32603` + data.hint | `-32603` | `failed` + hint |
| `E_ASSERTION_FAILED` | `-32603`（data 带断言详情） | `-32603` | `failed` + artifact 引用 |
| `E_TOOL_FAILED` | `-32603` | `-32603` | `failed` |
| `E_CANCELLED` | `-32800 Request cancelled` | `-32800` | `canceled` |
| `E_PROTOCOL` | `-32600` | `-32600` | `failed` |

**原则**：断言失败对调用方**不是异常而是结果**（`E_ASSERTION_FAILED` 要带可读的断言明细），因为我们的定位就是"报告验证结果"。把它翻译成裸的 `-32603` 会让整个差异化消失。

---

## 9. 包结构与测试

```
packages/protocol/
├── mcp/
│   ├── src/client.ts     # 消费外部 server
│   ├── src/server.ts     # 暴露我们的工具
│   ├── src/map.ts        # toEvents / fromEvent（纯函数，重点测试）
│   └── tests/fixtures/*.json
├── acp/src/{server,map}.ts
└── a2a/src/{server,map}.ts
```

测试策略（`map.ts` 是纯函数，覆盖率要求 ≥90%）：

| 用例 | 断言 |
|---|---|
| 入站：MCP `tools/call` 结果 → 内部事件 | 生成且仅生成 1 条 `tool/result`，`isolation='none'` |
| 入站：ACP `session/request_permission` | 生成 `approval/requested`，`params_hash` 与动作一致 |
| 出站：`verification/asserted` → A2A | 产生 Artifact 引用的更新，且不被当成 `assistant/message` |
| 取消：协议 cancel 到达时工具正在跑 | `turn/end{aborted}` 且 `tool/result{status:'cancelled'}` |
| 未知消息 | 不抛错，记 `protocol/received{summary:'unsupported'}` 继续 |
| 回归：删掉适配器包 | 内核测试全绿（证明 D11 的"边界翻译"成立） |

最后一条是整个 D11 的验收标准——**它必须作为 CI 的一个 job 长期存在**（`test:core-without-protocols`）。

---

## 10. 与已有实现的衔接

unitai.site 上已经跑着两个可复用的东西，不要重写：

| 已有 | 复用方式 |
|---|---|
| `POST /mcp`（JSON-RPC 2.0 + Bearer + 会员校验，`internal/httpapi/mcp.go`） | 作为"我们对外暴露工具"的参考实现与云端版本 |
| 工具库数据（`tool_picks` 210 条）+ MCP 查询 | 本地版通过 `ctx.market` 读离线数据包，MCP server 适配器只做协议翻译 |

这样"网站上能被 Claude Code 调的选型能力"，在本地版里变成"一个内置 MCP server"，协议契约不变，只是数据来源从 HTTP 换成离线包。
