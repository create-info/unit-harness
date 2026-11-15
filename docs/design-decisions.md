# UnitHarness 正式评审与决策记录 v1

> 状态：**已定稿**（2026-11-12）。本文件是 `unit-harness` 的技术决策基线，开工前不得推翻；如需变更，追加 ADR 而不是改写本文。
> 取代：`unit-harness-opensource-v1.draft.md`（草稿中"vendor Cordis""插件能力声明作为安全边界""Node/Bun 未定"三处结论已作废）。
> 配套：`unit-harness-core-api-v1.md`、`unit-harness-event-model-v1.md`、`unit-harness-protocol-adapters-v1.md`、`unit-harness-release-v1.md`

---

## 0. 决策索引

| ID | 决策 | 关键词 | 不可逆性 |
|---|---|---|---|
| D1 | 定位为「验证闭环」，不做插件化内核叙事 | the agent that proves its work | 高 |
| D2 | 全栈 Node，不用 Bun、不混用 | Node 22 LTS baseline | 高 |
| D3 | Cordis 走 npm 依赖 + `pnpm patch` + 薄封装 | 不 vendor | 中 |
| D4 | 插件 API 分级承诺（experimental / public） | 毕业制 | 高 |
| D5 | 插件完全信任 + 签名白名单 | 不假装有边界 | 中 |
| D6 | 核心 schema 不含同步字段 | sync 归插件 | 中 |
| D7 | 沙箱降级链 + fail-closed | 绝不静默降级 | 高 |
| D8 | 内核 = 厚护甲 + 可嵌入循环 | Claude Code + Codex | 高 |
| D9 | 状态 = 不可变事件日志 | OpenHands 事件溯源 | 高 |
| D10 | 插件能力受作用域约束 | DSH scope | 中 |
| D11 | MCP / ACP / A2A 各自为独立适配器包 | 边界翻译 | 中 |
| D12 | 内核与壳分离 | OpenCode | 高 |
| D13 | 六层架构 + 单向依赖 | 运行时/执行/验证/证据/插件/分发 | 高 |
| D14 | 传输层可插拔 | stdio JSON-RPC + HTTP/SSE | 低 |
| D15 | 分发对齐 Codex 供应链 | musl + aarch64 + sigstore + npm 分包 | 中 |
| D16 | 命名与许可 | unit-harness / @unit-harness / uh / Apache-2.0 | 高 |

---

## D1 · 定位：验证闭环

**决策**：对外定位为「**the agent that proves its work**」——它交付的每一份产物都在沙箱里真跑过，每一步都可回放，每一个花钱动作都有审批证据。

**背景（实测）**：

```
DeepSeek Harness  license: MIT  stars: 279,243  description: "DeepSeek Harness: Everything is a Plugin."
```

**理由**：

1. 在"插件化内核"赛道没有胜算：对手 27.9 万 star、MIT、npm 上已有 60+ 包、文档完备。跟随者的最优结果是"另一个选择"，不是"更好的选择"。
2. 验证闭环是**空位**：Codex / Claude Code / DSH 都止步于"生成 + 用户自行验证"。把验证做成一等公民，需要的是证据层与沙箱，而不是更聪明的模型——这是工程问题，我们能赢。
3. 定位与商业模型同构：验证 → 需要沙箱 → 沙箱要隔离与托管 → 托管是付费点。叙事和技术不脱节。
4. 验证可度量（"这份交付物的 sha256 通过了哪些断言"），可度量才能被讨论、被引用、被 star。

**否决的替代定位**：

| 替代方案 | 否决理由 |
|---|---|
| 又一个插件化 agent 内核（DSH 路线） | 27.9 万 star 的正面竞争，且我们复用其框架，等于自证是衍生品 |
| 垂直创业助手（"AI 创业顾问"） | 受众窄、海外社区无法理解、无技术护城河可讲，star 上限极低 |
| 通用 coding agent（Codex 路线） | 需要模型训练与超大规模评测，做不了 |
| Agent 可观测平台 | 只观测不验证，是 D1 的一半，且与 OpenTelemetry 系正面撞 |

**后果**：
- README 第一行、issue 模板、首个 demo 动图，都必须展示"验证通过"；
- 内核必须有"没验证就不能结束"的机制（见 D13 验证层），不能只写在文档里；
- 插件作者的第一课是"如何写验证器"，不是"如何写工具"。

---

## D2 · 运行时：全栈 Node

**决策**：全栈 Node，baseline **Node 22 LTS**（`engines: "^22.19.0 || >=24.0.0"`）。不引入 Bun，不允许"开发 Node / 发布 Bun"的混用。

**理由**：

1. **插件生态的依赖兼容风险 > Bun 的启动速度收益**。第三方插件会依赖 native 模块、`node:` 内建、worker_threads、AsyncLocalStorage；"某个插件在 Bun 下不工作"会变成无法转嫁的支持成本。
2. 价值在验证闭环与沙箱，不在毫秒级冷启动。agent 单次任务数十秒，80ms 还是 180ms 无意义。
3. 单一 runtime 才能保证"CI 里过的测试 = 用户机器上的行为"。
4. Node 官方 **SEA（Single Executable Applications）** 足以支撑单文件分发（详见 `unit-harness-release-v1.md`）。

**否决**：

| 替代 | 否决理由 |
|---|---|
| 全 Bun | 生态风险不可控；Cordis 的 Proxy/Service/装饰器元数据在非主线下存在未知差异 |
| Node 开发 + Bun 编译发布 | 两个 runtime 跑同一份代码，差异只在发版时暴露 |
| 内核 Go/Rust + 插件 TS | 需自造跨语言插件 RPC 协议，插件生态从零建立；与 D4/D10 冲突 |
| Deno | native 模块与 worker 语义差异大；SEA 能力弱于 Node |

**后果**：
- `engines`、CI matrix、`.nvmrc` 三处必须一致，CI 加一条校验相等；
- 原计划"Bun 兼容 Cordis"spike **取消**（决策已定），只保留复查点：*若 SEA 产物在某平台不可得或体积 > 150MB，重新评估打包方式，不评估更换 runtime*；
- 禁止使用 Bun 专有 API，CI 静态检查 `grep -r "Bun\."` 为空。

---

## D3 · Cordis：npm 依赖 + patch + 薄封装

**决策**：

```json
{ "dependencies": { "@deepseek-ai/cordis": "4.0.1" } }
```

需修改时用 pnpm `patchedDependencies`，补丁进 `patches/`。外面包一层 `@unit-harness/core`，**插件只 import 这一层，永不直接 import Cordis**。

**背景（实测）**：`@deepseek-ai/cordis@4.0.1` 已发布在 npm，MIT。DSH `vendor/` 是因为它改了 loader / include / HMR 行为，需要自己的补丁集。

**理由**：
1. copy 源码进仓库的三个代价：上游永远滞后（手工 rebase）、许可与版权声明负担、仓库体积与 clone 时间；
2. 薄封装层是 D4（API 稳定性）与 D5（未来 RPC 隔离）的**唯一抓手**——没有这层，插件直接吃 Cordis API，未来任何内核替换都不可能。

**否决**：

| 替代 | 否决理由 |
|---|---|
| vendor 源码（DSH 方式） | 我们不需要改内核行为；vendor 只带来同步债务 |
| fork 后发我们自己的 scope | 分叉即失去上游修复，且社区会问"为什么不直接用" |
| 自研插件框架 | 卸载顺序、依赖环检测、配置 schema、热重载要重走一遍，且失去 DSH 生态互操作 |

**薄封装必须做的四件事**：

1. **收敛 API 面**：插件只看 `UnitHarnessContext`，看不到 Cordis 的 `Context` / `Service` / `inject` 原始类型；
2. **包装注册**：内部用 `ctx.effect`，对外暴露 `ctx.provide(name, impl)`，保证可逆；
3. **事件白名单**：只转发 `events.v1.json` 声明过的事件，其余内部事件不外泄（防止插件依赖实现细节）；
4. **版本隔离**：`ctx.apiVersion` 由我们定义，与 Cordis 版本解耦——Cordis 4 → 5，插件不动。

**后果**：Cordis 的破坏性升级由我们吸收；`patches/` 在干净环境的 `pnpm install --frozen-lockfile` 里必须能干净应用。

---

## D4 · 插件 API 稳定性：分级承诺

**决策**：不做一刀切冻结，改为**毕业制**。

| 级别 | 含义 | 兼容承诺 |
|---|---|---|
| `@experimental` | 默认状态，新 API 一律从这里起步 | 无。可在 minor 中变更或删除，仅需 CHANGELOG 说明 |
| `@public` | 被**至少一个第一方插件在生产中真实使用**后才毕业 | 破坏性变更须走 major + 至少两个 minor 弃用期 + 可执行迁移脚本 |
| `@internal` | 不对插件暴露 | 随时可变 |

运行时校验：插件在 `apply()` 声明 `apiVersion`，不匹配时给出**可读升级指引**（含迁移命令），不是 "failed to load"。

**理由**：
1. 一刀切冻结在 0.x 阶段会锁死设计——sandbox 与 verification 的接口我们还没想清，冻结等于把错误固化成契约；
2. 完全不管则没人敢写插件——生态需要"什么时候可以依赖我"的明确信号；
3. 毕业制给出双向承诺：作者知道 `@public` 可依赖，我们保留早期演进空间。

**否决**：

| 替代 | 否决理由 |
|---|---|
| 全量 `@public` 冻结 | 0.x 期锁死设计，第一次大改就要 major，流失更严重 |
| 全部 `@experimental` | 等于没有承诺，生态不启动 |
| 靠"0.x 不稳定是常识"糊过去 | 对作者不可操作，且无法区分哪些能依赖 |

**实现**：
- JSDoc tag + `scripts/api-surface.ts` 生成 `api-surface.json`；
- CI 对比 main 与 PR：`@public` 条目被删改 → 构建失败，提示"需 major + 弃用期"；`@experimental` 变动 → 仅提示；
- 每个 `@public` API 在 `docs/graduation.md` 登记"哪个第一方插件在用"。

**后果**：v1.0 之前 `@public` 会很少，这是刻意的。README 写明"v1.0 前 API 仍在演进，标 `@public` 的可放心依赖"。

---

## D5 · 插件信任模型：完全信任 + 签名白名单

**决策**：承认插件与宿主同进程同权限。不把能力声明当安全边界。

`SECURITY.md` 必须写：

```markdown
## Plugin trust model

Plugins run in the same process as the host, with the same privileges as your
user account. Installing a plugin is equivalent to running its code.

Mitigations we actually provide:
- First-party plugins ship with signed checksums verified at install time.
- Third-party plugins are marked `unverified` in `uh plugin list`, with author
  and source URL shown; they are never auto-installed or auto-updated.
- The capability manifest is displayed before install **for your information
  only**. It is a declaration, not a boundary — a plugin can bypass it with a
  direct `node:` import.

We do not claim sandboxing of plugins. If you need that, isolate at the OS level.
```

**理由**：
1. 同进程 TS 插件 `import fs from 'node:fs'` 一行绕过任何 `ctx.*` 检查。把能力声明说成边界是**不可验证的声明**，对技术用户是负债。
2. 定位是"验证"，信任模型的诚实性是定位的一部分——安全上吹牛的项目，其"验证"同样可疑。
3. 先例充分：VS Code 扩展与几乎所有 JS 插件生态都是完全信任模型，用户已有心智准备。

**否决**：

| 替代 | 否决理由 |
|---|---|
| 把 capability manifest 当安全边界 | 技术上做不到，属虚假安全声明（本决策明确禁止再这样描述） |
| P0 上 Worker/子进程 RPC 隔离 | 所有 ctx 调用变 RPC，调试链路断裂，原生模块不可用；且跨进程无法保证证据记录完整性（与 D13 冲突） |
| WASM 插件 | 原生能力（exec/sandbox/lsp）无法实现，砍掉一半插件类型 |

**为将来留的后路**：因为有 D3 薄封装层，升级到 RPC 隔离只需替换 `@unit-harness/core` 实现，插件代码不变。这一点写进 `docs/security.md`，作为"架构不债"的证明。

---

## D6 · 核心 schema 不含同步字段

**决策**：核心表（`sessions` / `events` / `artifacts` / `ventures` / `runs`）**不含** `remote_id` / `synced_at` / `server_version` 等任何云端痕迹。同步状态归插件：

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  entity     TEXT NOT NULL,     -- session | artifact | venture
  local_id   TEXT NOT NULL,
  remote_id  TEXT,
  synced_at  TEXT,
  dirty      INTEGER DEFAULT 0,
  PRIMARY KEY (entity, local_id)
);
```

**理由**：① 开源后用户第一次看 schema 就看到"准备把数据推到服务器"，直接损伤信任；② 商业化的东西不污染内核契约（与 D13 同源）；③ 同步是可选的，可选能力不该占核心列。

**否决**：核心表加列并默认 `NULL`（"不用就不填"）——schema 是公开契约，字段存在即暗示意图。

---

## D7 · 沙箱：降级链 + fail-closed

**决策**：三平台降级链，逐级探测，**全部不可用时 fail-closed**（拒绝执行，而不是无隔离执行）。UI 与 `uh doctor` 必须显示**当前真实生效的隔离级别**。

| 平台 | 优先级 1 | 优先级 2 | 优先级 3 | 兜底 |
|---|---|---|---|---|
| Linux | **landlock**（5.13+，按 ABI 分级） | **bwrap**（自带签名二进制，见 D15） | 路径约束 + 每次确认 | **拒绝执行** |
| macOS | **seatbelt**（`sandbox-exec` profile） | 路径约束 + 每次确认 | — | **拒绝执行** |
| Windows | **受限令牌 + Job Object**（降权 + 资源限制 + 工作目录 ACL） | 路径约束 + 每次确认 | — | **拒绝执行** |

**隔离级别枚举**（必须出现在事件与 UI）：

```ts
type IsolationLevel =
  | 'landlock-v1' | 'landlock-v2' | 'landlock-v3' | 'landlock-v4'
  | 'bwrap' | 'seatbelt'
  | 'win-restricted-token'
  | 'path-guard'      // 仅路径约束，需逐次确认
  | 'none'            // 仅 --unsafe 显式开启，事件标记 unsafe
```

**已知撞墙点**（写进 `docs/sandbox.md`）：

| 环境 | 问题 |
|---|---|
| Ubuntu 22.04 / 内核 5.15 | landlock ABI v1，缺 `REFER` 等能力，写操作受限 |
| Ubuntu 23.10+ | `kernel.apparmor_restrict_unprivileged_userns=1`，bwrap 直接失败 |
| 容器内 / WSL2 | 两者都可能不可用 → 落到 path-guard |
| Windows | 无 landlock/seatbelt 对应物，靠受限令牌 |

**理由**：安全能力不可假设。静默降级是安全产品最严重的缺陷——用户以为有保护，实际没有。

**否决**：只支持 Linux/macOS（Windows 用户量不可忽略，"不支持"比"降级并告知"体验更差）；静默降级（违反 D1：验证意味着诚实报告状态）；默认关沙箱（与 D1 直接冲突）。

**实施状态（2026-11-12）**：Linux 已实现，通过 `native/landlock-helper`（C，~250 行）。

| 事实 | 值 |
|---|---|
| 实测内核 ABI | 7（Ubuntu 内核 6.17 / aarch64） |
| 写权限范围 | workspace + `~/.uh` + `/dev` |
| `$HOME` | 默认不可读（`--allow-home` 可放开） |
| 网络 | `--no-net` 时禁止 TCP bind/connect（landlock 管不了 UDP，已如实标注） |
| 读权限 | 系统路径白名单（`/usr /lib /lib64 /bin /sbin /etc /proc /sys /opt /run`） |
| bwrap | **不可用**：本机 `apparmor_restrict_unprivileged_userns=1`，bwrap 连 `--unshare-pid` 都失败。这验证了 D7 预判的撞墙点，也说明 landlock 才是主路径 |

**macOS（2026-11-12，CI 验证）**：`sandbox/seatbelt.ts` 生成 sbpl profile，经
`/usr/bin/sandbox-exec` 施加：

- `(deny file-write*)` 后只放行 workspace、`~/.uh`、`/tmp`、`/private/var/folders`
- `(deny file-read* (subpath $HOME))`，再放行 workspace 与 `~/.uh` → 同 landlock 一样挡住 `~/.ssh`
- `--no-net` 时 `(deny network*)`
- 选择 `(allow default)` + 显式 deny，而非白名单：macOS 进程需要读 dyld cache / TCC 等，
  白名单模式会让普通命令都起不来

**Windows**：未实现。`enforced` 报 `path-guard` → fail-closed。
受限令牌 + Job Object 需要 native（MSVC）实现，尚未动手；CI 在 `windows-latest` 上
断言的就是"报 path-guard 且拒绝执行"，防止悄悄放行。

自证命令：`uh sandbox check`（4 条断言，任一不过即退出码 1），三个平台的 CI 都跑。

---

## D8–D12 · 架构骨架：五个正交借鉴

| 维度 | 借鉴 | 决策 | 否决的替代 |
|---|---|---|---|
| **内核哲学** | Claude Code 厚护甲 + Codex 可嵌入循环 | 内核**不预设工作流编排**：不给模型固定 DAG，而是在厚运行时护甲（权限 / 沙箱 / 验证断言 / 上下文压缩）里让模型自主决策。内核是可被任意壳嵌入的循环 | ① 固定 workflow DAG（创业流程差异太大，写死即僵化）；② 极简循环无护甲（无法验证，与 D1 冲突） |
| **状态模型** | OpenHands 事件溯源 | Agent 定义、工具定义、配置**不可变**；唯一可变状态是**会话事件日志**。"验证" = 对事件流断言；"回放" = 重新消费事件流 | ① 可变数据库状态（无法回放，验证不可复现）；② 只存最终结果（无法定位失败点）；③ 纯 CRDT（单机无收益，过度设计） |
| **扩展模型** | DSH 作用域隔离 | 插件能力受 **Session 作用域**约束，不自动全局可见；外部 Agent 作为特殊子 Agent 后端，同样受作用域约束 | ① 全局注册表（插件越多冲突越多，无法多项目隔离）；② 每插件独立进程（见 D5，与证据完整性冲突） |
| **协议边界** | MCP / ACP / A2A | 内核**只认自己的规范化事件模型**；三种协议各自独立适配器包。对接其他 Agent = **边界翻译**，不是内核分支 | ① 内核直接实现某协议（协议会变，内核不能跟着变）；② 只支持 MCP（ACP 是编辑器入口，A2A 是子 Agent 互调标准） |
| **形态** | OpenCode 引擎/壳分离 | 内核与 UI、进程模型无关；CLI 与桌面客户端是同一引擎的两种壳，共用事件模型与验证语义 | ① 内核内置 UI 逻辑（无法多壳）；② 每形态一套实现（状态语义分叉） |

**D8 落地约束**：内核里不得出现"第一步、第二步"的硬编码，只有 `AgentLoop` + 工具 + 断言。"预设流程"一律以插件（playbook）形式存在，可关闭。

---

## D13 · 六层架构与单向依赖

```
L6 分发层      distribution   打包 / 签名 / 更新 / 平台包
L5 插件层      plugins        经 @unit-harness/core 接入；可加验证器，不能绕过验证层
L4 证据层      evidence       事件日志 / 快照 / 内容寻址哈希 / 回放
L3 验证层      verification   契约检查 / Schema 校验 / 确定性测试 / 断言执行
L2 执行层      execution      所有副作用过沙箱（exec / fs / net 全部封装）
L1 运行时层    runtime        Agent 循环 / 会话 / 模型调用 / 上下文管理
```

**依赖规则（CI 强制）**：

```
L5 → L3 → L2 → L4
L1 → L4
禁止：L1/L2/L3 反向依赖 L5；L5 直接 import L2 的实现
```

**关键约束**：插件不得直接操作执行层。所有副作用经 `ctx.sandbox` / `ctx.exec` / `ctx.fs` / `ctx.net` 封装接口，**自动记录证据**（命令、退出码、隔离级别、产物哈希）。

这是"验证闭环"的技术保证：绕不过执行层，就绕不过证据层。

---

## D14 · 传输层可插拔

| 场景 | 传输 | 用在哪 |
|---|---|---|
| CLI / 编辑器 / ACP | **stdio JSON-RPC** | `uh` 进程内；ACP 客户端拉起我们 |
| 桌面 / Web / 远程壳 | **本地 HTTP + SSE** | `uh serve`，UI 用 EventSource 订阅事件 |

内核不感知传输：`ProtocolAdapter` 把两种传输翻译成同一套内部事件（见 `unit-harness-protocol-adapters-v1.md`）。

**否决**：只做 HTTP（CLI/IDE 需 stdio，ACP 是 stdio-first）；只做 stdio（UI 需多客户端订阅）。

---

## D15 · 分发矩阵

| 项 | 决策 | 参考 Codex `rust-v0.167.2`（194 assets）的哪一项 |
|---|---|---|
| Linux | **musl 静态** × `{x86_64, aarch64}` | `codex-*-unknown-linux-musl.tar.gz` |
| macOS | `{x86_64, aarch64}` + `.dmg`（P3 桌面壳） | `codex-*-apple-darwin.tar.gz` / `.dmg` |
| Windows | `x86_64`（arm64 视需求） | `codex-*-pc-windows-msvc.exe.zip` |
| 压缩 | `.tar.gz` + `.zst` | 同 |
| 校验 | `SHA256SUMS` | `codex-package_SHA256SUMS` |
| 签名 | **sigstore / cosign keyless（OIDC）** | `.sigstore` 旁挂（非 GPG） |
| 安装 | `install.sh` / `install.ps1` | 同 |
| npm | 主包 + 平台分包 `@unit-harness/cli-<plat>-<arch>`，`npm i -g` 为第一入口 | `codex-npm-<plat>-<ver>.tgz` |
| 辅助二进制 | landlock helper / bwrap **自带并签名** | Codex 自带 `bwrap` 二进制 |
| 配置 schema | 发布 `cordis.schema.json` | `config-schema.json` |

**aarch64-linux 是硬要求**：ARM 云（Oracle A1、腾讯 SA 系列）比同级 x86 便宜 30–40%，正是目标用户会买的服务器。

**musl 可行性**：Node 官方产物为 glibc；musl 来自 `unofficial-builds.nodejs.org`（实测有 musl 目标，433 个 release 条目）。**风险**：非官方构建的签名链与稳定性。**缓解**：spike 验证；若不可靠，Linux 回退 glibc 构建 + 文档要求 glibc ≥ 2.28，并为容器场景提供纯 JS npm 模式兜底。

详细构建清单见 `unit-harness-release-v1.md`。

---

## D16 · 命名与合规

| 位置 | 定名 |
|---|---|
| repo | `create-info/unit-harness` |
| npm scope（内核 + 通用） | `@unit-harness/*` |
| npm scope（商业插件，将来） | `@unitai/*` |
| CLI | `uh`（`unitai` 作为 alias） |
| 配置目录 | `~/.uh/` |
| 桌面 app | UnitAI Studio |
| 许可 | **Apache-2.0** + `NOTICE` |

`NOTICE`：

```
UnitHarness
Copyright 2026 <owner>

This product includes software developed by DeepSeek
(https://github.com/deepseek-ai/deepseek-harness), licensed under the MIT License.
Portions of the plugin framework are provided by Cordis (MIT).
```

README 固定段落：

```markdown
## Built on Cordis

UnitHarness is built on [Cordis](https://github.com/cordisjs/cordis) (MIT), the
plugin framework also used by DeepSeek Harness. We depend on it as a normal npm
package and do not fork it. Thanks to the DeepSeek team for releasing it openly.
```

**理由**：Apache-2.0 带专利授权，对公司贡献与商业化更安全；MIT 代码可并入 Apache-2.0，只需保留声明。主动署名既是合规也是公关。

**否决**：MIT（缺专利条款，大公司贡献有顾虑）；AGPL（商业插件与托管服务受牵连）；BSL/SSPL（非 OSI 认证，会被归为"假开源"）。

---

## 开工前 8 项（更新版）

| # | 项目 | 性质 | 说明 |
|---|---|---|---|
| 1 | ~~Bun 兼容 Cordis~~ → **记录"不需要"** | 决策已定 | 全 Node 已定，此项关闭；只保留"禁止 Bun API"的 CI 检查 |
| 2 | **Node SEA 动态加载外部插件** | **硬阻塞 spike** | SEA 产物能否 `import()` 用户目录下的 ESM 插件；不能则走 fallback（见 release 文档） |
| 3 | **沙箱探测链三平台实测** | **硬阻塞 spike** | Ubuntu 22.04 / 24.04 / macOS / Windows 各跑一遍，产出 `IsolationLevel` 实际矩阵 |
| 4 | 命名定稿 | 决策 | 写进 `docs/naming.md`，CI 检查无 `unitai` 硬编码路径 |
| 5 | Apache-2.0 + NOTICE | 合规 | 含 DeepSeek / Cordis 声明 |
| 6 | `SECURITY.md` 信任模型 | 合规 | 用 D5 的大白话版本 |
| 7 | 核心 schema 去同步字段 | 架构 | 同步表归 `sync` 插件 |
| 8 | `examples/plugin-hello` + `plugin-tool` | 生态入口 | 各 ≤ 50 行，`uh dev run` 直接跑 |

**musl SEA 验证**作为第 2 项的兄弟 spike 同一天做，因为它同样决定分发形态。

---

## 附：不可回退约束（写入 CI）

任何 PR 违反即失败：

1. **不得引入 Bun**：无 bun 依赖，代码无 `Bun.` 调用；
2. **不得 vendor Cordis**：仓库无 `vendor/cordis`，依赖走 npm；
3. **核心 schema 不得出现同步字段**：`remote_id` / `synced_at` / `server_*` 出现在核心表即失败；
4. **不得声称能力声明是安全边界**：`docs/**` 与 `SECURITY.md` 出现 "capability manifest prevents/enforces" 类表述即失败（lint 关键词检查）。


---

## 网页端：一条会话多轮、选目录、本机语音（2026-11）

三件事都是「界面承诺了但没做到」，改的是行为，不是文案。

### D10 一条会话承载多轮

**决定**：续说一句 → 复用同一个 `session_id`（`EventStore.reopen` 把 `ended` 改回
`active`，`HarnessOptions.resumeSessionId`），`state.json` 里累积的 `messages` 作为
`resumeFrom` 传回 `runAgent`，`turn_index` 递增。

**理由**：左栏一个对话一条。每句话新开一条会话，回放里全是碎片，模型也拿不到上文；
而 side-effect 上「一条会话 = 一个工作区的一段连续意图」，拆碎之后 checkpoint、
撤销上一轮、成本统计全部失去边界。

**否决**：每条消息一条会话 + `parent_id` 链。回溯容易，但界面、成本、撤销都要在
客户端重新拼装，换来的只是「会话不可变」这一条理论好处。

**坑**：`dispose()` 每轮都 `end()`，所以复用的第一件事必须是 reopen；另外
`state.json` 只存图片的 `path` 不存 base64，续跑前要按路径读回来，否则 provider
收到一个空 base64 直接 400。

### D11 选项目 = 浏览本地目录

**决定**：`GET /api/fs` 只列目录（含面包屑、父目录），`POST /api/fs/mkdir` 只能建
**当前目录下**的子目录（名字里不许有 `/`、`..`）；界面是弹窗，不是右侧抽屉。

**理由**：让人从文件管理器复制绝对路径再粘回去，是三步操作且必然粘错。抽屉还占着
主界面右边的位置，而它一年用两次。

**否决**：系统原生目录选择器（Tauri 的 `dialog.open`）。浏览器里没有，桌面端有 →
两套代码路径；而这个弹窗两端都能用。

### D12 语音：本机转写，不用浏览器 SpeechRecognition

**决定**：`MediaRecorder` 录音 → `POST /api/transcribe` → 本机 faster-whisper
（`scripts/asr-install.sh`）。引擎找不到就返回 501 + 安装命令；设备打不开就说清是
「没有麦克风 / 权限 / 被占用」。

**理由**：浏览器自带的识别是**云端**的（Chrome 发给 Google）。在大陆连不上时它只回
`network`，界面上就是一句 `speech: network` —— 既不说原因也没给出路。桌面端的
WebKitGTK 更是根本没有这个 API。本机转写还顺带满足「音频不出机器」。

**坑**：`av>=16` 删掉了 `metadata_errors`，而 faster-whisper 1.2 还在传它 →
装完一切正常、一说话就 500。安装脚本必须钉 `av<16`。


---

## 步数与插话：两个「默认值害人」的修正（2026-11）

### D13 一轮没有步数上限

**决定**：`maxSteps` 默认 0 = 不限（`--max-steps N` 仍可明说上限）；`maxSeconds` 默认也不设。
**子 agent 同样不限步数**（`spawn_agent` 的 `max_steps` 只在真要封顶时传）；
它的边界是「一轮 run 最多几个子 agent」「嵌套多深」「token 预算」和用户的 Stop——
这些和任务长短无关，不会在正常工作时误伤。

**理由**：12 步是一个探索型任务的起步价——`ls`、读两个文件、grep 一次就没了。
真实发生的事：读 Codex 源码的那一轮跑到 12 步被判 `max-steps`，屏幕上写着
「Hit the step limit · 12 steps」，下面是空白。Codex 没有这个上限，边界是上下文和
用户的耐心；我们同样交给 token 预算、用户的 Stop，以及真正的死循环去暴露问题。

**代价与补充**：没有步数上限，就必须有别的东西保证「会停」。实测代价是真实的——去掉
子 agent 的步数上限后，`tests/subagent.test.mjs` 里那个「每层都要求再派一个」的假模型
不再被砍断，整套测试挂了 19 分钟。所以补了**卡死检测**：同一个动作（工具名 + 参数
完全相同）连续失败 5 次就停（`stop_reason: 'stuck'`，退出码 4），并且强制模型只用
已有信息汇报。失败有两种长相，都要认——工具自己报的 `ERROR`/`BLOCKED`，和
`run_command` 返回的 `exit=7 …`（后者才是最常空转的那种：同一条 build 一遍遍失败）。

**否决**：把 12 调成 30，或者给子 agent 一个「差不多够用」的 40。都是猜的，猜错了
用户一样撞墙，而且更难解释「为什么是 30 / 40」。

**子 agent 的名字**：叫 `worker1`、`worker2`。以前叫 `sub1`，出现在界面上像内部编号；
现在它的每一步都带名字（`● worker1 · Listing files`），起手一行 `↳ worker1 started — <任务>`，
收尾一行 `✓ worker1 finished · 4 steps · 2.1s`，结论单独挂在 `worker1 → …` 下面，
不冒充主 agent 的回答。名字靠 `AsyncLocalStorage` 传播——工具事件是 harness 里发的，
把 agent 参数穿过二十个函数签名做不到。

**代价**：无上限意味着模型可以一直花你的钱。所以三件事必须同时在：预算是显式可见的
（`budget/warning`、`budget/exceeded`）、Stop 在步边界可靠生效、以及下面这条。

**配套**：被截停（显式上限或超时）时，如果这一轮还没说过人话，就再要一次
「只用已有信息汇报」——不给工具。以前这一步缺失，`text` 是空字符串，子 agent 拿到
空结果、父 agent 只能说「子代理没返回结果，我自己来查」，用户看到的是一轮白干的活。

### D14 排队中的插话可以撤回、可以改

**决定**：每条插话带 `id`；`POST /api/steer/withdraw` 撤回；前端点一下队列里的
条目就把它放回输入框（并发起撤回），改完再提交就是一条新插话。

**理由**：插话是「还没轮到的话」，排队期间发现打错字、说错方向是常事。旧行为只有
「已经排队」这一种状态，改不了也撤不了——唯一出路是按 Stop 重来，那等于把已经跑完
的工作扔掉。以前也没有撤回：屏幕上摘掉一条，服务端队列里那句照样在下一个 step 生效，
于是「我改了啊」和「它照旧做了」同时发生。

**否决**：在队列里做行内编辑。看起来更直接，但输入框已有的 @ 引用、语音、附件都不在
那里；把话拿回它本来该在的地方，比在四个地方各建一套编辑体验便宜。

**坑**：`RUNNING` 是先置上的（按钮要立刻变 Stop），会话号要等 `/api/run` 返回才有。
这中间再发一句，旧代码走「新任务」分支——同一件事被开成两条会话，左栏出现两条。
现在等会话号（最多 5 秒）再插话；等不到就把话留在输入框里说清楚。
