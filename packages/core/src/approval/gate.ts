/**
 * 审批门。
 *
 * 定位里写了「花钱动作有审批」，但一直没实现——之前只有远端执行有分级开关，
 * 本地 exec 是「沙箱兜着，随便跑」。问题是沙箱会降级（path-guard、--allow-unconfined），
 * 一降级就等于什么都没拦。
 *
 * 这里的分工，抄的是 Codex 的 AskForApproval：
 *
 *   - 沙箱**真正生效**时的写操作，不问。沙箱已经保证它只能改工作区，
 *     再问一遍只是让人每装一个包就按一次 y。
 *   - 沙箱**没兜住**的写操作，问。
 *   - 毁灭性命令，一律问——哪怕在沙箱里：`rm -rf` 打在工作区里也是把你的交付物删了，
 *     沙箱对此无话可说。
 *
 * 默认策略是 deny 而不是 allow：一个没接交互界面的调用方（CI、脚本、API）
 * 不应该因为「没人回答」就获得了执行危险动作的许可。
 */

import type { RiskLevel } from '../remote/risk.ts'

export type ApprovalDecision = 'allow' | 'deny'

/** ask = 逐次询问（默认），allow = 全放行，deny = 一律拒绝 */
export type ApprovalPolicy = 'ask' | 'allow' | 'deny'

export interface ApprovalRequest {
  /** 哪一类动作：本地命令 / 远端命令 / 文件补丁 */
  kind: 'exec' | 'remote' | 'patch'
  risk: RiskLevel
  /** 一句话给人看：要干什么 */
  summary: string
  /** 完整内容给人看：要执行的命令或要改的文件 */
  detail: string
  /** 为什么需要问（沙箱没兜住 / 毁灭性 / 远端写） */
  reason: string
}

export interface ApprovalGate {
  request(req: ApprovalRequest): Promise<ApprovalDecision>
}

/** 一律拒绝的闸门：没接交互界面时的默认值 */
export const denyAll: ApprovalGate = {
  request: async () => 'deny',
}

/** 一律放行：`--yes` / 明确信任的自动化场景 */
export const allowAll: ApprovalGate = {
  request: async () => 'allow',
}

/** 这个动作在给定隔离强度下，是否需要人类点一次头 */
export function needsApproval(
  risk: RiskLevel,
  opts: { isolationEnforced: boolean; kind: 'exec' | 'remote' | 'patch' },
): { needed: boolean; reason: string } {
  if (risk === 'read') return { needed: false, reason: '' }

  if (risk === 'destructive') {
    return { needed: true, reason: 'destructive — it cannot be undone by the sandbox' }
  }

  // 远端没有沙箱可比：ssh 出去改的就是别人的生产机
  if (opts.kind === 'remote') {
    return { needed: true, reason: 'remote write — the sandbox does not cover the remote host' }
  }

  if (!opts.isolationEnforced) {
    return { needed: true, reason: 'the sandbox is not enforcing, so nothing bounds this write' }
  }

  // 沙箱生效时的写操作：它能改的只有工作区，不打扰人
  return { needed: false, reason: '' }
}
