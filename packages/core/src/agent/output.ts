/**
 * 工具输出的截断。
 *
 * 三个决定，都是被真实故障逼出来的：
 *
 * 1. **截中间，留两头。** 之前是「累计到 256KB 就不再收」，于是模型看到的是命令输出的开头——
 *    而错误、堆栈、"最后几行"全在结尾。一个 `npm install` 失败的输出，模型拿到的恰好是
 *    那一堆无关的进度日志。
 *
 * 2. **完整输出落盘，并把路径告诉模型。** 截断不等于丢弃：给了路径，它就可以用
 *    `run_command: ["sed","-n","500,560p",...]` 去看被省略的那一段。
 *
 * 3. **落盘位置在工作区内的 `.uh/` 下。** 那是交付物快照已经跳过的目录，不会被误算成
 *    本次运行的产物；同时它在工作区内，沙箱允许模型读回来。
 */

export interface PreparedOutput {
  text: string
  truncated: boolean
  omittedChars: number
  savedPath?: string
}

export interface PrepareOptions {
  /** 给模型的字符预算，默认 20000（约 5k tokens） */
  maxChars?: number
  /** 落盘回调：返回工作区内的相对路径，用于告诉模型去哪读 */
  save?: (content: string) => string
}

/** 从中间截断，保留头尾各一半的预算 */
export function truncateMiddle(text: string, maxChars: number): { text: string; omitted: number } {
  if (text.length <= maxChars) return { text, omitted: 0 }

  const budget = Math.max(200, maxChars - 120)
  const headLen = Math.floor(budget / 2)
  const tailLen = budget - headLen
  const head = text.slice(0, headLen)
  const tail = text.slice(text.length - tailLen)
  const omitted = text.length - head.length - tail.length

  return {
    text: `${head}\n\n… [${omitted} chars omitted — this is the middle, the tail follows] …\n\n${tail}`,
    omitted,
  }
}

export function prepareToolOutput(text: string, opts: PrepareOptions = {}): PreparedOutput {
  const maxChars = opts.maxChars ?? 20_000
  if (text.length <= maxChars) return { text, truncated: false, omittedChars: 0 }

  const { text: clipped, omitted } = truncateMiddle(text, maxChars)
  let savedPath: string | undefined
  if (opts.save) {
    try {
      savedPath = opts.save(text)
    } catch {
      savedPath = undefined
    }
  }

  const footer = savedPath
    ? `\n\n[full output (${text.length} chars) saved to ${savedPath} — read it with run_command if you need the omitted part]`
    : ''

  return { text: clipped + footer, truncated: true, omittedChars: omitted, ...(savedPath ? { savedPath } : {}) }
}
