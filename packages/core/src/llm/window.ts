/**
 * 模型的上下文窗口有多大。
 *
 * 为什么不能写死一个数：窗口是**模型的属性**，不是程序的属性。同一个
 * unit-harness 进程，接本地 27B（128k）和接 DeepSeek（128k/1M）应该是
 * 两个不同的预算。写死 32000 的后果不是"保守"，而是把 128k 的模型按
 * 32k 来压缩——模型明明还能装，历史却被反复摘要，答对的东西被摘要丢掉。
 *
 * 三个来源，按可靠性排序：
 *   1. 配置文件里显式写的 `contextWindow`（用户最清楚自己开了多少）
 *   2. 服务端 /models 报的：LM Studio 的 `max_context_length` /
 *      `loaded_context_length`、OpenRouter 的 `context_length`
 *   3. 内置表按模型名匹配（前缀匹配，因为 `deepseek-chat-0711` 这类
 *      带日期后缀的名字会变）
 * 都没有就用 DEFAULT_CONTEXT_WINDOW，并且**把"这是猜的"讲出来**——
 * 让用户看到 32k 却以为是他模型的真实窗口，比不显示更糟。
 */

/** 这家服务报的窗口字段名不一样，都要认 */
export interface ReportedWindow {
  /** 模型名 */
  id: string
  /** 服务端说的最大窗口 */
  max?: number
  /** 服务端说当前实际加载/生效的窗口（LM Studio 的 loaded_context_length） */
  loaded?: number
}

/**
 * 内置窗口表。key 用小写前缀匹配。
 *
 * 数字取自各家的公开文档；不确定的宁可不写——写了错数字会让压缩时机更离谱。
 * 这是**兜底**，不是权威：服务端一报，就用服务端的。
 */
const KNOWN_WINDOWS: Array<[prefix: string, tokens: number]> = [
  // DeepSeek：v4 系列 128k
  ['deepseek', 128_000],
  // Anthropic
  ['claude-3', 200_000],
  ['claude-4', 200_000],
  ['claude', 200_000],
  // OpenAI
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4', 128_000],
  ['gpt-5', 400_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  // 国内
  ['kimi', 256_000],
  ['moonshot', 128_000],
  ['glm', 128_000],
  ['qwen', 128_000],
  ['ernie', 128_000],
  ['minimax', 256_000],
  // 开源常见的 128k
  ['llama', 128_000],
  ['mistral', 128_000],
  ['gemma', 128_000],
]

/** 什么都没问到时的默认值。32k 是最保守的可用值，但它是"猜的"。 */
export const DEFAULT_CONTEXT_WINDOW = 32_000

/**
 * 压缩在窗口的多少比例触发。
 *
 * Codex 用 90%；我们用 70%。差别不是随手定的：90% 意味着压一次得丢掉
 * 一大半历史，模型刚建立的理解被整段换成摘要，之后要回去重读；70% 压得
 * 更勤但每次丢得少，正在做的那件事还在。实测那条 3164 步的会话，压完
 * 立刻重读文件、step 继续涨，就是压得太狠的表现。
 */
export const COMPACT_AT_RATIO = 0.7

/**
 * 算这次该用的上下文预算。
 *
 * `explicit` 传配置里写死的值（0 或缺省表示"没写"），`reported` 传服务端
 * 报的窗口。优先级：explicit > reported.loaded > reported.max > 内置表 > 默认。
 */
export function resolveContextWindow(opts: {
  model?: string | undefined
  explicit?: number | undefined
  reported?: ReportedWindow | undefined
}): { tokens: number; source: 'config' | 'server-loaded' | 'server-max' | 'builtin' | 'default' } {
  if (opts.explicit && opts.explicit > 0) return { tokens: Math.floor(opts.explicit), source: 'config' }

  const r = opts.reported
  // loaded 优先于 max：LM Studio 里 max 是"这模型最多能开多少"，
  // loaded 才是"现在真的开了多少"。按 max 算会把 128k 当 256k 用，直接 400。
  if (r?.loaded && r.loaded > 0) return { tokens: Math.floor(r.loaded), source: 'server-loaded' }
  if (r?.max && r.max > 0) return { tokens: Math.floor(r.max), source: 'server-max' }

  const name = (opts.model ?? '').toLowerCase()
  if (name) {
    // 长前缀优先：'gpt-4.1' 必须排在 'gpt-4' 前面，否则 1M 的模型会被当成 128k
    const hit = [...KNOWN_WINDOWS].sort((a, b) => b[0].length - a[0].length).find(([p]) => name.includes(p))
    if (hit) return { tokens: hit[1], source: 'builtin' }
  }

  return { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' }
}

/** 压缩触发点：窗口 × 比例，向下取整 */
export function compactThreshold(tokens: number): number {
  return Math.floor(tokens * COMPACT_AT_RATIO)
}

/**
 * 从服务端 /models 的一条记录里抠出窗口字段。
 *
 * 各家字段名不统一：LM Studio 用 max_context_length / loaded_context_length，
 * OpenRouter 用 context_length，vLLM 用 max_model_len。认不出的返回 undefined，
 * 不要瞎猜——猜错比没有更糟。
 */
export function windowFromModelEntry(entry: Record<string, unknown>): { max?: number; loaded?: number } {
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const max = num(entry.max_context_length) ?? num(entry.context_length) ?? num(entry.max_model_len) ?? num(entry.context_window)
  const loaded = num(entry.loaded_context_length)
  return {
    ...(max !== undefined ? { max } : {}),
    ...(loaded !== undefined ? { loaded } : {}),
  }
}
