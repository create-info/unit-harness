# UnitHarness 事件模型与钩子契约 v1

> 状态：**已定稿**（2026-11-12）。本文是 D9（事件溯源）+ D5（钩子）的落地规格，实现与 CI 均以此为准。
> 上位文档：`unit-harness-opensource-v1.md`（决策 D1–D16）
> 关联：`unit-harness-core-api-v1.md`（`ctx.hooks` / `ctx.evidence` 的签名）、`unit-harness-protocol-adapters-v1.md`（协议事件如何映射进来）

---

## 0. 一句话

**会话日志是"发生了什么"的唯一事实，钩子是"在关键节点要不要干预"的插件化入口**；两者通过 `session/*` 与 `agent/*` 两个域严格分开——回放读事实，拦截走 waterfall。

---

## 1. 两个域

| 域 | 性质 | 放什么 | 谁消费 | 是否落日志 |
|---|---|---|---|---|
| `session/*` | 持久、可回放的事实 | `turn/start`、`step/start`、`step/end`、`tool/call`、`tool/result`、`assistant/chunk`、`steering/message`、`hook/execution`、`verification/asserted` … | 回放引擎、UI 渲染、审计、证据链 | **是**，只追加 |
| `agent/*` | 实时拦截面 | `agent/pre-step`、`agent/request`、`agent/tool-pre`、`agent/tool-post`、`agent/stop` | 钩子插件（同步 waterfall，可 veto / mutate） | **否**（唯一痕迹是 `hook/execution`） |

### 边界规则

> 持久可回放的事实进 `session/*`；实时拦截和 veto 进 `agent/*`。同一个生命周期节点**不在两边镜像**——turn/step 边界是事实，只存在于会话日志里，不额外发一个 `agent/*` 事件。

**唯一例外**：`session-start` 既需要作为事实记录，又需要允许插件初始化拦截（可拒绝启动），因此它是唯一一个两端都有的点（见 §5.1 注）。

这条规则解决"钩子该订阅哪"的歧义：

| 你想做的事 | 订阅 |
|---|---|
| 记录、审计、统计、渲染、回放 | `session/*` |
| 拦截、修改、阻断、注入上下文 | `agent/*` 的 waterfall |

**反例（禁止）**：在 `agent/tool-pre` 里写数据库；在 `session/tool/call` 里做 veto。前者会破坏回放确定性，后者根本拦不住（事实已经发生）。

---

## 2. 事件基础 schema

每个事件是一个**冻结的** JSON 对象（`Object.freeze`，写入即不可改）：

```jsonc
{
  "id": "evt_01J9Z3K2M4Q8R7T6V5W4X3Y2Z1",   // ULID 前缀 evt_，全局唯一
  "session_id": "ses_01J9Z2...",              // 所属会话
  "seq": 128,                                 // 会话内单调递增，从 1 开始
  "timestamp": "2026-11-12T10:32:11.482Z",    // ISO8601 UTC，毫秒精度
  "kind": "tool/result",                      // 判别器，反序列化依据
  "source": "agent",                          // agent | user | environment | hook
  "parent_id": "evt_01J9Z3K2M4Q8...",         // 触发本事件的父事件，可空
  "payload": { }                              // 该 kind 的专属结构，见 §3
}
```

### 硬约束

| 约束 | 说明 | 违反后果 |
|---|---|---|
| `seq` 单调递增、无空洞 | 追加式写入，**日志本身就是索引**，不需要额外维护"第几条" | 回放游标错位 |
| `source` ∈ 四值 | `agent`（模型/循环产生）、`user`（人类输入，含 steering）、`environment`（协议、系统、超时等外部来源）、`hook`（钩子产生的决策与副作用） | 无法区分"谁做的决定"，审计失效 |
| `kind` 是判别器 | 反序列化时据此还原子类型，未知 `kind` 必须**保留原始 payload 继续回放**（前向兼容），不得丢弃 | 老版本读新日志时崩 |
| 只存 JSON | 不存活运行时对象（句柄、函数、流）。任何需要 Agent 句柄的操作属于 `agent/*` 实时域，不进日志 | 日志无法序列化/跨进程回放 |
| 不可变 | 写入后不得更新；"修正"用新事件表达（如 `verification/asserted` 的新结果） | 证据链失效 |
| 无同步字段 | 不得出现 `remote_id` / `synced_at`（D6） | CI 失败 |

### 可选完整性字段（`integrity`）

用于"防篡改"证据（可选开启，默认关闭以省开销）：

```jsonc
"integrity": { "prev_hash": "sha256:...", "hash": "sha256:..." }
```

`hash = sha256(canonicalJson(event 去掉 integrity))`，`prev_hash` 为同会话上一事件的 `hash`。开启后 `uh verify --chain` 可验证日志未被裁剪或篡改。**不影响回放语义**，只影响可信度声明。

---

## 3. 事件类型清单

### 3.1 `session/*`（持久事实）

| kind | source 常见值 | payload 关键字段 | 说明 |
|---|---|---|---|
| `session/start` | environment | `harness_version`, `api_version`, `isolation`, `workspace`, `model` | 会话开始，记录运行时环境快照 |
| `session/resumed` | environment | `from_seq`, `wake_reason` | 无状态实例 `wake()` 后接着消费 |
| `session/compacted` | agent | `before_tokens`, `after_tokens`, `dropped_seqs[]`, `strategy` | 上下文压缩，保留对原始事件的引用 |
| `session/end` | agent \| user | `reason`, `duration_ms` | 会话结束 |
| `turn/start` | user \| agent | `turn_index`, `trigger` | 一次用户输入到模型停止为一个 turn |
| `turn/end` | agent | `turn_index`, `stop_reason` | `stop_reason` ∈ `completed \| max_tokens \| stop_hook \| aborted \| error` |
| `step/start` | agent | `step_index`, `turn_index` | 一次模型调用 + 工具执行循环为一步 |
| `step/end` | agent | `step_index`, `status`, `duration_ms` | |
| `steering/message` | user | `text`, `injected_at_seq` | 用户在运行中插话（不打断，注入下一 step） |
| `assistant/chunk` | agent | `step_index`, `index`, `delta`, `channel` | 流式分片，见 §4.1 存储策略 |
| `assistant/message` | agent | `step_index`, `text`, `tool_calls[]`, `usage` | 分片聚合后的完整消息 |
| `llm/request` | agent | `model`, `messages_digest`, `tools_digest`, `params`, `est_tokens` | **只存摘要**，不存完整 prompt（体积与隐私） |
| `llm/response` | agent | `model`, `usage`, `finish_reason`, `response_digest`, `body_ref?` | `body_ref` 指向内容寻址的 blob（录制回放用） |
| `tool/call` | agent | `call_id`, `tool`, `args_digest`, `args?`, `isolation?` | `args?` 按工具敏感级别决定是否内联 |
| `tool/result` | environment | `call_id`, `status`, `exit_code?`, `duration_ms`, `output_digest`, `output?`, `isolation` | `isolation` 必填（见 D7） |
| `artifact/emitted` | agent | `path`, `sha256`, `bytes`, `kind` | 交付物落盘 |
| `verification/asserted` | environment | `assertion`, `result`, `detail`, `target_ref` | **验证即断言**，见 §4.2 |
| `approval/requested` | agent | `action`, `params_hash`, `expires_at` | 需要人类确认的动作 |
| `approval/resolved` | user | `requested_id`, `decision`, `decided_by` | |
| `hook/execution` | hook | `hook_name`, `event`, `mode`, `decision`, `duration_ms`, `error` | **钩子做了什么本身就是证据**，见 §5.5 |
| `scope/forked` | agent | `scope_id`, `parent_scope`, `label` | 作用域隔离（D10） |
| `scope/disposed` | agent | `scope_id` | |
| `agent/spawned` | agent | `child_session_id`, `role`, `scope_id` | 子代理 |
| `agent/finished` | environment | `child_session_id`, `status` | |
| `protocol/received` | environment | `protocol`, `method`, `message_id`, `summary` | MCP / ACP / A2A 入站 |
| `protocol/sent` | environment | `protocol`, `method`, `message_id`, `summary` | 出站 |
| `error` | environment | `scope`, `message`, `code?`, `stack?`, `fatal` | 非致命也记，`fatal` 决定是否终止会话 |

### 3.2 `agent/*`（实时拦截，不落日志）

| 事件 | 时刻 | 能否阻断 | 载荷（可变对象，插件可直接改） |
|---|---|---|---|
| `agent/request` | 组装模型请求前 | 是（可 veto / 改写消息与工具集） | `{ messages, tools, params }` |
| `agent/pre-step` | 每次 step 开始前 | 是（可 veto / 注入上下文） | `{ step_index, turn_index, context }` |
| `agent/tool-pre` | 每次工具调用前 | 是（可 veto / 改参数 / 替换工具） | `{ call_id, tool, args, isolation }` |
| `agent/tool-post` | 工具成功后 | 否（可 transform 结果） | `{ call_id, tool, result }` |
| `agent/stop` | 模型想结束时 | 是（阻止结束 + 注入 continuation） | `{ turn_index, stop_reason, continuation? }` |

**`agent/*` 不发日志**。它的决策通过 §5.5 的 `hook/execution` 事件留痕——这是"回放不重跑钩子"的技术前提。

---

## 4. 回放与存储

### 4.1 `assistant/chunk` 的存储策略

流式分片全量落盘会让日志体积膨胀 5–20 倍，而它在回放中几乎不需要逐片精度。策略：

| 模式 | 行为 | 默认 |
|---|---|---|
| `aggregate` | chunk 只进内存缓冲，step 结束写一条 `assistant/message`；`session/compacted` 后 chunk 完全丢弃 | ✅ |
| `verbose` | chunk 全部落盘（调试/复现用），`uh dev record --verbose` 开启 | — |

无论哪种模式，`assistant/message` 必须存在——回放只依赖聚合消息，chunk 是可选素材。

### 4.2 验证即断言

"交付物通过验证"这个事实**本身就是一条事件**：

```jsonc
{
  "kind": "verification/asserted",
  "source": "environment",
  "payload": {
    "assertion": { "kind": "command-exit", "cmd": "sh -n deploy.sh", "expect_exit": 0 },
    "result": "pass",                 // pass | fail | error | skipped
    "detail": { "exit_code": 0, "stderr": "" },
    "target_ref": { "artifact": "evt_...", "sha256": "..." }
  }
}
```

规则：
1. **断言必须在沙箱里执行**（D7），`tool/result.isolation` 与断言执行的隔离级别一并记录；
2. 断言失败不终止会话，但会使 `run` 状态为 `failed`（"交付物没验证通过"是**结果**，不是异常）；
3. 断言集合由插件的 `verify` 声明（D13 验证层），内核不内置业务断言；
4. 同一 `target_ref` 可有多条断言，全部 `pass` 才算通过。

### 4.3 三种回放模式

| 模式 | 目的 | LLM | 工具/执行 | 钩子 | 断言 |
|---|---|---|---|---|---|
| `replay` | 校验"结论是否可复现" | 读日志 `llm/response` | **不执行** | **不执行**，读日志 `decision` | 重算并比对 |
| `reproduce` | 复现问题现场 | 读日志（或重新调用，见下） | 重放（沙箱内） | **不执行**，读日志 `decision` | 重算 |
| `resume` | 崩溃恢复 / 续跑 | **真实调用** | 真实执行 | 正常触发（新决策） | 重算 |

关键规则（写进文档与 CLI 帮助）：

> **回放永不重新执行钩子。** 钩子的 `decision` 从 `hook/execution` 事件读取。因为钩子可能有副作用（发通知、写外部系统），重跑会破坏幂等，也会让"同一日志两次回放结果不同"。

`reproduce` 的 LLM 策略：默认读日志；若日志无 `body_ref`（未录制），则**拒绝进入 reproduce 模式并提示** `uh session replay --record-missing`，不允许静默退化成真实调用——那会让"复现"变成"重跑"。

### 4.4 崩溃恢复：无状态实例

```
任何实例：uh wake <session_id>
  → 读日志尾部 last_seq
  → 校验是否处于"进行中"（存在未配对的 turn/start 或 step/start）
  → 写 session/resumed{from_seq}，然后继续消费
```

- 不需要分布式锁：**同一 session 同时只能有一个写入者**，由日志的 `seq` 唯一约束保证（抢占式 `UPDATE sessions SET owner=?, lease_until=?`）；
- 恢复后不重放已完成 step：`step/end` 存在即跳过；
- 恢复写 `source: environment`，便于审计区分"人做的"与"系统补的"。

---

## 5. 钩子设计

### 5.1 核心立场

> **"原生钩子"不是一个特殊包，它只是一个订阅规范生命周期事件的普通插件。**

这意味着：钩子与插件走同一套 `ctx`（D3 薄封装）、同一套作用域（D10）、同一套证据记录（D13）。没有第二套机制。

### 5.2 钩子点全集

| 钩子点 | Cadence | 能否阻断 | 挂载域 |
|---|---|---|---|
| `session-start` | 会话级 | 否（但可拒绝启动，见注） | `session/*` 事实 + `agent/*` 初始化 waterfall |
| `prompt-submit` | 轮次级 | 是（可修改或拒绝） | `agent/*` waterfall |
| `pre-step` | 每 step 前 | 是（veto / mutate） | `agent/*` waterfall |
| `pre-tool` | 每次工具调用前 | 是 | `agent/*` waterfall |
| `post-tool` | 工具成功后 | 否（可 transform 结果） | `agent/*` waterfall |
| `post-tool-failure` | 工具失败后 | 否（可触发恢复） | `agent/*` 通知 |
| `stop` | 模型想结束时 | 是（阻止结束、注入 continuation） | `agent/*` waterfall |
| `session-end` | 会话结束 | 否 | `session/*` 事实 |

> **注**：`session-start` 是唯一两端都有的点。作为事实它写 `session/start`；作为初始化拦截它在 `agent/*` 上跑一次 waterfall（例如"检测到密钥缺失就拒绝启动"）。其余钩子**不得**跨域镜像。

设计原则：
1. **可变换策略（waterfall）与仅观测通知分离**。通知型钩子只收不可变快照，拿不到修改通道；
2. 通知型钩子（`post-tool-failure`）**不得**影响控制流，避免"终结性依赖监听器注册顺序"。

### 5.3 三种执行模式

| 模式 | 判定者 | 适用 | 可回放性 |
|---|---|---|---|
| **`command`（默认）** | 外部命令 / shell 脚本 | 确定性检查（阻止 `rm -rf`、schema 校验、路径检查） | 最高（decision 落日志即可复现） |
| `prompt` | 一次 LLM 调用 | 语义判断，不需要工具访问 | 中（依赖模型，需录制） |
| `agent` | 短命子 Agent | 需要读工作区才能判断 | 最低（本身有副作用，但受作用域约束） |

**原则：能用最低一档解决，就不升档。** `command` 最确定、最便宜、最可回放，应当覆盖 80% 的钩子需求。

`agent` 模式的钩子本身就是一个受作用域约束的子 Agent：它的工具调用、它的日志，与主会话分开记录（`agent/spawned` → 子 `session_id`），主会话只留 `hook/execution`。

### 5.4 退出码语义（`command` 模式）

| 退出码 | 含义 | stdout/stderr |
|---|---|---|
| `0` | **放行**。stdout 可返回 JSON `{ decision, reason, additionalContext }` | stdout 解析为 Decision；解析失败按 `continue` 处理并记 warning |
| `2` | **阻断**。 | stderr 作为反馈回传给模型（模型能看到"为什么被拒"） |
| 其他非零 | **非阻断错误**：记 `hook/execution{error}`，操作继续 | 不改变控制流 |

> ⚠️ **必须写进文档与 `uh hooks --help`**：`exit 1` 是 Unix 常规失败码，但在这里是**非阻断**的。想执行策略，**必须 `exit 2`**。
> 这一条不写清楚，第一个写钩子的人就会踩坑——他写了 `exit 1`，看到"策略没生效"却找不到原因。

超时：默认 5000ms，超时按"非阻断错误"处理并记 `hook/execution{error: timeout}`（**不**按阻断处理，避免钩子卡死锁住整个会话）。

### 5.5 钩子日志：`hook/execution`

```jsonc
{
  "kind": "hook/execution",
  "source": "hook",
  "payload": {
    "hook_name": "block-dangerous-cmd",
    "event": "pre-tool",              // 对应钩子点
    "mode": "command",                // command | prompt | agent
    "decision": { "type": "deny", "reason": "rm -rf is blocked by policy" },
    "duration_ms": 42,
    "error": null
  }
}
```

规则：
- 每次钩子执行（含放行）都写一条——否则无法区分"没拦住"和"没运行"；
- `decision` 必须**规范化后**存储（不存原始 stdout），保证回放时可直接复用；
- `prompt` / `agent` 模式的钩子若调用了模型，其 `llm/*` 事件记在钩子自己的子会话里，主会话只留这一条。

### 5.6 Decision 类型（waterfall 返回）

```ts
type Decision =
  | { type: 'continue' }
  | { type: 'mutate'; payload: unknown }        // 改写可变载荷（消息/参数/结果）
  | { type: 'deny'; reason: string }            // 阻断，reason 回传模型
  | { type: 'inject'; context: string }         // 仅 stop / pre-step：注入 continuation
```

**多个 waterfall 监听器的语义**（消除顺序依赖）：

1. 所有注册的监听器**按注册顺序串行执行**，不并行（保证 mutate 可叠加）；
2. **任何一个返回 `deny` 立即终止**，后续监听器不再执行，决策记为最早的那个；
3. 终止性**只由 `deny` 决定**，不由"谁先注册"决定——否则 A 插件注册早就能压制 B 插件；
4. `mutate` 的结果传给下一个监听器（链式），最终结果写进 `tool/call` 的 `args`。

### 5.7 注册形态（由 `ctx.hooks` 提供，见 core-api 文档）

```ts
ctx.hooks.on('pre-tool', {
  name: 'block-dangerous-cmd',
  mode: 'command',
  command: ['./scripts/guard.sh', '--json'],
  timeoutMs: 5000,
  // 仅在匹配的工具上触发；空 = 全部
  match: { tools: ['exec', 'shell'] },
})
```

- 注册走 `ctx.effect` 包装，插件卸载自动撤销（D3）；
- 钩子受 **Session 作用域**约束：A 会话注册的 `pre-tool` 不自动对 B 会话生效（D10）；
- 外部 Agent 通过 ACP / A2A 接入时，其权限请求 / 取消 / 结果回流同样映射为规范事件；跨进程钩子（如 shell 钩子桥接）只是把外部协议翻译成同一套 `agent/*` waterfall 契约，**不引入第二套语义**。

---

## 6. 存储：JSONL（P1 实现选择）

实现选了 **每个会话一个目录 + `events.jsonl` 追加写**，不是 SQLite。理由：

| 维度 | JSONL | SQLite |
|---|---|---|
| 语义匹配 | 追加流本来就是日志，与 D9 一致 | 需要自己保证"只追加" |
| 依赖 | 零（`node:fs`） | `node:sqlite` 在 Node 22 仍需实验 flag，或引 native 模块 |
| SEA 单文件 | 友好 | native 模块难打包 |
| 可审计 | `cat` / `grep` 直接看 | 需要 sqlite3 |
| 复杂查询 | 弱 | 强 |

事件格式与下面的表结构一一对应，将来迁移只是换索引层，事件本身不变。

```
~/.uh/sessions/<session_id>/
├── meta.json      # id / created_at / workspace / status / last_seq
└── events.jsonl   # 每行一个事件，append + fsync
```

## 7. 参考表结构（若迁移到 SQLite）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- ses_...
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_seq      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL,             -- active | ended | failed | aborted
  owner         TEXT,                      -- 当前写入者（抢占用）
  lease_until   TEXT,
  workspace     TEXT NOT NULL,
  api_version   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,
  id          TEXT NOT NULL UNIQUE,
  timestamp   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('agent','user','environment','hook')),
  parent_id   TEXT,
  payload     TEXT NOT NULL,               -- JSON
  integrity   TEXT,                        -- 可选哈希链
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(session_id, kind, seq);
CREATE INDEX IF NOT EXISTS idx_events_parent ON events(parent_id);

CREATE TABLE IF NOT EXISTS blobs (
  sha256      TEXT PRIMARY KEY,
  bytes       INTEGER NOT NULL,
  path        TEXT NOT NULL,               -- 内容寻址，相对 ~/.uh/blobs
  created_at  TEXT NOT NULL
);
```

**注意**：核心表**不含** `remote_id` / `synced_at`（D6）。同步状态在 `sync` 插件的 `sync_state` 表。

写入路径（唯一入口，插件不得绕过）：

```
ctx.evidence.append(kind, payload, { source, parentId })
  → 校验 kind 在 events.v1.json 白名单内
  → 校验 payload 符合该 kind 的 schema
  → 事务内 last_seq + 1，写 events，更新 sessions.last_seq
  → 返回已冻结的事件对象
```

---

## 8. JSON Schema 骨架（`schema/events.v1.json`）

```jsonc
{
  "$id": "https://unit-harness.dev/schema/events.v1.json",
  "type": "object",
  "required": ["id", "session_id", "seq", "timestamp", "kind", "source", "payload"],
  "additionalProperties": false,
  "properties": {
    "id":         { "type": "string", "pattern": "^evt_[0-9A-HJKMNP-TV-Z]{26}$" },
    "session_id": { "type": "string", "pattern": "^ses_[0-9A-HJKMNP-TV-Z]{26}$" },
    "seq":        { "type": "integer", "minimum": 1 },
    "timestamp":  { "type": "string", "format": "date-time" },
    "kind":       { "type": "string", "enum": [ /* §3.1 全部 kind */ ] },
    "source":     { "enum": ["agent", "user", "environment", "hook"] },
    "parent_id":  { "type": ["string", "null"] },
    "integrity":  { "type": "object" },
    "payload":    { "type": "object" }
  },
  "allOf": [
    { "if": { "properties": { "kind": { "const": "tool/result" } } },
      "then": { "properties": { "payload": { "required": ["call_id", "status", "isolation"] } } } }
    /* 其余 kind 的 payload 约束同名式追加 */
  ]
}
```

**前向兼容规则**：`payload` 允许额外字段（`additionalProperties: true`），未知 `kind` 的事件整体保留、原样回放。这让"新版本写的日志被旧版本读取"不会崩——对一个要长期保存证据的工具来说，这是必需项。

---

## 9. 验收（写进测试）

| # | 断言 | 方式 |
|---|---|---|
| 1 | `seq` 无空洞、单调 | 随机生成 1000 事件后校验 |
| 2 | 同 `session_id` 并发写只有一个成功 | 两个进程争 lease，断言一方失败 |
| 3 | 未知 `kind` 可原样回放 | 注入伪造 kind，跑 replay 不抛错 |
| 4 | `replay` 模式不执行任何工具与钩子 | 用会写文件的假工具，断言文件未产生 |
| 5 | 钩子 `exit 2` 阻断、`exit 1` 不阻断 | 三个脚本各跑一次，断言 `hook/execution.decision` |
| 6 | 钩子决策从日志读取，不重跑 | 修改日志里的 decision 后 replay，行为随之改变 |
| 7 | `verification/asserted` 在 replay 下重算结果一致 | 同一日志跑两次，断言两条结果相等 |
| 8 | `agent/*` 事件不产生 `events` 行 | 跑满一轮后统计 `kind LIKE 'agent/%'` 为 0 |
