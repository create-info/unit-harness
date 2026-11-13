# 成本预算

上下文预算（compaction）管的是「窗口装不下」，这里管的是「钱包受不了」。两件容易混的事：

- 压缩：把历史变短，然后**继续**
- 预算：**停下来**

压缩完还超，就必须停。

## 配置

`~/.uh/config.json`：

```json
{ "budget": { "perRun": 200000, "perDay": 2000000 } }
```

`0` 或缺省 = 不限。也可以在设置 → 用量页改（输入框留空就是不限，
显示 `0` 会让人以为预算是零）。

## 数字口径只有一条

**用 provider 自己报的 `usage`，不做任何估算。**

估出来的钱没人敢拿去做决定，而且估错了会让人以为在骗他。代价是本地模型：
很多自建端点根本不返回 `usage`，那时如实记 0，预算也就管不到它——
这一点必须说出来，不能假装「已计量」。用量页底部写明了这句。

## 两个上限取更紧的

| 上限 | 范围 | 超出时 |
|---|---|---|
| `perRun` | 这一次 run 累计 | `stoppedBy: 'budget'` |
| `perDay` | 今天所有会话累计 | 同上 |

「今天的用量」**现扫日志算**，不用内存计数器。内存里那个数只代表「这个进程见过多少」，
而 Web / CLI / ACP 是三个进程，用户一天完全可能用其中两个。

## 80% 提醒一次，100% 停

不是到线才动。用到八成写一条 `budget/warning`，界面上出现一次提醒；
再往上就 `budget/exceeded` 并停下。

提醒只发一次——每一步都弹一句等于没提醒。

## 停下之前先收尾

`budget/exceeded` 之后补一条 `turn/end { stop_reason: 'budget' }`，
否则回放会看到一段没有终点的循环。

CLI 退出码 **3**（`max-steps` 是 2，`interrupted` 是 130）。脚本拿退出码判断「跑完了」
时不会把预算停下误当成成功。

## 事件

```json
{ "kind": "budget/warning",  "used": 168000, "limit": 200000, "pct": 0.84, "message": "84% of this run's token budget used (168k tokens of 200k tokens)." }
{ "kind": "budget/exceeded", "used": 201000, "limit": 200000, "message": "Stopped: this run's token budget is used up (201k tokens of 200k tokens). Raise it in settings, or start again with a smaller task." }
```

`message` 是直接给人看的一句话，界面不自己拼。

## 验证

```bash
node --test tests/budget.test.mjs
```

13 个测试。函数层覆盖 80%/100% 边界、两个预算取紧的、没设预算时 80% 分支不能被
`0/0 = NaN` 触发、垃圾配置退化成「不限」而不是「极小预算」。

端到端三条更重要，它证明预算能拦住一个正在花钱的循环：

- `perRun: 5` + 每次调用报 8 token → 退出码 3、`stoppedBy=budget`、事件里有 `budget/exceeded`、`turn/end` 是 `budget`
- 不配预算 → 同样任务正常跑完，退出码 0
- 配得很大 → 正常跑完，且日志里**没有** `budget/exceeded`

界面在浏览器里看过：设置 → 用量页顶部是预算上限，下面紧接着就是用量统计
（用户是在看到用量之后才想设上限的），保存后立刻回读生效值。
