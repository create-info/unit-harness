/**
 * Rollout：一条会话的 append-only 消息流。
 *
 * 为什么不再用 state.json 当续跑依据：state.json 是**整轮结束时**写的一张快照。
 * 一轮被打断（--force、Ctrl-C、浏览器关掉）就没有"结束"，于是：
 *   - 这一轮说过的话一个字都没落盘；
 *   - 落盘的只有上一次的旧快照，里面可能还带着压缩后的摘要和半截工具输出。
 * 续跑时模型拿到那坨东西，只能说"我不知道之前做到哪了"——它确实不知道。
 *
 * Codex 的做法是 rollout：把每条消息**发生时就追加**到日志，历史靠重放日志得到。
 * 压缩不是改写历史，而是往日志里追加一条 `compacted` 记录，重放时用它替换掉
 * 之前的所有消息（对应 Codex 的 CompactedItem.replacement_history）。这样：
 *   - 被打断的一轮，已经发生的部分仍然在；
 *   - 压缩前后都能完整重放，不依赖任何"最后状态"；
 *   - 日志只追加，崩溃最多丢最后一行。
 *
 * 和 events.jsonl 的分工：events 是给**人**看的（进度、工具调用、耗时），
 * rollout 是给**模型**看的（它自己那串对话）。两边的保留策略本来就不一样——
 * 事件里塞满完整工具输出会让日志打不开，而模型缺了那些内容就没法继续干活。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Message } from '../llm/types.ts'

/** 一行日志。message = 一条对话消息；compacted = 从这里开始，前面全部作废 */
export type RolloutEntry =
  | { type: 'message'; message: Message }
  | { type: 'compacted'; messages: Message[] }

export function rolloutPath(sessionDir: string): string {
  return path.join(sessionDir, 'rollout.jsonl')
}

/**
 * 追加一行。
 *
 * 用 appendFileSync 而不是流：一次 run 里每个 step 最多写几条，同步写的开销
 * 远小于"进程被杀时缓冲区里还剩半行"的风险。崩溃最多丢掉正在写的那一行。
 */
export function appendRollout(sessionDir: string, entry: RolloutEntry): void {
  try {
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.appendFileSync(rolloutPath(sessionDir), JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* 落盘失败不该让整次运行失败：模型这一轮仍然是对的，只是续不了 */
  }
}

/**
 * 重放日志得到当前对话。
 *
 * 返回 null 表示"没有日志"（老会话、或这一轮还没写过），调用方可以退回 state.json。
 * 返回空数组是有效的：说明日志存在但里面只有压缩记录之类的东西。
 */
export function replayRollout(sessionDir: string): Message[] | null {
  const p = rolloutPath(sessionDir)
  let raw: string
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }

  let messages: Message[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let e: RolloutEntry
    try {
      e = JSON.parse(line) as RolloutEntry
    } catch {
      // 半行（进程在写这一行时被杀）：丢掉即可，它后面的内容还没发生
      continue
    }
    if (e.type === 'compacted') {
      // 压缩点：之前的一切被这份替换列表取代。system 永远由新的一轮重建，不存
      messages = e.messages.filter((m) => m.role !== 'system')
    } else if (e.type === 'message' && e.message?.role && e.message.role !== 'system') {
      messages.push(e.message)
    }
  }
  return messages
}
