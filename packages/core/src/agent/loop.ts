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
import type { Skill } from '../skill/registry.ts'

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
  stoppedBy: 'model' | 'max-steps' | 'timeout'
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

export async function runAgent(
  deps: AgentDeps,
  opts: { task: string; maxSteps?: number; maxSeconds?: number },
): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 12
  const deadline = Date.now() + (opts.maxSeconds ?? 600) * 1000
  const planEnabled = deps.planEnabled !== false

  deps.ev('turn/start', { turn_index: 1, trigger: 'user' })

  const messages: Message[] = []
  if (deps.system) messages.push({ role: 'system', content: deps.system })
  messages.push({ role: 'user', content: opts.task })

  const skills = deps.skills ?? []
  const tools: ToolSpec[] = [
    RUN_COMMAND,
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
    const needsOwnEvent = name === 'apply_patch' || name === 'update_plan' || name === 'use_skill'
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
      return `ERROR: arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`
    }

    try {
      if (name === 'run_command') {
        const a = args as unknown as RunCommandArgs
        if (!Array.isArray(a.argv) || a.argv.length === 0 || a.argv.some((x) => typeof x !== 'string')) {
          return 'ERROR: run_command expects argv: string[] with at least one element'
        }
        return (await deps.runCommand(a)).content
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
        if (!Array.isArray(raw)) return 'ERROR: update_plan expects steps: [{step,status}]'
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
  return { text: lastText, steps, usage, stoppedBy, plan, compactions }
}
