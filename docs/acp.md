# ACP 服务端

```bash
uh acp
```

stdio JSON-RPC，让编辑器（Zed、JetBrains 那一类）把我们当子进程起、用聊天面板驱动。

## 和 A2A 的区别不是传输，是谁在问

| | A2A | ACP |
|---|---|---|
| 对面 | 另一个 agent / 编排器 | 编辑器里的**人** |
| 审批 | 一律拒绝（没人在终端前） | **发 `session/request_permission` 问客户端** |
| 会话 | `Task` 从日志推导 | `sessionId` 直接是我们的会话 id |

最后一条意味着：ACP 会话在 `uh session list` 里同样看得见，回放、undo、checkpoints 全都照常可用。不是另一套东西套了个壳。

## 审批门在这里反着走

A2A 的任务没人能点确认，所以默认拒绝。ACP 的对面是真人在编辑器里，他**能**点，所以 gate 发反向请求出去等回复：

```
Agent → Client: session/request_permission { toolCall, options: [allow, deny] }
Client → Agent: { outcome: { outcome: 'selected', optionId: 'allow' } }
```

超时或客户端不回 → 按拒绝处理。**绝不默认放行**——这条在两种协议里是同一个原则，只是表现不同。

## 三条实现纪律

### 1. stdout 只能有协议帧

混进一个日志行，客户端就解析失败，表现是「连上了但没反应」。

这不是靠「记得别 log」能守住的。第一次实测就踩了：Harness 自己的 `[uh:info] provider...` 走了 `console.log`，直接污染协议通道。修法是给 Harness 加 `logToStderr` 选项，让**默认行为本身**分得清，而不是在每个调用点小心。

### 2. 取消不是错误

收到 `session/cancel` 后必须回 `stopReason: 'cancelled'`。把 abort 抛出来的异常原样丢给客户端，会在界面上显示成报错——而用户只是按了停止。

规范里还特别提醒：客户端往往把未识别的错误原样弹给用户，所以 agent 必须 catch 住 abort 类异常并翻译成 `cancelled`。代码里对 `abort|interrupt|cancel` 做匹配，真失败仍然走 `-32603`。

### 3. tool/call 与 tool/result 要自己配对

事件流里这两个**没有共同的 id**（只有工具名和 argv）。不配对的话客户端看到工具永远停在 `in_progress`，用户以为卡住了。按「第 N 个 call 配第 N 个 result」处理。

## 能力声明要诚实

`initialize` 回的 `agentCapabilities`：

```json
{ "loadSession": false, "promptCapabilities": { "image": false, "audio": false, "embeddedContext": true } }
```

`loadSession: false` 是因为没实现——声明了客户端就会来调 `session/load`，然后拿到 `-32601`。
`embeddedContext: true` 是真的：`session/prompt` 里的 `resource` 块会被内联进任务文本（只给 uri 模型看不见文件内容）。

## 验证

```bash
node --test tests/acp.test.mjs
```

13 个测试钉住：stdout 每一行都是合法 JSON-RPC、取消回 `cancelled` 而非错误、真失败仍报错、未知 session 不被静默接受、空 prompt 是 invalid params、资源被内联、坏 JSON 不断连接、`session/cancel` 真的传到 harness。

另有 `uh acp` 的真进程验证（`/tmp/acp3.py` 那种脚本）：起进程 → `initialize` → `session/new` → `session/prompt` → 收到 `session/request_permission` → 客户端批准 → 工具执行 → `tool_call_update completed` → `stopReason: end_turn`。

**这个探测过程中发现的「prompt 不返回」不是 bug**，是审批门在等客户端回复——而探测脚本当时没实现客户端侧。补上应答后立刻通过。这类「看起来卡住、其实是协议在等你」的情况，值得在接任何双向协议时先想到。
