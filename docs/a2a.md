# A2A 服务端

```bash
uh a2a --port 9300
```

把当前工作区暴露成一个 A2A agent。别的 agent 通过 AgentCard 发现它，用 `SendMessage` 派活，
用 `GetTask` 查进度。

## v1.0 和 v0.x 差得比想象中大

照旧文档（v0.x）写会连不上新客户端：

| | v0.x | v1.0 |
|---|---|---|
| 方法名 | `message/send`、`tasks/get` | `SendMessage`、`GetTask` |
| 状态枚举 | `working`、`completed` | `TASK_STATE_WORKING`、`TASK_STATE_COMPLETED` |
| 能力声明 | `url` + `preferredTransport` | `supportedInterfaces[]`（含 `protocolBinding`） |
| 发现 | `/.well-known/agent.json` | `/.well-known/agent-card.json` |

我们**两个发现路径都答**（旧客户端不至于 404），但只按 v1.0 的形状回。

## 为什么是 server

MCP 我们是 client（用别人的工具），ACP 和 A2A 我们是 server（别人来用我们）。

A2A 的 `Task` 和我们的事件日志几乎是一对一的：

| A2A | 我们 |
|---|---|
| `Task.id` | 会话 id（`ses_...`） |
| `Task.status.state` | 从 `events.jsonl` 现场推导 |
| `Task.history` | `turn/start` 的 task + `assistant/message` + `steering/message` |
| `Task.artifacts` | `artifact/emitted` + `verification/asserted` |
| `Task.metadata` | workspace、事件数、来源 |

**关键决定：Task 不是内存对象，是从日志现场推导的。**

所以 A2A 服务重启、或者任务是由 `uh run` 在另一个进程里跑的，`GetTask` 一样答得对。
不需要另建一套状态存储——状态本来就在日志里。

## 状态映射

```ts
TASK_STATE_SUBMITTED       刚收到，还没有任何事件
TASK_STATE_WORKING         有事件但没有 turn/end
TASK_STATE_COMPLETED       turn/end + session/end
TASK_STATE_FAILED          stop_reason 是 error，或出现 error 事件
TASK_STATE_CANCELED        session/interrupted，或 stop_reason 是 interrupted
TASK_STATE_INPUT_REQUIRED  有 approval/requested 但没有对应的 approval/resolved
TASK_STATE_REJECTED        被策略拒绝且这一轮没跑完
```

`INPUT_REQUIRED` 这条值得单独说：**我们的审批门天然就是这个状态**。

有 `approval/requested` 却没有 `approval/resolved`，说明任务卡在等人确认——对别的 agent
来说这正是"需要输入才能继续"。不用另造一套状态机去表达审批。

## 鉴权

默认只听 `127.0.0.1`，没有鉴权。

把 agent 暴露到公网是用户的决定，不该是默认行为。真要对外：

```bash
uh a2a --host 0.0.0.0 --token "$(openssl rand -hex 24)" --public-url https://agent.example.com/
```

开了 `--token` 才在卡上声明 `securitySchemes`——**声明了却不校验，比不声明更糟**。

发现端点（`/.well-known/agent-card.json`）不需要令牌：客户端得先拿到卡才知道要怎么鉴权。

## 外部任务的审批

从 A2A 进来的任务没有人在终端前点确认，所以 `gate` 一律拒绝，并把尝试记进日志。

这看着保守，但对比一下：默认放行等于让任何一个能连上这个端口的人，
通过一条 A2A 消息在本机跑毁灭性命令。宁可任务失败得难看一点。

任务超过 `--max-seconds`（默认 1800）会被 abort，防止外部把机器占死。

## 明确不做的事

- **pushNotifications**：要有公网可回调的地址和重试队列。做一半只会让对方等一个永远不来的
  回调，所以卡上声明 `false`。
- **streaming**：`SendStreamingMessage` 明确返回 `-32004`，不挂起不装忙。
  客户端按卡上的 `streaming: false` 就该走 `SendMessage` + 轮询 `GetTask`。
- **多轮续跑**：带 `taskId` 的消息只会返回当前状态。真正的多轮（同一个 task 里继续追加指令）
  还没做，这一点在代码里如实拒绝而不是假装接受。

## 验证

```bash
node --test tests/a2a.test.mjs
```

19 个测试，覆盖：

- 状态推导的每条分支（含审批未决 → `INPUT_REQUIRED`，批准后回到 `COMPLETED`）
- history 能还原用户原始指令（这是实测发现的缺陷：`turn/start` 以前没记 task）
- artifacts 带验证结果，且**没验证过的文件不会假装有**
- 协议错误码：未知方法 `-32601`、未知 task `-32001`、不可取消 `-32002`、不支持流式 `-32004`
- REST 绑定：`GET /tasks/{id}`、`POST /message:send`
- 令牌校验：没有令牌时 `/tasks` 是 401，发现端点仍可访问
