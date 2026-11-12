/**
 * Agent 循环：turn → step → (llm → tool*) → step → … → turn end。
 *
 * 设计约束（D8/D9）：
 *  - 不预设流程：没有固定步骤表，由模型决定下一步；护甲在工具执行层（沙箱）。
 *  - 每一步都落事件；工具调用本身由 exec/callTool 自动留痕，循环只写 turn/step。
 */
import type { CompletionResult, Message, ToolSpec } from '../llm/types.ts'
import type { LlmGateway } from '../llm/gateway.ts'
import type { ToolDefinition } from '../types.ts'

export interface RunCommandArgs {
  argv: string[]
  timeoutMs?: number
}

export interface AgentDeps {
  workspace: string
  gateway: LlmGateway
  tools: ReadonlyArray<ToolDefinition>
  /** 内置 run_command：走 exec，因而自动受沙箱约束 */
  runCommand: (args: RunCommandArgs) => Promise<{ content: string }>
  /** 调用插件注册的工具（自带事件记录） */
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: string }>
  ev: (kind: 'turn/start' | 'turn/end' | 'step/start' | 'step/end', payload: Record<string, unknown>) => void
  log: (msg: string) => void
}

export interface RunResult {
  text: string
  steps: number
  usage: { prompt: number; completion: number; total: number }
  stoppedBy: 'model' | 'max-steps' | 'timeout'
}

const RUN_COMMAND_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Run a program inside the sandbox. Pass argv as an array, e.g. ["ls","-la","."]. ' +
      'For shell features use ["sh","-c","..."] explicitly.',
    parameters: {
      type: 'object',
      properties: {
        argv: { type: 'array', items: { type: 'string' }, description: 'command and arguments' },
        timeoutMs: { type: 'number', description: 'timeout in milliseconds (default 60000)' },
      },
      required: ['argv'],
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

export async function runAgent(
  deps: AgentDeps,
  opts: { task: string; maxSteps?: number; maxSeconds?: number },
): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? 8
  const deadline = Date.now() + (opts.maxSeconds ?? 300) * 1000

  deps.ev('turn/start', { turn_index: 1, trigger: 'user' })

  const messages: Message[] = [{ role: 'user', content: opts.task }]
  const tools = [RUN_COMMAND_TOOL, ...toToolSpecs(deps.tools)]

  let steps = 0
  let stoppedBy: RunResult['stoppedBy'] = 'model'
  const usage = { prompt: 0, completion: 0, total: 0 }
  let lastText = ''

  while (steps < maxSteps) {
    if (Date.now() > deadline) { stoppedBy = 'timeout'; break }
    steps++
    deps.ev('step/start', { step_index: steps, turn_index: 1 })

    let res: CompletionResult
    try {
      res = await deps.gateway.complete({ messages, tools, role: 'plan' })
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

    // assistant 消息必须带着 tool_calls 进入历史，否则后续 tool 消息无主
    messages.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls })

    for (const call of res.toolCalls) {
      let out: string
      try {
        if (call.function.name === 'run_command') {
          const args = JSON.parse(call.function.arguments || '{}') as RunCommandArgs
          out = (await deps.runCommand(args)).content
        } else {
          const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>
          out = (await deps.callTool(call.function.name, args)).content
        }
      } catch (err) {
        out = `ERROR: ${err instanceof Error ? err.message : String(err)}`
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: out.slice(0, 8000) })
    }

    deps.ev('step/end', { step_index: steps, status: 'ok', kind: 'tools', tool_count: res.toolCalls.length })
    if (steps >= maxSteps) stoppedBy = 'max-steps'
  }

  deps.ev('turn/end', { turn_index: 1, stop_reason: stoppedBy, steps })
  return { text: lastText, steps, usage, stoppedBy }
}
