/**
 * Hooks。
 *
 * 事件模型里 `hook/execution` 早就登记了，但从来没人真的执行过。这里补上执行端。
 *
 * 三个挂点，各有各的用处：
 *
 *   pre_tool   工具执行前。非 0 退出 = 挡下，stderr 原样回给模型。
 *              用来钉「这个仓库里不许跑 deploy」，比写在提示词里可靠——
 *              提示词可以被绕开，进程退出码不行。
 *   post_tool  工具执行后。只做记录与告警，不改结果。
 *   pre_finish 模型声称「做完了」的时候跑。非 0 = 把它的话打回去，
 *              stderr 作为新的用户消息塞回上下文，让它继续改。
 *              这是把「验证」从一句提示词变成机制的地方：
 *              提示词说「验证后再声称完成」，模型可以不理；hook 不行。
 *
 * 配置在工作区的 .uh/hooks.json：
 *
 *   {
 *     "pre_finish": [{ "run": "npm test" }],
 *     "pre_tool":   [{ "tool": "run_command", "match": "deploy", "run": "echo 禁止部署 >&2; exit 2" }]
 *   }
 */

import fs from 'node:fs'
import path from 'node:path'

export type HookEvent = 'pre_tool' | 'post_tool' | 'pre_finish'

export interface HookDef {
  /** pre_tool/post_tool 匹配的工具名；缺省 = 任何工具 */
  tool?: string
  /** 只看命令行里是否含这个正则；缺省 = 不筛 */
  match?: string
  /** 要执行的 shell 命令 */
  run: string
  /** 超时，默认 60s */
  timeout_ms?: number
}

export interface HookConfig {
  pre_tool?: HookDef[]
  post_tool?: HookDef[]
  pre_finish?: HookDef[]
}

export interface HookOutcome {
  name: string
  event: HookEvent
  decision: 'allow' | 'block'
  exitCode: number
  output: string
}

export function hooksPath(workspace: string): string {
  return path.join(workspace, '.uh', 'hooks.json')
}

export function loadHooks(workspace: string): HookConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(hooksPath(workspace), 'utf8')) as HookConfig
    return {
      pre_tool: Array.isArray(raw.pre_tool) ? raw.pre_tool : [],
      post_tool: Array.isArray(raw.post_tool) ? raw.post_tool : [],
      pre_finish: Array.isArray(raw.pre_finish) ? raw.pre_finish : [],
    }
  } catch {
    return {}
  }
}

/** 该 hook 是否适用于这次调用 */
export function matches(def: HookDef, tool: string | undefined, command: string | undefined): boolean {
  if (def.tool && def.tool !== '*' && def.tool !== tool) return false
  if (def.match) {
    if (!command) return false
    try {
      if (!new RegExp(def.match).test(command)) return false
    } catch {
      return false
    }
  }
  return true
}

/** hook 的浏览器标签，写进事件用 */
export function hookName(event: HookEvent, def: HookDef, i: number): string {
  return `${event}#${i + 1}${def.tool ? `:${def.tool}` : ''}`
}
