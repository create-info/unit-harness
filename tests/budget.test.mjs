/**
 * 成本预算测试。
 *
 * 两件事分开验：
 *   1. 纯函数 verdict（80% 提醒一次、100% 叫停、两个预算取紧的）
 *   2. 端到端：预算到线时 run 真的停下、退出码非 0、事件里有预算被拒的记录
 *
 * 端到端那条比函数测试重要得多——它证明预算不是"算出来给人看"，
 * 而是真的能拦住一个正在花钱的循环。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(here, 'dist', 'uh.cjs')

const budgetMod = await import(
  pathToFileURL(join(here, 'packages', 'core', 'src', 'agent', 'budget.ts')).href
)
const { checkBudget, normalizeBudget, formatTokens, describeBudget } = budgetMod

// ─────────────────────── 纯函数 ───────────────────────

test('under the limit is ok, and nothing is said', () => {
  const v = checkBudget({ used: 100, limit: 10_000, dayUsed: 100, dayLimit: 0 })
  assert.equal(v.action, 'ok')
})

test('eighty percent warns once, and the caller can suppress the repeat', () => {
  const state = { used: 8500, limit: 10_000, dayUsed: 8500, dayLimit: 0 }
  const first = checkBudget(state)
  assert.equal(first.action, 'warn')
  assert.match(first.message, /85%/)
  // 已经提醒过就不再提醒：每步都弹一句等于没提醒
  assert.equal(checkBudget(state, { warned: true }).action, 'ok')
})

test('reaching the limit stops, and the message says what to do', () => {
  const v = checkBudget({ used: 10_000, limit: 10_000, dayUsed: 10_000, dayLimit: 0 })
  assert.equal(v.action, 'stop')
  assert.match(v.message, /budget is used up/)
  assert.match(v.message, /10k tokens/)
})

test('going over the limit still stops (the call that crossed it is paid for)', () => {
  const v = checkBudget({ used: 12_000, limit: 10_000, dayUsed: 12_000, dayLimit: 0 })
  assert.equal(v.action, 'stop')
})

test('the tighter of the two budgets wins', () => {
  // 单次还很宽，但今天已经到线了
  const dayTight = checkBudget({ used: 100, limit: 1_000_000, dayUsed: 100_000, dayLimit: 100_000 })
  assert.equal(dayTight.action, 'stop')
  assert.match(dayTight.message, /today/)

  // 今天 99% 但还没到线：说 warn，不说 stop
  const dayNear = checkBudget({ used: 100, limit: 1_000_000, dayUsed: 99_000, dayLimit: 100_000 })
  assert.equal(dayNear.action, 'warn')
  assert.match(dayNear.message, /today/)

  // 今天还很宽,但这一次快满了
  const runTight = checkBudget({ used: 9_500, limit: 10_000, dayUsed: 9_500, dayLimit: 1_000_000 })
  assert.equal(runTight.action, 'warn')
})

test('zero or missing limits mean unlimited, not zero', () => {
  assert.equal(checkBudget({ used: 999_999, limit: 0, dayUsed: 999_999, dayLimit: 0 }).action, 'ok')
})

test('a budget only warns when it is actually set', () => {
  // 没设预算时 80% 的分支不该被触发（0/0 是 NaN，不能当成"用完了"）
  assert.equal(checkBudget({ used: 0, limit: 0, dayUsed: 0, dayLimit: 0 }).action, 'ok')
})

test('tokens are formatted for humans, not as raw numbers', () => {
  assert.equal(formatTokens(500), '500 tokens')
  assert.equal(formatTokens(1234), '1.2k tokens')
  assert.equal(formatTokens(12_345), '12k tokens')
  assert.equal(formatTokens(2_500_000), '2.50M tokens')
})

test('config values are clamped: garbage becomes unlimited, not a tiny budget', () => {
  assert.deepEqual(normalizeBudget({ perRun: '5000', perDay: 0 }), { perRun: 5000, perDay: 0 })
  assert.deepEqual(normalizeBudget({ perRun: -100 }), { perRun: 0, perDay: 0 })
  assert.deepEqual(normalizeBudget({ perRun: 'abc' }), { perRun: 0, perDay: 0 })
  assert.deepEqual(normalizeBudget(null), { perRun: 0, perDay: 0 })
  // 1.9 不是 1900：预算单位就是 token，不做隐式换算
  assert.deepEqual(normalizeBudget({ perRun: 1.9 }), { perRun: 1, perDay: 0 })
})

test('the summary line disappears entirely when no budget is set', () => {
  assert.equal(describeBudget({ perRun: 0, perDay: 0 }, { run: 100, day: 200 }), null)
  const line = describeBudget({ perRun: 10_000, perDay: 0 }, { run: 1234, day: 0 })
  assert.match(String(line), /1\.2k tokens of 10k tokens this run/)
})

// ─────────────────────── 端到端 ───────────────────────

/** 假模型：每轮都报 8 个 token，跑一次工具再收尾 */
function modelServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const parsed = JSON.parse(b || '{}')
      const hadTool = (parsed.messages ?? []).some((m) => m.role === 'tool')
      const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
      const payload = hadTool
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage }
        : {
            model: 'mock',
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ argv: ['ls'] }) } }],
              },
              finish_reason: 'tool_calls',
            }],
            usage,
          }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

function run(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (out += d))
    p.on('close', (code) => resolve({ out, code }))
  })
}

const sessionDir = (home) => {
  const base = join(home, 'sessions')
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name.startsWith('ses_')) return join(d, e.name)
        const found = walk(join(d, e.name))
        if (found) return found
      }
    }
    return null
  }
  return walk(base) ?? walk(home)
}

test('a tiny per-run budget stops the loop and exits non-zero', async () => {
  const server = modelServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-budget-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ budget: { perRun: 5 } }))

  try {
    const { out, code } = await run(['run', 'do something', '--max-steps', '5'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })

    assert.equal(code, 3, `budget stop must exit 3, got ${code}\n${out}`)
    assert.match(out, /stoppedBy=budget/)

    const dir = sessionDir(home)
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))

    const exceeded = events.find((e) => e.kind === 'budget/exceeded')
    assert.ok(exceeded, 'the stop must be recorded, not just reflected in the exit code')
    assert.equal(exceeded.payload.limit, 5)
    assert.ok(exceeded.payload.used >= 5)
    assert.match(String(exceeded.payload.message), /budget is used up/)

    // 停下之前必须先收尾 turn，否则回放会看到一段没有终点的循环
    const turnEnd = events.filter((e) => e.kind === 'turn/end').pop()
    assert.equal(turnEnd.payload.stop_reason, 'budget')
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('with no budget configured the same task runs to completion', async () => {
  const server = modelServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-budget2-'))

  try {
    const { out, code } = await run(['run', 'do something', '--max-steps', '5'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0, `no budget should mean no interference\n${out}`)
    assert.match(out, /stoppedBy=model/)

    const dir = sessionDir(home)
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(!events.some((e) => e.kind === 'budget/exceeded'))
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('a generous budget lets the task finish, and leaves no stop record', async () => {
  const server = modelServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const home = mkdtempSync(join(tmpdir(), 'uh-budget3-'))
  writeFileSync(join(home, 'config.json'), JSON.stringify({ budget: { perRun: 100_000 } }))

  try {
    const { out, code } = await run(['run', 'do something', '--max-steps', '5'], {
      ...process.env, UH_HOME: home, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock',
    })
    assert.equal(code, 0, out)
    assert.match(out, /stoppedBy=model/)
  } finally {
    server.close()
    rmSync(home, { recursive: true, force: true })
  }
})
