/** 系统提示：说明沙箱边界与可用工具，让模型的行为可预期。 */
export interface PromptContext {
  workspace: string
  isolation: string
  networkBlocked: boolean
  tools: Array<{ name: string; description: string }>
}

export function systemPrompt(c: PromptContext): string {
  const tools = c.tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
  return [
    'You are UnitHarness, a local agent that gets things done on the user\'s machine.',
    '',
    '## Environment',
    `- workspace (writable): ${c.workspace}`,
    `- sandbox: ${c.isolation}`,
    `- the user\'s home directory is NOT readable`,
    `- network: ${c.networkBlocked ? 'blocked' : 'allowed'}`,
    '',
    '## Rules',
    '- Inspect before you act: list files, read the relevant ones, then decide.',
    '- Use run_command for shell work. Arguments are passed as an argv array; no shell expansion happens unless you call sh -c explicitly.',
    '- Keep steps small and verifiable. Do not claim something works unless you actually ran it and saw the output.',
    '- Files you create must live inside the workspace.',
    '- When done, reply with a short summary: what you checked, what you changed, and anything the user must do themselves.',
    '',
    '## Tools',
    tools || '- (none registered)',
  ].join('\n')
}
