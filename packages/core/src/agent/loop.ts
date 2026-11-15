/**
 * Agent 循环：turn → step → (llm → tools) → step → … → turn end。
 *
 * 借鉴 Codex 第 10 讲的骨架，但按我们的规模收敛：
 *  - 模型每步只做两种事之一：要工具，或给最终回答（契约明确，状态机简单）；
 *  - 工具结果按调用顺序回填，但互不依赖的可以并行（apply_patch 例外，它改文件）；
 *  - 每一步都落事件；工具本身由 exec/callTool 留痕，循环只写 turn/step。
 */
import type { CompletionResult, Message, ToolCall, ToolSpec } from '../llm/types.ts'
import type { LlmGateway } from '../llm/gateway.ts'
import type { ToolDefinition } from '../types.ts'
import { parsePatch, planPatch } from './tools/apply-patch.ts'
import { searchImages } from './image-search.ts'
import { checkBudget } from './budget.ts'
import { compactMessages, shouldCompact } from './compact.ts'
import { prepareToolOutput } from './output.ts'
import { sliceLines, formatEntry, formatHits, looksBinary } from './tools/fs.ts'
import type { ReadResult } from './tools/fs.ts'
import type { HookEvent, HookOutcome } from '../hook/hooks.ts'
import type { Skill } from '../skill/registry.ts'
import type { ImageInput } from '../llm/types.ts'

export interface RunCommandArgs {
  argv: string[]
  timeoutMs?: number
  /** 沙箱挡住之后，申请这一次跑在外面；必须附理由 */
  escalate?: string
}

export interface PlanStep {
  step: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AgentDeps {
  workspace: string
  /** 系统提示：沙箱边界、可用工具、行为要求（为空则不注入） */
  system?: string
  gateway: LlmGateway
  tools: ReadonlyArray<ToolDefinition>
  /** 内置 run_command：走 exec，因而自动受沙箱约束 */
  runCommand: (args: RunCommandArgs) => Promise<{ content: string }>
  /** 调用插件注册的工具（自带事件记录） */
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: string }>
  /** 工作区内文件访问（调用方负责 safeJoin，挡住 ../ 逃逸） */
  readFile: (rel: string) => string | null
  /** 带行号的切片读取；文件不存在返回 null */
  readSlice: (rel: string, offset: number, limit: number) => ReadResult | null
  /** 目录树文本；目录不存在返回 null */
  listTree: (rel: string, depth: number) => string | null
  /** 内容检索；路径非法返回 null */
  grep: (rel: string, pattern: string, opts: { glob?: string | undefined; max: number }) => { text: string; count: number } | null
  /**
   * 读一张图作为多模态附件。给不了就是 null（不支持的格式/读不到/太大）。
   * 工具结果本身只是一行文字——像素要另外挂到消息上，见 execOne 的返回值。
   */
  readImage?: (rel: string) => { mediaType: string; data: string } | null
  /** 起一个子 agent 干活，返回它的最终文本（不给就是禁用了子 agent） */
  spawnSubAgent?: (task: string, opts: { maxSteps?: number }) => Promise<string>
  /** 跑某个挂点的 hook；返回被挡下的那些 */
  runHooks?: (event: HookEvent, ctx: { tool?: string; command?: string }) => Promise<HookOutcome[]>
  writeFile: (rel: string, content: string) => void
  /** 写二进制（图片下载用）；同样是工作区相对路径 */
  writeBytes: (rel: string, bytes: Uint8Array) => void
  deleteFile: (rel: string) => void
  ev: (
    kind:
      | 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'plan/updated'
      | 'assistant/message'
      | 'tool/call' | 'tool/result' | 'tool/output' | 'session/compacted' | 'steering/message'
      | 'budget/warning' | 'budget/exceeded',
    payload: Record<string, unknown>,
  ) => string | null
  log: (msg: string) => void
  /** 流式：模型正文增量（CLI 用来实时打印） */
  onText?: (delta: string) => void
  /** 流式：推理模型思考增量 */
  onReasoning?: (delta: string) => void
  /** 是否启用 update_plan（关闭时连工具都不给，学 Codex 的按需切除） */
  planEnabled?: boolean
  /** 上下文预算：超过 budget*0.7 就压缩（0 = 关闭压缩） */
  maxContextTokens?: number
  /** 可用的 skills（正文按需加载） */
  skills?: Skill[]
  /**
   * 取走这期间用户追加的指令。
   *
   * 每步开头取一次，取到的当成一条新的用户消息插进去——不是改原来的任务，
   * 是「在它干活的时候插话」。放在 step 边界而不是工具执行中间，是因为
   * 半路改消息会让这次工具调用的上下文对不上，日志也不好读。
   */
  /** 取走积压的插话。带上 id，前端才能准确摘掉「这一条」而不误伤同名的一条 */
  drainSteer?: () => { id: string; text: string }[]
}

export interface RunResult {
  text: string
  steps: number
  usage: { prompt: number; completion: number; total: number }
  /** 'stuck' = 同一个动作连续失败，模型在空转（不是任务太长，是原地打转） */
  stoppedBy: 'model' | 'max-steps' | 'timeout' | 'interrupted' | 'budget' | 'stuck'
  /** 结束时完整消息列表，供续跑落盘 */
  messages: Message[]
  plan: PlanStep[]
  compactions: number
}

// ---------- 内置工具定义 ----------

const RUN_COMMAND: ToolSpec = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run a program inside the sandbox. argv is an array: ["ls","-la","."]. Shell syntax ' +
      '(pipes, redirects, `&&`) needs an explicit ["sh","-c","..."]. Use this to inspect, test, ' +
      'build, and run things — not to modify files (use apply_patch for that).',
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'program and its arguments' },
        timeoutMs: { type: 'number', description: 'timeout in milliseconds (default 60000)' },
      },
      required: ['argv'],
      additionalProperties: false,
    },
  },
}

const APPLY_PATCH: ToolSpec = {
  type: 'function',
  function: {
    name: 'apply_patch',
    description:
      'Create, edit, move or delete files with a patch. ALWAYS prefer this over shell redirection: ' +
      'the patch is applied atomically — if any hunk fails to match, nothing is written. ' +
      'Format:\n' +
      '*** Begin Patch\n' +
      '*** Add File: path/to/new.txt\n' +
      '+first line\n' +
      '*** Update File: path/to/existing.txt\n' +
      '@@ optional context line\n' +
      '-line to remove\n' +
      '+line to add\n' +
      '*** Delete File: path/to/gone.txt\n' +
      '*** End Patch\n' +
      'Context lines start with a space. Paths are relative to the workspace.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'the full patch text, starting with *** Begin Patch' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
  },
}

const USE_SKILL: ToolSpec = {
  type: 'function',
  function: {
    name: 'use_skill',
    description:
      'Load a skill: returns its full instructions. Call this when the task matches a skill listed ' +
      'in <available_skills>. Load it before starting work, not after — the skill usually tells you ' +
      'how it expects to be used.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill name from the list' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
}

const RUN_SKILL_SCRIPT: ToolSpec = {
  type: 'function',
  function: {
    name: 'run_skill_script',
    description:
      'Run a script that ships with a skill you already loaded. Only use script paths listed when ' +
      'you loaded the skill. Runs through the same sandbox and approval gate as run_command.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'skill name' },
        script: { type: 'string', description: 'path as listed by use_skill, e.g. scripts/check.sh' },
        args: { type: 'array', items: { type: 'string' }, description: 'arguments passed through' },
      },
      required: ['skill', 'script'],
      additionalProperties: false,
    },
  },
}

const UPDATE_PLAN: ToolSpec = {
  type: 'function',
  function: {
    name: 'update_plan',
    description:
      'Record or revise the task plan. Call it at the start of multi-step work and after each step ' +
      'finishes. Keep exactly one step in_progress. This is the only place the user sees your plan — ' +
      'do not narrate plans in prose instead.',
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'the full list of steps, in order',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['step', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
  },
}

function toToolSpecs(tools: ReadonlyArray<ToolDefinition>): ToolSpec[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema as unknown as Record<string, unknown> },
  }))
}

const MAX_RESULT_CHARS = 8000

function clip(s: string): string {
  return s.length <= MAX_RESULT_CHARS ? s : `${s.slice(0, MAX_RESULT_CHARS)}\n… [truncated ${s.length - MAX_RESULT_CHARS} chars]`
}

const SPAWN_AGENT: ToolSpec = {
  type: 'function',
  function: {
    name: 'spawn_agent',
    description:
      'Delegate a self-contained subtask to a sub-agent. It gets its own context and works in the ' +
      'same workspace, then returns a written summary. Use it for exploring a big tree, or for ' +
      'several independent lookups you would otherwise do one after another. Do NOT use it for ' +
      'steps that depend on what you just learned — you already have that context, it does not.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'A complete, standalone instruction' },
        // 默认不限步数：绝大多数子任务不需要人操心步数，给了上限反而会在
        // 「读到一半」把它砍断。这个参数只用于确实想封顶的调用。
        max_steps: {
          type: 'integer',
          description: 'Optional hard ceiling on the sub-agent\'s steps. Omit for no limit.',
        },
      },
      required: ['task'],
    },
  },
}


const SEARCH_IMAGES: ToolSpec = {
  type: 'function',
  function: {
    name: 'search_images',
    description:
      'Find real photos and illustrations online and save them into the workspace. ' +
      'Use this whenever the task needs a picture — do NOT scrape image search engines, ' +
      'they return HTML, watermarked thumbnails and no usable license. ' +
      'Results come from Openverse (Creative Commons / public domain) and each file is saved ' +
      'with its title, author, license and source page so attribution is possible.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the picture should show, e.g. "fried noodles"' },
        count: { type: 'integer', description: 'How many images to save, 1-8. Default 3.' },
        dir: { type: 'string', description: 'Folder for the files, relative to the workspace. Default "images".' },
      },
      required: ['query'],
    },
  },
}

const READ_FILE: ToolSpec = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read a text file from the workspace. Every line is prefixed with its line number. ' +
      'For anything long, read it in slices with offset/limit instead of pulling the whole file in.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root' },
        offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'integer', description: 'How many lines. Default 2000.' },
      },
      required: ['path'],
    },
  },
}

const LIST_DIR: ToolSpec = {
  type: 'function',
  function: {
    name: 'list_dir',
    description:
      'List a directory in the workspace. Prefer this over running `ls`: it cannot fail on shell quirks and reports sizes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Default "."' },
        depth: { type: 'integer', description: 'Recursion depth, 1-3. Default 1.' },
      },
    },
  },
}

const VIEW_IMAGE: ToolSpec = {
  type: 'function',
  function: {
    name: 'view_image',
    description:
      'Look at an image file from the workspace (screenshot, chart, photo, scanned page). The picture ' +
      'is shown to you as an attachment after the call returns — you do not get pixels from reading ' +
      'the bytes. Use this instead of guessing what a file looks like from its name or size.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Image path relative to the workspace root' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
}

/**
 * 问「还能用多少上下文」。
 *
 * 加这个不是为了好玩：一条 3000 步的会话里，模型反复去猜自己是不是快满了，
 * 于是提前压缩、提前收尾——而它猜不出。这个问题只有 harness 知道答案
 * （每次 LLM 响应都带 prompt_tokens），所以直接让它问。
 */
const GET_CONTEXT_REMAINING: ToolSpec = {
  type: 'function',
  function: {
    name: 'get_context_remaining',
    description:
      'How much context is left before the harness compacts the conversation. Returns the token ' +
      'budget, what the last request used, and how many tokens remain. Ask this instead of guessing ' +
      'whether to wrap up.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
}

const GREP: ToolSpec = {
  type: 'function',
  function: {
    name: 'grep',
    description:
      'Search file contents in the workspace with a regular expression. Returns path:line:text. ' +
      'Skips binaries, .git, node_modules and .uh.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression' },
        path: { type: 'string', description: 'Directory or file to search. Default "."' },
        glob: { type: 'string', description: 'Only files whose name matches, e.g. "*.ts"' },
        max: { type: 'integer', description: 'Stop after this many matches. Default 60.' },
      },
      required: ['pattern'],
    },
  },
}

export async function runAgent(
  deps: AgentDeps,
  opts: {
    task: string
    /**
     * 屏幕上该显示的那句话。
     *
     * 任务文本里可能塞了 @文件内容、技能正文、MCP 交代——那是给模型的，
     * 不是给人看的。日志里记原文，界面才会显示用户真正写的那一句。
     */
    displayTask?: string
    maxSteps?: number
    maxSeconds?: number
    signal?: AbortSignal
    /** 续跑：上次会话的消息（system 会被新提示替换） */
    initialMessages?: Message[]
    /**
     * 这是这条会话里的第几轮。单轮调用不传（=1）；网页多轮必须传实际轮次，
     * 否则同一会话里会出现两个 `turn_index: 1`，回放和「撤销上一轮」都会认错边界。
     */
    turnIndex?: number
    /** 附在第一轮用户消息上的图片 */
    images?: ImageInput[]
    /** 成本预算（token）：到线就停，stoppedBy 记为 'budget' */
    budget?: { perRun?: number; perDay?: number; dayUsed?: number }
  },
): Promise<RunResult> {
  // 这条会话里的第几轮：多轮对话必须递增，单轮默认仍是 1
  const turnIndex = opts.turnIndex ?? 1
  // 步数不再是「默认 12 步」的硬上限。
  //
  // 12 步是一个探索型任务的起步价：看目录、读两个文件、grep 一次就没了，
  // 然后这一轮被判成 max-steps，答案是空的——用户看到的是「Hit the step limit」
  // 加一片空白。Codex 没有这个上限，边界是上下文和用户的耐心，我们同样交给
  // 预算（token）、用户 Stop 和真正的死循环去管；想限就用 --max-steps 明说。
  const maxSteps = opts.maxSteps ?? 0            // 0 = 不限步数
  const deadline = opts.maxSeconds ? Date.now() + opts.maxSeconds * 1000 : Infinity
  const planEnabled = deps.planEnabled !== false

  // task 必须落进日志：没有它，事后回放一个会话只知道"跑了三步"，不知道用户要的是什么。
  // A2A 的 history 也靠这条事件还原第一条用户消息。
  deps.ev('turn/start', {
    turn_index: turnIndex,
    trigger: 'user',
    task: opts.task,
    ...(opts.displayTask ? { display_task: opts.displayTask } : {}),
  })

  const messages: Message[] = []
  if (deps.system) messages.push({ role: 'system', content: deps.system })
  // 续跑：保留历史（去掉旧 system，换成当前这次的环境/工具描述），再接新指令
  const carried = (opts.initialMessages ?? []).filter((m) => m.role !== 'system')
  messages.push(...carried)
  if (opts.task.trim() || opts.images?.length) {
    messages.push({
      role: 'user',
      content: opts.task,
      ...(opts.images?.length ? { images: opts.images } : {}),
    })
  }

  const skills = deps.skills ?? []
  // 上下文预算：工具表里「有没有 get_context_remaining」取决于它，所以先算
  const budget = deps.maxContextTokens ?? 0
  const tools: ToolSpec[] = [
    RUN_COMMAND,
    READ_FILE,
    LIST_DIR,
    GREP,
    ...(deps.readImage ? [VIEW_IMAGE] : []),
    ...(budget > 0 ? [GET_CONTEXT_REMAINING] : []),
    SEARCH_IMAGES,
    SPAWN_AGENT,
    ...(skills.some((s) => s.scripts.length) ? [RUN_SKILL_SCRIPT] : []),
    APPLY_PATCH,
    ...(planEnabled ? [UPDATE_PLAN] : []),
    ...(skills.length > 0 ? [USE_SKILL] : []),
    ...toToolSpecs(deps.tools),
  ]

  let steps = 0
  let stoppedBy: RunResult['stoppedBy'] = 'model'
  const usage = { prompt: 0, completion: 0, total: 0 }
  const costBudget = opts.budget
  // 「快到线」只提醒一次，不然每一步都弹一句
  let budgetWarned = false
  // 卡死检测：同一条失败动作连续出现几次就停（见下面 step 末尾）
  let stuckSig = ''
  let stuckN = 0
  const STUCK_REPEATS = 5

  /**
   * 把一次工具调用压成「动作」，用来判重复。
   *
   * 参数里随手边情况变化的部分（URL、文件名、行号、offset）不属于动作本身：
   * 「换一个站点接着抓」「换一个文件接着读」是同一件事在重复，不是新进展。
   * 反过来，`npm test` 和 `npm build`、`python x.py` 和 `python y.py` 是不同动作，
   * 主体不同就该区分开。
   */
  const actionKey = (raw: unknown): string => {
    const s = String(raw ?? '')
    let o: Record<string, unknown> = {}
    try { o = JSON.parse(s) as Record<string, unknown> } catch { return s.slice(0, 80) }
    const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '')

    // exec：取 argv 里真正的命令主体（解释器 + 脚本名 / 命令名 + 子命令），丢掉参数
    const argv = Array.isArray(o.argv) ? (o.argv as unknown[]).map(String) : null
    if (argv && argv.length) {
      // `sh -c "cd X && cmd ..."` 的真正动作是 cmd：先剥掉 cd/env 前缀，再取前三个词
      const script = argv[0] === 'sh' || argv[0] === 'bash' ? argv.slice(2).join(' ') : ''
      const core = script
        .replace(/^\s*(cd\s+\S+\s*&&\s*)+/, '')
        .replace(/^\s*(export\s+\S+=\S*\s*)+/, '')
        .split(/\s*(?:&&|\||;)\s*/)[0]
      const a = core ? core.split(/\s+/).slice(0, 3) : argv.slice(0, 3)
      // 脚本路径只留文件名，换目录找同一份脚本算同一动作
      return a.map((x) => x.split('/').pop() ?? x).join(' ')
    }
    // 文件类工具：只看工具名和目录层级，不看具体文件
    const p = str('path') || str('file')
    if (p) {
      const seg = p.split(/[\\/]+/).filter(Boolean)
      return seg.length > 1 ? seg.slice(0, 2).join('/') : (seg[0] ?? p)
    }
    // 抓网页：抓哪儿都是同一件事（换站点只是碰运气），统一成 fetch
    if (str('url') || str('query')) return 'fetch'
    for (const k of ['cmd', 'command']) if (str(k)) return str(k).split(/\s+/).slice(0, 2).join(' ')
    return Object.keys(o).sort().join(',')
  }
  let lastText = ''
  /** 最近一次 LLM 请求的 prompt_tokens（get_context_remaining 用） */
  let lastPromptTokens = 0
  let plan: PlanStep[] = []
  let compactions = 0

  // 工具结果的两种形态：几乎都是纯文本；view_image 还要把像素挂到消息上。
  // 用对象而不是往字符串里塞 base64 —— 后者会进事件日志，一条会话能涨到几十 MB。
  type ToolOutcome = string | { text: string; image?: { path: string; mediaType: string; data: string } }

  const execOne = async (call: ToolCall): Promise<ToolOutcome> => {
    const name = call.function.name
    // apply_patch / update_plan 在进程内执行，不经过 exec，因此这里自己补审计
    const needsOwnEvent =
      name === 'apply_patch' || name === 'update_plan' || name === 'use_skill' || name === 'run_skill_script' ||
      name === 'read_file' || name === 'list_dir' || name === 'grep' || name === 'spawn_agent' ||
      name === 'search_images' || name === 'view_image' || name === 'get_context_remaining'
    let callEvId: string | null = null
    if (needsOwnEvent) {
      // args 是完整参数（页面点开看「它拿什么去调」），args_preview 留给
      // 一行式摘要。两者都存：只留 200 字预览的话，参数一多就只剩半截 JSON。
      const rawArgs = String(call.function.arguments || '')
      callEvId = deps.ev('tool/call', {
        tool: name,
        args_preview: rawArgs.slice(0, 200),
        args: rawArgs.slice(0, 4000),
      })
    }
    const finish = (status: 'ok' | 'error', detail?: Record<string, unknown>): void => {
      if (needsOwnEvent) {
        deps.ev('tool/result', { tool: name, status, isolation: 'in-process', ...(detail ?? {}) })
      }
    }
    let args: Record<string, unknown>
    try {
      args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
    } catch {
      // 这里必须先收尾再返回：tool/call 已经写进日志了，少一条 tool/result
      // 就变成「调用过、没有结果」——审计链断在半空，事后无法判断到底执行没执行
      finish('error', { error: 'arguments are not valid JSON' })
      return `ERROR: arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`
    }

    // ---- pre_tool hooks：挡在真正执行之前 ----
    if (deps.runHooks) {
      const cmd = name === 'run_command' && Array.isArray(args.argv) ? (args.argv as string[]).join(' ') : undefined
      const blocked = await deps.runHooks('pre_tool', { tool: name, ...(cmd === undefined ? {} : { command: cmd }) })
      if (blocked.length > 0) {
        finish('error', { error: 'blocked by hook', hook: blocked[0]?.name })
        return `BLOCKED by hook ${blocked[0]?.name}:\n${blocked.map((b) => b.output.slice(0, 500)).join('\n')}`
      }
    }

    try {
      if (name === 'run_command') {
        const a = args as unknown as RunCommandArgs
        if (!Array.isArray(a.argv) || a.argv.length === 0 || a.argv.some((x) => typeof x !== 'string')) {
          finish('error', { error: 'bad argv' })
          return 'ERROR: run_command expects argv: string[] with at least one element'
        }
        return (await deps.runCommand(a)).content
      }

      if (name === 'spawn_agent') {
        const subTask = String(args.task ?? '').trim()
        if (!subTask) { finish('error', { error: 'missing task' }); return 'ERROR: spawn_agent needs a `task`' }
        if (!deps.spawnSubAgent) { finish('error', { error: 'not available' }); return 'ERROR: sub-agents are disabled for this run' }
        try {
          // 不给 max_steps 就跟着默认走（=不限）；以前这里默认 6 步，
          // 子 agent 刚好在「读了一半」时被砍，回来只有一句 (no text)
          const text = await deps.spawnSubAgent(subTask, {
            ...(args.max_steps ? { maxSteps: Number(args.max_steps) } : {}),
          })
          finish('ok', { task: subTask.slice(0, 80) })
          return text
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          finish('error', { error: msg.slice(0, 200) })
          return `ERROR: sub-agent failed: ${msg}`
        }
      }

      if (name === 'read_file') {
        const rel = String(args.path ?? '')
        if (!rel) { finish('error', { error: 'missing path' }); return 'ERROR: read_file needs a `path`' }
        const out = deps.readSlice(rel, Number(args.offset ?? 1), Number(args.limit ?? 2000))
        if (out === null) { finish('error', { error: `no such file: ${rel}` }); return `ERROR: no such file in workspace: ${rel}` }
        finish('ok', { path: rel, lines: out.shownTo - out.shownFrom + 1, total: out.totalLines })
        return out.text
      }

      if (name === 'list_dir') {
        const rel = String(args.path ?? '.')
        const out = deps.listTree(rel, Math.min(Number(args.depth ?? 1), 3))
        if (out === null) { finish('error', { error: `no such directory: ${rel}` }); return `ERROR: no such directory: ${rel}` }
        finish('ok', { path: rel })
        return out
      }

      if (name === 'grep') {
        const pattern = String(args.pattern ?? '')
        if (!pattern) { finish('error', { error: 'missing pattern' }); return 'ERROR: grep needs a `pattern`' }
        const out = deps.grep(String(args.path ?? '.'), pattern, {
          glob: args.glob ? String(args.glob) : undefined,
          max: Math.min(Number(args.max ?? 60), 200),
        })
        if (out === null) { finish('error', { error: `bad path: ${String(args.path ?? '.')}` }); return `ERROR: bad path: ${String(args.path ?? '.')}` }
        finish('ok', { pattern, matches: out.count })
        return out.text
      }


      if (name === 'get_context_remaining') {
        // 用「上一次真实请求的 prompt_tokens」，不是自己估算——估算是另一套数字，
        // 而模型要的是"还差多少会触发压缩"的确切答案。
        const used = lastPromptTokens
        const compactAt = Math.floor(budget * 0.7)
        const left = Math.max(0, compactAt - used)
        finish('ok', { used, budget, compact_at: compactAt, left })
        return [
          `context budget: ${budget} tokens`,
          `last request used: ${used} tokens`,
          `compaction triggers at: ${compactAt} tokens (70%)`,
          `remaining before compaction: ${left} tokens`,
          'Keep going unless you are close to done; the harness compacts automatically.',
        ].join('\n')
      }

      if (name === 'view_image') {
        const rel = String(args.path ?? '')
        if (!rel) { finish('error', { error: 'missing path' }); return 'ERROR: view_image needs a `path`' }
        if (!deps.readImage) { finish('error', { error: 'not available' }); return 'ERROR: viewing images is not available in this run' }
        const img = deps.readImage(rel)
        if (!img) {
          finish('error', { error: `cannot read image: ${rel}` })
          return `ERROR: cannot read "${rel}" as an image. Supported: png, jpg, webp, gif. ` +
            'If it is a PDF or a slide file, convert or render it first.'
        }
        finish('ok', { path: rel, mediaType: img.mediaType, bytes: Math.floor(img.data.length * 0.75) })
        return {
          text: `image attached: ${rel} (${img.mediaType}) — describe what you see in it.`,
          image: { path: rel, mediaType: img.mediaType, data: img.data },
        }
      }

      if (name === 'search_images') {
        const q = String(args.query ?? '').trim()
        if (!q) { finish('error', { error: 'missing query' }); return 'ERROR: search_images needs a `query`' }
        const want = Math.max(1, Math.min(Number(args.count ?? 3), 8))
        const dir = String(args.dir ?? 'images').replace(/^\.?\/+/, '').replace(/\/+$/, '')
        if (!dir) { finish('error', { error: 'bad dir' }); return 'ERROR: search_images needs a folder name' }
        try {
          const found = await searchImages(q, want, deps, dir)
          finish('ok', { query: q, saved: found.saved.length })
          return found.text
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          finish('error', { error: msg.slice(0, 200) })
          return `ERROR: image search failed: ${msg}`
        }
      }

      if (name === 'apply_patch') {
        const patchText = String(args.patch ?? '')
        if (!patchText) { finish('error', { error: 'missing patch' }); return 'ERROR: apply_patch needs a `patch` string' }
        const { hunks, warnings } = parsePatch(patchText)
        const { writes, results } = planPatch(hunks, deps.readFile)

        // 干跑全过才落盘（原子性）
        for (const w of writes) {
          if (w.content === null) deps.deleteFile(w.path)
          else deps.writeFile(w.path, w.content)
        }
        const summary = results
          .map((r) => `  ${r.action} ${r.file} (+${r.addedLines}/-${r.removedLines})`)
          .join('\n')
        deps.log(`patch applied:\n${summary}`)
        finish('ok', { files: results.map((r) => r.file) })
        return `patch applied\n${summary}${warnings.length ? `\nwarnings:\n${warnings.map((w) => `  ${w}`).join('\n')}` : ''}`
      }

      if (name === 'use_skill') {
        const wanted = String(args.name ?? '')
        const skill = skills.find((s) => s.name === wanted)
        if (!skill) {
          finish('error', { error: `unknown skill ${wanted}` })
          return `ERROR: unknown skill "${wanted}". Available: ${skills.map((s) => s.name).join(', ')}`
        }
        finish('ok', {
          skill: wanted,
          root: skill.root,
          chars: skill.body.length,
          scripts: skill.scripts.length,
          allowed_tools: skill.allowedTools,
        })
        deps.log(`skill loaded: ${wanted} (${skill.body.length} chars, ${skill.scripts.length} scripts)`)
        const extras: string[] = []
        if (skill.allowedTools.length) {
          extras.push(`Declared tools: ${skill.allowedTools.join(', ')}`)
        }
        if (skill.scripts.length) {
          // 只列相对路径：绝对路径把用户的 home 目录结构泄进上下文，换台机器也不一样
          extras.push(
            'Scripts bundled with this skill:\n'
            + skill.scripts.map((sc) => `- ${sc.rel}`).join('\n')
            + '\nRun one with run_skill_script. They execute inside the sandbox like any other command.',
          )
        }
        return `# Skill: ${skill.name}\n\n${skill.body}`
          + (extras.length ? `\n\n---\n\n${extras.join('\n\n')}` : '')
      }

      if (name === 'run_skill_script') {
        const skillName = String(args.skill ?? '')
        const rel = String(args.script ?? '')
        const skill = skills.find((sk) => sk.name === skillName)
        if (!skill) { finish('error', { error: `unknown skill ${skillName}` }); return `ERROR: unknown skill "${skillName}"` }
        // 只认 use_skill 列出来的那几个，不接受拼出来的路径
        const target = skill.scripts.find((sc) => sc.rel === rel)
        if (!target) {
          finish('error', { error: 'script not found', scripts: skill.scripts.map((sc) => sc.rel) })
          return `ERROR: "${rel}" is not a script of skill "${skillName}". Available: ${skill.scripts.map((sc) => sc.rel).join(', ') || '(none)'}`
        }
        const extra = Array.isArray(args.args) ? args.args.map((a) => String(a)) : []
        finish('ok', { skill: skillName, script: rel })
        return (await deps.runCommand({ argv: [target.path, ...extra] })).content
      }

      if (name === 'update_plan') {
        const raw = args.steps
        if (!Array.isArray(raw)) { finish('error', { error: 'steps must be an array' }); return 'ERROR: update_plan expects steps: [{step,status}]' }
        plan = raw.map((s) => {
          const o = s as { step?: unknown; status?: unknown }
          const status = o.status === 'completed' || o.status === 'in_progress' ? o.status : 'pending'
          return { step: String(o.step ?? ''), status } as PlanStep
        })
        deps.ev('plan/updated', { steps: plan })
        finish('ok', { steps: plan.length })
        return plan.map((p) => `[${p.status === 'completed' ? 'x' : p.status === 'in_progress' ? '>' : ' '}] ${p.step}`).join('\n')
      }

      return (await deps.callTool(name, args)).content
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      finish('error', { error: msg.slice(0, 300) })
      return `ERROR: ${msg}`
    }
  }

  while (maxSteps <= 0 || steps < maxSteps) {
    // 中断只在 step 边界生效：正在跑的工具调用会自己收到 abort 并收尾，
    // 半路硬切会让事件日志停在「调用了但没结果」的状态。
    if (opts.signal?.aborted) { stoppedBy = 'interrupted'; break }
    if (Date.now() > deadline) { stoppedBy = 'timeout'; break }
    // 用户插话：在 step 边界接上。取走而不是 peek，避免同一句被插两遍
    const steers = deps.drainSteer?.() ?? []
    for (const s of steers) {
      messages.push({
        role: 'user',
        content: `[the user interrupted while you were working] ${s.text}`,
      })
      deps.ev('steering/message', { id: s.id, text: s.text.slice(0, 200), status: 'applied' })
    }
    if (steers.length > 0) lastText = ''

    steps++
    deps.ev('step/start', { step_index: steps, turn_index: turnIndex, ...(steers.length ? { steered: steers.length } : {}) })

    let res: CompletionResult
    try {
      res = await deps.gateway.complete({
        messages,
        tools,
        role: 'plan',
        ...(deps.onText ? { onText: deps.onText } : {}),
        ...(deps.onReasoning ? { onReasoning: deps.onReasoning } : {}),
        // 用户点 Stop 时这一层要立刻断，不能等到 step 边界——
        // 一次请求就是几十秒，那时候"停止"看起来根本没生效
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      // 用户按了 Stop：这不是错误，是被打断。当成 error 抛出去，屏幕上就会出现
      // 一行红字 "ERROR: E_LLM ABORTED: stopped by the user"——用户自己按的键，
      // 却看起来像程序坏了。收成 interrupted，由下面正常的收尾路径处理。
      if (opts.signal?.aborted) {
        deps.ev('step/end', { step_index: steps, status: 'interrupted' })
        stoppedBy = 'interrupted'
        break
      }
      const msg = err instanceof Error ? err.message : String(err)
      deps.ev('step/end', { step_index: steps, status: 'error', error: msg })
      // 必须补 turn/end 再抛。turn/start 已经写进日志了，只 throw 的话这一轮
      // 在回放里永远是"开始了、没结束"——和 tool/call 没有 tool/result 一样，
      // 审计链断在半空，事后分不清是失败了还是进程被杀了。
      deps.ev('turn/end', { turn_index: turnIndex, steps, stop_reason: 'error', error: msg.slice(0, 500), usage })
      throw err
    }

    lastPromptTokens = res.usage.prompt_tokens
    usage.prompt += res.usage.prompt_tokens
    usage.completion += res.usage.completion_tokens
    usage.total += res.usage.total_tokens
    if (res.content) lastText = res.content

    // ---- 成本预算：钱包到线就停，与上下文压缩是两件事 ----
    // 压缩是把历史变短，超了还继续；预算超了必须停。
    if (costBudget) {
      const verdict = checkBudget(
        {
          used: usage.total,
          limit: costBudget.perRun ?? 0,
          dayUsed: (costBudget.dayUsed ?? 0) + usage.total,
          dayLimit: costBudget.perDay ?? 0,
        },
        { warned: budgetWarned },
      )
      if (verdict.action === 'warn') {
        budgetWarned = true
        deps.ev('budget/warning', {
          used: usage.total,
          limit: costBudget.perRun ?? 0,
          day_used: (costBudget.dayUsed ?? 0) + usage.total,
          day_limit: costBudget.perDay ?? 0,
          pct: verdict.pct,
          message: verdict.message,
        })
      } else if (verdict.action === 'stop') {
        deps.ev('budget/exceeded', {
          used: usage.total,
          limit: costBudget.perRun ?? 0,
          day_used: (costBudget.dayUsed ?? 0) + usage.total,
          day_limit: costBudget.perDay ?? 0,
          message: verdict.message,
        })
        // 收尾：这一轮不算完成，让上层知道是被预算停下的
        deps.ev('turn/end', { turn_index: turnIndex, steps, stop_reason: 'budget', usage })
        return { text: lastText, steps, usage, stoppedBy: 'budget', plan, compactions, messages }
      }
    }


    if (res.toolCalls.length === 0) {
      // ---- pre_finish hooks：把「做完了」这句话打回去重做 ----
      // 提示词说「验证后再声称完成」，模型可以不理；hook 的退出码不行
      if (deps.runHooks) {
        const failed = await deps.runHooks('pre_finish', {})
        if (failed.length > 0) {
          deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'hook-rejected' })
          messages.push({ role: 'assistant', content: res.content })
          messages.push({
            role: 'user',
            content:
              `Your finish was rejected by a hook:\n\n` +
              failed.map((f) => `[${f.name}]\n${f.output.slice(0, 1500)}`).join('\n\n') +
              `\n\nFix the problem, then report again. Do not just restate the summary.`,
          })
          continue
        }
      }

      // 最终回答也要进历史：否则 --continue 拿到的是「用户说了什么、模型没回过话」，
      // 续跑时模型等于失忆；压缩估算也会少算这一段
      messages.push({ role: 'assistant', content: res.content })
      deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'assistant' })
      break
    }

    // 只有"还要继续干"的时候才值得压缩：最后一步之后再压缩纯属浪费一次调用
    if (budget > 0 && shouldCompact(res.usage.prompt_tokens, budget)) {
      const before = messages.length
      // keepRecent 6 太短：一条会话里 15–25 条消息才是「刚刚在做的事」，
      // 只留 6 条意味着每压一次就丢掉刚读到的文件内容，模型立刻回去重读——
      // 压缩省下的 token 又原样花回去，而且 step 数还在涨。
      // 24 条 + 0.7 阈值：压得少一点、但每次活得长一点。
      const c = await compactMessages(deps.gateway, messages, { keepRecent: 24 })
      if (c.dropped > 0) {
        messages.length = 0
        messages.push(...c.messages)
        compactions++
        deps.ev('session/compacted', {
          dropped_messages: c.dropped,
          kept_messages: before - c.dropped,
          before_chars: c.beforeChars,
          summary_chars: c.afterChars,
          prompt_tokens_before: res.usage.prompt_tokens,
          budget,
          strategy: 'local-summary',
        })
      }
    }

    messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls })

    // 互不依赖的并行跑；apply_patch 改文件，必须按顺序
    const outcomes = new Array<ToolOutcome>(res.toolCalls.length).fill('')
    const patches = res.toolCalls.map((c, i) => ({ c, i })).filter((x) => x.c.function.name === 'apply_patch')
    const others = res.toolCalls.map((c, i) => ({ c, i })).filter((x) => x.c.function.name !== 'apply_patch')

    // 跑完补一条 tool/output：页面点开结果那行就能看到工具真正返回了什么。
    // 只进事件日志、不进模型消息流（messages 里已经有一条 tool 消息了），
    // 所以多这一条不会让模型多读一遍。
    const runOne = async (c: ToolCall): Promise<ToolOutcome> => {
      const out = await execOne(c)
      // 事件里的工具名不一定等于模型看到的工具名：run_command 在审计里叫
      // `exec`（它跑的是沙箱 exec）。两条都用同一个 key，界面才能把返回
      // 挂到对应的那一行上；挂不上就只剩一个「参数」，看不到结果。
      const key = c.function.name === 'run_command' ? 'exec' : c.function.name
      // 只有文字进日志。图片的 base64 落盘就是一条会话几十 MB，
      // 而且页面上也读不出来——留个路径就够了。
      const text = typeof out === 'string' ? out : out.text
      deps.ev('tool/output', {
        tool: key,
        name: c.function.name,
        output: String(text ?? '').slice(0, 8000),
        truncated: String(text ?? '').length > 8000,
      })
      return out
    }

    if (others.length > 1) {
      await Promise.all(others.map(async ({ c, i }) => { outcomes[i] = await runOne(c) }))
    } else {
      for (const { c, i } of others) outcomes[i] = await runOne(c)
    }
    for (const { c, i } of patches) outcomes[i] = await runOne(c)

    for (let i = 0; i < res.toolCalls.length; i++) {
      const o: ToolOutcome = outcomes[i] ?? ''
      const text = typeof o === 'string' ? o : o.text
      messages.push({ role: 'tool', tool_call_id: (res.toolCalls[i] as ToolCall).id, content: clip(text) })
      // tool 消息在 OpenAI 协议里只能是字符串，塞不进图片。所以看图的结果
      // 另起一条 user 消息带图——模型看到的顺序是「工具说图在这里」→「图」。
      const img = typeof o === 'string' ? undefined : o.image
      if (img) {
        messages.push({
          role: 'user',
          content: `[view_image] ${img.path}`,
          images: [{ path: img.path, mediaType: img.mediaType, data: img.data }],
        })
      }
    }

    deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'tools', tool_count: res.toolCalls.length })

    // ---- 卡死检测：同一个动作连续失败 5 次就停 ----
    // 步数上限取消后必须补上这件事：模型如果卡在「同一条命令再试一次」上，
    // 每步都很小、预算也不涨，不设边界就是转到天荒地老（子 agent 尤其明显：
    // 深度被拒之后它会拿同一条 spawn_agent 一直试）。
    // 这仍然不是「猜任务有多长」——判据是「什么都没变、还是同样的失败」。
    for (let i = 0; i < res.toolCalls.length; i++) {
      const c = res.toolCalls[i] as ToolCall
      const out = outcomes[i] as string
      // 「失败」有两种长相：工具自己报的 ERROR/BLOCKED，和命令跑完但退出码非 0
      // （run_command 的返回是 `exit=1 isolation=...`，不是 ERROR——只认 ERROR 会
      // 漏掉最常见的那种空转：同一条 build/test 一遍一遍地失败）
      const exit = /^exit=(-?\d+)\b/.exec(out)
      const failed = /^(ERROR|BLOCKED)\b/.test(out) || (exit !== null && Number(exit[1]) !== 0)
      if (!failed) { stuckSig = ''; stuckN = 0; continue }
      // 签名只取「工具名 + 命令主体」，不取整串参数。
      //
      // 原来的签名是整串参数，于是「一条命令换个 URL 接着试」永远不会被认成重复：
      // 实测一条会话里连着 200 次 `python3 .../attribution_guard.py`（每次都成功），
      // 以及几十次 curl 换域名找同一份资料——每一步签名都不同，次数统计一直是 1。
      // 真正重复的是**同一个动作**，参数里的 URL/文件名只是它在换目标碰运气。
      const sig = c.function.name + ':' + actionKey(c.function.arguments)
      if (sig === stuckSig) stuckN++
      else { stuckSig = sig; stuckN = 1 }
    }
    if (stuckN >= STUCK_REPEATS) {
      deps.ev('step/end', { step_index: steps, status: 'error', kind: 'stuck', repeats: stuckN, action: stuckSig.slice(0, 200) })
      stoppedBy = 'stuck'
      break
    }

    // 只有用户明确给了上限才可能因为步数停下；0 表示没上限
    if (maxSteps > 0 && steps >= maxSteps) stoppedBy = 'max-steps'
  }

  // ---- 收尾：跑完却一句人话都没有 ----
  // 工具刷了十几步、模型没来得及总结就被上限/超时打断时，lastText 是空字符串。
  // 上层（尤其是子 agent）拿到的就是空结果，用户看到「— done —」后面什么都没有。
  // 只要不是用户按了 Stop，就再要一次「只用已有信息汇报」，这一次不给工具。
  // 错误路径本来就 throw 出去了，这里只剩 max-steps / timeout 需要补一句人话
  if (!lastText.trim() && stoppedBy !== 'interrupted') {
    deps.ev('step/start', { step_index: steps + 1, turn_index: turnIndex, reason: 'final-report' })
    try {
      messages.push({
        role: 'user',
        content:
          (stoppedBy === 'stuck'
            ? 'The same action kept failing the same way, so you cannot keep trying it. Stop calling tools and answer now: ' +
              'what you tried, what the error actually said, and what you would do differently.'
            : `You are out of room to keep working (${stoppedBy}). Stop calling tools and answer now, ` +
              'using only what you already have: what you found, what you changed, and what is still unclear. ' +
              'If you found nothing, say so plainly and name the one thing you would try next.'),
      })
      const fin = await deps.gateway.complete({
        messages,
        tools: [],
        role: 'plan',
        ...(deps.onText ? { onText: deps.onText } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
      steps++
      usage.prompt += fin.usage.prompt_tokens
      usage.completion += fin.usage.completion_tokens
      usage.total += fin.usage.total_tokens
      if (fin.content.trim()) {
        lastText = fin.content
        messages.push({ role: 'assistant', content: fin.content })
      }
      deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'final-report' })
    } catch (err) {
      deps.ev('step/end', { step_index: steps + 1, status: 'error', error: String(err).slice(0, 200) })
    }
  }

  // 模型最后说了什么，必须落盘。
  // 之前只有实时广播带着这段文本，日志里没有——重放会话时回答区是空的，
  // 追问"它当时怎么解释的"根本查不到。可审计的前提是话也得记下来。
  if (lastText) deps.ev('assistant/message', { role: 'assistant', text: lastText, chars: lastText.length })
  deps.ev('turn/end', { turn_index: turnIndex, stop_reason: stoppedBy, steps })
  return { text: lastText, steps, usage, stoppedBy, plan, compactions, messages }
}