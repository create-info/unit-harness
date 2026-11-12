/**
 * 剧本的验收单。
 *
 * 与交付物断言的区别：断言看的是「文件本身对不对」（存在/语法/哈希），
 * 剧本检查看的是「它作为程序能不能跑」——起服务探端口、跑 CLI 看输出。
 * 两者都在沙箱里执行，都落 `verification/asserted`。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Harness } from '../harness.ts'
import type { RecipeCheck, RecipeCheckResult } from './types.ts'
import { renderTemplate } from './registry.ts'

function label(check: RecipeCheck, rendered: string): string {
  return check.label ?? rendered
}

export async function runRecipeChecks(
  harness: Harness,
  checks: RecipeCheck[],
  vars: Record<string, string | number>,
  workspace: string,
): Promise<RecipeCheckResult[]> {
  const out: RecipeCheckResult[] = []

  for (const check of checks) {
    if (check.kind === 'file') {
      const rel = renderTemplate(check.path ?? '', vars)
      const abs = path.resolve(workspace, rel)
      const exists = fs.existsSync(abs)
      const size = exists ? fs.statSync(abs).size : 0
      out.push({
        label: label(check, rel),
        kind: 'file',
        result: exists && size > 0 ? 'pass' : 'fail',
        detail: exists ? `${size} B` : 'missing',
      })
      continue
    }

    const argv = (check.argv ?? []).map((a) => renderTemplate(a, vars))
    if (argv.length === 0) continue
    const cmd = argv as [string, ...string[]]
    const rendered = argv.join(' ')
    const expect = check.expectExit ?? 0

    try {
      const r = await harness.exec({
        argv: cmd,
        ...(check.timeoutMs ? { timeoutMs: check.timeoutMs } : {}),
      }) as { exitCode?: number; stdout?: string; stderr?: string }

      const code = r.exitCode ?? -1
      // 126/127 = 检查器自己都没跑起来（找不到命令/不可执行），不能算交付物不合格
      const envBroken = code === 126 || code === 127
      out.push({
        label: label(check, rendered),
        kind: 'command',
        result: envBroken ? 'error' : code === expect ? 'pass' : 'fail',
        detail: envBroken
          ? `checker could not run (exit ${code})`
          : `exit ${code}${code === expect ? '' : ` (expected ${expect})`}${r.stderr ? ` :: ${String(r.stderr).trim().slice(0, 160)}` : ''}`,
      })
    } catch (err) {
      out.push({
        label: label(check, rendered),
        kind: 'command',
        result: 'error',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return out
}
