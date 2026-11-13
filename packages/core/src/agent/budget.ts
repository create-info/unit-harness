/**
 * 成本预算。
 *
 * 上下文预算（compaction）管的是「窗口装不下」，这里管的是「钱包受不了」。
 * 两件事容易混：压缩是把历史变短，预算是停下来——压缩完还超，就必须停。
 *
 * 数字口径只有一条：**用 provider 自己报的 usage，不做估算**。
 * 估出来的钱没人敢拿去做决定，而且估错了会让人以为在骗他。
 * 本地模型常常不报 usage，那时如实记 0，预算也就管不到它——这一点要说出来，
 * 不能假装"已计量"。
 */

export interface BudgetConfig {
  /** 单次 run 的 token 上限；0 或缺省 = 不限 */
  perRun?: number
  /** 当天的 token 上限；0 或缺省 = 不限 */
  perDay?: number
}

export interface BudgetState {
  /** 这次 run 已经用掉 */
  used: number
  /** 这次 run 的上限（0 = 不限） */
  limit: number
  /** 今天已经用掉（含本次） */
  dayUsed: number
  /** 今天的上限（0 = 不限） */
  dayLimit: number
}

export type BudgetVerdict =
  | { action: 'ok' }
  /** 快到线了，提醒一次 */
  | { action: 'warn'; message: string; pct: number }
  /** 到线了，必须停 */
  | { action: 'stop'; message: string; pct: number }

const WARN_AT = 0.8

/** 人话：12_345 → "12.3k tokens" */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n} tokens`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k tokens`
  return `${(n / 1_000_000).toFixed(2)}M tokens`
}

/**
 * 判断这次 run 还能不能继续。
 *
 * 两个预算取更紧的那个：单次和每日任何一项到线都停。
 * 返回的 message 是直接给用户看的一句话，不要让它自己去拼。
 */
export function checkBudget(state: BudgetState, opts: { warned?: boolean } = {}): BudgetVerdict {
  const checks: Array<{ used: number; limit: number; what: string }> = []
  if (state.limit > 0) checks.push({ used: state.used, limit: state.limit, what: 'this run' })
  if (state.dayLimit > 0) checks.push({ used: state.dayUsed, limit: state.dayLimit, what: 'today' })

  for (const c of checks) {
    if (c.used >= c.limit) {
      return {
        action: 'stop',
        message:
          `Stopped: ${c.what === 'today' ? "today's" : 'this run\'s'} token budget is used up ` +
          `(${formatTokens(c.used)} of ${formatTokens(c.limit)}). ` +
          `Raise it in settings, or start again with a smaller task.`,
        pct: 1,
      }
    }
  }

  // 还没到线，但已经用了八成：提醒一次，让用户有机会在自己觉得贵之前叫停
  if (!opts.warned) {
    for (const c of checks) {
      const pct = c.used / c.limit
      if (pct >= WARN_AT) {
        return {
          action: 'warn',
          message:
            `${Math.round(pct * 100)}% of ${c.what === 'today' ? "today's" : "this run's"} token budget used ` +
            `(${formatTokens(c.used)} of ${formatTokens(c.limit)}).`,
          pct,
        }
      }
    }
  }

  return { action: 'ok' }
}

/** 从配置里读出来，顺手把明显不合理的值挡掉 */
export function normalizeBudget(raw: unknown): BudgetConfig {
  const o = (raw ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  return { perRun: num(o.perRun), perDay: num(o.perDay) }
}

/** 给界面用的一句话摘要；没设预算时返回 null，不要显示「不限制」这种噪音 */
export function describeBudget(cfg: BudgetConfig, used: { run: number; day: number }): string | null {
  const parts: string[] = []
  if (cfg.perRun) parts.push(`${formatTokens(used.run)} of ${formatTokens(cfg.perRun)} this run`)
  if (cfg.perDay) parts.push(`${formatTokens(used.day)} of ${formatTokens(cfg.perDay)} today`)
  return parts.length ? parts.join(' · ') : null
}
