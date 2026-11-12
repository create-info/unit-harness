# 接入 UnitAI（选型数据）

UnitAI 已经跑着一个 MCP 端点（Streamable HTTP）：`https://unitai.site/mcp`。
工具前缀 `unitai`，接入后 agent 能自己查工具库、赚钱榜、选型矩阵，而不是凭记忆推荐。

## 三步

```console
$ uh mcp add unitai https://unitai.site/mcp --header authorization
authorization value (input hidden): ********
added unitai → ~/.uh/mcp.json (mode 0600)
verify with:  uh mcp test unitai

$ uh mcp test unitai
✓ unitai  (http)  7 tool(s)
    mcp__unitai__search_options
    mcp__unitai__compare_options
    ...
```

token 从 <https://unitai.site/mcp> 页面复制。它**不回显、不进 shell history、文件权限 0600**；
和 `uh config set` 是同一套密钥处理。

然后直接干活：

```console
$ uh run "帮我选一个能纯内网跑、显存 8G 以内、要能识别扫描件的中文 OCR 方案，给出两个候选和理由"
```

模型会自己调 `search_options` 拿候选、`compare_options` 做并排对比，最后交付一份带出处的选型说明。

## 暴露的工具

| 工具 | 用途 |
|---|---|
| `search_options` | 按约束查选型矩阵（类别 / 部署形态 / 显存 / 难度 / 离线 / 国产 / OCR / 批处理 / 团队） |
| `compare_options` | 2~5 个方案并排对比，逐字段矩阵 |
| `list_filters` | 有哪些筛选维度与取值 |
| `find_tools` / `get_tool` | 工具库：搜索与详情 |
| `research` | 一句话约束 → 解析出的条件 + 结论 + 四组结果 |
| `submit_report` | 把这次调研回写（会员） |

## 隔离说明

MCP server 是**外部进程/服务**，不在本地沙箱里。所有 `unitai` 调用在事件日志里记
`isolation: "none"` + `external: true`，`uh doctor` 也会单独列一行。这不是缺陷，是事实——
本地 sandbox 管不到别人的服务器，假装管得到才是问题。

## 排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `E_MCP_HTTP 401` | 没配 token 或 token 过期 | 重新 `uh mcp add unitai ...` |
| `E_MCP_TIMEOUT` | 网络不通 / 端点地址错 | `curl -I https://unitai.site/mcp` |
| 工具列表为空 | 服务器握手成功但没注册工具 | `uh mcp test unitai` 看 `0 tool(s)` 的那一行 |
