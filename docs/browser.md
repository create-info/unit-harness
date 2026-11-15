# 浏览器控制

插件：`plugins/browser/`

让 agent 操作一个真实的浏览器。不是无头抓取 HTML，是点击、输入、看页面结构。

## 为什么这样设计

参考 Codex 浏览器控制的四个要点，逐条对应：

### 1. 复用真实浏览器状态

`connect()` 的顺序就是"复用优先"：

1. `<uhHome>/browser/state.json` 里记的 pid 还活着 → 复用它
2. 探测 9222 / 9223 / 9224 / 9229 上已经在跑的浏览器 → attach（**用他的 session，带登录态**）
3. 都不行 → 自己起一个

第 2 步是这个插件存在的关键。自己起的浏览器是干净的，用户在站点上的登录态一点没有，
每做一件事都要先登录一遍。attach 到用户自己开的浏览器就没有这个问题。

**自启时用独立 profile**（`<uhHome>/browser/profile`），不碰用户的真实 profile。理由：

- 真实 profile 里是用户所有网站的登录态，让 agent 默认读写它，风险不对等；
- 真实 profile 通常正被用户的浏览器占着，进程内会话锁会直接让启动失败。

想强制用真实 profile，设 `useRealProfile: true`，但要知道上面两条。

用户想让 agent 用上自己的登录态，正确做法是让他自己开：

```bash
chrome --remote-debugging-port=9222
```

然后 agent 一调工具就会 attach 上去。

### 2. 持久化的运行时环境

浏览器进程跨工具调用、跨 run 存活，状态落在 `<uhHome>/browser/state.json`。

插件卸载、进程退出都**不杀浏览器**——它就是"持久运行时环境"，下次还要接着用。
只有显式关闭才杀。

实测价值：第一次启动约 20 秒，之后每个动作 0.2 秒。如果每次重启，光启动就吃掉一轮对话。

### 3. 基于语义的增量观察

`browser_look` 默认只返回**变化**（added / gone / changed），不是重发整棵树。

ref 的稳定性来自 fingerprint = `role | name | 同类第几个`。界面局部刷新后，
同一个按钮还是同一个 ref，模型不用重新学一遍页面。

实测同一页面：DOM 273 字符、原始 AX JSON 7125 字符、裁剪后 80 字符。
原始 AX 比 DOM 还大七倍——直接吐 JSON 等于自残上下文。

### 4. 事务化的动作执行

每个动作 = 前置检查 → 执行 → 等稳定 → 回读确认。

- **等稳定**：连续两次读到相同的页面指纹才算稳定，不是 `sleep(500)`。动画或长轮询
  的页面会如实报 `settled: no`，但不当作错误。
- **回读确认**：`browser_type` 会读回输入框的 `.value` 并比对；`browser_click` 会比对
  动作前后的页面指纹。`changed: no` 意思是"这次操作可能没生效"，不是"成功了"。

## CDP 传输：pipe 优先

两种传输，用途不同：

| 传输 | 何时用 | 限制 |
|---|---|---|
| WebSocket | attach 别人的浏览器 | snap / 容器 / 企业策略可能挡 TCP |
| pipe | 自己启动的浏览器 | 只能操作自己启的 |

pipe 走 fd 3/4，消息以 `\0` 结尾，不过网络。实测 snap chromium：端口在听，
但 HTTP 和 WS 都被 reset（confinement 挡 TCP），只有 pipe 能通。

`launchOwn` 是**降级链**：port 失败自动退 pipe。唯一不退的情况是 profile 被占用——
那 pipe 也会同样撞墙，这时直接告诉用户关掉浏览器。

## 工具

| 工具 | 作用 |
|---|---|
| `browser_open` | 打开 URL，返回可操作元素 |
| `browser_look` | 再看一眼，默认只返回增量；`fresh: true` 全量 |
| `browser_click` | 按 ref 点击，等稳定，报是否真的变化 |
| `browser_type` | 按 ref 聚焦并输入，回读确认；`submit: true` 回车 |
| `browser_screenshot` | 截图存盘 |
| `browser_status` | 当前用的是哪个浏览器、怎么连上的、是复用还是新起 |

## 边界

- **不受沙箱约束**：它启动的是本机浏览器，碰的是真实网络。页面上写明了这一点。
- **只接受 http(s) 和 data:text/html**：`file://` 故意不支持——那等于把任意本地文件内容交给模型。
- **`DOM.getBoxModel` 不可用**：flatten session 下它返回的盒子是错的（实测返回文档首元素）。
  取坐标一律走 `DOM.resolveNode` + `getBoundingClientRect()`。
- **ref 只在当前页面有效**：页面导航后旧 ref 失效，会报错要求重新 `browser_look`，不会瞎点。

## 验证

```bash
node scripts/e2e-browser.mjs
```

在**同一个进程**里连续调用工具。这点很重要：`uh tool` 每次是新进程，插件的 ref 映射和
增量基线都不共享，单独调用测不到"点上一眼看到的按钮"这条路径。

脚本用 `data:` URL 而不是真实站点，因为开发机的 snap chromium 连不上外网
（TLS 层 `ERR_ACCESS_DENIED`，连 loopback 也是 `ERR_ACCESS_DENIED`）。
`data:` 不联网也能把 snapshot / type / 回读 / click / 增量 look 整条链路跑完。

要验证真实站点，在有正常 Chrome 的机器上把 `PAGE` 换成 URL 即可。
