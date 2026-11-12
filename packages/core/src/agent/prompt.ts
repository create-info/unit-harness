/**
 * 提示词组装。
 *
 * 借鉴 Codex 第 9 讲的结构：系统提示词不是一句写死的话，而是几段"世界状态"的拼装：
 *   base        —— 身份、能力、行为要求（静态，教模型怎么和 harness 协作）
 *   environment —— 工作区、沙箱强度、网络、平台（变了就要重说）
 *   project     —— AGENTS.md（就近优先，和 Codex 一致）
 *   tools       —— 何时用哪个工具、何时别用
 *
 * 每段带标记（<environment_context> 之类），这样回放时能一眼看出"模型当时看到了什么"。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PromptContext {
  workspace: string
  isolation: string
  networkBlocked: boolean
  tools: Array<{ name: string; description: string }>
  /** 计划工具是否启用（关闭时 base 里不提它，学 Codex 的"手术式切除"） */
  planEnabled?: boolean
  /** 额外注入的项目指令（覆盖 AGENTS.md 发现结果） */
  projectInstructions?: string
}

/** 从 workspace 向上找 AGENTS.md，越近的越优先（同名文件后出现的覆盖前面的） */
export function findProjectInstructions(workspace: string): { files: string[]; text: string } {
  const files: string[] = []
  const chunks: string[] = []
  const seen = new Set<string>()

  let dir = path.resolve(workspace)
  const stop = path.parse(dir).root
  for (;;) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const p = path.join(dir, name)
      if (!seen.has(p) && fs.existsSync(p)) {
        seen.add(p)
        files.push(p)
        try {
          chunks.push(`<!-- ${name} @ ${p} -->\n${fs.readFileSync(p, 'utf8').trim()}`)
        } catch {
          /* unreadable: skip */
        }
      }
    }
    if (dir === stop) break
    dir = path.dirname(dir)
  }

  // 从最外层到最内层排序，让近的指令出现在后面（覆盖前面的）
  return { files: files.reverse(), text: chunks.reverse().join('\n\n') }
}

function baseSection(ctx: PromptContext): string {
  const lines = [
    'You are UnitHarness, an agent that works on a real machine inside a real sandbox.',
    '',
    '## Who you are',
    '- You do the work yourself. You do not describe what the user should do unless you cannot.',
    '- You verify before you claim. "Done" means you ran it and saw the result.',
    '- You are not a chatbot: a short answer is fine, a guess is not.',
    '',
    '## How to act',
    '- Inspect before you change: list, read, then edit.',
    '- Use `apply_patch` to create or modify files. Do not build files with `echo >` or heredocs —',
    '  patches are atomic, reviewable, and fail loudly instead of half-writing.',
    '- Use `run_command` for programs, tests and inspection. argv is an array; for shell syntax',
    '  call `sh -c "..."` explicitly.',
    '- Keep steps small enough that a failure tells you which step failed.',
  ]
  if (ctx.planEnabled) {
    lines.push(
      '- For anything with more than ~3 steps, call `update_plan` first and keep exactly one step',
      '  in progress. Update it as you go instead of narrating a plan in prose.',
    )
  }
  lines.push(
    '',
    '## Reporting',
    '- Lead with the outcome. Then what you changed. Then anything the user must do themselves.',
    '- If something failed, say what failed and what you tried — do not paper over it.',
    '- Never claim a file was written, a command passed, or a test succeeded unless the tool said so.',
  )
  return lines.join('\n')
}

function environmentSection(ctx: PromptContext): string {
  const sandbox = ctx.networkBlocked
    ? `${ctx.isolation}; network blocked`
    : `${ctx.isolation}`
  return [
    '<environment_context>',
    `  <workspace>${ctx.workspace}</workspace>`,
    `  <platform>${process.platform}/${process.arch} ${os.release()}</platform>`,
    `  <sandbox>${sandbox}</sandbox>`,
    `  <home_readable>false</home_readable>`,
    `  <date>${new Date().toISOString().slice(0, 10)}</date>`,
    '</environment_context>',
    '',
    'Everything you write must land inside <workspace>. The user\'s home directory is not readable,',
    'so do not try to inspect dotfiles, keys or ~/.config — it will fail and waste a step.',
  ].join('\n')
}

function toolsSection(ctx: PromptContext): string {
  const lines = ['<tool_guidance>']
  for (const t of ctx.tools) {
    lines.push(`  - ${t.name}: ${t.description}`)
  }
  lines.push('</tool_guidance>')
  return lines.join('\n')
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts = [baseSection(ctx), environmentSection(ctx)]
  if (ctx.tools.length > 0) parts.push(toolsSection(ctx))

  const project = ctx.projectInstructions ?? findProjectInstructions(ctx.workspace).text
  if (project) {
    parts.push(`<project_instructions>\n${project}\n</project_instructions>`)
  }
  return parts.join('\n\n')
}

/** 兼容旧调用点 */
export const systemPrompt = buildSystemPrompt
