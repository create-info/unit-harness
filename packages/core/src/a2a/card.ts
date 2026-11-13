/**
 * AgentCard：别的 agent 靠这张卡判断"你能不能干、怎么连、要什么鉴权"。
 *
 * 卡上写的能力必须是真能做的。skills 里列的每一项，都有对应的执行路径——
 * 填一堆漂亮但点不通的 skill，只会让对方 agent 调一次、失败一次、然后不再来。
 */
import type { AgentCard, AgentInterface, AgentSkill } from './types.ts'

export interface CardOptions {
  /** 对外可访问的 A2A 端点 URL（必须绝对地址，生产环境要 https） */
  url: string
  version: string
  /** 是否已开启鉴权。开了才在卡上声明 securitySchemes */
  authToken?: string
  streaming?: boolean
}

const JSON_MODE = 'application/json'
const TEXT_MODE = 'text/plain'

/** 我们真能做的事。每个 skill 都是当前代码里存在的执行路径。 */
function skills(): AgentSkill[] {
  return [
    {
      id: 'run-task',
      name: 'Run a task and prove it',
      description:
        'Execute a coding/ops task in a sandbox, then verify the result: run the tests, '
        + 'assert on the artifacts, and report what actually passed. Refuses to claim success '
        + 'it cannot show.',
      tags: ['code', 'shell', 'verification', 'sandbox'],
      examples: [
        'Add a --json flag to the CLI and make sure the tests still pass',
        'Find why the build fails on Linux and fix it',
      ],
      inputModes: [TEXT_MODE, JSON_MODE],
      outputModes: [TEXT_MODE, JSON_MODE],
    },
    {
      id: 'verify',
      name: 'Verify existing changes',
      description:
        'Look at what changed in a workspace and run the assertions that apply: build, tests, '
        + 'probes. Reports per-check results instead of a judgment call.',
      tags: ['verification', 'tests', 'ci'],
      inputModes: [TEXT_MODE],
      outputModes: [JSON_MODE, TEXT_MODE],
    },
    {
      id: 'exec',
      name: 'Run a command in the sandbox',
      description:
        'Run one command under the sandbox (bubblewrap → landlock → path-guard, and the event log '
        + 'records which one actually applied). Destructive commands and anything writing outside '
        + 'the workspace require approval, which surfaces as TASK_STATE_INPUT_REQUIRED.',
      tags: ['shell', 'sandbox'],
      inputModes: [TEXT_MODE, JSON_MODE],
      outputModes: [TEXT_MODE, JSON_MODE],
    },
  ]
}

export function buildAgentCard(o: CardOptions): AgentCard {
  const supportedInterfaces: AgentInterface[] = [
    { url: o.url, protocolBinding: 'JSONRPC' },
    // 同一个地址也支持 REST 绑定：POST /message:send、GET /tasks/{id}
    { url: o.url, protocolBinding: 'HTTP+JSON' },
  ]

  const card: AgentCard = {
    name: 'UnitHarness',
    description:
      'A coding agent that proves its work. Runs tasks in a sandbox, records everything it did as '
      + 'an append-only event log, and verifies deliverables before claiming success.',
    supportedInterfaces,
    provider: {
      organization: 'UnitAI',
      url: 'https://unitai.site',
    },
    version: o.version,
    documentationUrl: 'https://github.com/create-info/unit-harness',
    capabilities: {
      streaming: o.streaming === true,
      pushNotifications: false,      // 没实现就不声明，别让客户端等一个永远不会来的回调
      stateTransitionHistory: true,  // 有 events.jsonl，状态迁移可回放
    },
    // 只有真开了令牌才声明鉴权。声明了却没有校验，是更糟的谎
    ...(o.authToken
      ? {
          securitySchemes: {
            bearer: { httpAuthSecurityScheme: { scheme: 'bearer' } },
          },
          securityRequirements: [{ bearer: [] }],
        }
      : {}),
    defaultInputModes: [TEXT_MODE, JSON_MODE],
    defaultOutputModes: [TEXT_MODE, JSON_MODE],
    skills: skills(),
  }

  return card
}
