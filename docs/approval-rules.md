# 审批记忆（prefix_rule）

会话内的审批记忆只活到进程退出，于是每开一个新会话，`npm install` 要重新批一遍。
这里把它持久化，跨会话生效。

```
⚠ Run this command?                              DESTRUCTIVE
  this deletes files and cannot be undone
  rm -rf node_modules
  ☐ Always allow `rm -rf node_modules` — this exact command, in this folder only
                                       [Deny]  [Run it]
```

## 三种规则，三种粒度

| 命令 | 记住什么 | 例子 |
|---|---|---|
| 构建 / 测试 / 安装类 | **前缀** | 批了 `npm install` → `npm install lodash` 不再问 |
| 破坏性命令 | **这一条确切的命令** | 批了 `rm -rf node_modules` → `rm -rf src` 照问 |
| 认不出来的 | **不记** | `curl`、`sudo`、自定义脚本 |

破坏性命令允许记，是因为它恰恰是最常被问的一类——一律不许记等于这个功能没用。
但粒度必须窄：`rm -rf node_modules` 和 `rm -rf ~` 是两条命令，前者批过不代表后者可以跑。

## 永不记忆的

判据不是「危险动词」，而是**目标不可恢复且范围大到没人真的会一直授权**：

- 指向根、家目录本身或上一级：`/`、`/*`、`~`、`$HOME`、`..`
- 顶层目录：`/etc`、`/usr`、`/home`
- 写整块设备：`dd of=/dev/sda`、`mkfs.*`
- 关机类：`shutdown`、`reboot`
- `chmod -R 777`、`chown -R`（能把机器锁死或打开）
- `curl` / `wget`（常配 `| sh`，读不出意图就别记）
- `git push|reset|clean|rebase|filter-branch|gc`

## 规则带工作区

在 `~/proj-a` 里信任 `npm install` 不代表在 `~/proj-b` 里也信任——两个项目的依赖脚本
能干完全不同的事。匹配时 `cwd` 必须完全相同（子目录也不算）。

## `sh -c` 要看穿

`sh -c "npm install lodash"` 若记成 `['sh','-c']`，等于记住「任何 shell 命令」，整个审批就废了。
所以记录前先剥外壳，规则指向里面那条真实命令。同理，`sh -c "rm -rf /"` 会被识别成灾难性目标而拒绝记忆。

## 越权（escalate）不持久化

「这一次允许在沙箱外跑」和「以后这个命令都不受沙箱限制」是两回事。
把 escalate 的批准持久化，等于永久打开沙箱边界的一个口子，所以那个弹窗上**没有**「一直都行」——
不是前端忘了显示，是后端根本不给 `persistPrefix`。

## 存储

`~/.uh/approval-rules.json`，0600：

```json
{
  "rules": [
    { "prefix": ["npm", "install"], "cwd": "/home/u/proj", "createdAt": "2026-11-13T…", "uses": 3 },
    { "prefix": ["rm", "-rf", "node_modules"], "cwd": "/home/u/proj", "createdAt": "…", "uses": 1 }
  ]
}
```

文件坏了不影响运行：解析失败退化成「每次都问」，不是放行。

## 事件

命中规则时写：

```json
{ "kind": "approval/resolved", "decision": "allow", "cached": true, "rule": "npm install" }
```

新建规则时额外带 `remembered: true`。审计链因此能回答「这次为什么没问我」——
答案永远是「你上次在什么目录批过什么」。

## 验证

```bash
node --test tests/approval-rules.test.mjs
```

19 个测试。重心不是「能记住」，而是**记住的范围足够小**——那些
`assert.equal(suggestPrefix(...), null)` 才是这套东西的价值所在：

- 灾难性目标一个都不许记（`/`、`~`、`/etc`、`dd of=/dev/sda`、`reboot`）
- `git push` / `chmod -R` / `curl` / `sudo` 不记
- 记住的 `rm -rf node_modules` 不会放 `rm -rf src` 过
- 记住的 `npm install` 不会放 `rm` 过
- 换目录不生效
- 前缀匹配不是子串匹配（`npm run install-everything` ≠ `npm install`）
- 规则文件坏了退化成「每次都问」

界面部分在浏览器里验过：弹窗出现、文案显示会记住的确切范围（精确规则不画成 `*`）、
勾选后发出的请求带 `always: true`。
