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
  /** 起一个子 agent 干活，返回它的最终文本（不给就是禁用了子 agent） */
  spawnSubAgent?: (task: string, opts: { maxSteps?: number }) => Promise<string>
  /** 跑某个挂点的 hook；返回被挡下的那些 */
  runHooks?: (event: HookEvent, ctx: { tool?: string; command?: string }) => Promise<HookOutcome[]>
  writeFile: (rel: string, content: string) => void
  deleteFile: (rel: string) => void
  ev: (
    kind: 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'plan/updated' | 'tool/call' | 'tool/result' | 'session/compacted',
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
}

export interface RunResult {
  text: string
  steps: number
  usage: { prompt: number; completion: number; total: number }
  stoppedBy: 'model' | 'max-steps' | 'timeout' | 'interrupted'
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
        max_steps: { type: 'integer', description: 'Budget for the sub-agent. Default 6.' },
      },
      required: ['task'],
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
    maxSteps?: number
    maxSeconds?: number
    signal?: AbortSignal
    /** 续跑：上次会话的消息（system 会被新提示替换） */
    initialMessages?: Message[]
    /** 附在第一轮用户消息上的图片 */
    images?: ImageInput[]
  },
): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 12
  const deadline = Date.now() + (opts.maxSeconds ?? 600) * 1000
  const planEnabled = deps.planEnabled !== false

  deps.ev('turn/start', { turn_index: 1, trigger: 'user' })

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
  const tools: ToolSpec[] = [
    RUN_COMMAND,
    READ_FILE,
    LIST_DIR,
    GREP,
    SPAWN_AGENT,
    APPLY_PATCH,
    ...(planEnabled ? [UPDATE_PLAN] : []),
    ...(skills.length > 0 ? [USE_SKILL] : []),
    ...toToolSpecs(deps.tools),
  ]

  let steps = 0
  let stoppedBy: RunResult['stoppedBy'] = 'model'
  const usage = { prompt: 0, completion: 0, total: 0 }
  let lastText = ''
  let plan: PlanStep[] = []
  let compactions = 0
  const budget = deps.maxContextTokens ?? 0

  const execOne = async (call: ToolCall): Promise<string> => {
    const name = call.function.name
    // apply_patch / update_plan 在进程内执行，不经过 exec，因此这里自己补审计
    const needsOwnEvent =
      name === 'apply_patch' || name === 'update_plan' || name === 'use_skill' ||
      name === 'read_file' || name === 'list_dir' || name === 'grep' || name === 'spawn_agent'
    let callEvId: string | null = null
    if (needsOwnEvent) {
      callEvId = deps.ev('tool/call', { tool: name, args_preview: String(call.function.arguments).slice(0, 200) })
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
          const text = await deps.spawnSubAgent(subTask, { maxSteps: Number(args.max_steps ?? 6) })
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
        finish('ok', { skill: wanted, root: skill.root, chars: skill.body.length })
        deps.log(`skill loaded: ${wanted} (${skill.body.length} chars)`)
        return `# Skill: ${skill.name}\n\n${skill.body}`
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

  while (steps < maxSteps) {
    // 中断只在 step 边界生效：正在跑的工具调用会自己收到 abort 并收尾，
    // 半路硬切会让事件日志停在「调用了但没结果」的状态。
    if (opts.signal?.aborted) { stoppedBy = 'interrupted'; break }
    if (Date.now() > deadline) { stoppedBy = 'timeout'; break }
    steps++
    deps.ev('step/start', { step_index: steps, turn_index: 1 })

    let res: CompletionResult
    try {
      res = await deps.gateway.complete({
        messages,
        tools,
        role: 'plan',
        ...(deps.onText ? { onText: deps.onText } : {}),
        ...(deps.onReasoning ? { onReasoning: deps.onReasoning } : {}),
      })
    } catch (err) {
      deps.ev('step/end', { step_index: steps, status: 'error', error: err instanceof Error ? err.message : String(err) })
      throw err
    }

    usage.prompt += res.usage.prompt_tokens
    usage.completion += res.usage.completion_tokens
    usage.total += res.usage.total_tokens
    if (res.content) lastText = res.content


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
      const c = await compactMessages(deps.gateway, messages, { keepRecent: 6 })
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
    const outcomes = new Array<string>(res.toolCalls.length).fill('')
    const patches = res.toolCalls.map((c, i) => ({ c, i })).filter((x) => x.c.function.name === 'apply_patch')
    const others = res.toolCalls.map((c, i) => ({ c, i })).filter((x) => x.c.function.name !== 'apply_patch')

    if (others.length > 1) {
      await Promise.all(others.map(async ({ c, i }) => { outcomes[i] = await execOne(c) }))
    } else {
      for (const { c, i } of others) outcomes[i] = await execOne(c)
    }
    for (const { c, i } of patches) outcomes[i] = await execOne(c)

    for (let i = 0; i < res.toolCalls.length; i++) {
      messages.push({ role: 'tool', tool_call_id: (res.toolCalls[i] as ToolCall).id, content: clip(outcomes[i] as string) })
    }

    deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'tools', tool_count: res.toolCalls.length })
    if (steps >= maxSteps) stoppedBy = 'max-steps'
  }

  deps.ev('turn/end', { turn_index: 1, stop_reason: stoppedBy, steps })
  return { text: lastText, steps, usage, stoppedBy, plan, compactions, messages }
}
