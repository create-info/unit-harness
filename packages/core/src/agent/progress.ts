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
  if (!cmd) return { label: 'Running a command' }

  // `sh -c "..."` / `bash -c "..."` 只是外壳，真正要看的是里面那条
  const inner = /^(?:ba|z|d)?sh\s+-[a-z]*c\s+(.*)$/s.exec(cmd)
  const real = (inner?.[1] ?? cmd).replace(/^['"]|['"]$/g, '').trim()
  const head = real.split(/\s+/)[0] ?? ''
  const rest = real.slice(head.length).trim()

  // 跑测试：这是最常见的"我现在在验证"，值得单独说
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/.test(real)) return { label: 'Running the tests', detail: real }
  if (/^(pytest|tox|nox)\b/.test(real)) return { label: 'Running the tests', detail: real }
  if (/^(cargo|go)\s+test\b/.test(real)) return { label: 'Running the tests', detail: real }
  if (/^(jest|vitest|mocha|ava)\b/.test(real)) return { label: 'Running the tests', detail: real }
  if (/^node\s+--test\b/.test(real)) return { label: 'Running the tests', detail: real }

  if (/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b/.test(real)) return { label: 'Installing packages', detail: real }
  if (/^(pip|pip3|uv)\s+install\b/.test(real)) return { label: 'Installing packages', detail: real }
  if (/^(cargo|go)\s+(build|install)\b/.test(real)) return { label: 'Building', detail: real }

  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck|type-check)\b/.test(real)) {
    return { label: 'Building and checking', detail: real }
  }

  if (/^git\s+(status|diff|log|show|branch)\b/.test(real)) return { label: 'Looking at the repo', detail: real }
  if (/^git\s+(add|commit)\b/.test(real)) return { label: 'Committing changes', detail: real }
  if (/^git\s+(push|pull|fetch|clone)\b/.test(real)) return { label: 'Talking to the remote', detail: real }

  // 只读的看一眼
  if (/^(ls|ll|dir)\b/.test(real)) return { label: 'Listing files', detail: real }
  if (/^(cat|head|tail|less|more)\b/.test(real)) {
    const last = rest.split(/\s+/).pop() || ''
    return { label: rest ? `Reading ${shorten(pretty(last), 60)}` : 'Reading a file', detail: real }
  }
  if (/^(grep|rg|ag|ack)\b/.test(real)) {
    const m = /(?:-e\s+)?['"]?([^'"\s-][^'"]*)['"]?/.exec(rest)
    const pat = m?.[1] ?? ''
    return { label: pat ? `Searching for "${shorten(pat, 40)}"` : 'Searching', detail: real }
  }
  if (/^(find|fd)\b/.test(real)) return { label: 'Finding files', detail: real }
  if (/^(which|command|type)\b/.test(real)) return { label: 'Checking what is installed', detail: real }

  if (/^(rm|rmdir|unlink)\b/.test(real)) return { label: 'Deleting', detail: real }
  if (/^(mv|cp|ln)\b/.test(real)) return { label: 'Moving files', detail: real }
  if (/^mkdir\b/.test(real)) return { label: 'Creating a directory', detail: real }
  if (/^(chmod|chown)\b/.test(real)) return { label: 'Changing permissions', detail: real }

  if (/^(curl|wget)\b/.test(real)) return { label: 'Fetching from the network', detail: real }
  if (/^(ssh|scp|rsync)\b/.test(real)) return { label: 'Working on a remote machine', detail: real }
  if (/^(docker|podman)\b/.test(real)) return { label: 'Working with containers', detail: real }
  if (/^(systemctl|service|journalctl)\b/.test(real)) return { label: 'Looking at services', detail: real }
  if (/^(node|python|python3|deno|bun|ruby|perl|php)\b/.test(real)) {
    return { label: `Running ${basename(head)}`, detail: real }
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
    case 'exec':
      return describeCommand(argv ?? arg('command'))

    case 'read_file':
      return { label: `Reading ${shorten(pretty(arg('path'), cwd), 60)}`, detail: arg('path') }

    case 'list_dir':
      return { label: `Listing ${shorten(pretty(arg('path'), cwd) || 'the workspace', 50)}`, detail: arg('path') }

    case 'grep':
      return {
        label: `Searching${arg('pattern') ? ` for "${shorten(arg('pattern'), 40)}"` : ''}`,
        detail: arg('path') || undefined,
      }

    case 'apply_patch': {
      const n = Array.isArray(p.files) ? (p.files as string[]).length : 0
      const one = arg('path')
      if (n > 1) return { label: `Editing ${n} files` }
      return { label: `Editing ${shorten(pretty(one || ((p.files as string[])?.[0] ?? ''), cwd), 60)}` }
    }

    case 'write_file':
    case 'create_file':
      return { label: `Writing ${shorten(pretty(arg('path'), cwd), 60)}`, detail: arg('path') }

    case 'update_plan':
      return { label: 'Planning the work' }

    case 'use_skill':
      return { label: `Loading the ${arg('name') || 'skill'} skill` }

    case 'run_skill_script':
      return { label: `Running ${arg('script') || 'a skill script'}` }

    case 'spawn_agent':
    case 'delegate':
      return { label: 'Handing part of it to a sub-agent', detail: arg('task') || undefined }

    case 'list_resources':
      return { label: 'Looking for documents' }
    case 'read_resource':
      return { label: 'Reading a document', detail: arg('uri') || undefined }

    case 'remote_exec':
      return { label: `Working on ${arg('host') || 'a remote machine'}`, detail: arg('command') || undefined }
  }

  // 协议/插件工具：前缀本身就是信息，说清楚它去了哪里
  if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__')
    const name = rest.join('__').replace(/^prompt_/, '')
    return { label: `Asking ${server} to ${name.replace(/_/g, ' ')}` }
  }
  if (tool.startsWith('browser_')) {
    const a = tool.slice('browser_'.length)
    if (a === 'open') return { label: 'Opening a page', detail: arg('url') || undefined }
    if (a === 'look') return { label: 'Looking at the page' }
    if (a === 'click') return { label: 'Clicking on the page' }
    if (a === 'type') return { label: 'Typing into the page' }
    if (a === 'screenshot') return { label: 'Taking a screenshot' }
    return { label: `Using the browser (${a})` }
  }
  if (tool.startsWith('phone_')) {
    const a = tool.slice('phone_'.length)
    if (a === 'tap') return { label: 'Tapping on the phone' }
    if (a === 'type') return { label: 'Typing on the phone' }
    if (a === 'swipe') return { label: 'Swiping on the phone' }
    if (a === 'look') return { label: 'Looking at the phone screen' }
    if (a === 'shot') return { label: 'Screenshotting the phone' }
    return { label: `Using the phone (${a})` }
  }

  // 兜底：把 snake_case 变成一句能读的话，而不是原样吐工具名
  const words = tool.replace(/[_-]+/g, ' ').trim()
  return { label: words.charAt(0).toUpperCase() + words.slice(1) }
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
