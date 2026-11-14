/**
 * 交互式终端界面（`uh` 直接回车进入）。
 *
 * 目标不是「把一次性命令接个循环」，而是像 Codex CLI 那样能真的待在里面干活：
 *
 *   - 一个输入行：回车送出，↑↓ 翻历史，Ctrl+C 打断当前任务（空行上按就退出）
 *   - 边跑边看：思考、工具调用、回答都是流出来的，不是跑完才一口气吐
 *   - /model 选模型、/config 看和改配置、/skills 看有什么技能
 *   - @路径 把文件带进上下文，$技能 明确加载某个技能
 *   - 同一个会话可以连续对话，/new 才开新的
 *
 * 这里刻意不引入 TUI 框架：多一个依赖、多一套渲染模型，而终端里真正要紧的
 * 只有三件事——输入不丢、输出不花、Ctrl+C 随时能停。
 */
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  Harness, describeTool, describeToolResult, discoverSkills, readConfig, writeConfig,
  findProvider, listModels, uhHome, latestResumable,
} from '@unit-harness/core'
import type { ApprovalRequest, Message, ProviderDef } from '@unit-harness/core'

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
} as const

const isTTY = Boolean(process.stdout.isTTY)
/** 颜色只在真终端里用：重定向到文件时不该出现转义序列 */
const paint = (c: string, s: string): string => (isTTY ? c + s + C.reset : s)
const dim = (s: string): string => paint(C.dim, s)
const cyan = (s: string): string => paint(C.cyan, s)
const green = (s: string): string => paint(C.green, s)
const red = (s: string): string => paint(C.red, s)
const yellow = (s: string): string => paint(C.yellow, s)
const bold = (s: string): string => paint(C.bold, s)

interface TuiState {
  rl: readline.Interface
  /**
   * 跑的时候用户敲的东西排在这里。
   * 不排队的话，回车会被当成「上一条已经处理完了」立刻执行——管道里灌脚本时
   * 就会看到 `bye` 先于整套运行输出，交互时也一样会丢话。
   */
  queue: string[]
  /** 这一轮有没有真的流过文字：没流就把最终回答补上 */
  streamed: number
  messages: Message[]
  sessionId: string | undefined
  model: string
  provider: string
  running: boolean
  /** 上一次 Ctrl+C 的时间：连按两次直接退出 */
  lastInterrupt: number
  abort: Harness | null
  /** 回答正在流：用它决定要不要在下一行输出前补一个换行 */
  inline: boolean
  cwd: string
}

/** 历史记录落盘：重开终端还能翻到上次敲的 */
function historyFile(): string {
  return path.join(uhHome(), 'history')
}

function loadHistory(): string[] {
  try {
    return fs.readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).slice(-500)
  } catch {
    return []
  }
}

function saveHistory(line: string): void {
  if (!line.trim()) return
  try {
    fs.mkdirSync(uhHome(), { recursive: true })
    // 只追加，不重写：同时开两个终端时不会互相覆盖
    fs.appendFileSync(historyFile(), line + '\n')
  } catch { /* 历史存不下不算错误 */ }
}

/** 当前配置里的 provider 定义（找不到就给一个空壳，让后面报错说人话） */
function currentProvider(id: string): ProviderDef | undefined {
  return findProvider(id)
}

function readCurrent(): { provider: string; model: string; baseUrl: string; approval: string } {
  const cfg = readConfig()
  const id = cfg.defaultProvider ?? 'deepseek'
  const entry = (cfg.providers ?? {})[id] ?? {}
  const def = currentProvider(id)
  return {
    provider: id,
    model: String(entry.model ?? ''),
    baseUrl: String(entry.baseUrl ?? def?.baseUrl ?? ''),
    approval: String(cfg.approval ?? 'ask'),
  }
}

/** 工具调用的一行说明：CLI 和网页必须用同一套人话 */
function toolLine(name: string, args: Record<string, unknown>): string {
  try {
    return describeTool(name, args).label
  } catch {
    return name
  }
}

/**
 * 把 `@路径` 和 `$技能` 变成真正的上下文。
 *
 * 这两个记号是「我知道有这个东西，帮我带进来」的表达：@ 带进文件内容（大的只给
 * 指针），$ 带进技能正文。没有它们，用户要么记不住路径，要么得让模型自己去翻。
 */
function expandRefs(task: string, cwd: string): string {
  const blocks: string[] = []

  const files = new Set<string>()
  for (const m of task.matchAll(/(?:^|\s)@([\w./\-]+)/g)) {
    if (m[1]) files.add(m[1])
  }
  for (const rel of [...files].slice(0, 12)) {
    const abs = path.resolve(cwd, rel)
    if (!abs.startsWith(cwd + path.sep) && abs !== cwd) continue
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      blocks.push(`<file path="${rel}">(not found)</file>`)
      continue
    }
    if (!st.isFile()) continue
    if (st.size > 16 * 1024) {
      blocks.push(`<file path="${rel}" bytes="${st.size}">(too large to inline — open it with read_file)</file>`)
      continue
    }
    try {
      blocks.push(`<file path="${rel}">\n${fs.readFileSync(abs, 'utf8')}\n</file>`)
    } catch { /* 读不了就当没提过 */ }
  }

  const wanted = new Set<string>()
  for (const m of task.matchAll(/(?:^|\s)\$([\w\-]+)/g)) {
    if (m[1]) wanted.add(m[1])
  }
  if (wanted.size) {
    for (const s of discoverSkills(cwd)) {
      if (!wanted.has(s.name)) continue
      blocks.push(`<skill name="${s.name}">\n${s.body}\n</skill>`)
    }
  }

  if (!blocks.length) return task
  return `<attached>\n${blocks.join('\n')}\n</attached>\n\n${task}`
}

function banner(s: TuiState): void {
  // 不在这里构造 Harness 只为读一行说明：构造会碰工作区和沙箱探测，
  // 而「开始输入」这件事应该立刻可用。沙箱细节留给 `uh doctor`。
  console.log('')
  console.log('  ' + bold('UnitHarness') + dim('  ·  the agent that proves its work'))
  console.log('  ' + dim('model     ') + cyan(s.model || '(未设置——用 /model 选一个)') + dim(`  [${s.provider}]`))
  console.log('  ' + dim('workspace ') + s.cwd)
  console.log('  ' + dim('tips      ') + dim('/help  ·  @文件  ·  $技能  ·  Ctrl+C 打断'))
  console.log('')
}

function printHelp(): void {
  const rows: Array<[string, string]> = [
    ['/help', '这页说明'],
    ['/model [名字]', '选模型（不带参数会列出可用模型）'],
    ['/config', '看当前配置；/config approval ask|auto|allow'],
    ['/skills', '列出可用技能；发消息时写 $名字 就会加载它'],
    ['/files', '列出工作区里的文件（可以直接 @路径）'],
    ['/new', '开一个新会话（当前这段不再续）'],
    ['/resume [n]', '接着上一次的会话干（默认最近一次）'],
    ['/clear', '清屏（不动会话）'],
    ['/quit', '退出（Ctrl+C 两次也行）'],
    ['@路径', '把文件内容带进这次提问，例如 @src/cli.ts'],
    ['$技能', '明确加载某个技能，例如 $wechat-publisher'],
  ]
  console.log('')
  for (const [k, v] of rows) console.log('  ' + cyan(k.padEnd(18)) + v)
  console.log('')
}

async function cmdModel(s: TuiState, arg: string): Promise<void> {
  const cur = readCurrent()
  const def = currentProvider(cur.provider)
  if (!def) {
    console.log(red('  当前 provider 不认识：' + cur.provider) + dim('（用 uh provider list 看看有哪些）'))
    return
  }
  if (arg) {
    const cfg = readConfig()
    cfg.providers = cfg.providers ?? {}
    cfg.providers[cur.provider] = { ...(cfg.providers[cur.provider] ?? {}), model: arg }
    writeConfig(cfg)
    s.model = arg
    console.log('  ' + green('✓') + ' model → ' + cyan(arg) + dim('  [' + cur.provider + ']'))
    return
  }

  const key = String((readConfig().providers?.[cur.provider] ?? {}).apiKey ?? process.env[def.envKey ?? ''] ?? '')
  console.log(dim('  正在问 ' + cur.provider + ' 有哪些模型…'))
  let models: string[] = []
  try {
    models = await listModels(def, key, cur.baseUrl || undefined)
  } catch (e) {
    console.log(red('  取不到模型列表：' + (e instanceof Error ? e.message : String(e))))
    console.log(dim('  也可以直接写：/model 模型名'))
    return
  }
  if (!models.length) {
    console.log(yellow('  这家没有返回模型列表。') + dim('直接写：/model 模型名'))
    return
  }
  models.slice(0, 30).forEach((m, i) => {
    const mark = m === cur.model ? green('  ← 当前') : ''
    console.log('  ' + dim(String(i + 1).padStart(2) + '.') + ' ' + m + mark)
  })
  const pick = await new Promise<string>((resolve) => s.rl.question(dim('  序号或名字（回车取消）> '), resolve))
  const name = /^\d+$/.test(pick.trim()) ? models[Number(pick.trim()) - 1] : pick.trim()
  if (!name) {
    console.log(dim('  没改。'))
    return
  }
  await cmdModel(s, name)
}

function cmdConfig(s: TuiState, arg: string): void {
  const cur = readCurrent()
  const parts = arg.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    const cfg = readConfig()
    console.log('')
    console.log('  ' + dim('provider  ') + cur.provider)
    console.log('  ' + dim('model     ') + (cur.model || yellow('(未设置)')))
    console.log('  ' + dim('baseUrl   ') + cur.baseUrl)
    console.log('  ' + dim('approval  ') + cur.approval + dim('   (ask=每次问, auto=只问危险, allow=都放行)'))
    console.log('  ' + dim('config    ') + dim(path.join(uhHome(), 'config.json')))
    console.log('')
    return
  }
  const [k, v] = parts
  if (k === 'approval') {
    // 配置里只认 ask / auto / allow 三档（deny 是没接交互界面时的默认，不是用户选项）
    if (!v || !['ask', 'auto', 'allow'].includes(v)) {
      console.log(dim('  用法：/config approval ask|auto|allow'))
      return
    }
    const cfg = readConfig()
    cfg.approval = v as 'ask' | 'auto' | 'allow'
    writeConfig(cfg)
    console.log('  ' + green('✓') + ' approval → ' + v)
    return
  }
  if (k === 'model') {
    void cmdModel(s, v ?? '')
    return
  }
  console.log(dim('  能改的：approval、model。其余用 uh config set/use，或打开设置页。'))
}

function cmdSkills(cwd: string): void {
  const skills = discoverSkills(cwd)
  if (!skills.length) {
    console.log(dim('  还没有技能。把 SKILL.md 放进 ' + path.join(cwd, '.uh', 'skills', '<名字>') + '/ 或 ' + path.join(uhHome(), 'skills') + '/'))
    return
  }
  console.log('')
  for (const s of skills) {
    console.log('  ' + cyan('$' + s.name) + '  ' + dim(s.description || '(无描述)'))
  }
  console.log('')
  console.log(dim('  发消息时写 $名字 就会把它的正文带进这次提问。'))
  console.log('')
}

/** 列工作区里的文件：@ 的时候总得先知道有什么 */
function cmdFiles(cwd: string): void {
  const out = spawnSync('sh', ['-c', 'find . -maxdepth 3 -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./.uh/*" | head -80'], { cwd, encoding: 'utf8' })
  const lines = (out.stdout ?? '').split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, ''))
  if (!lines.length) {
    console.log(dim('  （工作区里没有文件）'))
    return
  }
  console.log('')
  for (const l of lines) console.log('  ' + dim('@') + l)
  console.log('')
}

function cmdResume(s: TuiState, arg: string): void {
  if (arg && arg !== '') {
    console.log(dim('  目前只支持接着最近一次（/resume）；指定 id 用 uh session show 查看。'))
  }
  const st = latestResumable()
  if (!st) {
    console.log(dim('  没有可以接着干的会话。'))
    return
  }
  s.messages = st.messages
  s.sessionId = st.sessionId
  console.log('  ' + green('✓') + ' 接着 ' + cyan(st.sessionId) + dim(`（${st.messages.length} 条消息，上次由 ${st.stoppedBy} 停下）`))
}

/** 一次提问：让模型干活，把过程流出来 */
async function runTurn(s: TuiState, task: string): Promise<void> {
  const expanded = expandRefs(task, s.cwd)
  const cur = readCurrent()
  const gate = {
    request: async (req: ApprovalRequest): Promise<'allow' | 'deny'> => {
      finishInline(s)
      console.log('')
      console.log('  ' + yellow('⚠ 需要批准：' + req.reason))
      console.log('  ' + dim(String(req.detail).split('\n').join('\n  ')))
      const a = await new Promise<string>((resolve) => s.rl.question('  ' + yellow('放行？[y/N] '), resolve))
      return /^y(es)?$/i.test(a.trim()) ? 'allow' : 'deny'
    },
  }

  let files = 0
  let steps = 0
  s.streamed = 0
  const h = new Harness({
    record: true,
    logLevel: 'warn',
    ...(s.sessionId ? { resumeSessionId: s.sessionId } : { label: task.slice(0, 60) }),
    workspace: s.cwd,
    ...(process.stdin.isTTY ? { gate } : {}),
    onText: (d) => {
      // 回答直接流到屏幕上：中途按 Ctrl+C 也能立刻停
      s.inline = true
      s.streamed += d.length
      process.stdout.write(d)
    },
    onReasoning: (d) => {
      // 思考也流，但压暗；换行照常，不然一行会被无限拉长
      if (!isTTY) return
      s.inline = true
      process.stdout.write(paint(C.dim, d))
    },
    onEvent: (kind, p) => {
      if (kind === 'step/end') steps = Number(p.step_index ?? steps)
      if (kind === 'checkpoint/file') {
        files++
        return
      }
      if (kind === 'tool/call') {
        finishInline(s)
        const label = toolLine(String(p.tool ?? ''), p as Record<string, unknown>)
        console.log('  ' + dim('● ') + label)
        return
      }
      if (kind === 'tool/result') {
        if (p.status !== 'ok') {
          finishInline(s)
          console.log('  ' + red('✗ ') + dim(String(p.label ?? 'failed')))
        }
        return
      }
      if (kind === 'error') {
        finishInline(s)
        console.log('  ' + red('ERROR: ' + String(p.message ?? '')))
        return
      }
      if (kind === 'budget/warning') {
        finishInline(s)
        console.log('  ' + yellow('⚠ 预算快用完了'))
        return
      }
      if (kind === 'step/end' && p.kind === 'stuck') {
        finishInline(s)
        console.log('  ' + yellow('⚠ 同一个动作反复失败，停下了'))
      }
    },
  })
  s.abort = h

  try {
    // start() 才是「开会话」的地方：不调用它，事件不落盘、sessionId 是 null，
    // 于是连续对话其实是各说各话——第一轮的记忆根本没存在这里。
    await h.start()
    const res = await h.runTask({
      task: expanded,
      ...(s.messages.length ? { resumeFrom: s.messages } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(cur.provider ? { provider: cur.provider } : {}),
    })
    s.messages = res.messages
    s.sessionId = h.sessionId ?? s.sessionId
    finishInline(s)
    // 有些链路不吐流式增量（非流式响应、或者中途重试过）：
    // 那时候屏幕上会一行回答都没有——把最终文本补上，别让人以为它什么都没说。
    if (!s.streamed && res.text) console.log('  ' + res.text.replace(/\n/g, '\n  '))
    const secs = (res.usage.total / 1000).toFixed(1)
    const tail = [
      res.stoppedBy === 'model' ? green('✓ done') : yellow('· ' + res.stoppedBy),
      dim(`${res.steps} steps · ${secs}k tokens${files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}`),
    ].join('  ')
    console.log('')
    console.log('  ' + tail)
    console.log('')
  } catch (e) {
    finishInline(s)
    console.log('  ' + red('出错了：' + (e instanceof Error ? e.message : String(e))))
    console.log('')
  } finally {
    // 每轮结束都把会话封好：下一轮 reopen 同一条，日志才是连续的一段
    try { h.dispose() } catch { /* 收尾失败不该盖掉已经显示的结果 */ }
    s.abort = null
    s.running = false
  }
}

/** 流式输出没以换行结尾时补一个：状态行不能粘在回答最后一句后面 */
function finishInline(s: TuiState): void {
  if (!s.inline) return
  s.inline = false
  process.stdout.write('\n')
}

export async function runTui(): Promise<void> {
  const cur = readCurrent()
  const s: TuiState = {
    rl: undefined as unknown as readline.Interface,
    queue: [],
    streamed: 0,
    messages: [],
    sessionId: undefined,
    model: cur.model,
    provider: cur.provider,
    running: false,
    lastInterrupt: 0,
    abort: null,
    inline: false,
    cwd: process.cwd(),
  }

  s.rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    history: loadHistory().reverse(),
    historySize: 500,
    removeHistoryDuplicates: true,
    terminal: Boolean(process.stdin.isTTY),
  })

  banner(s)

  const prompt = (): void => {
    s.rl.setPrompt(dim('› ') + '')
    s.rl.prompt()
  }

  // Ctrl+C：正在跑就打断这一轮（会话保留），闲着就连按两次退出。
  // 直接 process.exit 会把用户正看着的回答也一起弄丢。
  s.rl.on('SIGINT', () => {
    if (s.running && s.abort) {
      s.abort.abort()
      process.stdout.write('\n')
      console.log('  ' + yellow('· 已打断（这段对话还在，可以接着说）'))
      return
    }
    const now = Date.now()
    if (now - s.lastInterrupt < 1500) {
      console.log('')
      s.rl.close()
      return
    }
    s.lastInterrupt = now
    process.stdout.write('\n')
    console.log(dim('  再按一次 Ctrl+C 退出，或输入 /quit'))
    prompt()
  })

  /**
   * 一行输入的处理。返回 true 表示「该退出了」。
   *
   * 单独抽出来是为了让调用方可以 await：跑一轮的时候新敲的话先排队，
   * 轮到它们时**按顺序一个一个跑**。以前是同步 emit 回去，第二句会在
   * 第一句还没跑完时就开始，/quit 更是直接关掉 rl 把正在跑的那轮甩掉
   * （屏幕上就会先出现 bye，然后才出现结果）。
   */
  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim()
    if (!text) return
    saveHistory(text)

    if (text.startsWith('/')) {
      const [cmdName, ...rest] = text.slice(1).split(/\s+/)
      const arg = rest.join(' ')
      switch (cmdName) {
        case 'help': case 'h': case '?': printHelp(); break
        case 'quit': case 'exit': case 'q': s.rl.close(); return
        case 'model': await cmdModel(s, arg); break
        case 'config': cmdConfig(s, arg); break
        case 'skills': cmdSkills(s.cwd); break
        case 'files': case 'ls': cmdFiles(s.cwd); break
        case 'new':
          s.messages = []
          s.sessionId = undefined
          console.log('  ' + green('✓') + ' 新会话')
          break
        case 'resume': cmdResume(s, arg); break
        case 'clear': if (isTTY) process.stdout.write('\x1b[2J\x1b[H'); banner(s); break
        default: console.log(dim('  没有这个命令：/' + cmdName + '，试试 /help'))
      }
      prompt()
      return
    }

    s.running = true
    await runTurn(s, text)
    prompt()
  }

  let draining = false
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      while (s.queue.length) {
        const next = s.queue.shift() as string
        await handleLine(next)
      }
    } finally {
      draining = false
    }
  }

  s.rl.on('line', (line) => {
    s.queue.push(line)
    void drain()
  })

  await new Promise<void>((resolve) => s.rl.on('close', () => resolve()))
  console.log(dim('  bye'))
}
