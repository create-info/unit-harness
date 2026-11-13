/**
 * 被沙箱挡住之后的正规出路。
 *
 * 之前撞墙的模型只有两个选择：换个写法再撞一次，或者报告做不到。
 * Codex 和 DeepSeek Harness 都给了第三条路——明确申请一次越权，人批了才跑。
 * 这里钉住三件事：撞墙时它知道原因、申请会被问到人、批准后真的跑在外面。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(process.cwd(), 'dist', 'uh.cjs')
const POSIX_ONLY = process.platform === 'win32' ? 'posix-only' : false

/** 按顺序发起 tool call，最后给一句结论 */
/** 把每次发给模型的请求都记下来：工具结果是作为 tool 消息回灌的 */
const seen = []

function startSequence(calls) {
  return http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock' }] }))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {}
      for (const m of parsed.messages ?? []) if (m.role === 'tool') seen.push(String(m.content))
      const done = (parsed.messages ?? []).filter((m) => m.role === 'tool').length
      const payload = done >= calls.length
        ? { model: 'mock', choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }
        : { model: 'mock', choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'c' + done, type: 'function', function: calls[done] }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
  })
}

function eventsOf(home) {
  let dir = join(home, 'sessions')
  for (let i = 0; i < 5; i++) {
    const sub = readdirSync(dir)
    if (!sub.length) break
    dir = join(dir, sub[0])
    const f = join(dir, 'events.jsonl')
    if (existsSync(f)) return readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  }
  return []
}

test('a sandbox refusal tells the model what it is and how to ask for an exception', { skip: POSIX_ONLY }, async () => {
  seen.length = 0
  const base = mkdtempSync(join(tmpdir(), 'uh-esc-'))
  const work = join(base, 'work')
  mkdirSync(work, { recursive: true })
  const outside = join(base, 'pwned.txt')

  const server = startSequence([
    { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', `touch ${outside}`] }) },
  ])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  try {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'write outside', '--max-steps', '3', '--yes'], {
        cwd: work,
        env: { ...process.env, UH_HOME: join(base, 'home'), UH_WORKSPACE: work, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      p.on('close', resolve)
    })

    assert.equal(existsSync(outside), false, 'the write really was refused')

    // 提示语是拼在**返回给模型的 tool 消息**里的，不是事件 payload
    const fed = seen.join('\n')
    assert.match(fed, /this is the boundary, not a bug in your command/,
      'without this the model just retries the same shape or gives up')
    assert.match(fed, /escalate:"<one line saying why>"/, 'and it is told the sanctioned way out')
  } finally {
    server.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('an approved escalation runs outside the sandbox — and is logged as such', { skip: POSIX_ONLY }, async () => {
  seen.length = 0
  const base = mkdtempSync(join(tmpdir(), 'uh-esc2-'))
  const work = join(base, 'work')
  mkdirSync(work, { recursive: true })
  const outside = join(base, 'allowed.txt')

  const server = startSequence([
    // 第一次：正常被拒
    { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', `touch ${outside}`] }) },
    // 第二次：明确申请越权
    { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', `touch ${outside}`], escalate: 'the file has to live outside the project' }) },
  ])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  try {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'write outside', '--max-steps', '4', '--yes'], {
        cwd: work,
        env: { ...process.env, UH_HOME: join(base, 'home'), UH_WORKSPACE: work, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      p.on('close', resolve)
    })

    assert.ok(existsSync(outside), 'after approval the command must actually leave the sandbox')

    const evs = eventsOf(join(base, 'home'))
    const resolved = evs.filter((e) => e.kind === 'approval/resolved' && e.payload.escalation === true)
    assert.equal(resolved.length, 1, 'the escalation itself is recorded, not hidden inside the exec')
    const results = evs.filter((e) => e.kind === 'tool/result').map((e) => JSON.stringify(e.payload))
    assert.ok(results.some((r) => r.includes('"isolation":"none"')),
      'the log must show which run was unsandboxed — otherwise the audit trail lies about isolation')
  } finally {
    server.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('approving a command once silences it for the rest of the session', { skip: POSIX_ONLY }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'uh-esc3-'))
  const work = join(base, 'work')
  mkdirSync(work, { recursive: true })

  // destructive 命令：沙箱兜不住，必然要问
  const cmd = { name: 'run_command', arguments: JSON.stringify({ argv: ['sh', '-c', 'rm -rf build'] }) }
  const server = startSequence([cmd, cmd, cmd])
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  try {
    await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'run', 'clean twice', '--max-steps', '5', '--yes'], {
        cwd: work,
        env: { ...process.env, UH_HOME: join(base, 'home'), UH_WORKSPACE: work, UH_BASE_URL: `http://127.0.0.1:${port}/v1`, UH_MODEL: 'mock' },
      })
      p.on('close', resolve)
    })

    const evs = eventsOf(join(base, 'home'))
    const asked = evs.filter((e) => e.kind === 'approval/requested').length
    const cached = evs.filter((e) => e.kind === 'approval/resolved' && e.payload.cached === true).length
    assert.equal(asked, 0, '--yes auto-approves, so nothing should be "asked" at all')
    // 第二条同样的命令走缓存：它仍然被放行，但不再产生一次真正的请求
    assert.ok(cached >= 1, 'the same command in the same directory should not be re-litigated')
  } finally {
    server.close()
    rmSync(base, { recursive: true, force: true })
  }
})
