/**
 * 剧本（recipe）：把「一句话任务」变成「可验收的交付」。
 *
 * 一条 `uh run "..."` 依赖模型自己理解要求、自己决定什么叫完成。
 * 剧本把两件事固定下来：
 *   1. task —— 说清楚要做什么（变量可注入）
 *   2. checks —— 跑完之后由**我们**判定做没做成，不问模型
 *
 * 这不是给模型看的提示词模板，是给人看的验收单。
 */

export type CheckKind = 'file' | 'command'

export interface RecipeCheck {
  kind: CheckKind
  /** file: 相对工作区的路径 */
  path?: string
  /** command: argv 数组（不经 shell，除非你显式写 sh -c） */
  argv?: string[]
  /** command: 期望退出码，默认 0 */
  expectExit?: number
  /** 人读的说明，失败时显示这一行 */
  label?: string
  timeoutMs?: number
}

export interface Recipe {
  name: string
  description: string
  /** 变量默认值；task 与 checks 里用 {{name}} 引用 */
  vars?: Record<string, string | number>
  /** 逐行写的任务描述，合并成一段 */
  task: string[]
  checks?: RecipeCheck[]
}

export interface RecipeCheckResult {
  label: string
  kind: CheckKind
  result: 'pass' | 'fail' | 'error'
  detail: string
}
