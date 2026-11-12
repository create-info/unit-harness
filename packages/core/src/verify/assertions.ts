/**
 * 断言：验证层的执行体（D13 的 L3）。
 *
 * 原则：
 *  1. 断言必须在沙箱里执行 —— 验尸不能成为逃逸口；
 *  2. 断言结果本身是事件（verification/asserted），不是控制流；
 *  3. 自动推断的断言要"真能发现问题"，不是走过场（.sh 做语法检查、.json 做解析）。
 */
import path from 'node:path'
import type { Artifact } from '../artifact/snapshot.ts'

export type Assertion =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-sha256'; path: string; sha256: string }
  | { kind: 'artifact-nonempty'; path: string }
  | { kind: 'command-exit'; argv: string[]; expectExit: number; why: string }

export type AssertionResult = 'pass' | 'fail' | 'error' | 'skipped'

export interface AssertionOutcome {
  assertion: Assertion
  result: AssertionResult
  detail?: unknown
}

/** 按文件类型推断断言：能真跑的检查才加，不加没意义的 */
export function inferAssertions(a: Artifact): Assertion[] {
  const out: Assertion[] = [
    { kind: 'artifact-exists', path: a.path },
    { kind: 'artifact-nonempty', path: a.path },
    { kind: 'artifact-sha256', path: a.path, sha256: a.sha256 },
  ]

  const ext = path.extname(a.path).toLowerCase()
  if (ext === '.sh') {
    out.push({ kind: 'command-exit', argv: ['sh', '-n', a.path], expectExit: 0, why: 'shell syntax check' })
  } else if (ext === '.json') {
    out.push({ kind: 'command-exit', argv: ['node', '-e', `JSON.parse(require('fs').readFileSync(${JSON.stringify(a.path)},'utf8'))`], expectExit: 0, why: 'json parses' })
  } else if (ext === '.py') {
    out.push({ kind: 'command-exit', argv: ['python3', '-m', 'py_compile', a.path], expectExit: 0, why: 'python compiles' })
  } else if (ext === '.yml' || ext === '.yaml') {
    out.push({ kind: 'command-exit', argv: ['node', '-e', `require('fs').readFileSync(${JSON.stringify(a.path)})`], expectExit: 0, why: 'yaml readable (parse check needs a dep; skipped)' })
  }
  return out
}

export interface AssertDeps {
  workspace: string
  /** 必须在沙箱里执行 */
  exec: (argv: [string, ...string[]]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  exists: (rel: string) => boolean
  size: (rel: string) => number
  sha256: (rel: string) => string | null
}

/** 执行一条断言 */
export async function runAssertion(a: Assertion, deps: AssertDeps): Promise<AssertionOutcome> {
  try {
    switch (a.kind) {
      case 'artifact-exists': {
        const ok = deps.exists(a.path)
        return { assertion: a, result: ok ? 'pass' : 'fail', detail: { exists: ok } }
      }
      case 'artifact-nonempty': {
        const n = deps.size(a.path)
        return { assertion: a, result: n > 0 ? 'pass' : 'fail', detail: { bytes: n } }
      }
      case 'artifact-sha256': {
        const got = deps.sha256(a.path)
        return { assertion: a, result: got === a.sha256 ? 'pass' : 'fail', detail: { expected: a.sha256, got } }
      }
      case 'command-exit': {
        const r = await deps.exec(a.argv as [string, ...string[]])
        if (r.exitCode === a.expectExit) {
          return { assertion: a, result: 'pass', detail: { why: a.why } }
        }
        // 126/127 = 命令本身跑不起来；这类结果说明"无法验证"，不是"验证不通过"。
        // 把它报成 fail 会让用户以为交付物坏了，而实际是环境里没有这个解释器。
        const unrunnable =
          r.exitCode === 126 || r.exitCode === 127 ||
          /Failed to import the site module|command not found|No such file or directory/.test(r.stderr)
        return {
          assertion: a,
          result: unrunnable ? 'error' : 'fail',
          detail: {
            why: a.why,
            expect: a.expectExit,
            got: r.exitCode,
            stderr: r.stderr.slice(0, 300),
            ...(unrunnable ? { note: 'the checker itself could not run in this sandbox' } : {}),
          },
        }
      }
      default:
        return { assertion: a as Assertion, result: 'skipped' }
    }
  } catch (err) {
    return {
      assertion: a,
      result: 'error',
      detail: { error: err instanceof Error ? err.message : String(err) },
    }
  }
}

/** 人类可读的一句话 */
export function describeAssertion(a: Assertion): string {
  switch (a.kind) {
    case 'artifact-exists': return `${a.path} exists`
    case 'artifact-nonempty': return `${a.path} is not empty`
    case 'artifact-sha256': return `${a.path} sha256 matches`
    case 'command-exit': return a.why
  }
}
