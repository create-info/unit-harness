# Windows 上的隔离：**没有实现**

这一页存在的唯一目的是不让这件事含糊。Windows 上目前**没有内核级隔离**，
只有路径检查（`path-guard`），也就是说一条命令仍然能写到工作区之外。

## 现在 Windows 上会发生什么

`uh doctor` / `session/start` 会如实写：

```
windows: no kernel-level isolation on Windows: AppContainer / restricted-token are not implemented
windows: On Windows only path-guard runs, so a command can still write outside the workspace
         (exec therefore needs --allow-unconfined). For real isolation, run under WSL2 — there
         the Linux landlock path applies and is enforced.
```

`enforced` 报 `path-guard`，`available` 也是 `path-guard`，两者一致——不会出现
「说能隔离但其实没隔」那种情况。

## 为什么没做

真要在 Windows 上限制「能写哪里」，三条路都是重活：

| 方案 | 代价 |
|---|---|
| **AppContainer**（最接近 landlock） | 原生 helper 调 `CreateAppContainerProfile` + `CreateProcessAsUser`，还要给工作区授 capability SID |
| **Restricted Token + ACL**（Codex 的 `WindowsRestrictedToken` 路线） | `CreateRestrictedToken` 去特权 + 给目录加 ACL；ACL 是持久的，进程异常退出会留痕迹，要额外清理 |
| **Job Object + 低权限账户** | 建账户要管理员权限 |

三条都需要编译原生代码或要管理员权限，而**这个仓库的 Windows 支持没有在真机上验证过**。

所以这里不写「看起来能跑」的实现。一个会让人以为有保护、实际上没有的安全模块，
比没有更糟——它改变的是人的行为，而人一旦相信了就不再看。

## 探测是真的

`probeWindows()` 会判断：

- 是否跑在 **AppContainer** 里（外层已经在管边界了，这时不该提示用户去折腾）
- 是否跑在 **容器** 里（同上）
- 是否跑在 **WSL** 里（那就按 Linux 算，landlock 是真的生效的）

`available` **在任何输入下都是 false**。测试里专门有一条穷举这一点：
把「可能有」当「有」是安全软件最坏的错。

## 出路

1. **WSL2**。里面就是 Linux，landlock 那条路径已经被强制，`uh doctor` 会报
   `landlock-vN`。这是目前唯一真能用的做法。
2. **等 Windows 实现**。做的时候应该照 Codex 的结构：`#[cfg(windows)]` 等价物
   ——一个只在 win32 加载的模块 + CI 的 Windows job，其他平台完全不受影响。

## 验证

```bash
node --test tests/windows-probe.test.mjs
```

9 个测试，重心在「不能撒谎」：普通 Windows 要说清后果和出路、AppContainer / 容器里要承认
外层边界而不是催用户动手、WSL 要识别成 Linux、`available` 永远 false。
