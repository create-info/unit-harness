/**
 * Windows 上的隔离能力探测。
 *
 * 结论先说：**这里没有实现内核级隔离，只是探测并如实报告。**
 *
 * Windows 上真要限制「能写哪里」，可选的方案都是重活：
 *
 *   - **AppContainer**（最接近 landlock）：进程跑在一个受限容器里，文件访问靠
 *     capability SID 白名单。需要一个原生 helper 调 `CreateAppContainerProfile`
 *     + `CreateProcessAsUser`，还要为工作区授予一个 capability SID。
 *   - **Restricted Token + ACL**（Codex 的 `WindowsRestrictedToken` 路线）：
 *     `CreateRestrictedToken` 去掉特权，再给工作区目录加 ACL。ACL 是持久的，
 *     进程异常退出时会留下痕迹，需要额外的清理逻辑。
 *   - **Job Object + 低权限账户**：最省事但要求管理员权限建账户。
 *
 * 三个都需要编译原生代码或要管理员权限，而这个仓库的 Windows 支持**没有被
 * 真机验证过**——没有人在 Windows 上跑过它。所以这里不写「看起来能跑」的
 * 实现：那种代码比没有更糟，因为它会让人以为有保护。
 *
 * 取而代之，这里做三件能验证的事：
 *
 *   1. 判断当前是否在受 Windows 沙箱保护的状态下（容器/AppContainer）
 *   2. 把"没有隔离"这件事变成**可诊断、可解释**的，而不是静默降级
 *   3. 给出真实可行的替代方案（WSL2）
 *
 * 判据宁可保守：探测不出来就说没有。把"可能有"当成"有"是安全软件最坏的错。
 */

export interface WindowsProbe {
  /** 是不是 Windows */
  isWindows: boolean
  /** 是否跑在 AppContainer 里（已经有人在替我们隔离了） */
  inAppContainer: boolean
  /** 是否跑在容器里（Docker / Windows Sandbox / 其他） */
  inContainer: boolean
  /** 是否跑在 WSL 里——那样其实是在 Linux 上，能力按 Linux 算 */
  inWsl: boolean
  /** 有没有可用的隔离。目前恒为 false：没有实现 */
  available: boolean
  /** 给人看的一句话 */
  reason: string
  /** 可执行建议 */
  hint: string
}

/**
 * 判断是否在 AppContainer 内。
 *
 * AppContainer 进程的令牌里会有一个 capability SID
 * （形如 `S-1-15-3-…`）。读令牌需要原生调用，这里用一个不可靠但保守的
 * 代理信号：`%LOCALAPPDATA%\Packages` 存在且当前进程的用户目录指向
 * `Packages\…` 这种布局，说明大概率是打包应用。
 *
 * **只是启发式**，所以返回 true 时也只当"可能"，不影响 available。
 */
function looksLikeAppContainer(env: NodeJS.ProcessEnv): boolean {
  const local = (env.LOCALAPPDATA ?? '').toLowerCase()
  return local.includes('\\packages\\') || local.includes('/packages/')
}

/**
 * 容器检测。Windows 容器里 `%USERPROFILE%` 往往被重定向到 C:\Users\ContainerAdministrator
 * 这类账号，且存在环境变量标记。
 */
function looksLikeContainer(env: NodeJS.ProcessEnv): boolean {
  if (env.SystemDrive === undefined) return true          // 极精简容器
  if ((env.COMPUTERNAME ?? '').toUpperCase().includes('CONTAINER')) return true
  if ((env.USERNAME ?? '').toLowerCase().includes('container')) return true
  return false
}

function looksLikeWsl(env: NodeJS.ProcessEnv, release: string): boolean {
  return Boolean(env.WSL_DISTRO_NAME) || /microsoft/i.test(release)
}

/** platform 可注入：测试里要在 Linux 上验 win32 分支 */
export function probeWindows(
  env: NodeJS.ProcessEnv = process.env,
  release = '',
  platform: NodeJS.Platform = process.platform,
): WindowsProbe {
  const isWindows = platform === 'win32'
  if (!isWindows) {
    return {
      isWindows: false,
      inAppContainer: false,
      inContainer: false,
      inWsl: looksLikeWsl(env, release),
      available: false,
      reason: 'not windows',
      hint: '',
    }
  }

  const inWsl = looksLikeWsl(env, release)
  const inAppContainer = looksLikeAppContainer(env)
  const inContainer = looksLikeContainer(env)

  // 已经有人在隔离我们了：这时候报"没有隔离"会让用户以为要自己动手
  if (inAppContainer || inContainer) {
    return {
      isWindows: true,
      inAppContainer,
      inContainer,
      inWsl: false,
      available: false,
      reason: inAppContainer
        ? 'running inside an AppContainer (something else owns the boundary)'
        : 'running inside a container (the container owns the boundary)',
      hint: 'Unit harness adds no further restriction; the outer container decides what is reachable.',
    }
  }

  return {
    isWindows: true,
    inAppContainer: false,
    inContainer: false,
    inWsl: false,
    available: false,
    reason: 'no kernel-level isolation on Windows: AppContainer / restricted-token are not implemented',
    // 说清楚后果 + 给出真的能用的路
    hint:
      'On Windows only path-guard runs, so a command can still write outside the workspace ' +
      '(exec therefore needs --allow-unconfined). For real isolation, run under WSL2 — there ' +
      'the Linux landlock path applies and is enforced.',
  }
}
