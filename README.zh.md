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

## 快速开始

```bash
git clone https://github.com/create-info/unit-harness.git
cd unit-harness
npm install
npm run build:native     # 编译 landlock helper -> ~/.uh/bin（需要 cc）
npm run build

node dist/uh.cjs doctor
node dist/uh.cjs sandbox check
```

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

| 平台 | 第一档 | 第二档 | 兜底 | 状态 |
|---|---|---|---|---|
| Linux | landlock（`native/landlock-helper`） | bwrap | 路径约束 + 确认 | landlock **已实现** |
| macOS | seatbelt | 路径约束 + 确认 | — | 待做 |
| Windows | 受限令牌 + Job Object | 路径约束 + 确认 | — | 待做 |

Linux 上 landlock 实际给了什么：

- 写入**只能**在工作区（默认 `~/.uh/work`）与 `~/.uh`
- `$HOME` **不可读**，除非显式 `--allow-home`——这是挡住 `~/.ssh`、`~/.aws` 的关键
- `--no-net` 可禁 TCP（landlock 管不了 UDP，我们如实说明，不含糊）
- 系统路径（`/usr`、`/lib`、`/etc`、`/proc`…）需要可读，否则 shell 和运行时起不来

全部不可用时 **fail-closed**。我们绝不静默降级。

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
| P1 | 事件日志（`session/*`）、断言、回放 | 下一步 |
| P2 | macOS seatbelt / Windows 受限令牌、桌面壳 | — |
| P2 | 桌面壳、数据包、巡检 | — |
| P3 | 协议适配器（MCP / ACP / A2A） | — |

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
