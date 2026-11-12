/**
 * 沙箱里允许**只读**访问的工具链目录。
 *
 * 背景：我们默认把 $HOME 整个设为不可读（为了挡住 ~/.ssh、~/.aws），但这会让
 * venv、nvm、pyenv 里的解释器全部失效 —— 现象是 `python3` 报
 * "Failed to import the site module"，agent 连脚本都跑不了。
 *
 * 取舍：只放行"工具的二进制与包缓存"，**不放行**凭据类路径。
 * 宁可少放行几个目录，也不要为了便利把 ~/.cargo/credentials.toml 这类东西暴露给模型。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 只读放行：解释器、包管理器缓存、编译产物 */
const READ_ONLY = [
  '.nvm/versions',
  '.pyenv/versions',
  '.bun/bin',
  '.deno/bin',
  '.volta/bin',
  '.asdf/installs',
  '.cargo/bin',
  '.cargo/registry',
  '.rustup/toolchains',
  '.local/bin',
  '.local/share/uv',
  '.local/share/pnpm',
  '.cache/uv',
  'miniconda3',
  'anaconda3',
  'go/bin',
  'go/pkg/mod',
]

/** 明确不放行（即使出现在上面的父目录里也要单独 deny）：凭据 */
const NEVER = [
  '.cargo/credentials.toml',
  '.cargo/credentials',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker/config.json',
]

export interface ToolchainPaths {
  readOnly: string[]
  denied: string[]
}

export function toolchainPaths(): ToolchainPaths {
  const home = os.homedir()
  const readOnly = READ_ONLY
    .map((rel) => path.join(home, rel))
    .filter((p) => {
      try { return fs.statSync(p).isDirectory() } catch { return false }
    })
  const denied = NEVER.map((rel) => path.join(home, rel))
  return { readOnly, denied }
}


/**
 * 动态放行"用户正在执行的那个程序所在的目录树"。
 *
 * 静态白名单永远追不上所有虚拟环境位置（venv 可以出现在 home 下任意路径），
 * 但执行时我们可以看一眼 argv[0]：如果它解析到 home 里的某个 bin 目录，
 * 就把 bin 的父目录（venv 根 / node 安装根）一起只读放行。
 *
 * 这仍然不是"全放行"：只放行实际被调用的那一棵树。
 */
export function executableRoots(argv0: string, cwd: string): string[] {
  const home = os.homedir()
  let resolved: string | null = null

  if (argv0.includes('/')) {
    resolved = path.isAbsolute(argv0) ? argv0 : path.resolve(cwd, argv0)
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const candidate = path.join(dir, argv0)
      try {
        if (fs.statSync(candidate).isFile()) { resolved = candidate; break }
      } catch { /* keep looking */ }
    }
  }

  if (!resolved) return []
  // 注意：venv 的 bin/python3 通常是软链到 /usr/bin/python3.x，
  // realpath 之后就跑到系统目录去了，反而认不出"这是 home 里的 venv"。
  // 所以先按未解析的路径判断归属，解不出来的才退回 realpath。
  const real = resolved.startsWith(home + path.sep)
    ? resolved
    : (() => { try { return fs.realpathSync(resolved) } catch { return resolved } })()
  if (!real.startsWith(home + path.sep)) return []

  const dir = path.dirname(real)
  // bin 的父目录；但如果直接放在 home 顶层的 bin 里，就只放行那个 bin
  const root = path.basename(dir) === 'bin' ? path.dirname(dir) : dir
  if (root === home || root.startsWith(home) === false) return []
  return [root]
}


/**
 * `sh -c "python3 app.py"` 这种写法，argv[0] 是 sh，看不到里面真正的程序。
 * 模型很喜欢这么写（因为能顺手拼管道），所以把 -c 后面的第一个词也当候选程序，
 * 一并解析它所在的目录树。
 */
export function shellInnerPrograms(argv: string[]): string[] {
  const shells = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])
  const first = argv[0] ? path.basename(argv[0]) : ''
  if (!shells.has(first)) return []
  const ci = argv.indexOf('-c')
  if (ci < 0 || !argv[ci + 1]) return []
  const cmd = argv[ci + 1] as string

  // 不能只看第一个词：`test "$(python3 cli.py add 2 3)" = "5"` 里的程序藏在命令替换里，
  // 只看首词就把 python3 的目录树挡在外面，表现是「解释器起不来」而不是「命令被拒」。
  // 按 shell 的断词符切分，把所有**真实存在**的可执行文件都收进来。
  const tokens = cmd.split(/[\s;|&()<>`'"$]+/).filter(Boolean)
  const found = new Set<string>()

  for (const raw of tokens) {
    const token = raw.replace(/^[\]\[]+|[\]\[]+$/g, '')
    if (!token || token.startsWith('-')) continue
    if (!/^[\w./~-]+$/.test(token)) continue

    if (token.includes('/')) {
      if (isExecutable(token)) found.add(token)
      continue
    }
    const resolved = whichInPath(token)
    if (resolved) found.add(resolved)
  }

  return [...found]
}

/** 在 PATH 里找可执行文件（只读判断，不执行） */
function whichInPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const full = path.join(dir, name)
    if (isExecutable(full)) return full
  }
  return null
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
