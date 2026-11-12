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

`uh exec -- <命令>` 在沙箱里跑单条命令，排查"到底为什么失败"时很好用。

**步骤由模型决定，边界由沙箱决定。**

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
