/**
 * 把内部事件翻译成人话。
 *
 * 屏幕上不该出现 `run_command`、`argv`、`tool_call(s)` 这类词——那是我们自己的
 * 词汇表，不是用户的语言。用户要知道的是"它在读文件""它在跑测试""它改了 2 个文件"，
 * 一句话说得清，动词开头，扫一眼就知道现在在干什么。
 *
 * 这层放在 core 而不是前端，因为三个前端都要用同一套说法：Web UI、ACP（编辑器
 * 拿它当 tool title）、CLI。各写一套的结果是同一个动作在三处叫三个名字。
 */

export interface ProgressLine {
  /** 一行短句，动词开头。屏幕上直接显示这个 */
  label: string
  /** 可选的具体对象（路径、命令全文），界面上作为次要信息 */
  detail?: string
  /** 行首那个记号：读文件、搜索、跑命令……一眼区分类型，而不是每行都一个圆点 */
  icon?: string
}

const shorten = (s: string, n = 100): string =>
  s.length > n ? s.slice(0, n - 1) + '…' : s

const basename = (p: string): string => p.split('/').filter(Boolean).pop() || p

/** 相对路径更好读：/home/x/proj/src/a.ts → src/a.ts */
const pretty = (p: string, cwd?: string): string => {
  if (!p) return ''
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1)
  return p.replace(/^\/home\/[^/]+\//, '~/')
}

/** 一条 shell 命令 → 一句人话 */
export function describeCommand(argv: string[] | string): ProgressLine {
  const cmd = (Array.isArray(argv) ? argv.join(' ') : String(argv || '')).trim()
  if (!cmd) return { label: '执行命令' }

  // `sh -c "..."` / `bash -c "..."` 只是外壳，真正要看的是里面那条
  const inner = /^(?:ba|z|d)?sh\s+-[a-z]*c\s+(.*)$/s.exec(cmd)
  const real = (inner?.[1] ?? cmd).replace(/^['"]|['"]$/g, '').trim()
  const head = real.split(/\s+/)[0] ?? ''
  const rest = real.slice(head.length).trim()

  // 跑测试：这是最常见的"我现在在验证"，值得单独说
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(real)) return { label: '跑测试', detail: real }
  if (/^(pytest|tox|nox)\b/.test(real)) return { label: '跑测试', detail: real }
  if (/^(cargo|go)\s+test\b/.test(real)) return { label: '跑测试', detail: real }
  if (/^(jest|vitest|mocha|ava)\b/.test(real)) return { label: '跑测试', detail: real }
  if (/^node\s+--test\b/.test(real)) return { label: '跑测试', detail: real }

  if (/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/.test(real)) return { label: '装依赖', detail: real }
  if (/^(pip|pip3|uv)\s+install\b/.test(real)) return { label: '装依赖', detail: real }
  if (/^(cargo|go)\s+(build|install)\b/.test(real)) return { label: '编译', detail: real }

  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck|type-check)\b/.test(real)) {
    return { label: '编译与检查', detail: real }
  }

  if (/^git\s+(status|diff|log|show|branch)\b/.test(real)) return { label: '看一眼仓库', detail: real }
  if (/^git\s+(add|commit)\b/.test(real)) return { label: '提交改动', detail: real }
  if (/^git\s+(push|pull|fetch|clone)\b/.test(real)) return { label: '和远端同步', detail: real }

  // 只读的看一眼
  if (/^(ls|ll|dir)\b/.test(real)) return { label: '列目录', detail: real }
  if (/^(cat|head|tail|less|more)\b/.test(real)) {
    const last = rest.split(/\s+/).pop() || ''
    return { label: rest ? `读取 ${shorten(pretty(last), 60)}` : '读文件', detail: real }
  }
  if (/^(grep|rg|ag|ack)\b/.test(real)) {
    const m = /(?:-e\s+)?['"]?([^'"\s-][^'"]*)['"]?/.exec(rest)
    const pat = m?.[1] ?? ''
    return { label: pat ? `搜索"${shorten(pat, 40)}"` : '搜索', detail: real }
  }
  if (/^(find|fd)\b/.test(real)) return { label: '找文件', detail: real }
  if (/^(which|command|type)\b/.test(real)) return { label: '查已装的东西', detail: real }

  if (/^(rm|rmdir|unlink)\b/.test(real)) return { label: '删除', detail: real }
  if (/^(mv|cp|ln)\b/.test(real)) return { label: '移动文件', detail: real }
  if (/^mkdir\b/.test(real)) return { label: '建目录', detail: real }
  if (/^(chmod|chown)\b/.test(real)) return { label: '改权限', detail: real }

  if (/^(curl|wget)\b/.test(real)) return { label: '下载', detail: real }
  if (/^(ssh|scp|rsync)\b/.test(real)) return { label: '远程执行', detail: real }
  if (/^(docker|podman)\b/.test(real)) return { label: '操作容器', detail: real }
  if (/^(systemctl|service|journalctl)\b/.test(real)) return { label: '看服务状态', detail: real }
  if (/^(node|python|python3|deno|bun|ruby|perl|php)\b/.test(real)) {
    return { label: `运行 ${basename(head)}`, detail: real }
  }

  // 认不出来的：说它跑了一条命令，命令原文放 detail，不要硬猜语义
  return { label: `Running ${shorten(real, 60)}`, detail: real }
}

/** 内建工具的名字 → 人话。工具名本身绝不该出现在屏幕上。 */
export function describeTool(tool: string, p: Record<string, unknown>, cwd?: string): ProgressLine {
  const arg = (k: string): string => (typeof p[k] === 'string' ? (p[k] as string) : '')
  const argv = p.argv as string[] | undefined

  switch (tool) {
    case 'run_command':
    case 'exec': {
      // 意图比 argv 好读：`npm test` 就是「跑测试」。完整命令留在 detail 里，
      // 想复现那一步，点开这一行就能看到原文。
      return { ...describeCommand(argv ?? arg('command')), icon: '⌘' }
    }

    case 'read_file':
      return { label: `已读取 ${shorten(pretty(arg('path'), cwd), 60)}`, icon: '▤', detail: arg('path') }

    case 'list_dir':
      return { label: `已列出 ${shorten(pretty(arg('path'), cwd) || '工作区', 50)}`, icon: '▦', detail: arg('path') }

    case 'grep':
      return {
        label: `已在${arg('path') ? ' ' + shorten(pretty(arg('path'), cwd), 40) + ' 中' : '工作区'}搜索"${shorten(arg('pattern'), 40)}"`,
        icon: '⌕',
        detail: arg('path') || undefined,
      }

    case 'apply_patch': {
      const n = Array.isArray(p.files) ? (p.files as string[]).length : 0
      const one = arg('path')
      if (n > 1) return { label: `已修改 ${n} 个文件`, icon: '✎' }
      return { label: `已修改 ${shorten(pretty(one || ((p.files as string[])?.[0] ?? ''), cwd), 60)}`, icon: '✎' }
    }

    case 'write_file':
    case 'create_file':
      return { label: `已写入 ${shorten(pretty(arg('path'), cwd), 60)}`, icon: '✎', detail: arg('path') }

    case 'update_plan':
      return { label: '正在规划这一步', icon: '☰' }

    case 'use_skill':
      return { label: `加载技能 ${arg('name') || ''}`.trim(), icon: '✦' }

    case 'run_skill_script':
      return { label: `运行脚本 ${arg('script') || ''}`.trim(), icon: '⌘' }

    case 'spawn_agent':
    case 'delegate':
      return { label: '分一部分活给子 agent', icon: '↳', detail: arg('task') || undefined }

    case 'list_resources':
      return { label: '在找文档', icon: '▦' }
    case 'read_resource':
      return { label: '读取文档', icon: '▤', detail: arg('uri') || undefined }

    case 'remote_exec':
      return { label: `在 ${arg('host') || '远程机器'} 上执行`, icon: '⌘', detail: arg('command') || undefined }
  }

  // 协议/插件工具：前缀本身就是信息，说清楚它去了哪里
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__')
    const name = rest.join('__').replace(/^prompt_/, '')
    return { label: `${server}：${name.replace(/_/g, ' ')}` }
  }
  if (tool.startsWith('browser_')) {
    const a = tool.slice('browser_'.length)
    if (a === 'open') return { label: '打开网页', detail: arg('url') || undefined }
    if (a === 'look') return { label: '看页面' }
    if (a === 'click') return { label: '点击页面' }
    if (a === 'type') return { label: '输入文字' }
    if (a === 'screenshot') return { label: '截图' }
    return { label: `浏览器：${a.replace(/_/g, ' ')}` }
  }
  if (tool.startsWith('phone_')) {
    const a = tool.slice('phone_'.length)
    if (a === 'tap') return { label: '点手机屏幕' }
    if (a === 'type') return { label: '在手机上输入' }
    if (a === 'swipe') return { label: '滑动手机' }
    if (a === 'look') return { label: '看手机屏幕' }
    if (a === 'shot') return { label: '手机截图' }
    return { label: `手机：${a.replace(/_/g, ' ')}` }
  }

  // 兜底：把 snake_case 变成一句能读的话，而不是原样吐工具名
  const words = tool.replace(/[_-]+/g, ' ').trim()
  return { label: words, icon: '●' }
}

/** 工具跑完之后的说法 */
export function describeToolResult(tool: string, p: Record<string, unknown>): ProgressLine {
  if (p.refused === true) {
    const by = p.denied_by ? ` by ${String(p.denied_by)}` : ''
    return { label: `Blocked${by}` }
  }
  if (p.status === 'error') {
    const code = p.exit_code !== undefined ? ` (exit ${p.exit_code})` : ''
    return { label: `That did not work${code}` }
  }
  if (tool === 'run_command' || tool === 'exec') {
    const code = p.exit_code
    if (typeof code === 'number' && code !== 0) return { label: `Exited with ${code}` }
    return { label: 'Done' }
  }
  if (tool === 'apply_patch' || tool === 'write_file') return { label: 'Saved' }
  return { label: 'Done' }
}

/** 模型在调模型（llm/request）时，界面上说"在想"，不说 provider 名 */
export function describeThinking(): ProgressLine {
  return { label: 'Thinking' }
}

/** 文件改动汇总：Codex 的 `2 files +4 −0` */
export function describeFilesChanged(added: number, removed: number, count: number): ProgressLine {
  const parts = [`${count} file${count === 1 ? '' : 's'}`]
  if (added || removed) parts.push(`+${added} −${removed}`)
  return { label: parts.join(' · ') }
}
