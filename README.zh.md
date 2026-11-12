# UnitHarness

**会自证结果的 agent。**

它交给你的每一份产物，都在沙箱里真跑过；每一次运行都可回放。验证不过，就不算完成。

> 状态：`v0.1.0` —— Linux 上 landlock 隔离已生效（通过一个小型 C helper）。
> 文件写入被限制在工作区，`$HOME` 不可读，TCP 可禁用。macOS / Windows 的施加仍未实现，
> 这两个平台保持 fail-closed。用 `uh sandbox check` 自己验证。

---

## 为什么做这个

编码类 agent 止步于「生成」：写完脚本交给你，能不能跑是你的事。

UnitHarness 把**验证**做成一等公民：

| | 常见 agent | UnitHarness |
|---|---|---|
| 输出 | 文本 / diff | 交付物 + 断言 |
| 成功标准 | 「看着对」 | `verification/asserted` 事件 |
| 失败发现者 | 你 | 沙箱 |
| 审计 | 无 | 追加式事件日志，可回放 |
| 花钱动作 | 静默执行 | 审批门禁 |

## 安装

```bash
# macOS / Linux —— 单个静态二进制，不需要装 Node
curl -fsSL https://raw.githubusercontent.com/create-info/unit-harness/main/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/create-info/unit-harness/main/install.ps1 | iex
```

Linux 的二进制里**内嵌了 landlock helper**，首次运行时自动释放到 `~/.uh/bin/`，
不需要再装任何东西。走源码也行：

```bash
git clone https://github.com/create-info/unit-harness.git
cd unit-harness
npm i -g .        # 自动构建，并把 uh 链接进 PATH
uh doctor
```

## 快速开始

```console
$ uh doctor
UnitHarness 0.1.0  (node v22.22.3)
platform    darwin/arm64  kernel=24.6.0
isolation   seatbelt
enforcement seatbelt via /usr/bin/sandbox-exec; writes limited to ~/.uh/work; home unreadable
...
model       qwen3.8-27b  @ http://127.0.0.1:1234/v1  (discovered:LM Studio)

$ uh sandbox check
PASS  write inside workspace  (expected ok, got ok)
PASS  write outside workspace (expected deny, got deny)
PASS  read $HOME/.gitconfig   (expected deny, got deny)
PASS  write to /etc           (expected deny, got deny)

4/4 checks passed
```

`uh doctor` 显示 `model none` 的话，起一个 LM Studio 或 Ollama 就行，
或者导出 `UH_BASE_URL` / `UH_MODEL` / `UH_API_KEY`。

`build:native` 是可选的：不做的话 `exec` 报无隔离并拒绝执行（fail-closed）。

```console
$ node dist/uh.cjs doctor
UnitHarness 0.1.0  (node v22.22.3)
platform    linux/arm64  kernel=6.17.0-1008-nvidia
isolation   landlock-v7 (platform=linux/arm64, kernel=6.17.0-1008-nvidia)
enforcement landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable
```

而且不是"相信"，是能验证：

```console
$ node dist/uh.cjs sandbox check
isolation: landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable

PASS  write inside workspace  (expected ok, got ok)
PASS  write outside workspace  (expected deny, got deny)
PASS  read $HOME/.gitconfig  (expected deny, got deny)
PASS  write to /etc  (expected deny, got deny)

4/4 checks passed
```

没有任何隔离后端时，`exec` 直接拒绝执行：

```console
$ node dist/uh.cjs tool hello
E_SANDBOX_UNAVAILABLE: current isolation is "none". Refusing to execute (fail-closed).
```

## 支持的模型

```console
$ uh provider list
config: ~/.uh/config.json

  id           provider              key           model                     state
  deepseek     DeepSeek              (none)        —                         no key
  anthropic    Anthropic (Claude)    (none)        —                         no key
  openai       OpenAI                (none)        —                         no key
  ...
  ollama       Ollama (local)        —             qwen3.6:latest            running
  lmstudio     LM Studio (local)     —             qwen3.8-27b               running
```

```bash
uh config set deepseek        # 输入 API key，不回显，存成 0600
uh config use deepseek        # 设为默认
uh config set deepseek.model deepseek-v4-flash
uh run --provider anthropic "…"
```

**模型名不硬编码**：`deepseek-chat` / `deepseek-reasoner` 已经在 2026 年 7 月退役，
写死的列表一定会过期。真实模型列表是运行时从各家的 `/models` 拉的。

**两套协议**：OpenAI 兼容（`/chat/completions`）和 Anthropic Messages（`/v1/messages`）。
差异——system 是顶层参数、用 `input_schema` 而不是 `parameters`、`tool_use`/`tool_result`
内容块、`x-api-key` 认证——全部在 `llm/anthropic.ts` 里吸收，内核只认自己的
`CompletionResult`。

**密钥不外泄**：存成 0600，所有输出里打码成 `sk-a…1234`，并且有测试断言 key 字符串
不会出现在事件日志里。

## 跑一个任务

```console
$ uh run "在工作区创建一个 hello.txt，内容写 hi from unit-harness，然后用 ls 确认"
workspace: /home/you/.uh/work
isolation: landlock-v7 via ~/.uh/bin/landlock-helper; writes limited to ~/.uh/work; home unreadable

· turn start
· step 1
  → qwen3.8-27b
  ← 1 tool call(s), 775 tokens
  ⚙ run_command: sh -c printf 'hi from unit-harness\n' > hello.txt && ls -la
  ✓ exit=0
· step 2
  → qwen3.8-27b
  ← 1 tool call(s), 706 tokens
  ⚙ run_command: cat hello.txt
  ✓ exit=0
· step 3
  → qwen3.8-27b
  ← 0 tool call(s), 837 tokens
· turn end (model, 3 steps)

--- answer ---
完成 ✅
- 已在工作区创建 hello.txt，内容为 hi from unit-harness
- ls -la 确认文件存在

--- deliverables (1) ---
  ✓ hello.txt                    21 B  3/3  sha256=3f2a1b2c9d8e
```

交付物那一段**不是模型的自述**，而是跑前跑后对比工作区、对新文件算哈希、再在沙箱里
执行断言得出的：

| 文件类型 | 自动执行的断言 |
|---|---|
| 任意 | 存在 · 非空 · sha256 匹配 |
| `.sh` | `sh -n`（语法检查） |
| `.json` | 能被解析 |
| `.py` | `python3 -m py_compile` |

任一断言失败，`uh run` 退非零。运行时被**删除**的文件会记成 `error` 事件。

如果你开着 LM Studio（`:1234`）或 Ollama（`:11434`），**不需要任何 API key**——
`uh` 会探测这两个默认端口并取第一个模型。否则指向任何 OpenAI 兼容服务：

```bash
export UH_BASE_URL=https://api.deepseek.com/v1
export UH_MODEL=deepseek-chat
export UH_API_KEY=sk-...
uh run "看看工作区里有什么"
```

## 它是怎么想事情的

系统提示词不是一句写死的话，而是分段拼装的（和 Codex 同构）：

| 段 | 内容 |
|---|---|
| base | 身份、行为准则、汇报方式（不接受"看起来对"，只接受"我跑过了"） |
| `environment_context` | 工作区、平台、**真实**的沙箱强度、网络、日期 |
| `tool_guidance` | 每个工具什么时候用、什么时候别用 |
| `project_instructions` | 从工作区向上找的 `AGENTS.md` / `CLAUDE.md`，越近越优先 |

内置工具刻意很少，每个都有契约：

- **`apply_patch`** —— 用 `*** Begin Patch` 补丁增删改文件，**原子执行**：任一 hunk
  匹配失败，一个字节都不落盘。上下文匹配宽容（忽略空白），因为模型给的上下文行
  经常不精确。
- **`run_command`** —— argv 数组而不是 shell 字符串；真需要 shell 语法就写
  `["sh","-c","..."]`。每一次调用都过沙箱。
- **`update_plan`** —— 模型的计划唯一可见的地方，同一时刻只有一个 in_progress。

### 长任务

上下文接近窗口上限时（`--max-context`，默认 32000 tokens），早期的轮次会被替换成摘要
——就是 Codex 在 provider 没有远程压缩能力时走的本地摘要那条路。

三条规则让它是安全的：

1. 用户的原始请求逐字保留——那是授权事实，摘要不许改写它；
2. 失败过的尝试写进摘要，避免模型自信地再踩同一个坑；
3. 保留的尾部必须从 assistant 边界开始，否则 `tool` 消息会失去配对的 `tool_calls`，
   Anthropic 会直接 400。

只在"还有活要干"的时候压缩——压缩最后一步的上下文纯属浪费一次调用。每次压缩都是一个
`session/compacted` 事件，回放时能准确看到模型忘掉了什么。

`uh exec -- <命令>` 在沙箱里跑单条命令，排查"到底为什么失败"时很好用。

**步骤由模型决定，边界由沙箱决定。**

## 循环替你做掉的事

这几件是从 Codex 和 DeepSeek Harness 里特意抄来的，因为它们直接决定 agent 能不能干完一件真事：

- **流式输出**。token 到一点打一点（SSE）。推理模型的思考走 stderr，`UH_VERBOSE=1` 才显示，
  绝不混进正文。对面忽略 `stream: true` 直接回整包 JSON 也能正常解析，不会报错。
- **截中间，不丢尾巴**。长输出保留头和尾——错误都在结尾——完整内容落盘到 `.uh/output/`，
  路径交给模型，需要时它能自己回去读被省略的那段。
- **工具输出预算**。给模型 2 万字符，其余留在磁盘上。
- **压缩**。到上下文预算 70% 触发，且只在「还有活要干」时压。

## 远端主机

```console
$ uh host add prod ubuntu@203.0.113.10 --key ~/.ssh/id_ed25519
$ uh host test prod
✓ prod  Linux 6.8.0-117-generic x86_64 · ubuntu  (657ms)

$ uh exec --host prod -- df -h /
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda2        40G  7.6G   31G  20% /
```

`hosts.json` 里存的是**私钥路径**，不是私钥。只要配了至少一台，agent 就会多出
`remote_exec` 工具，能真的去操作一台服务器。

三条规矩，因为那是别人的生产机：

| 命令 | 行为 |
|---|---|
| 只读（`df`、`ps`、`journalctl`、`systemctl status`、`docker ps`） | 直接执行 |
| 改状态（`mkdir`、`npm i`、`systemctl restart`、`echo > 文件`） | 默认拒绝，要 `--allow-remote-write` |
| 毁灭性（`rm -rf /`、`dd`、`mkfs`、`shutdown`、`curl … \| sh`） | 默认拒绝，要 `--allow-remote-destructive` |

远端执行**故意绕开本地沙箱**——ssh 必须读私钥，而沙箱正是让 `~/.ssh` 不可读的那道墙。所以它
是一个独立工具：凭据不经过模型，每次调用记 `isolation: "none"` + `scope: "remote"`，绝不冒充
landlock 生效。

分级靠模式匹配，一定有漏网之鱼——它是多一道闸，不是保证。真正的保证是审计：每一次尝试
（包括被拒的）都在事件日志里。

## 剧本

`uh run "..."` 让模型自己判断什么叫完成；`uh do <剧本>` 不让：

```console
$ uh do node-service
recipe: node-service
vars:   port=8731

--- deliverables (1) ---
  ✓ server.mjs  1223 B  3/3

--- checks ---
  ✓ server.mjs 已创建   1223 B
  ✓ 服务能起来且 /healthz 返回 200   exit 0
```

验收单是**我们的，不是模型的**：它在沙箱里真的把服务起起来、探端口、再杀掉，没响应就是失败。
模型说"完成了"不算证据，一个会回应的端口才算。

内置 `node-service`、`python-cli`。自己的剧本丢进 `~/.uh/recipes/*.json`（形状同
`packages/core/src/recipe/builtin.ts`），同名覆盖内置。

端口之类的参数是 `{{变量}}`，用 `--set port=9000` 覆盖。内置检查目前经由 `sh` 执行，
所以只在 POSIX 上可用；失败会报成 `error`，不会静默算通过。

## 桌面应用

| 平台 | 安装包 |
|---|---|
| macOS（Apple Silicon） | `UnitHarness_0.1.0_aarch64.dmg` |
| Windows x64 | `UnitHarness_0.1.0_x64-setup.exe` / `.msi` |
| Linux x64 | `UnitHarness_0.1.0_amd64.deb` / `.AppImage` |

用 Tauri 构建，macOS 上约 36 MB。壳刻意做得很薄：把内置的 `uh` 二进制作为 sidecar 拉起
（`uh serve`），等端口通了再把窗口导航过去。**界面只有一份实现**——就是 CLI 服务的那张
静态页——所以桌面端和 CLI 不可能走岔。退出时壳会杀掉 sidecar，不留下占端口的孤儿进程。

安装包**没有签名**：macOS 首次打开要右键 → 打开，Windows 会弹 SmartScreen。签名需要证书，
这是分发问题不是代码问题。

## 桌面界面

```console
$ uh desktop
UnitHarness UI  http://127.0.0.1:7878  (opened in your browser)
```

二进制自己起的本地 UI——和 DeepSeek Harness 的形态一致（`apps/web` + `host/webserver`）：
一个绑在 `127.0.0.1` 的 HTTP 服务、一张静态页、事件走 SSE。没有 Electron，没有前端构建，
没有第二个要守护的进程，macOS / Linux / Windows 表现完全一致。

你看到的就是证据本身：每一步、每次工具调用（带确切 argv）、计划更新、压缩，跑完后是交付物
清单和断言计数、sha256。历史会话从 CLI 写的同一份事件日志回放。

## Skills

```console
$ tree .uh/skills
.uh/skills/
└── deploy-check/
    └── SKILL.md
```

```markdown
---
name: deploy-check
description: Verify a deployment actually took effect
---

# Deploy check
1. curl 健康检查端点
2. 把 /status 里的 git sha 和你部署的那个比对
```

扫描 `.uh/skills`、`.agents/skills`、`~/.uh/skills`（就近优先）——和 DeepSeek Harness 同一组根。

**索引**（名字 + 一句话）常驻 prompt，**正文**只在模型调 `use_skill` 时才加载。这个分工是全部
意义所在：五十个 skill 的全文会吃光窗口，但五十行名字能让模型知道"有什么可用"。

## MCP

```console
$ uh mcp list
config: ~/.uh/mcp.json

✓ filesystem  (stdio)  14 tool(s)

  mcp__filesystem__read_file
      [MCP:filesystem] Read a file (runs outside the local sandbox)
```

配置格式和 Claude Desktop 一致，你在那边跑的 server 直接能用——全局
`~/.uh/mcp.json`，项目级 `./.uh/mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "authorization": "Bearer …" } }
  }
}
```

stdio 和 streamable-HTTP 两种传输都支持。

```console
$ uh mcp add unitai https://unitai.site/mcp --header authorization
authorization value (input hidden): ********
$ uh mcp test unitai
✓ unitai  (http)  7 tool(s)
```

`uh mcp add` 要求输入 token 时不回显、写 `~/.uh/mcp.json` 时权限 0600；`uh mcp test` 打印
真实的握手错误（401 会告诉你去哪拿 token），而不是甩一段堆栈。见 [`docs/unitai.md`](docs/unitai.md)。

**MCP server 不在沙箱里。** 它们是独立进程，拥有你本人的全部权限——landlock 和
seatbelt 管不到它们。所以：工具名带 `mcp__<server>__<tool>` 前缀，`uh doctor` 会带警告
列出来，每次调用在事件里记 `isolation: "none"` 而不是继承沙箱等级。如果某次 MCP 调用
删了东西，日志不会假装它被隔离住了。

## 每次运行都是证据

没有静默发生的事。每个会话写一份追加式 JSONL 日志：

```console
$ node dist/uh.cjs session show ses_01M77JP1...
#  1  session/start          environment  {"workspace":"~/.uh/work","isolation":"landlock-v7",...}
#  2  tool/call              agent        {"tool":"exec","argv":["sh","-c","echo ok > ./sb-check.txt"],...}
#  3  tool/result            environment  {"tool":"exec","status":"ok","exit_code":0,"isolation":"landlock-v7",...}
#  4  verification/asserted  environment  {"assertion":{"kind":"sandbox-probe","name":"write inside workspace",...}
```

断言可以事后只凭日志重跑：

```console
$ node dist/uh.cjs session replay ses_01M77JP1...
SAME  write inside workspace  recorded=ok now=ok
SAME  write outside workspace  recorded=deny now=deny
SAME  read $HOME/.gitconfig  recorded=deny now=deny
SAME  write to /etc  recorded=deny now=deny

4 reproduced, 0 diverged
```

`replay` **不会重跑钩子**（钩子可能有副作用），只读日志里记录的决策。
任一结果不一致即退非零。

## 插件

一切皆插件，从 `~/.uh/plugins/<name>/index.js` 加载：

```js
export default {
  name: '@example/hello',
  apiVersion: 1,
  apply(ctx) {
    ctx.tools.register({
      name: 'hello',
      description: 'Say hello',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async handler() {
        const r = await ctx.exec.run(['sh', '-c', 'echo hi'])
        return { content: `hi (isolation=${r.isolation})` }
      },
    })
  },
}
```

见 [`examples/plugin-hello`](examples/plugin-hello)。插件**零运行时依赖**：
不 import cordis，也不 import 本包的运行时值。

## 架构

```
L1 运行时     agent 循环、turn、模型调用
L2 执行层     exec / fs / net —— 唯一有副作用的地方
L3 验证层     断言（退出码、schema、哈希）
L4 证据层     追加式事件日志、内容寻址 blob、回放
L5 插件层     只经 @unit-harness/core；可加验证器，不能绕过 L3
L6 分发层     CLI / 桌面壳、签名产物
```

依赖单向流动：`插件 → 验证 → 执行 → 证据`。反向依赖 CI 直接失败。

设计与决策记录见 [`docs/`](docs)。

## 沙箱

| 平台 | 机制 | 状态 |
|---|---|---|
| Linux | landlock（`native/landlock-helper`，C） | **已实现**，CI 验证 |
| macOS | seatbelt（`/usr/bin/sandbox-exec` + sbpl） | **已实现**，`macos-latest` 上 CI 验证 |
| Windows | 受限令牌 + Job Object | **未实现**——报 `path-guard`，拒绝执行 |

Linux 上 landlock 实际给了什么：

- 写入**只能**在工作区（默认 `~/.uh/work`）与 `~/.uh`
- `$HOME` **不可读**，除非显式 `--allow-home`——这是挡住 `~/.ssh`、`~/.aws` 的关键
- `--no-net` 可禁 TCP（landlock 管不了 UDP，我们如实说明，不含糊）
- 系统路径（`/usr`、`/lib`、`/etc`、`/proc`…）需要可读，否则 shell 和运行时起不来

全部不可用时 **fail-closed**。我们绝不静默降级。

**一个刻意的例外**：解释器与包管理器目录是**可读**的（`~/.nvm/versions`、
`~/.pyenv/versions`、`~/.cargo/bin`，以及你实际调用的那个 venv 根）。一个
`python3` 都起不来的沙箱不是安全，是没用——第一次读 `pyvenv.cfg` 就会失败，所有脚本
跟着死。凭据路径（`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.cargo/credentials*`、
`~/.netrc`、`~/.git-credentials`）仍然不可读，`uh sandbox check` 会证明这一点。

macOS 上保证同构：用 sbpl profile 实现 `(deny file-write*)` 后只放行工作区与 `~/.uh`，
对 `$HOME` 加 `(deny file-read* …)`，`--no-net` 时 `(deny network*)`。
`uh sandbox check` 在两个平台跑的是同一组四条探针——所以"保证"是同一个保证。

Windows 还没有内核级隔离，因此报 `path-guard` 并拒绝执行，除非显式
`--allow-unconfined`。宁可给一个真实的"不"，也不给一个舒服的"应该可以"。

注：bwrap 会被探测到，但在 `apparmor_restrict_unprivileged_userns=1` 的内核上
（Ubuntu 23.10+）无法创建 user namespace，因此不作为施加路径；landlock 没有这个前提。

## 基于 Cordis

UnitHarness 构建于 [Cordis](https://github.com/cordisjs/cordis)（MIT），
DeepSeek Harness 使用的同一个插件框架。我们以普通 npm 依赖的方式使用它，不做 fork。
感谢 DeepSeek 团队的开源。

## 路线图

| 阶段 | 范围 | 状态 |
|---|---|---|
| P0 | 内核、插件加载、沙箱探测、fail-closed exec、CLI | ✅ 完成 |
| P1 | landlock 施加 + `sandbox check` | ✅ 完成 |
| P1 | 事件日志（`session/*`）、断言、回放 | ✅ 完成 |
| P1 | agent loop + `uh run`（零配置探测本地模型） | ✅ 完成 |
| P1 | 交付物识别 + 自动断言（proves its work） | ✅ 完成 |
| P2 | macOS seatbelt / Windows 受限令牌、桌面壳 | — |
| P2 | 桌面壳、数据包、巡检 | — |
| P3 | 协议适配器（MCP / ACP / A2A） | — |

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
